import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseNeon } from './neon.js';

describe('Neon parser', () => {
  it('should parse Neon CSV correctly', () => {
    const csv = `"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description";"Subject";"Category"
2024-10-15;-45.50;-45.50;CHF;1.00;MIGROS;Groceries;Food
2024-10-16;-32.10;-28.50;EUR;1.127;AMAZON;Online purchase;Shopping`;

    const transactions = parseNeon(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].date, '2024-10-15');
    assert.strictEqual(transactions[0].merchant, 'MIGROS');
    assert.strictEqual(transactions[0].originalAmount, 45.50);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'neon');
  });

  it('should keep currency as CHF even when Original currency is present', () => {
    const csv = `"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description";"Subject";"Category"
2024-10-16;-32.10;-28.50;EUR;1.127;AMAZON;Online purchase;Shopping`;

    const transactions = parseNeon(csv);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].originalAmount, 32.10);
  });
});
