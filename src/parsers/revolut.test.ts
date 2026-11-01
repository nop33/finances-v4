import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRevolutCsv } from './revolut.js';

describe('Revolut parser', () => {
  it('should parse Revolut CSV correctly', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
CARD_PAYMENT,Current,2024-10-16 14:20:00,2024-10-16 14:20:10,AMAZON,-35.00,0,EUR,COMPLETED,950.00
TRANSFER,Current,2024-10-17 09:00:00,2024-10-17 09:00:15,Salary,5000.00,0,CHF,COMPLETED,5950.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].date, '2024-10-15');
    assert.strictEqual(transactions[0].merchant, 'MIGROS');
    assert.strictEqual(transactions[0].originalAmount, 42.50);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'revolut');

    assert.strictEqual(transactions[1].originalCurrency, 'EUR');
  });

  it('should only include COMPLETED transactions', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
CARD_PAYMENT,Current,2024-10-16 14:20:00,,PENDING SHOP,-35.00,0,EUR,PENDING,950.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 1);
  });
});
