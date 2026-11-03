import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRevolutCsv } from './revolut.js';

describe('Revolut parser', () => {
  it('should parse Revolut CSV correctly', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
Card Payment,Current,2024-10-16 14:20:00,2024-10-16 14:20:10,AMAZON,-35.00,0,EUR,COMPLETED,950.00
Transfer,Current,2024-10-17 09:00:00,2024-10-17 09:00:15,Salary,5000.00,0,CHF,COMPLETED,5950.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].date, '2024-10-15');
    assert.strictEqual(transactions[0].merchant, 'MIGROS');
    assert.strictEqual(transactions[0].originalAmount, 42.50);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'revolut');
    assert.strictEqual(transactions[0].kind, 'expense');

    assert.strictEqual(transactions[1].originalCurrency, 'EUR');
    assert.strictEqual(transactions[2].kind, 'transfer');
  });

  it('should only include COMPLETED transactions', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
Card Payment,Current,2024-10-16 14:20:00,,PENDING SHOP,-35.00,0,EUR,PENDING,950.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 1);
  });

  it('imports a fee as its own row instead of folding it into the charge', () => {
    const prev = process.env.REVOLUT_FEE_CATEGORY;
    process.env.REVOLUT_FEE_CATEGORY = 'Tech/Phone';
    try {
      const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-18.40,0.60,CHF,COMPLETED,1000.00
Card Payment,Current,2024-10-16 10:30:00,2024-10-16 10:30:05,COOP,-42.50,1.50,CHF,COMPLETED,950.00`;

      const transactions = parseRevolutCsv(csv);

      assert.strictEqual(transactions.length, 4);
      assert.strictEqual(transactions[0].merchant, 'MIGROS');
      assert.strictEqual(transactions[0].originalAmount, 18.40);
      assert.strictEqual(transactions[1].merchant, 'MIGROS fee');
      assert.strictEqual(transactions[1].originalAmount, 0.60);
      assert.strictEqual(transactions[1].description, 'Fee');
      assert.strictEqual(transactions[1].category, 'Tech/Phone');
      assert.strictEqual(transactions[2].originalAmount, 42.50);
      assert.strictEqual(transactions[3].originalAmount, 1.50);
    } finally {
      if (prev === undefined) delete process.env.REVOLUT_FEE_CATEGORY;
      else process.env.REVOLUT_FEE_CATEGORY = prev;
    }
  });

  it('keeps Card Refund as a negative expense', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,MIGROS,-42.50,0,CHF,COMPLETED,1000.00
Card Refund,Current,2024-10-17 11:00:00,2024-10-17 11:00:05,MIGROS Refund,20.00,0,CHF,COMPLETED,5970.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].originalAmount, 42.50);
    assert.strictEqual(transactions[0].kind, 'expense');
    assert.strictEqual(transactions[1].originalAmount, -20.00);
    assert.strictEqual(transactions[1].kind, 'expense');
  });

  it('classifies Topup, Transfer, and Exchange regardless of case', () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Topup,Current,2024-10-15 09:00:00,2024-10-15 09:00:05,Top-up from debit card,100.00,0,CHF,COMPLETED,1100.00
TRANSFER,Current,2024-10-16 09:00:00,2024-10-16 09:00:15,To savings space,-50.00,0,CHF,COMPLETED,1050.00
exchange,Current,2024-10-17 09:00:00,2024-10-17 09:00:15,Exchanged to EUR,-100.00,2.00,EUR,COMPLETED,950.00
Card Payment,Current,2024-10-18 10:30:00,2024-10-18 10:30:05,MIGROS,-10.00,0,CHF,COMPLETED,940.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 5);
    assert.strictEqual(transactions[0].kind, 'top-up');
    assert.strictEqual(transactions[1].kind, 'transfer');
    assert.strictEqual(transactions[2].kind, 'exchange');
    assert.strictEqual(transactions[2].originalAmount, 100);
    assert.strictEqual(transactions[3].merchant, 'Exchanged to EUR fee');
    assert.strictEqual(transactions[3].originalAmount, 2);
    assert.strictEqual(transactions[4].kind, 'expense');
  });

  it('should repair double-encoded UTF-8 (mojibake)', () => {
    const bakerei = Buffer.from('Bäckerei Zürich', 'utf8').toString('latin1');
    const greek = Buffer.from('Ταβέρνα', 'utf8').toString('latin1');
    const dashed = Buffer.from('Shop – Zurich', 'utf8').toString('latin1');
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-10-15 10:30:00,2024-10-15 10:30:05,${bakerei},-25.00,0,CHF,COMPLETED,1000.00
Card Payment,Current,2024-10-16 10:30:00,2024-10-16 10:30:05,${greek},-18.00,0,CHF,COMPLETED,982.00
Card Payment,Current,2024-10-17 10:30:00,2024-10-17 10:30:05,${dashed},-12.00,0,CHF,COMPLETED,970.00`;

    const transactions = parseRevolutCsv(csv);

    assert.strictEqual(transactions.length, 3);
    assert.strictEqual(transactions[0].merchant, 'Bäckerei Zürich');
    assert.strictEqual(transactions[1].merchant, 'Ταβέρνα');
    assert.strictEqual(transactions[2].merchant, 'Shop – Zurich');
  });
});
