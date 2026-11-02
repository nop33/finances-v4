import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { parseSbb } from './sbb.js';
import { DB } from '../db.js';
import { importTransactions } from '../import.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SBB parser', () => {
  it('should parse plural journeys receipt with Total', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
...
Order number 100000000001

Payment charge
Reference number 250204000000000001

Payment method
Half Fare Travelcard PLUS

Date
04.02.2025

Amount
CHF 7.40

Your journeys on 03.02.2025
Journey from Bern, Bahnhof
To Bern, Zytglogge
Class 2nd class
...
Tickets charged
...
Item

ZVV Day Pass (calendar day)
1-2 Zones, null
Reference no. 1000000001
...
Total
CHF 7.40`;

    const transactions = parseSbb(receipt);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].date, '2025-02-03');
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide - ZVV Day Pass (calendar day)');
    assert.strictEqual(transactions[0].description, 'Half Fare Travelcard PLUS');
    assert.strictEqual(transactions[0].originalAmount, 7.40);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'sbb');
    assert.strictEqual(transactions[0].kind, 'expense');
    assert.ok(transactions[0].id, 'Should have an ID');
  });

  it('should parse singular journey receipt', () => {
    const receipt = `+++ EasyRide purchase receipt – your journey on 15.03.2025
...
Order number 100000000002

Payment method
Half Fare Travelcard PLUS

Amount
CHF 12.60

Your journey on 15.03.2025
Journey from Zürich HB
To Zürich Oerlikon
Class 2nd class
...
Total
CHF 12.60`;

    const transactions = parseSbb(receipt);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].date, '2025-03-15');
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide');
    assert.strictEqual(transactions[0].originalAmount, 12.60);
  });

  it('should fall back to Amount when Total is missing', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
...
Order number 100000000003

Payment method
Half Fare Travelcard PLUS

Amount
CHF 9.50

Your journeys on 03.02.2025
Journey from Bern, Bahnhof
To Bern, Zytglogge`;

    const transactions = parseSbb(receipt);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].originalAmount, 9.50);
  });

  it('should throw error when order number is missing', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40`;

    assert.throws(() => parseSbb(receipt), /Missing required fields/);
  });

  it('should throw error when amount is missing', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025

Order number 100000000001

Payment method
Half Fare Travelcard PLUS`;

    assert.throws(() => parseSbb(receipt), /Missing required fields/);
  });

  it('should throw error when travel date is missing', () => {
    const receipt = `Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40`;

    assert.throws(() => parseSbb(receipt), /Missing travel date/);
  });

  it('should parse German receipt with Bestellnummer and Betrag', () => {
    const receipt = `+++ EasyRide Kaufbeleg – Ihre Fahrten am 03.02.2025
...
Bestellnummer 100000000004

Zahlungsart
Halbtax-Abo PLUS

Betrag
CHF 15.20

Ihre Fahrten am 03.02.2025
Fahrt von Zürich HB
Nach Bern
Klasse 2. Klasse
...
Total
CHF 15.20`;

    const transactions = parseSbb(receipt);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].date, '2025-02-03');
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide');
    assert.strictEqual(transactions[0].description, 'Halbtax-Abo PLUS');
    assert.strictEqual(transactions[0].originalAmount, 15.20);
  });

  it('should handle CRLF line endings', () => {
    const receipt = [
      '+++ EasyRide purchase receipt – your journeys on 03.02.2025',
      '...',
      'Order number 100000000005',
      '',
      'Amount',
      'CHF 7.40',
    ].join('\r\n');

    const transactions = parseSbb(receipt);

    assert.strictEqual(transactions.length, 1);
    assert.strictEqual(transactions[0].originalAmount, 7.40);
  });

  it('should generate same merchant for same item, different IDs for different orders', () => {
    const receipt1 = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)`;

    const receipt2 = `+++ EasyRide purchase receipt – your journeys on 04.02.2025
Order number 100000000002

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)`;

    const tx1 = parseSbb(receipt1);
    const tx2 = parseSbb(receipt2);

    // Same item = same merchant name (for merchant memory)
    assert.strictEqual(tx1[0].merchant, tx2[0].merchant);
    assert.strictEqual(tx1[0].merchant, 'SBB EasyRide - ZVV Day Pass (calendar day)');

    // Different order numbers = different IDs (no duplicates)
    assert.notStrictEqual(tx1[0].id, tx2[0].id);
  });

  it('should generate stable ID for idempotent re-import', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)`;

    // Parse twice
    const tx1 = parseSbb(receipt);
    const tx2 = parseSbb(receipt);

    // Should generate identical IDs (for upsert behavior)
    assert.strictEqual(tx1[0].id, tx2[0].id);
    
    // All fields should be identical
    assert.strictEqual(tx1[0].merchant, tx2[0].merchant);
    assert.strictEqual(tx1[0].date, tx2[0].date);
    assert.strictEqual(tx1[0].originalAmount, tx2[0].originalAmount);
  });

  it('should update on re-import, not duplicate', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sbb-test-'));
    const dbPath = join(tempDir, 'test.db');
    const db = new DB(dbPath);

    try {
      const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)`;

      const parsed = parseSbb(receipt);
      
      // First import
      const first = await importTransactions(db, parsed);
      assert.deepStrictEqual(first, { new: 1, unchanged: 0 });
      let allTxs = db.getTransactionsByMonth('2025-02');
      assert.strictEqual(allTxs.length, 1);
      const firstId = allTxs[0].id;

      // Re-import same receipt
      const second = await importTransactions(db, parsed);
      assert.deepStrictEqual(second, { new: 0, unchanged: 1 });
      allTxs = db.getTransactionsByMonth('2025-02');
      
      // Should still be 1 transaction (updated, not duplicated)
      assert.strictEqual(allTxs.length, 1);
      assert.strictEqual(allTxs[0].id, firstId);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true });
    }
  });

  it('CLI reports 0 new, 1 unchanged when the same receipt is imported twice', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'sbb-cli-'));
    const receiptPath = join(tempDir, 'receipt.txt');
    const dbPath = join(tempDir, 'finances.sqlite');
    writeFileSync(receiptPath, `+++ EasyRide purchase receipt – your journeys on 03.02.2025
Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)
Total
CHF 7.40`);

    const run = () => spawnSync(
      process.execPath,
      ['dist/cli.js', 'sbb', 'import', receiptPath],
      { encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath } }
    );

    try {
      const first = run();
      assert.strictEqual(first.status, 0, first.stderr);
      assert.match(first.stdout, /1 new, 0 unchanged/);

      const second = run();
      assert.strictEqual(second.status, 0, second.stderr);
      assert.match(second.stdout, /0 new, 1 unchanged/);
      assert.doesNotMatch(second.stdout, /1 imported/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });
});
