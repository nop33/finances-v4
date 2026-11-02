import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { importTransactions } from './import.js';
import { ParsedTransaction } from './types.js';
import { unlinkSync } from 'fs';

describe('Import module', () => {
  const testDbPath = './test-import.sqlite';
  let db: DB;

  before(() => {
    db = new DB(testDbPath);
  });

  after(() => {
    db.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });

  it('should generate unique IDs for same-day duplicates', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-15',
        merchant: 'MIGROS',
        originalAmount: 45.50,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 0,
      },
      {
        date: '2024-10-15',
        merchant: 'MIGROS',
        originalAmount: 45.50,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 1,
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    assert.strictEqual(transactions.length, 2);
    assert.notStrictEqual(transactions[0].id, transactions[1].id);
  });

  it('should be idempotent on re-import', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-16',
        merchant: 'COOP',
        originalAmount: 32.10,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 0,
      },
    ];

    await importTransactions(db, parsed);
    const firstImport = db.getTransactionsByMonth('2024-10');
    const initialCount = firstImport.length;

    await importTransactions(db, parsed);
    const secondImport = db.getTransactionsByMonth('2024-10');

    assert.strictEqual(secondImport.length, initialCount);
  });

  it('should preserve FX conversion metadata', async () => {
    db.saveFxRate({
      date: '2024-10-17',
      currency: 'EUR',
      rateFromCHF: 0.95,
      fetchedAt: new Date().toISOString(),
    });

    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-17',
        merchant: 'AMAZON',
        originalAmount: 95,
        originalCurrency: 'EUR',
        source: 'swisscard',
        fileRowIndex: 0,
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    const tx = transactions.find(t => t.merchant === 'AMAZON');

    assert.ok(tx);
    assert.strictEqual(tx.originalAmount, 95);
    assert.strictEqual(tx.originalCurrency, 'EUR');
    assert.strictEqual(tx.chfAmount, 100);
    assert.strictEqual(tx.fxRate, 0.95);
  });

  it('should exclude transfers, income, and top-ups by kind', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-18',
        merchant: 'MIGROS',
        originalAmount: 50,
        originalCurrency: 'CHF',
        source: 'revolut',
        fileRowIndex: 0,
        kind: 'expense',
      },
      {
        date: '2024-10-18',
        merchant: 'Salary',
        originalAmount: -5000,
        originalCurrency: 'CHF',
        source: 'revolut',
        fileRowIndex: 1,
        kind: 'income',
      },
      {
        date: '2024-10-18',
        merchant: 'Bank transfer',
        originalAmount: 100,
        originalCurrency: 'CHF',
        source: 'neon',
        fileRowIndex: 2,
        kind: 'transfer',
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    const expense = transactions.find(t => t.merchant === 'MIGROS' && t.date === '2024-10-18');
    const income = transactions.find(t => t.merchant === 'Salary');
    const transfer = transactions.find(t => t.merchant === 'Bank transfer');

    assert.ok(expense);
    assert.strictEqual(expense.excluded, false);
    
    assert.ok(income);
    assert.strictEqual(income.excluded, true);
    
    assert.ok(transfer);
    assert.strictEqual(transfer.excluded, true);
  });
});
