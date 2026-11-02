import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'fs';
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

  it('should handle income with negative amounts', () => {
    const csv = `"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description";"Subject";"Category"
2024-10-15;-45.50;-45.50;CHF;1.00;MIGROS;Groceries;Food
2024-10-16;500.00;500.00;CHF;1.00;Salary;Monthly salary;Income`;

    const transactions = parseNeon(csv);

    assert.strictEqual(transactions.length, 2);
    assert.strictEqual(transactions[0].originalAmount, 45.50, 'Spending should be positive');
    assert.strictEqual(transactions[1].originalAmount, -500.00, 'Income should be negative');
  });

  it('marks configured merchants as transfers', () => {
    const path = './test-neon-transfer-rules.json';
    writeFileSync(path, JSON.stringify([
      { pattern: 'own-savings-pocket', kind: 'transfer' },
      { pattern: 'demo-broker', kind: 'transfer' },
      { pattern: 'card-bill-pay', kind: 'transfer' }
    ]));
    const prev = process.env.EXCLUDE_RULES_CONFIG;
    process.env.EXCLUDE_RULES_CONFIG = path;
    try {
      const csv = `"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description";"Subject";"Category"
2024-11-01;-40.00;-40.00;CHF;1.00;COOP;Groceries;Food
2024-11-02;-100.00;-100.00;CHF;1.00;Own-Savings-Pocket;Move to savings;
2024-11-03;-250.00;-250.00;CHF;1.00;Demo-Broker;Broker top-up;
2024-11-04;-80.00;-80.00;CHF;1.00;Card-Bill-Pay;Swisscard bill;`;

      const transactions = parseNeon(csv);
      assert.strictEqual(transactions[0].kind, 'expense');
      assert.strictEqual(transactions[1].kind, 'transfer');
      assert.strictEqual(transactions[2].kind, 'transfer');
      assert.strictEqual(transactions[3].kind, 'transfer');
    } finally {
      if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
      else process.env.EXCLUDE_RULES_CONFIG = prev;
      unlinkSync(path);
    }
  });
});
