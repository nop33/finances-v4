import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSbb } from './sbb.js';

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
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide - ZVV Day Pass (calendar day) [100000000001]');
    assert.strictEqual(transactions[0].description, 'Half Fare Travelcard PLUS');
    assert.strictEqual(transactions[0].originalAmount, 7.40);
    assert.strictEqual(transactions[0].originalCurrency, 'CHF');
    assert.strictEqual(transactions[0].source, 'sbb');
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
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide [100000000002]');
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
    assert.strictEqual(transactions[0].merchant, 'SBB EasyRide [100000000004]');
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

  it('should generate stable merchant name for idempotent import', () => {
    const receipt = `+++ EasyRide purchase receipt – your journeys on 03.02.2025
...
Order number 100000000001

Payment method
Half Fare Travelcard PLUS

Amount
CHF 7.40

Item

ZVV Day Pass (calendar day)`;

    // Parse twice
    const transactions1 = parseSbb(receipt);
    const transactions2 = parseSbb(receipt);

    // Should generate identical merchant names (which will result in same ID)
    assert.strictEqual(transactions1[0].merchant, transactions2[0].merchant);
    assert.strictEqual(transactions1[0].merchant, 'SBB EasyRide - ZVV Day Pass (calendar day) [100000000001]');
    
    // All fields should be identical
    assert.strictEqual(transactions1[0].date, transactions2[0].date);
    assert.strictEqual(transactions1[0].originalAmount, transactions2[0].originalAmount);
    assert.strictEqual(transactions1[0].source, transactions2[0].source);
  });
});
