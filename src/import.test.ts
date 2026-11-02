import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { importTransactions } from './import.js';
import { ParsedTransaction } from './types.js';
import { parseRevolutCsv } from './parsers/revolut.js';
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

  it('excludes Revolut Topup/Transfer/Exchange but keeps Card Refund as expense', async () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-11-01 10:30:00,2024-11-01 10:30:05,COOP,-12.00,0,CHF,COMPLETED,1000.00
Card Refund,Current,2024-11-02 11:00:00,2024-11-02 11:00:05,COOP Refund,5.00,0,CHF,COMPLETED,1005.00
Topup,Current,2024-11-03 09:00:00,2024-11-03 09:00:05,Top-up from debit card,80.00,0,CHF,COMPLETED,1085.00
Transfer,Current,2024-11-04 09:00:00,2024-11-04 09:00:15,To savings space,-40.00,0,CHF,COMPLETED,1045.00
Exchange,Current,2024-11-05 09:00:00,2024-11-05 09:00:15,Exchanged to EUR,-20.00,0.50,EUR,COMPLETED,1025.00`;

    await importTransactions(db, parseRevolutCsv(csv));

    const txs = db.getTransactionsByMonth('2024-11');
    const payment = txs.find(t => t.merchant === 'COOP');
    const refund = txs.find(t => t.merchant === 'COOP Refund');
    const topup = txs.find(t => t.kind === 'top-up');
    const transfer = txs.find(t => t.kind === 'transfer');
    const exchange = txs.find(t => t.kind === 'exchange');

    assert.strictEqual(payment?.excluded, false);
    assert.strictEqual(payment?.chfAmount, 12.00);

    assert.strictEqual(refund?.excluded, false);
    assert.strictEqual(refund?.kind, 'expense');
    assert.strictEqual(refund?.chfAmount, -5.00);

    assert.strictEqual(topup?.excluded, true);
    assert.strictEqual(transfer?.excluded, true);
    assert.strictEqual(exchange?.excluded, true);
  });
});
