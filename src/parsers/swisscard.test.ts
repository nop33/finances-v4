import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSwisscard } from './swisscard.js';

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
});
