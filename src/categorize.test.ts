import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeMerchant, categorizeTransaction, categorizeMonth, correctTransaction } from './categorize.js';
import { DB } from './db.js';
import { Transaction } from './types.js';
import { unlinkSync } from 'fs';

test('normalizeMerchant strips payment processor prefixes', () => {
  assert.strictEqual(normalizeMerchant('SumUp*CoffeShop'), 'coffeshop');
  assert.strictEqual(normalizeMerchant('Zettle*Bakery'), 'bakery');
  assert.strictEqual(normalizeMerchant('PayPal *Amazon'), 'amazon');
  assert.strictEqual(normalizeMerchant('SQ *Restaurant'), 'restaurant');
  assert.strictEqual(normalizeMerchant('TWINT*Store'), 'store');
});

test('normalizeMerchant strips card numbers and asterisks', () => {
  assert.strictEqual(normalizeMerchant('Store 1234'), 'store');
  assert.strictEqual(normalizeMerchant('Shop****5678'), 'shop');
  assert.strictEqual(normalizeMerchant('Cafe Card 9999'), 'cafe');
});

test('normalizeMerchant strips city suffixes', () => {
  assert.strictEqual(normalizeMerchant('ACME Cafe Zurich'), 'acme cafe');
  assert.strictEqual(normalizeMerchant('Store Zürich'), 'store');
  assert.strictEqual(normalizeMerchant('Shop ZH'), 'shop');
  assert.strictEqual(normalizeMerchant('Market Switzerland'), 'market');
  assert.strictEqual(normalizeMerchant('Bakery Geneva'), 'bakery');
});

test('normalizeMerchant combines all transformations', () => {
  assert.strictEqual(
    normalizeMerchant('SumUp*ACME Cafe 1234 Zurich'),
    'acme cafe'
  );
  assert.strictEqual(
    normalizeMerchant('PayPal *Shop****5678 CH'),
    'shop'
  );
});

test('categorizeTransaction uses merchant memory when available', () => {
  const dbPath = './test-categorize-memory.sqlite';
  const db = new DB(dbPath);

  try {
    db.recordCorrection('test merchant', 'Meals/Snacks');
    db.recordCorrection('test merchant', 'Meals/Snacks');

    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test Merchant',
      originalAmount: 10,
      originalCurrency: 'CHF',
      chfAmount: 10,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.category, 'Meals/Snacks');
    assert.strictEqual(result.source, 'merchant_memory');
    assert.ok(result.confidence >= 0.5);
    assert.ok(result.explanation.includes('merchant memory'));
    assert.ok(result.explanation.includes('2 time'));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('categorizeTransaction uses rules when no memory exists', () => {
  const dbPath = './test-categorize-rule.sqlite';
  const db = new DB(dbPath);

  try {
    db.addRule('sbb', 'Movement/Transit pass');

    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'SBB CFF FFS',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.category, 'Movement/Transit pass');
    assert.strictEqual(result.source, 'rule');
    assert.strictEqual(result.confidence, 0.7);
    assert.ok(result.explanation.includes('rule: contains "sbb"'));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('categorizeTransaction returns unknown when no match', () => {
  const dbPath = './test-categorize-unknown.sqlite';
  const db = new DB(dbPath);

  try {
    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Unknown Merchant',
      originalAmount: 10,
      originalCurrency: 'CHF',
      chfAmount: 10,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.category, '');
    assert.strictEqual(result.source, 'unknown');
    assert.strictEqual(result.confidence, 0);
    assert.ok(result.explanation.includes('unknown'));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('confidence rises with repeated corrections', () => {
  const dbPath = './test-confidence-rise.sqlite';
  const db = new DB(dbPath);

  try {
    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test Cafe',
      originalAmount: 10,
      originalCurrency: 'CHF',
      chfAmount: 10,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    db.recordCorrection('test cafe', 'Meals/Dining out');
    let result = categorizeTransaction(tx, db, [tx]);
    const confidence1 = result.confidence;

    db.recordCorrection('test cafe', 'Meals/Dining out');
    result = categorizeTransaction(tx, db, [tx]);
    const confidence2 = result.confidence;

    db.recordCorrection('test cafe', 'Meals/Dining out');
    result = categorizeTransaction(tx, db, [tx]);
    const confidence3 = result.confidence;

    assert.ok(confidence2 > confidence1, 'Confidence should rise after second correction');
    assert.ok(confidence3 > confidence2, 'Confidence should rise after third correction');
    assert.ok(confidence3 <= 0.95, 'Confidence should be capped at 0.95');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: new merchant flag', () => {
  const dbPath = './test-anomaly-new.sqlite';
  const db = new DB(dbPath);

  try {
    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Brand New Shop',
      originalAmount: 10,
      originalCurrency: 'CHF',
      chfAmount: 10,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.anomalies.newMerchant, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: not new merchant after correction', () => {
  const dbPath = './test-anomaly-not-new.sqlite';
  const db = new DB(dbPath);

  try {
    db.recordCorrection('familiar shop', 'Meals/Snacks');

    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Familiar Shop',
      originalAmount: 10,
      originalCurrency: 'CHF',
      chfAmount: 10,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.anomalies.newMerchant, false);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: unusual amount flag', () => {
  const dbPath = './test-anomaly-unusual-amount.sqlite';
  const db = new DB(dbPath);

  try {
    const txs: Transaction[] = [
      {
        id: 'test1',
        date: '2024-10-01',
        source: 'test',
        merchant: 'Regular Cafe',
        originalAmount: 10,
        originalCurrency: 'CHF',
        chfAmount: 10,
        fileRowIndex: 0,
        importedAt: new Date().toISOString()
      },
      {
        id: 'test2',
        date: '2024-10-05',
        source: 'test',
        merchant: 'Regular Cafe',
        originalAmount: 12,
        originalCurrency: 'CHF',
        chfAmount: 12,
        fileRowIndex: 1,
        importedAt: new Date().toISOString()
      },
      {
        id: 'test3',
        date: '2024-10-10',
        source: 'test',
        merchant: 'Regular Cafe',
        originalAmount: 11,
        originalCurrency: 'CHF',
        chfAmount: 11,
        fileRowIndex: 2,
        importedAt: new Date().toISOString()
      },
      {
        id: 'test4',
        date: '2024-10-15',
        source: 'test',
        merchant: 'Regular Cafe',
        originalAmount: 100,
        originalCurrency: 'CHF',
        chfAmount: 100,
        fileRowIndex: 3,
        importedAt: new Date().toISOString()
      }
    ];

    for (const tx of txs) {
      db.insertTransaction(tx);
    }

    const result = categorizeTransaction(txs[3], db, txs);

    assert.strictEqual(result.anomalies.unusualAmount, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: possible duplicate flag (not same day)', () => {
  const dbPath = './test-anomaly-duplicate.sqlite';
  const db = new DB(dbPath);

  try {
    const txs: Transaction[] = [
      {
        id: 'test1',
        date: '2024-10-10',
        source: 'test',
        merchant: 'Store',
        originalAmount: 50,
        originalCurrency: 'CHF',
        chfAmount: 50,
        fileRowIndex: 0,
        importedAt: new Date().toISOString()
      },
      {
        id: 'test2',
        date: '2024-10-12',
        source: 'test',
        merchant: 'Store',
        originalAmount: 50,
        originalCurrency: 'CHF',
        chfAmount: 50,
        fileRowIndex: 1,
        importedAt: new Date().toISOString()
      }
    ];

    const result = categorizeTransaction(txs[1], db, txs);

    assert.strictEqual(result.anomalies.possibleDuplicate, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: same-day identical transactions NOT flagged as duplicate', () => {
  const dbPath = './test-anomaly-same-day.sqlite';
  const db = new DB(dbPath);

  try {
    const txs: Transaction[] = [
      {
        id: 'test1',
        date: '2024-10-15',
        source: 'test',
        merchant: 'Store',
        originalAmount: 50,
        originalCurrency: 'CHF',
        chfAmount: 50,
        fileRowIndex: 0,
        importedAt: new Date().toISOString()
      },
      {
        id: 'test2',
        date: '2024-10-15',
        source: 'test',
        merchant: 'Store',
        originalAmount: 50,
        originalCurrency: 'CHF',
        chfAmount: 50,
        fileRowIndex: 1,
        importedAt: new Date().toISOString()
      }
    ];

    const result = categorizeTransaction(txs[1], db, txs);

    assert.strictEqual(result.anomalies.possibleDuplicate, false, 'Same-day identical transactions should NOT be flagged as duplicate');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('anomaly: unconverted FX flag', () => {
  const dbPath = './test-anomaly-unconverted-fx.sqlite';
  const db = new DB(dbPath);

  try {
    const tx: Transaction = {
      id: 'test1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Foreign Store',
      originalAmount: 100,
      originalCurrency: 'USD',
      chfAmount: 100,
      fileRowIndex: 0,
      importedAt: new Date().toISOString()
    };

    const result = categorizeTransaction(tx, db, [tx]);

    assert.strictEqual(result.anomalies.unconvertedFx, true);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('correctTransaction updates merchant memory and re-categorises similar merchants', () => {
  const dbPath = './test-correct-update.sqlite';
  const db = new DB(dbPath);

  try {
    const txs: Transaction[] = [
      {
        id: 'test1',
        date: '2024-10-01',
        source: 'test',
        merchant: 'SumUp*ACME Cafe',
        originalAmount: 10,
        originalCurrency: 'CHF',
        chfAmount: 10,
        fileRowIndex: 0,
        importedAt: new Date().toISOString(),
        reviewed: false
      },
      {
        id: 'test2',
        date: '2024-10-05',
        source: 'test',
        merchant: 'ACME Cafe Zurich',
        originalAmount: 12,
        originalCurrency: 'CHF',
        chfAmount: 12,
        fileRowIndex: 1,
        importedAt: new Date().toISOString(),
        reviewed: false
      }
    ];

    for (const tx of txs) {
      db.insertTransaction(tx);
    }

    correctTransaction(db, 'test1', 'Meals/Snacks');

    const updated1 = db.getTransaction('test1');
    const updated2 = db.getTransaction('test2');

    assert.strictEqual(updated1?.category, 'Meals/Snacks');
    assert.strictEqual(updated1?.reviewed, true);
    assert.ok(updated1?.explanation?.includes('corrected'));

    assert.strictEqual(updated2?.category, 'Meals/Snacks');
    assert.ok(updated2?.explanation?.includes('merchant memory'));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('categorizeMonth skips already reviewed transactions', () => {
  const dbPath = './test-categorize-month.sqlite';
  const db = new DB(dbPath);

  try {
    const txs: Transaction[] = [
      {
        id: 'test1',
        date: '2024-10-01',
        source: 'test',
        merchant: 'Store',
        originalAmount: 10,
        originalCurrency: 'CHF',
        chfAmount: 10,
        fileRowIndex: 0,
        importedAt: new Date().toISOString(),
        category: 'Meals/Snacks',
        reviewed: true
      },
      {
        id: 'test2',
        date: '2024-10-05',
        source: 'test',
        merchant: 'Other Store',
        originalAmount: 20,
        originalCurrency: 'CHF',
        chfAmount: 20,
        fileRowIndex: 1,
        importedAt: new Date().toISOString()
      }
    ];

    for (const tx of txs) {
      db.insertTransaction(tx);
    }

    categorizeMonth(db, '2024-10');

    const tx1 = db.getTransaction('test1');
    const tx2 = db.getTransaction('test2');

    assert.strictEqual(tx1?.category, 'Meals/Snacks', 'Reviewed transaction should keep original category');
    assert.ok(tx2?.categorizationSource === 'unknown', 'Unreviewed transaction should be categorised');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});
