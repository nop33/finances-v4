import { describe, it } from 'node:test';
import assert from 'node:assert';
import { unlinkSync } from 'fs';
import { parseSwisscard } from './swisscard.js';
import { importTransactions } from '../import.js';
import { DB } from '../db.js';

describe('Swisscard parser', () => {
  it('should parse Swisscard CSV correctly', () => {
    const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.10.2024,Purchase,MIGROS ZURICH,5555,CHF,42.30,Debit,Posted,Groceries,
02.10.2024,Restaurant,TIBITS,5555,CHF,28.50,Debit,Posted,Food,
03.10.2024,Hotel,HOTEL PARIS,6666,EUR,150.00,Debit,Posted,Travel,`;

    const transactions = parseSwisscard(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].date, '2024-10-01');
    assert.strictEqual(transactions[0].merchant, 'MIGROS ZURICH');
    assert.strictEqual(transactions[0].originalAmount, 42.30);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'swisscard');
    assert.strictEqual(transactions[0].sourceCard, '5555');

    assert.strictEqual(transactions[2].originalCurrency, 'EUR');
    assert.strictEqual(transactions[2].originalAmount, 150.00);
  });

  it('should handle credit transactions with negative amounts', () => {
    const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.10.2024,Purchase,MIGROS,5555,CHF,42.30,Debit,Posted,Groceries,
02.10.2024,Refund,MIGROS,5555,CHF,15.00,Credit,Posted,Groceries,`;

    const transactions = parseSwisscard(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].originalAmount, 42.30, 'Debit should be positive');
    assert.strictEqual(transactions[1].originalAmount, -15.00, 'Credit should be negative');
  });

  it('keeps already-signed Credit amounts negative', () => {
    const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.10.2024,Purchase,MIGROS,5555,CHF,100.00,Debit,Posted,Groceries,
02.10.2024,Refund,MIGROS,5555,CHF,-50.00,Credit,Posted,Groceries,`;

    const transactions = parseSwisscard(csv);

    assert.strictEqual(transactions[0].originalAmount, 100);
    assert.strictEqual(transactions[1].originalAmount, -50);
  });

  it('debit 100 plus credit 50 totals 50 for the month', async () => {
    const dbPath = './test-swisscard-credit-total.sqlite';
    const db = new DB(dbPath);
    try {
      const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.12.2024,Purchase,COOP,5555,CHF,100.00,Debit,Posted,Groceries,
02.12.2024,Refund,COOP,5555,CHF,-50.00,Credit,Posted,Groceries,`;

      await importTransactions(db, parseSwisscard(csv));
      assert.strictEqual(db.getMonthTotal('2024-12'), 50);
    } finally {
      db.close();
      unlinkSync(dbPath);
    }
  });

  it('should filter out pending transactions', () => {
    const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.10.2024,Purchase,MIGROS,5555,CHF,42.30,Debit,Posted,Groceries,
02.10.2024,Online order,AMAZON,5555,CHF,89.50,Debit,Pending,Shopping,
03.10.2024,Restaurant,TIBITS,5555,CHF,28.50,Debit,Posted,Food,`;

    const transactions = parseSwisscard(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].merchant, 'MIGROS');
    assert.strictEqual(transactions[1].merchant, 'TIBITS');
  });

  it('should repair double-encoded UTF-8 (mojibake)', () => {
    // Simulate double-encoded UTF-8: 'ü' becomes 'Ã¼'
    const csv = `Transaction date,Description,Merchant,Card number,Currency,Amount,Debit/Credit,Status,Merchant Category,Registered Category
01.10.2024,Groceries,BÃ¤ckerei ZÃ¼rich,5555,CHF,42.30,Debit,Posted,Food,`;

    const transactions = parseSwisscard(csv);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].merchant, 'Bäckerei Zürich', 'German umlauts should be repaired');
  });
});
