import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'fs';
import { DB } from './db.js';
import { Transaction } from './types.js';
import { importTransactions } from './import.js';
import { applyExcludeRules, formatExcludeHit, listExcludeHits, loadExcludeRules, setTransactionExcluded, shouldExclude } from './exclude.js';
import { categorizeMonth } from './categorize.js';

function insertTx(db: DB, tx: Partial<Transaction> & { id: string; chfAmount: number }): void {
  db.insertTransaction({
    date: '2024-11-01',
    source: 'test',
    merchant: 'Shop',
    originalAmount: tx.chfAmount,
    originalCurrency: 'CHF',
    fileRowIndex: 0,
    importedAt: new Date().toISOString(),
    ...tx
  });
}

test('EXCLUDE_RULES_CONFIG points loadExcludeRules at that file', () => {
  const path = './test-exclude-rules-env.json';
  writeFileSync(path, JSON.stringify([{ pattern: 'broker-xyz', description: 'test' }]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  try {
    const rules = loadExcludeRules();
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].pattern, 'broker-xyz');
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    unlinkSync(path);
  }
});

test('import uses EXCLUDE_RULES_CONFIG patterns', async () => {
  const path = './test-exclude-rules-import.json';
  const dbPath = './test-exclude-env-import.sqlite';
  writeFileSync(path, JSON.stringify([{ pattern: 'broker-xyz' }]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  const db = new DB(dbPath);
  try {
    await importTransactions(db, [
      {
        date: '2024-11-02',
        merchant: 'Broker-XYZ Transfer',
        originalAmount: 80,
        originalCurrency: 'CHF',
        source: 'neon',
        fileRowIndex: 0,
        kind: 'expense'
      }
    ]);
    const tx = db.getTransactionsByMonth('2024-11').find(t => t.merchant === 'Broker-XYZ Transfer');
    assert.strictEqual(tx?.excluded, true);
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    db.close();
    unlinkSync(dbPath);
    unlinkSync(path);
  }
});

test('exclude-apply marks matching imported rows as excluded', () => {
  const path = './test-exclude-rules-apply.json';
  const dbPath = './test-exclude-apply.sqlite';
  writeFileSync(path, JSON.stringify([{ pattern: 'broker-xyz' }]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 80, merchant: 'Broker-XYZ Transfer' });
    insertTx(db, { id: 'tx2', chfAmount: 12, merchant: 'COOP', date: '2024-11-03', fileRowIndex: 1 });

    assert.strictEqual(db.getTransaction('tx1')?.excluded, false);
    const applied = applyExcludeRules(db, '2024-11');
    assert.strictEqual(applied, 1);
    assert.strictEqual(db.getTransaction('tx1')?.excluded, true);
    assert.strictEqual(db.getTransaction('tx2')?.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-11'), 12);
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    db.close();
    unlinkSync(dbPath);
    unlinkSync(path);
  }
});

test('exclude-apply does not undo a manual include', () => {
  const path = './test-exclude-rules-manual-include.json';
  const dbPath = './test-exclude-manual-include.sqlite';
  writeFileSync(path, JSON.stringify([{ pattern: 'broker-xyz' }]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 80, merchant: 'Broker-XYZ Transfer' });
    insertTx(db, { id: 'tx2', chfAmount: 12, merchant: 'COOP', date: '2024-11-03', fileRowIndex: 1 });

    applyExcludeRules(db, '2024-11');
    assert.strictEqual(db.getTransaction('tx1')?.excluded, true);

    setTransactionExcluded(db, 'tx1', false);
    assert.strictEqual(db.getTransaction('tx1')?.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-11'), 92);

    const applied = applyExcludeRules(db, '2024-11');
    assert.strictEqual(applied, 0);
    assert.strictEqual(db.getTransaction('tx1')?.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-11'), 92);
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    db.close();
    unlinkSync(dbPath);
    unlinkSync(path);
  }
});

test('exclude and include toggle a single row', () => {
  const dbPath = './test-exclude-toggle.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 40, merchant: 'COOP' });
    assert.strictEqual(db.getMonthTotal('2024-11'), 40);

    setTransactionExcluded(db, 'tx1', true);
    assert.strictEqual(db.getTransaction('tx1')?.excluded, true);
    assert.strictEqual(db.getMonthTotal('2024-11'), 0);

    setTransactionExcluded(db, 'tx1', false);
    assert.strictEqual(db.getTransaction('tx1')?.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-11'), 40);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('exclude source, direction, and exact match do not drop a third-party bankx out', () => {
  const path = './test-exclude-rules-scope.json';
  writeFileSync(path, JSON.stringify([
    { pattern: 'bankx', source: 'revolut', direction: 'in' },
    { pattern: 'bankx', match: 'exact' }
  ]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  try {
    assert.strictEqual(shouldExclude({
      merchant: 'bankx',
      source: 'revolut',
      originalAmount: -80,
      kind: 'expense'
    }), true, 'incoming own-account bankx');
    assert.strictEqual(shouldExclude({
      merchant: 'Shop BankX Ltd',
      source: 'revolut',
      originalAmount: 40,
      kind: 'expense'
    }), false, 'outgoing third party containing bankx');
    assert.strictEqual(shouldExclude({
      merchant: 'bankx',
      source: 'neon',
      originalAmount: 25,
      kind: 'expense'
    }), true, 'exact merchant bankx');
    assert.strictEqual(shouldExclude({
      merchant: 'Broker-XYZ Transfer',
      source: 'neon',
      originalAmount: 80,
      kind: 'expense'
    }), false, 'unrelated substring still needs its own rule');
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    unlinkSync(path);
  }
});

test('exclude-apply --dry-run lists the matching rule and does not write', () => {
  const path = './test-exclude-rules-dry-run.json';
  const dbPath = './test-exclude-dry-run.sqlite';
  writeFileSync(path, JSON.stringify([
    { pattern: 'bankx', description: 'own-account top-up', direction: 'in' }
  ]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'in1', chfAmount: -80, merchant: 'BankX', source: 'revolut' });
    insertTx(db, { id: 'out1', chfAmount: 40, merchant: 'Shop BankX Ltd', source: 'revolut', fileRowIndex: 1 });

    const hits = listExcludeHits(db, '2024-11');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].id, 'in1');
    assert.strictEqual(hits[0].reason, 'rule:own-account top-up');
    assert.strictEqual(hits[0].alreadyExcluded, false);
    assert.match(formatExcludeHit(hits[0]), /in1\s+BankX\s+rule:own-account top-up/);

    assert.strictEqual(db.getTransaction('in1')?.excluded, false);
    assert.strictEqual(db.getTransaction('out1')?.excluded, false);
    assert.strictEqual(db.getMonthTotal('2024-11'), -40);
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    db.close();
    unlinkSync(dbPath);
    unlinkSync(path);
  }
});

test('categorise count skips excluded rows', () => {
  const dbPath = './test-exclude-categorise-count.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'tx1', chfAmount: 10, merchant: 'COOP', excluded: true });
    insertTx(db, { id: 'tx2', chfAmount: 20, merchant: 'Unknown Cafe', date: '2024-11-04', fileRowIndex: 1 });

    categorizeMonth(db, '2024-11');

    const all = db.getTransactionsByMonth('2024-11');
    const considered = all.filter(t => !t.excluded);
    assert.strictEqual(all.length, 2);
    assert.strictEqual(considered.length, 1);
    assert.ok(!db.getTransaction('tx1')?.categorizationSource);
    assert.ok(db.getTransaction('tx2')?.categorizationSource === 'unknown');
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});
