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
});
