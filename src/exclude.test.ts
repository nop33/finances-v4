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

test('sending-bank exact out rule excludes a Revolut top-up source, not a third-party name', () => {
  const path = './test-exclude-rules-scope.json';
  writeFileSync(path, JSON.stringify([
    { pattern: 'revolut', source: 'neon', direction: 'out', match: 'exact', description: 'own-account top-up' }
  ]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  try {
    assert.strictEqual(shouldExclude({
      merchant: 'revolut',
      source: 'neon',
      originalAmount: 80,
      kind: 'expense'
    }), true, 'outgoing neon to exact merchant revolut');
    assert.strictEqual(shouldExclude({
      merchant: 'Revolut Shop',
      source: 'neon',
      originalAmount: 40,
      kind: 'expense'
    }), false, 'third-party name containing revolut');
    assert.strictEqual(shouldExclude({
      merchant: 'Top-up from debit card',
      source: 'revolut',
      originalAmount: -80,
      kind: 'top-up'
    }), true, 'receiving Revolut top-up is already excluded by kind');
    assert.strictEqual(shouldExclude({
      merchant: 'revolut',
      source: 'revolut',
      originalAmount: -80,
      kind: 'expense'
    }), false, 'receiving side is not this sending-bank rule');
  } finally {
    if (prev === undefined) delete process.env.EXCLUDE_RULES_CONFIG;
    else process.env.EXCLUDE_RULES_CONFIG = prev;
    unlinkSync(path);
  }
});

test('exclude-apply --dry-run lists every matching reason and does not write', () => {
  const path = './test-exclude-rules-dry-run.json';
  const dbPath = './test-exclude-dry-run.sqlite';
  writeFileSync(path, JSON.stringify([
    { pattern: 'revolut', source: 'neon', direction: 'out', match: 'exact', description: 'own-account top-up' },
    { pattern: 'savings', description: 'own pocket' }
  ]));
  const prev = process.env.EXCLUDE_RULES_CONFIG;
  process.env.EXCLUDE_RULES_CONFIG = path;
  const db = new DB(dbPath);
  try {
    insertTx(db, { id: 'out1', chfAmount: 80, merchant: 'revolut', source: 'neon' });
    insertTx(db, { id: 'own1', chfAmount: 50, merchant: 'To savings space', source: 'revolut', kind: 'transfer', fileRowIndex: 1 });
    insertTx(db, { id: 'shop1', chfAmount: 12, merchant: 'Revolut Shop', source: 'neon', fileRowIndex: 2 });

    const hits = listExcludeHits(db, '2024-11');
    assert.strictEqual(hits.length, 2);
    const sending = hits.find(h => h.id === 'out1');
    const own = hits.find(h => h.id === 'own1');
    assert.ok(sending);
    assert.ok(own);
    assert.deepStrictEqual(sending.reasons, ['rule:own-account top-up']);
    assert.deepStrictEqual(own.reasons, ['kind:transfer', 'rule:own pocket']);
    assert.match(formatExcludeHit(own), /own1\s+To savings space\s+kind:transfer, rule:own pocket/);
    assert.strictEqual(sending.alreadyExcluded, false);

    assert.strictEqual(db.getTransaction('out1')?.excluded, false);
    assert.strictEqual(db.getTransaction('own1')?.excluded, false);
    assert.strictEqual(db.getTransaction('shop1')?.excluded, false);
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
