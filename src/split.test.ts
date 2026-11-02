import { test } from 'node:test';
import assert from 'node:assert';
import { unlinkSync } from 'fs';
import { DB } from './db.js';
import { Transaction } from './types.js';
import { parseSplitParts, splitTransaction, getCategoryTotals } from './split.js';
import { parseRevolutCsv } from './parsers/revolut.js';
import { importTransactions } from './import.js';

function insertTx(db: DB, tx: Partial<Transaction> & { id: string; chfAmount: number }): void {
  db.insertTransaction({
    date: '2024-10-15',
    source: 'test',
    merchant: 'Shop',
    originalAmount: tx.chfAmount,
    originalCurrency: 'CHF',
    fileRowIndex: 0,
    importedAt: new Date().toISOString(),
    ...tx
  });
}

test('parseSplitParts reads category=amount pairs', () => {
  const parts = parseSplitParts(['Shopping=25.50', 'General gifts=25.50']);
  assert.deepStrictEqual(parts, [
    { category: 'Shopping', chfAmount: 25.50 },
    { category: 'General gifts', chfAmount: 25.50 }
  ]);
});

test('parseSplitParts rejects malformed parts', () => {
  assert.throws(() => parseSplitParts(['Shopping']), /Expected category=amount/);
  assert.throws(() => parseSplitParts(['=10']), /Expected category=amount/);
  assert.throws(() => parseSplitParts(['Shopping=nope']), /Invalid amount/);
});

test('split rejects parts that do not sum to the original amount', () => {
  const dbPath = './test-split-sum.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 51 });
    assert.throws(
      () => splitTransaction(db, 'tx1', [
        { category: 'Shopping', chfAmount: 20 },
        { category: 'General gifts', chfAmount: 20 }
      ]),
      /must sum to transaction amount/
    );
    assert.strictEqual(db.getSplits('tx1').length, 0);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('split stores parts that sum exactly to the original amount', () => {
  const dbPath = './test-split-ok.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 51, category: 'Shopping' });
    splitTransaction(db, 'tx1', [
      { category: 'Shopping', chfAmount: 25.50 },
      { category: 'General gifts', chfAmount: 25.50 }
    ]);

    const tx = db.getTransaction('tx1');
    assert.strictEqual(tx?.chfAmount, 51);
    assert.strictEqual(tx?.splits?.length, 2);
    assert.strictEqual(tx?.splits?.[0].category, 'Shopping');
    assert.strictEqual(tx?.splits?.[0].chfAmount, 25.50);
    assert.strictEqual(tx?.splits?.[1].category, 'General gifts');
    assert.strictEqual(tx?.splits?.[1].chfAmount, 25.50);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('category totals use split parts instead of the parent category', () => {
  const dbPath = './test-split-totals.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 51, category: 'Shopping', merchant: 'Department Store' });
    insertTx(db, {
      id: 'tx2',
      chfAmount: 10,
      category: 'Meals/Snacks',
      merchant: 'Cafe',
      date: '2024-10-16',
      fileRowIndex: 1
    });

    splitTransaction(db, 'tx1', [
      { category: 'Shopping', chfAmount: 30 },
      { category: 'General gifts', chfAmount: 21 }
    ]);

    const totals = getCategoryTotals(db, '2024-10');
    assert.strictEqual(totals['Shopping'], 30);
    assert.strictEqual(totals['General gifts'], 21);
    assert.strictEqual(totals['Meals/Snacks'], 10);
    assert.strictEqual(db.getMonthTotal('2024-10'), 61);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('month list keeps the original row and shows its parts', () => {
  const dbPath = './test-split-list.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 40, merchant: 'Department Store' });
    splitTransaction(db, 'tx1', [
      { category: 'Shopping', chfAmount: 15 },
      { category: 'General gifts', chfAmount: 25 }
    ]);

    const list = db.getTransactionsByMonth('2024-10');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'tx1');
    assert.strictEqual(list[0].merchant, 'Department Store');
    assert.strictEqual(list[0].chfAmount, 40);
    assert.deepStrictEqual(list[0].splits, [
      { category: 'Shopping', chfAmount: 15 },
      { category: 'General gifts', chfAmount: 25 }
    ]);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('category totals skip excluded Revolut top-ups and transfers and still match the grand total after a split', async () => {
  const dbPath = './test-split-exclude-totals.sqlite';
  const db = new DB(dbPath);
  try {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-11-01 10:30:00,2024-11-01 10:30:05,COOP,-40.00,0,CHF,COMPLETED,1000.00
Card Payment,Current,2024-11-02 10:30:00,2024-11-02 10:30:05,MIGROS,-20.00,0,CHF,COMPLETED,980.00
Topup,Current,2024-11-03 09:00:00,2024-11-03 09:00:05,Top-up from debit card,200.00,0,CHF,COMPLETED,1180.00
Transfer,Current,2024-11-04 09:00:00,2024-11-04 09:00:15,To savings space,-50.00,0,CHF,COMPLETED,1130.00`;

    await importTransactions(db, parseRevolutCsv(csv));

    const coop = db.getTransactionsByMonth('2024-11').find(t => t.merchant === 'COOP');
    assert.ok(coop);
    splitTransaction(db, coop.id, [
      { category: 'Shopping', chfAmount: 25 },
      { category: 'General gifts', chfAmount: 15 }
    ]);

    const grand = db.getMonthTotal('2024-11');
    const totals = getCategoryTotals(db, '2024-11');
    const categorySum = Object.values(totals).reduce((sum, n) => sum + n, 0);

    assert.strictEqual(grand, 60);
    assert.strictEqual(Math.round(categorySum * 100), Math.round(grand * 100));
    assert.strictEqual(totals['Shopping'], 25);
    assert.strictEqual(totals['General gifts'], 15);
    assert.strictEqual(totals['(uncategorised)'], 20);
    assert.ok(!Object.values(totals).includes(-200), 'Topup must not appear in category totals');
    assert.ok(!Object.values(totals).includes(50), 'Transfer must not appear in category totals');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});
