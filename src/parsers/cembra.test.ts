import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseCembra } from './cembra.js';

describe('Cembra parser', () => {
  it('should parse Cembra CSV correctly', () => {
    const csv = `Account number,Credit Card,Booking date,Merchant,Description,Type,Amount (CHF)
1234567890,1111,15-10-2024,MIGROS,Groceries purchase,Debit,45.50
1234567890,2222,15-10-2024,COOP,Shopping,Debit,32.10
1234567890,1111,15-10-2024,MIGROS,Groceries purchase,Debit,45.50`;

    const transactions = parseCembra(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].date, '2024-10-15');
    assert.strictEqual(transactions[0].merchant, 'MIGROS');
    assert.strictEqual(transactions[0].originalAmount, 45.50);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'cembra');
    assert.strictEqual(transactions[0].sourceCard, '1111');

    assert.strictEqual(transactions[2].sourceCard, '1111');
  });

  it('should handle same-day duplicates with unique IDs', () => {
    const csv = `Account number,Credit Card,Booking date,Merchant,Description,Type,Amount (CHF)
1234567890,1111,15-10-2024,MIGROS,Purchase,Debit,45.50
1234567890,1111,15-10-2024,MIGROS,Purchase,Debit,45.50`;

    const transactions = parseCembra(csv);

    assert.strictEqual(transactions.length, 2);
    assert.notStrictEqual(transactions[0], transactions[1]);
  });
});
