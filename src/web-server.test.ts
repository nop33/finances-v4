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

test('WebServer: HTML injection prevention in merchant names', () => {
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

    // Transaction with malicious merchant name
    const maliciousTx: Transaction = {
      id: 'malicious',
      date: '2024-10-15',
      source: 'test',
      merchant: '<script>alert("XSS")</script>Evil Shop',
      originalAmount: 100,
      originalCurrency: 'CHF',
      chfAmount: 100,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
      category: 'Essentials/Food',
      confidence: 0.8,
      explanation: '<img src=x onerror=alert("XSS2")>',
      categorizationSource: 'merchant_memory',
      reviewed: false
    };

    db.insertTransaction(maliciousTx);

    // Get transaction from API (returns JSON)
    const transactions = server.getTransactionsList('2024-10');
    
    // Verify the data comes through as-is in JSON (escaping happens client-side)
    assert.strictEqual(transactions[0].merchant, '<script>alert("XSS")</script>Evil Shop');
    assert.strictEqual(transactions[0].explanation, '<img src=x onerror=alert("XSS2")>');

    // Verify the HTML pages would escape it when rendered
    // The review page HTML contains escapeHtml function
    const reviewHTML = (server as any).getReviewPageHTML();
    assert.ok(reviewHTML.includes('function escapeHtml(text)'), 'Review page should have escapeHtml function');
    assert.ok(reviewHTML.includes('escapeHtml(tx.merchant)'), 'Review page should escape merchant');
    assert.ok(reviewHTML.includes('escapeHtml(tx.explanation)'), 'Review page should escape explanation');

    // The transactions list page HTML also contains escapeHtml function
    const listHTML = (server as any).getTransactionsPageHTML();
    assert.ok(listHTML.includes('function escapeHtml(text)'), 'List page should have escapeHtml function');
    assert.ok(listHTML.includes('escapeHtml(tx.merchant)'), 'List page should escape merchant');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: malformed JSON in POST requests returns 400', () => {
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

    // Test accept endpoint with malformed JSON
    const acceptReq = {
      method: 'POST',
      url: '/api/accept',
      headers: {},
      on: (event: string, handler: Function) => {
        if (event === 'data') {
          handler('{invalid json}');
        } else if (event === 'end') {
          handler();
        }
      }
    } as any;

    let acceptStatusCode = 0;
    let acceptBody = '';
    const acceptRes = {
      setHeader: () => {},
      writeHead: (code: number) => { acceptStatusCode = code; },
      end: (data: string) => { acceptBody = data; }
    } as any;

    server.handleRequest(acceptReq, acceptRes);

    // Give handlers time to execute
    setTimeout(() => {
      assert.strictEqual(acceptStatusCode, 400, 'Should return 400 for malformed JSON in accept');
      assert.ok(acceptBody.includes('Invalid JSON'), 'Should include error message');
    }, 100);

    // Test correct endpoint with malformed JSON
    const correctReq = {
      method: 'POST',
      url: '/api/correct',
      headers: {},
      on: (event: string, handler: Function) => {
        if (event === 'data') {
          handler('not json at all');
        } else if (event === 'end') {
          handler();
        }
      }
    } as any;

    let correctStatusCode = 0;
    let correctBody = '';
    const correctRes = {
      setHeader: () => {},
      writeHead: (code: number) => { correctStatusCode = code; },
      end: (data: string) => { correctBody = data; }
    } as any;

    server.handleRequest(correctReq, correctRes);

    setTimeout(() => {
      assert.strictEqual(correctStatusCode, 400, 'Should return 400 for malformed JSON in correct');
      assert.ok(correctBody.includes('Invalid JSON'), 'Should include error message');
    }, 100);

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: add twint transaction with valid data', async () => {
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

    const reqData = JSON.stringify({
      date: '2024-10-15',
      merchant: 'Test Shop',
      amount: 25.50,
      note: 'Test purchase'
    });

    const result = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(reqData);
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let statusCode = 0;
      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: (code: number) => { statusCode = code; },
        end: (data: string) => {
          responseBody = data;
          resolve({ statusCode, responseBody });
        }
      } as any;

      server.handleRequest(req, res);
    });

    assert.strictEqual(result.statusCode, 200, 'Should return 200 OK');
    const parsed = JSON.parse(result.responseBody);
    assert.strictEqual(parsed.success, true);
    assert.ok(parsed.id, 'Should return transaction id');

    const tx = db.getTransaction(parsed.id);
    assert.ok(tx, 'Transaction should exist in database');
    assert.strictEqual(tx?.source, 'twint');
    assert.strictEqual(tx?.merchant, 'Test Shop');
    assert.strictEqual(tx?.chfAmount, 25.50);
    assert.strictEqual(tx?.description, 'Test purchase');
    assert.ok(tx?.confidence !== undefined, 'Transaction should have confidence score');
    assert.ok(tx?.explanation, 'Transaction should have explanation');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: add twint transaction validates required fields', async () => {
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

    // Missing merchant
    let result = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(JSON.stringify({ date: '2024-10-15', amount: 25.50 }));
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let statusCode = 0;
      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: (code: number) => { statusCode = code; },
        end: (data: string) => {
          responseBody = data;
          resolve({ statusCode, responseBody });
        }
      } as any;

      server.handleRequest(req, res);
    });

    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.responseBody.includes('merchant'));

    // Invalid amount (negative)
    result = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(JSON.stringify({ date: '2024-10-15', merchant: 'Test', amount: -10 }));
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let statusCode = 0;
      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: (code: number) => { statusCode = code; },
        end: (data: string) => {
          responseBody = data;
          resolve({ statusCode, responseBody });
        }
      } as any;

      server.handleRequest(req, res);
    });

    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.responseBody.includes('amount'));

    // Invalid date format
    result = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(JSON.stringify({ date: '15-10-2024', merchant: 'Test', amount: 10 }));
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let statusCode = 0;
      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: (code: number) => { statusCode = code; },
        end: (data: string) => {
          responseBody = data;
          resolve({ statusCode, responseBody });
        }
      } as any;

      server.handleRequest(req, res);
    });

    assert.strictEqual(result.statusCode, 400);
    assert.ok(result.responseBody.includes('date'));

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: twint transactions have unique IDs for same-day duplicates', async () => {
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

    const reqData = JSON.stringify({
      date: '2024-10-15',
      merchant: 'Coop',
      amount: 15.00
    });

    // Insert first transaction
    const result1 = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(reqData);
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: () => {},
        end: (data: string) => {
          responseBody = data;
          resolve(JSON.parse(responseBody));
        }
      } as any;

      server.handleRequest(req, res);
    });

    const id1 = result1.id;

    // Insert second identical transaction
    const result2 = await new Promise<any>((resolve) => {
      const req = {
        method: 'POST',
        url: '/api/twint',
        headers: {},
        on: (event: string, handler: Function) => {
          if (event === 'data') {
            handler(reqData);
          } else if (event === 'end') {
            handler();
          }
        }
      } as any;

      let responseBody = '';
      const res = {
        setHeader: () => {},
        writeHead: () => {},
        end: (data: string) => {
          responseBody = data;
          resolve(JSON.parse(responseBody));
        }
      } as any;

      server.handleRequest(req, res);
    });

    const id2 = result2.id;

    assert.notStrictEqual(id1, id2, 'IDs should be different for same-day duplicates');
    
    const tx1 = db.getTransaction(id1);
    const tx2 = db.getTransaction(id2);
    
    assert.ok(tx1);
    assert.ok(tx2);
    assert.strictEqual(tx1?.date, tx2?.date);
    assert.strictEqual(tx1?.merchant, tx2?.merchant);
    assert.strictEqual(tx1?.chfAmount, tx2?.chfAmount);

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: delete twint transaction', () => {
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
      id: 'twi-test123',
      date: '2024-10-15',
      source: 'twint',
      merchant: 'Test Shop',
      originalAmount: 25.50,
      originalCurrency: 'CHF',
      chfAmount: 25.50,
      fileRowIndex: 0,
      importedAt: new Date().toISOString(),
    };

    db.insertTransaction(tx);

    const req = {
      method: 'DELETE',
      url: '/api/twint/twi-test123',
      headers: {}
    } as any;

    let statusCode = 0;
    let responseBody = '';
    const res = {
      setHeader: () => {},
      writeHead: (code: number) => { statusCode = code; },
      end: (data: string) => { responseBody = data; }
    } as any;

    server.handleRequest(req, res);

    assert.strictEqual(statusCode, 200);
    const result = JSON.parse(responseBody);
    assert.strictEqual(result.success, true);

    const deleted = db.getTransaction('twi-test123');
    assert.strictEqual(deleted, undefined, 'Transaction should be deleted');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: cannot delete non-twint transaction', () => {
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
      id: 'bank-tx123',
      date: '2024-10-15',
      source: 'revolut',
      merchant: 'Test Shop',
      originalAmount: 25.50,
      originalCurrency: 'CHF',
      chfAmount: 25.50,
      fileRowIndex: 1,
      importedAt: new Date().toISOString(),
    };

    db.insertTransaction(tx);

    const req = {
      method: 'DELETE',
      url: '/api/twint/bank-tx123',
      headers: {}
    } as any;

    let statusCode = 0;
    let responseBody = '';
    const res = {
      setHeader: () => {},
      writeHead: (code: number) => { statusCode = code; },
      end: (data: string) => { responseBody = data; }
    } as any;

    server.handleRequest(req, res);

    assert.strictEqual(statusCode, 403, 'Should return 403 Forbidden');
    assert.ok(responseBody.includes('Can only delete twint'));

    const stillExists = db.getTransaction('bank-tx123');
    assert.ok(stillExists, 'Non-twint transaction should not be deleted');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});

test('WebServer: twint page HTML escapes user input', () => {
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

    const html = (server as any).getTwintPageHTML();
    
    assert.ok(html.includes('function escapeHtml(text)'), 'Page should have escapeHtml function');
    assert.ok(html.includes('escapeHtml(tx.merchant)'), 'Page should escape merchant');
    assert.ok(html.includes('escapeHtml(tx.description)'), 'Page should escape description');

    db.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CATEGORY_CONFIG;
  }
});
