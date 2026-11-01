import { test } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { WebServer } from './web-server.js';
import { Transaction } from './types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('WebServer: review queue in full mode includes all unreviewed', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' },
      { column: 'D', header: 'Transport', group: 'Essentials', role: 'leaf_category' },
      { column: 'E', header: 'Entertainment', group: 'Lifestyle', role: 'leaf_category' }
    ],
    tierGroups: {
      need: ['Essentials'],
      want: ['Lifestyle']
    }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    // Insert test transactions
    const tx1: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test Merchant 1',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    const tx2: Transaction = {
      id: 'tx2',
      date: '2024-10-16',
      source: 'test',
      merchant: 'Test Merchant 2',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 2,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Transport',
      confidence: 0.9,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: true // Already reviewed
    };

    const tx3: Transaction = {
      id: 'tx3',
      date: '2024-10-17',
      source: 'test',
      merchant: 'Test Merchant 3',
      originalAmount: 75,
      originalCurrency: 'CHF',
      chfAmount: 75,
      fileRowIndex: 3,
      importedAt: new Date().toISOString(),
      category: 'Lifestyle/Entertainment',
      confidence: 0.6,
      explanation: 'test',
      categorizationSource: 'rule',
      reviewed: false
    };

    db.insertTransactions([tx1, tx2, tx3]);

    const queue = server.getReviewQueue({ month: '2024-10', mode: 'full' });

    assert.strictEqual(queue.length, 2, 'Should have 2 unreviewed transactions');
    assert.ok(queue.find(t => t.id === 'tx1'), 'Should include tx1');
    assert.ok(queue.find(t => t.id === 'tx3'), 'Should include tx3');
    assert.ok(!queue.find(t => t.id === 'tx2'), 'Should not include reviewed tx2');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: review queue in exceptions mode filters by confidence and flags', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const highConfidence: Transaction = {
      id: 'high',
      date: '2024-10-15',
      source: 'test',
      merchant: 'High Confidence',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.9,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    const lowConfidence: Transaction = {
      id: 'low',
      date: '2024-10-16',
      source: 'test',
      merchant: 'Low Confidence',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 2,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.5,
      explanation: 'test',
      categorizationSource: 'unknown',
      reviewed: false
    };

    const flagged: Transaction = {
      id: 'flagged',
      date: '2024-10-17',
      source: 'test',
      merchant: 'Flagged',
      originalAmount: 75,
      originalCurrency: 'CHF',
      chfAmount: 75,
      fileRowIndex: 3,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false,
      newMerchant: true
    };

    db.insertTransactions([highConfidence, lowConfidence, flagged]);

    const queue = server.getReviewQueue({ month: '2024-10', mode: 'exceptions' });

    assert.strictEqual(queue.length, 2, 'Should have 2 exception transactions');
    assert.ok(!queue.find(t => t.id === 'high'), 'Should not include high confidence');
    assert.ok(queue.find(t => t.id === 'low'), 'Should include low confidence');
    assert.ok(queue.find(t => t.id === 'flagged'), 'Should include flagged');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: review queue excludes transactions covered by fixed bills', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const uncovered: Transaction = {
      id: 'uncovered',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Uncovered',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    const covered: Transaction = {
      id: 'covered',
      date: '2024-10-16',
      source: 'test',
      merchant: 'Covered',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 2,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.9,
      explanation: 'paid via fixed bill: Test Bill',
      categorizationSource: 'merchant_memory',
      reviewed: false,
      coveredByFixedBill: 'Test Bill'
    };

    db.insertTransactions([uncovered, covered]);

    const queue = server.getReviewQueue({ month: '2024-10', mode: 'full' });

    assert.strictEqual(queue.length, 1, 'Should have 1 uncovered transaction');
    assert.ok(queue.find(t => t.id === 'uncovered'), 'Should include uncovered');
    assert.ok(!queue.find(t => t.id === 'covered'), 'Should not include covered');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: accept marks transaction as reviewed', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const tx: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    db.insertTransaction(tx);

    server.acceptTransaction('tx1');

    const updated = db.getTransaction('tx1');
    assert.ok(updated, 'Transaction should exist');
    assert.strictEqual(updated.reviewed, true, 'Transaction should be marked as reviewed');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: correct teaches merchant memory and marks as reviewed', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' },
      { column: 'D', header: 'Transport', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const tx: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Coop Supermarket',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'unknown',
      reviewed: false
    };

    db.insertTransaction(tx);

    server.correctTransactionViaWeb('tx1', 'Essentials/Transport');

    const updated = db.getTransaction('tx1');
    assert.ok(updated, 'Transaction should exist');
    assert.strictEqual(updated.reviewed, true, 'Transaction should be marked as reviewed');
    assert.strictEqual(updated.category, 'Essentials/Transport', 'Category should be updated');
    assert.strictEqual(updated.confidence, 1.0, 'Confidence should be 1.0 for correction');

    // Check merchant memory was updated
    const memory = db.getMerchantMemory('coop supermarket');
    assert.ok(memory, 'Merchant memory should exist');
    assert.strictEqual(memory.category, 'Essentials/Transport', 'Memory should have new category');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: undo restores previous state', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const tx: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'original explanation',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    db.insertTransaction(tx);

    // Accept the transaction
    server.acceptTransaction('tx1');
    let updated = db.getTransaction('tx1');
    assert.strictEqual(updated?.reviewed, true, 'Should be reviewed after accept');

    // Undo
    const undone = server.undo();
    assert.strictEqual(undone, true, 'Undo should succeed');

    updated = db.getTransaction('tx1');
    assert.strictEqual(updated?.reviewed, false, 'Should be unreviewed after undo');
    assert.strictEqual(updated?.category, 'Essentials/Food', 'Category should be restored');
    assert.strictEqual(updated?.confidence, 0.8, 'Confidence should be restored');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: transaction list includes covered transactions', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const tx1: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Test 1',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    const tx2: Transaction = {
      id: 'tx2',
      date: '2024-10-16',
      source: 'test',
      merchant: 'Test 2',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 2,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.9,
      explanation: 'paid via fixed bill: Test Bill',
      categorizationSource: 'merchant_memory',
      reviewed: false,
      coveredByFixedBill: 'Test Bill'
    };

    db.insertTransactions([tx1, tx2]);

    const list = server.getTransactionsList('2024-10');

    assert.strictEqual(list.length, 2, 'List should include all transactions');
    assert.ok(list.find(t => t.id === 'tx1'), 'Should include uncovered');
    assert.ok(list.find(t => t.id === 'tx2'), 'Should include covered');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: transaction list filtering by text', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finances-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const configPath = join(tmpDir, 'config.json');

  writeFileSync(configPath, JSON.stringify({
    columns: [
      { column: 'A', header: 'Year', role: 'year' },
      { column: 'B', header: 'Month', role: 'month_date' },
      { column: 'C', header: 'Food', group: 'Essentials', role: 'leaf_category' }
    ],
    tierGroups: { need: ['Essentials'] }
  }));

  process.env.CATEGORY_CONFIG = configPath;

  try {
    const db = new DB(dbPath);
    const server = new WebServer(db);

    const tx1: Transaction = {
      id: 'tx1',
      date: '2024-10-15',
      source: 'test',
      merchant: 'Coop Supermarket',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    const tx2: Transaction = {
      id: 'tx2',
      date: '2024-10-16',
      source: 'test',
      merchant: 'Migros',
      originalAmount: 50,
      originalCurrency: 'CHF',
      chfAmount: 50,
      fileRowIndex: 2,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.9,
      explanation: 'test',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    db.insertTransactions([tx1, tx2]);

    const filtered = server.getTransactionsList('2024-10', { text: 'coop' });

    assert.strictEqual(filtered.length, 1, 'Should filter by text');
    assert.strictEqual(filtered[0].id, 'tx1', 'Should return matching transaction');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});
