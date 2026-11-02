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

  it('should handle income and refunds with negative amounts', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
TRANSFER,Current,2024-10-16 09:00:00,2024-10-16 09:00:15,Salary,5000.00,0,CHF,COMPLETED,5950.00
CARD_REFUND,Current,2024-10-17 11:00:00,2024-10-17 11:00:05,MIGROS Refund,20.00,0,CHF,COMPLETED,5970.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].originalAmount, 42.50, 'Spending should be positive');
    assert.strictEqual(transactions[1].originalAmount, -5000.00, 'Income should be negative');
    assert.strictEqual(transactions[2].originalAmount, -20.00, 'Refund should be negative');
  });

  it('should add fee to transaction amount', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,-1.50,CHF,COMPLETED,1000.00
EXCHANGE,Current,2024-10-16 09:00:00,2024-10-16 09:00:15,EUR Exchange,-100.00,-2.00,EUR,COMPLETED,950.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].originalAmount, 44.00, 'Amount should include fee (42.50 + 1.50)');
    assert.strictEqual(transactions[1].originalAmount, 102.00, 'Exchange amount should include fee (100.00 + 2.00)');
  });

  it('should repair double-encoded UTF-8 (mojibake)', () => {
    // Simulate double-encoded UTF-8: 'ü' becomes 'Ã¼', 'ä' becomes 'Ã¤'
    // Create mojibaked strings by encoding the correct UTF-8 bytes as Latin-1
    const bakerei = Buffer.from('Bäckerei Zürich', 'utf8').toString('latin1');
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,${bakerei},-25.00,0,CHF,COMPLETED,1000.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].merchant, 'Bäckerei Zürich', 'German umlauts should be repaired');
  });
});
