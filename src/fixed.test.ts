import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'fs';
import { applyFixedBills } from './fixed.js';
import { DB } from './db.js';
import { Transaction } from './types.js';
import { FixedBill } from './fixed-bills.js';

function withBills(dbPath: string, bills: FixedBill[], run: (db: DB) => void): void {
  const configPath = dbPath.replace('.sqlite', '-bills.json');
  writeFileSync(configPath, JSON.stringify({ bills }));
  const prevCat = process.env.CATEGORY_CONFIG;
  const prevBills = process.env.FIXED_BILLS_CONFIG;
  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = configPath;
  const db = new DB(dbPath);
  try {
    run(db);
  } finally {
    db.close();
    unlinkSync(dbPath);
    unlinkSync(configPath);
    if (prevCat === undefined) delete process.env.CATEGORY_CONFIG;
    else process.env.CATEGORY_CONFIG = prevCat;
    if (prevBills === undefined) delete process.env.FIXED_BILLS_CONFIG;
    else process.env.FIXED_BILLS_CONFIG = prevBills;
  }
}

function charge(id: string, merchant: string, chfAmount: number, fileRowIndex = 1): Transaction {
  return {
    id,
    date: '2024-10-05',
    source: 'neon',
    merchant,
    originalAmount: chfAmount,
    originalCurrency: 'CHF',
    chfAmount,
    fileRowIndex,
    importedAt: new Date().toISOString()
  };
}

test('applyFixedBills creates synthetic transactions for active bills', () => {
  const dbPath = './test-fixed-apply-basic.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-10');

    const transactions = db.getTransactionsByMonth('2024-10');
    const fixedTransactions = transactions.filter(t => t.source === 'fixed');

    assert.strictEqual(fixedTransactions.length, 4);

    const rent = fixedTransactions.find(t => t.merchant === 'Test monthly rent');
    assert.ok(rent);
    assert.strictEqual(rent.category, 'Living/Rent');
    assert.strictEqual(rent.chfAmount, 1000);
    assert.strictEqual(rent.confidence, 1);
    assert.strictEqual(rent.explanation, 'fixed bill: Test monthly rent');
    assert.ok(rent.id.startsWith('fixed:test-monthly-rent:'));

    const phone = fixedTransactions.find(t => t.merchant === 'Test bill without patterns');
    assert.ok(phone);
    assert.strictEqual(phone.category, 'Tech/Phone');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills is idempotent', () => {
  const dbPath = './test-fixed-idempotent.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-10');
    const firstRun = db.getTransactionsByMonth('2024-10').filter(t => t.source === 'fixed');

    applyFixedBills(db, '2024-10');
    const secondRun = db.getTransactionsByMonth('2024-10').filter(t => t.source === 'fixed');

    assert.strictEqual(firstRun.length, secondRun.length);

    for (let i = 0; i < firstRun.length; i++) {
      assert.strictEqual(firstRun[i].id, secondRun[i].id);
      assert.strictEqual(firstRun[i].chfAmount, secondRun[i].chfAmount);
      assert.strictEqual(firstRun[i].category, secondRun[i].category, 'Category should be preserved');
      assert.strictEqual(firstRun[i].confidence, secondRun[i].confidence, 'Confidence should be preserved');
    }
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills preserves reviewed flag on re-run', () => {
  const dbPath = './test-fixed-reviewed.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-10');

    const transactions = db.getTransactionsByMonth('2024-10');
    const fixedTx = transactions.find(t => t.source === 'fixed' && t.merchant === 'Test monthly rent');
    assert.ok(fixedTx);

    db.markAsReviewed(fixedTx.id);

    const reviewedTx = db.getTransaction(fixedTx.id);
    assert.strictEqual(reviewedTx?.reviewed, true);

    applyFixedBills(db, '2024-10');

    const afterRerun = db.getTransaction(fixedTx.id);
    assert.strictEqual(afterRerun?.reviewed, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills does not cover a single off-band same-merchant purchase', () => {
  withBills('./test-fixed-off-band-tool.sqlite', [{
    id: 'tools',
    label: 'Yearly tools',
    category: 'Tech/Phone',
    monthlyAmount: 10,
    renewalMonth: 10,
    merchantPatterns: ['^tool']
  }], db => {
    db.insertTransaction(charge('bank1', 'Tool 50', 50));
    applyFixedBills(db, '2024-10');

    const bank = db.getTransaction('bank1');
    const bill = db.getTransactionsByMonth('2024-10').find(t => t.id === 'fixed:tools:2024-10');
    assert.ok(bank);
    assert.ok(bill);
    assert.strictEqual(bank.coveredByFixedBill, null);
    assert.strictEqual(bank.fixedChanged, true);
    assert.strictEqual(bill.fixedChanged, true);
    assert.strictEqual(bill.fixedMissing, false);
    assert.strictEqual(bill.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-10'), 60);
  });
});

test('coverAnyAmount covers a single off-band charge such as rent paid in full', () => {
  withBills('./test-fixed-cover-any-single.sqlite', [{
    id: 'rent',
    label: 'Rent',
    category: 'Living/Rent',
    monthlyAmount: 1000,
    merchantPatterns: ['landlord'],
    coverAnyAmount: true
  }], db => {
    db.insertTransaction(charge('bank1', 'Landlord 3000', 3000));
    applyFixedBills(db, '2024-10');

    const bank = db.getTransaction('bank1');
    const bill = db.getTransactionsByMonth('2024-10').find(t => t.id === 'fixed:rent:2024-10');
    assert.ok(bank);
    assert.ok(bill);
    assert.strictEqual(bank.coveredByFixedBill, 'Rent');
    assert.strictEqual(bank.fixedChanged, true);
    assert.strictEqual(bill.fixedChanged, true);
    assert.strictEqual(db.getMonthTotal('2024-10'), 1000);
  });
});

test('applyFixedBills keeps an extra same-merchant purchase when another charge is within 10%', () => {
  withBills('./test-fixed-extra-purchase.sqlite', [{
    id: 'phone',
    label: 'Phone share',
    category: 'Tech/Phone',
    monthlyAmount: 4,
    merchantPatterns: ['carrier']
  }], db => {
    db.insertTransaction(charge('bank1', 'Carrier Family', 4, 1));
    db.insertTransaction(charge('bank2', 'Carrier Family', 27, 2));
    applyFixedBills(db, '2024-10');

    const billCharge = db.getTransaction('bank1');
    const extra = db.getTransaction('bank2');
    assert.ok(billCharge);
    assert.ok(extra);
    assert.strictEqual(billCharge.coveredByFixedBill, 'Phone share');
    assert.strictEqual(extra.coveredByFixedBill, null);
    assert.strictEqual(extra.fixedChanged, false);
    assert.strictEqual(db.getMonthTotal('2024-10'), 31);
  });
});

test('applyFixedBills does not guess which off-amount charge is the bill', () => {
  withBills('./test-fixed-ambiguous.sqlite', [{
    id: 'rent',
    label: 'Rent',
    category: 'Living/Rent',
    monthlyAmount: 1000,
    merchantPatterns: ['landlord']
  }], db => {
    db.insertTransaction(charge('bank1', 'Landlord A', 3000, 1));
    db.insertTransaction(charge('bank2', 'Landlord B', 2000, 2));
    applyFixedBills(db, '2024-10');

    const a = db.getTransaction('bank1');
    const b = db.getTransaction('bank2');
    const bill = db.getTransactionsByMonth('2024-10').find(t => t.id === 'fixed:rent:2024-10');
    assert.ok(a);
    assert.ok(b);
    assert.ok(bill);
    assert.strictEqual(a.coveredByFixedBill, null);
    assert.strictEqual(b.coveredByFixedBill, null);
    assert.strictEqual(a.fixedChanged, true);
    assert.strictEqual(b.fixedChanged, true);
    assert.strictEqual(bill.fixedChanged, true);
    assert.strictEqual(bill.fixedMissing, false);
    assert.strictEqual(bill.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-10'), 6000);
  });
});

test('coverAnyAmount covers the closest charge even when several matches are off band', () => {
  withBills('./test-fixed-cover-any.sqlite', [{
    id: 'rent',
    label: 'Rent',
    category: 'Living/Rent',
    monthlyAmount: 1000,
    merchantPatterns: ['landlord'],
    coverAnyAmount: true
  }], db => {
    db.insertTransaction(charge('bank1', 'Landlord A', 3000, 1));
    db.insertTransaction(charge('bank2', 'Landlord B', 2000, 2));
    applyFixedBills(db, '2024-10');

    const closer = db.getTransaction('bank2');
    const extra = db.getTransaction('bank1');
    const bill = db.getTransactionsByMonth('2024-10').find(t => t.id === 'fixed:rent:2024-10');
    assert.ok(closer);
    assert.ok(extra);
    assert.ok(bill);
    assert.strictEqual(closer.coveredByFixedBill, 'Rent');
    assert.strictEqual(extra.coveredByFixedBill, null);
    assert.strictEqual(bill.fixedChanged, true);
    assert.strictEqual(db.getMonthTotal('2024-10'), 4000);
  });
});

test('applyFixedBills covers a pattern match within 10% of the bill amount', () => {
  const dbPath = './test-fixed-amount-match.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 1090,
      originalCurrency: 'CHF',
      chfAmount: 1090,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);
    applyFixedBills(db, '2024-10');

    const covered = db.getTransaction('bank1');
    assert.ok(covered);
    assert.strictEqual(covered.coveredByFixedBill, 'Test monthly rent');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills marks matching bank transactions as covered', () => {
  const dbPath = './test-fixed-covered.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 1000,
      originalCurrency: 'CHF',
      chfAmount: 1000,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);

    applyFixedBills(db, '2024-10');

    const covered = db.getTransaction('bank1');
    assert.ok(covered);
    assert.strictEqual(covered.coveredByFixedBill, 'Test monthly rent');
    assert.strictEqual(covered.explanation, 'paid via fixed bill: Test monthly rent');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills sets fixedMissing flag when due bill has no bank charge', () => {
  const dbPath = './test-fixed-missing.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-03');

    const transactions = db.getTransactionsByMonth('2024-03');
    const insurance = transactions.find(t => t.merchant === 'Test annual insurance');

    assert.ok(insurance);
    assert.strictEqual(insurance.fixedMissing, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills does not set fixedMissing for non-due annual bills', () => {
  const dbPath = './test-fixed-not-due.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-10');

    const transactions = db.getTransactionsByMonth('2024-10');
    const insurance = transactions.find(t => t.merchant === 'Test annual insurance');

    assert.ok(insurance);
    assert.strictEqual(insurance.fixedMissing, false);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills sets fixedChanged flag when amount differs by >2%', () => {
  const dbPath = './test-fixed-changed.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 1050,
      originalCurrency: 'CHF',
      chfAmount: 1050,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);

    applyFixedBills(db, '2024-10');

    const covered = db.getTransaction('bank1');
    assert.ok(covered);
    assert.strictEqual(covered.fixedChanged, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills does not set fixedChanged when amount differs by <=2%', () => {
  const dbPath = './test-fixed-not-changed.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 1010,
      originalCurrency: 'CHF',
      chfAmount: 1010,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);

    applyFixedBills(db, '2024-10');

    const covered = db.getTransaction('bank1');
    assert.ok(covered);
    assert.strictEqual(covered.fixedChanged, false);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills handles annual bills with expected annual amount', () => {
  const dbPath = './test-fixed-annual.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-03-15',
      source: 'neon',
      merchant: 'Insurance Company Co',
      originalAmount: 1200,
      originalCurrency: 'CHF',
      chfAmount: 1200,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);

    applyFixedBills(db, '2024-03');

    const covered = db.getTransaction('bank1');
    assert.ok(covered);
    assert.strictEqual(covered.coveredByFixedBill, 'Test annual insurance');
    assert.strictEqual(covered.fixedChanged, false);

    const synthetic = db.getTransactionsByMonth('2024-03').find(t => 
      t.source === 'fixed' && t.merchant === 'Test annual insurance'
    );
    assert.ok(synthetic);
    assert.strictEqual(synthetic.chfAmount, 100);
    assert.strictEqual(synthetic.fixedMissing, false);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills respects activeFrom constraint', () => {
  const dbPath = './test-fixed-active-from.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-05');
    const mayTransactions = db.getTransactionsByMonth('2024-05').filter(t => t.source === 'fixed');
    const mayGym = mayTransactions.find(t => t.merchant === 'Test bill with activeFrom');
    assert.strictEqual(mayGym, undefined);

    applyFixedBills(db, '2024-06');
    const juneTransactions = db.getTransactionsByMonth('2024-06').filter(t => t.source === 'fixed');
    const juneGym = juneTransactions.find(t => t.merchant === 'Test bill with activeFrom');
    assert.ok(juneGym);
    assert.strictEqual(juneGym.chfAmount, 75);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills respects activeUntil constraint', () => {
  const dbPath = './test-fixed-active-until.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    applyFixedBills(db, '2024-05');
    const mayTransactions = db.getTransactionsByMonth('2024-05').filter(t => t.source === 'fixed');
    const mayParking = mayTransactions.find(t => t.merchant === 'Test bill with activeUntil');
    assert.ok(mayParking);

    applyFixedBills(db, '2024-06');
    const juneTransactions = db.getTransactionsByMonth('2024-06').filter(t => t.source === 'fixed');
    const juneParking = juneTransactions.find(t => t.merchant === 'Test bill with activeUntil');
    assert.strictEqual(juneParking, undefined);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('applyFixedBills does not affect existing transactions without patterns', () => {
  const dbPath = './test-fixed-no-affect.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Random Store',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);

    applyFixedBills(db, '2024-10');

    const unchanged = db.getTransaction('bank1');
    assert.ok(unchanged);
    assert.strictEqual(unchanged.coveredByFixedBill, null);
    assert.strictEqual(unchanged.merchant, 'Random Store');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('month total excludes covered bank charges to prevent double-counting', () => {
  const dbPath = './test-fixed-month-total.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const rentCharge: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 1000,
      originalCurrency: 'CHF',
      chfAmount: 1000,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    const groceries: Transaction = {
      id: 'bank2',
      date: '2024-10-10',
      source: 'neon',
      merchant: 'Grocery Store',
      originalAmount: 150,
      originalCurrency: 'CHF',
      chfAmount: 150,
      fileRowIndex: 2,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(rentCharge);
    db.insertTransaction(groceries);

    applyFixedBills(db, '2024-10');

    const total = db.getMonthTotal('2024-10');

    const allTx = db.getTransactionsByMonth('2024-10');
    const rentFixed = allTx.find(t => t.source === 'fixed' && t.merchant === 'Test monthly rent');
    const rentBank = allTx.find(t => t.id === 'bank1');
    const groceriesTx = allTx.find(t => t.id === 'bank2');

    assert.ok(rentFixed, 'Fixed rent transaction should exist');
    assert.ok(rentBank, 'Bank rent charge should exist');
    assert.ok(groceriesTx, 'Groceries transaction should exist');

    assert.strictEqual(rentBank.coveredByFixedBill, 'Test monthly rent', 'Rent charge should be marked as covered');

    const allFixed = allTx.filter(t => t.source === 'fixed');
    const totalFixed = allFixed.reduce((sum, t) => sum + t.chfAmount, 0);
    
    const expectedTotal = totalFixed + groceriesTx.chfAmount;

    assert.strictEqual(total, expectedTotal, 
      `Total should be ${expectedTotal} (fixed bills ${totalFixed} + groceries ${groceriesTx.chfAmount}), excluding covered bank charge ${rentBank.chfAmount}`);

    const totalWithoutExclusion = totalFixed + rentBank.chfAmount + groceriesTx.chfAmount;
    assert.notStrictEqual(total, totalWithoutExclusion, 
      `Total should NOT be ${totalWithoutExclusion} (would include double-counted rent charge)`);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});
