import { test } from 'node:test';
import assert from 'node:assert';
import { applyFixedBills } from './fixed.js';
import { DB } from './db.js';
import { Transaction } from './types.js';
import { unlinkSync } from 'fs';

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

test('applyFixedBills does not cover a pattern match whose amount is far from the bill', () => {
  const dbPath = './test-fixed-amount-mismatch.sqlite';
  const db = new DB(dbPath);

  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  process.env.FIXED_BILLS_CONFIG = './dist/test-fixtures/test-fixed-bills.json';

  try {
    const bankTx: Transaction = {
      id: 'bank1',
      date: '2024-10-05',
      source: 'neon',
      merchant: 'Landlord Inc',
      originalAmount: 26.95,
      originalCurrency: 'CHF',
      chfAmount: 26.95,
      fileRowIndex: 1,
      importedAt: new Date().toISOString()
    };

    db.insertTransaction(bankTx);
    applyFixedBills(db, '2024-10');

    const leftover = db.getTransaction('bank1');
    assert.ok(leftover);
    assert.strictEqual(leftover.coveredByFixedBill, null, 'Off-amount charge must stay a normal expense');

    const allFixed = db.getTransactionsByMonth('2024-10').filter(t => t.source === 'fixed');
    const totalFixed = allFixed.reduce((sum, t) => sum + t.chfAmount, 0);
    assert.strictEqual(db.getMonthTotal('2024-10'), totalFixed + 26.95);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
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
