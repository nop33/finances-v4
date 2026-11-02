import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { spawnSync } from 'node:child_process';
import { DB } from './db.js';
import { ParsedTransaction, Transaction } from './types.js';
import { loadCategories } from './categories.js';
import {
  buildLedger,
  ledgerCsv,
  buildExpencesRow,
  buildSummary,
  formatSummary,
  formatDecimal,
  merchantsMatch,
} from './output.js';
import { splitTransaction } from './split.js';
import { categorizeMonth, correctTransaction } from './categorize.js';
import { importTransactions } from './import.js';

const categoryConfig = './dist/test-fixtures/test-output-categories.json';

function insertTx(db: DB, tx: Partial<Transaction> & { id: string; chfAmount: number }): void {
  db.insertTransaction({
    date: '2024-10-15',
    source: 'neon',
    merchant: 'Shop',
    originalAmount: tx.chfAmount,
    originalCurrency: 'CHF',
    fileRowIndex: 0,
    importedAt: new Date().toISOString(),
    ...tx,
  });
}

function withMonth(dbPath: string, run: (db: DB) => void): void {
  const prev = process.env.CATEGORY_CONFIG;
  process.env.CATEGORY_CONFIG = categoryConfig;
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'split-1',
      date: '2024-10-01',
      merchant: 'Department Store',
      chfAmount: 50,
      category: 'Shopping/Purchases',
      reviewed: true,
      confidence: 1,
    });
    splitTransaction(db, 'split-1', [
      { category: 'Meals/Snacks', chfAmount: 20 },
      { category: 'Shopping/Purchases', chfAmount: 30 },
    ]);
    insertTx(db, {
      id: 'excluded-1',
      date: '2024-10-02',
      merchant: 'Hidden',
      chfAmount: 100,
      category: 'Meals/Snacks',
      excluded: true,
      confidence: 1,
    });
    insertTx(db, {
      id: 'sw-credit',
      date: '2024-10-03',
      source: 'splitwise',
      merchant: 'Dinner',
      chfAmount: -15,
      category: 'Meals/Snacks',
      reviewed: true,
      confidence: 1,
    });
    insertTx(db, {
      id: 'unmapped-1',
      date: '2024-10-04',
      merchant: 'Oddball',
      chfAmount: 8,
      category: 'Misc/Unmapped',
      reviewed: false,
      confidence: 0.2,
    });
    insertTx(db, {
      id: 'coop-bank',
      date: '2024-10-05',
      merchant: 'COOP',
      chfAmount: 40,
      category: 'Meals/Snacks',
      reviewed: false,
      confidence: 0.9,
      fixedChanged: true,
    });
    insertTx(db, {
      id: 'coop-sw',
      date: '2024-10-05',
      source: 'splitwise',
      merchant: 'COOP',
      chfAmount: -10,
      category: 'Meals/Snacks',
      reviewed: true,
      confidence: 1,
    });
    run(db);
  } finally {
    db.close();
    unlinkSync(dbPath);
    if (prev === undefined) delete process.env.CATEGORY_CONFIG;
    else process.env.CATEGORY_CONFIG = prev;
  }
}

test('ledger writes counted rows, splits halves, skips excluded, and links Splitwise', () => {
  withMonth('./test-output-ledger.sqlite', db => {
    const rows = buildLedger(db, '2024-10');
    assert.deepStrictEqual(rows.map(r => ({
      date: r.date,
      source: r.source,
      merchant: r.merchant,
      amount: r.amount,
      category: r.category,
      splitwiseAdjustment: r.splitwiseAdjustment,
      reviewed: r.reviewed,
    })), [
      {
        date: '2024-10-01',
        source: 'neon',
        merchant: 'Department Store',
        amount: 20,
        category: 'Meals/Snacks',
        splitwiseAdjustment: null,
        reviewed: true,
      },
      {
        date: '2024-10-01',
        source: 'neon',
        merchant: 'Department Store',
        amount: 30,
        category: 'Shopping/Purchases',
        splitwiseAdjustment: null,
        reviewed: true,
      },
      {
        date: '2024-10-03',
        source: 'splitwise',
        merchant: 'Dinner',
        amount: -15,
        category: 'Meals/Snacks',
        splitwiseAdjustment: null,
        reviewed: true,
      },
      {
        date: '2024-10-04',
        source: 'neon',
        merchant: 'Oddball',
        amount: 8,
        category: 'Misc/Unmapped',
        splitwiseAdjustment: null,
        reviewed: false,
      },
      {
        date: '2024-10-05',
        source: 'neon',
        merchant: 'COOP',
        amount: 40,
        category: 'Meals/Snacks',
        splitwiseAdjustment: -10,
        reviewed: false,
      },
      {
        date: '2024-10-05',
        source: 'splitwise',
        merchant: 'COOP',
        amount: -10,
        category: 'Meals/Snacks',
        splitwiseAdjustment: null,
        reviewed: true,
      },
    ]);
    assert.ok(!rows.some(r => r.merchant === 'Hidden'), 'excluded row must not appear');

    const csv = ledgerCsv(rows);
    assert.match(csv, /^date,source,merchant,amount,category,splitwise_adjustment,reviewed\n/);
    assert.match(csv, /2024-10-01,neon,Department Store,20\.00,Meals\/Snacks,,true/);
    assert.match(csv, /2024-10-05,neon,COOP,40\.00,Meals\/Snacks,-10\.00,false/);
    assert.match(csv, /2024-10-03,splitwise,Dinner,-15\.00,Meals\/Snacks,,true/);
    assert.doesNotMatch(csv, /\d{1,3},\d{3}/);
    assert.strictEqual(formatDecimal(1234.5), '1234.50');
  });
});

test('expences-row maps sheet columns, lists unmapped, and checks sum against month total', () => {
  withMonth('./test-output-expences.sqlite', db => {
    const row = buildExpencesRow(db, '2024-10', loadCategories(categoryConfig));
    assert.strictEqual(row.month, '2024-10');
    assert.deepStrictEqual(row.cells, { C: 35, D: 30, E: 0 });
    assert.deepStrictEqual(row.unmapped, [{ category: 'Misc/Unmapped', amount: 8 }]);
    assert.strictEqual(row.total, 73);
    assert.strictEqual(row.cellsSum, 65);
    assert.strictEqual(row.cellsSum, Object.values(row.cells).reduce((s, n) => s + n, 0));
    assert.notStrictEqual(row.cellsSum, row.total);
    assert.strictEqual(row.cellsSum + row.unmapped.reduce((s, u) => s + u.amount, 0), row.total);
    assert.strictEqual(row.cells.E, 0);
  });
});

test('summary reports total, top categories, flagged count, and month-over-month delta', () => {
  withMonth('./test-output-summary.sqlite', db => {
    insertTx(db, {
      id: 'sep-1',
      date: '2024-09-10',
      merchant: 'September',
      chfAmount: 100,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    db.recordFileImport({
      file: 'september-neon.csv',
      source: 'neon',
      statementMonth: '2024-09',
      dates: ['2024-09-10'],
    });

    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.total, 73);
    assert.deepStrictEqual(summary.topCategories, [
      { category: 'Meals/Snacks', amount: 35 },
      { category: 'Shopping/Purchases', amount: 30 },
      { category: 'Misc/Unmapped', amount: 8 },
    ]);
    assert.strictEqual(summary.flagged, 2);
    assert.deepStrictEqual(summary.flaggedBreakdown, {
      fixedChanged: 1,
      fixedMissing: 0,
      lowConfidence: 1,
      newMerchant: 0,
    });
    assert.strictEqual(summary.previousMonth, '2024-09');
    assert.strictEqual(summary.delta, -27);

    const text = formatSummary(summary);
    assert.match(text, /Month 2024-10/);
    assert.match(text, /Total: 73\.00/);
    assert.match(text, /Meals\/Snacks: 35\.00/);
    assert.match(text, /Flagged: 2/);
    assert.match(text, /fixedChanged: 1/);
    assert.match(text, /low confidence: 1/);
    assert.match(text, /vs 2024-09: -27\.00/);
    assert.doesNotMatch(text, /previous month not loaded/);
  });
});

test('summary flagged skips excluded and covered rows and does not treat missing confidence as low', () => {
  const dbPath = './test-output-flagged-skip.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'excluded-low',
      date: '2024-10-01',
      merchant: 'Hidden',
      chfAmount: 10,
      excluded: true,
      confidence: 0.1,
      newMerchant: true,
    });
    insertTx(db, {
      id: 'covered-changed',
      date: '2024-10-02',
      merchant: 'Landlord',
      chfAmount: 1000,
      coveredByFixedBill: 'Rent',
      fixedChanged: true,
      confidence: 0.2,
    });
    insertTx(db, {
      id: 'plain',
      date: '2024-10-03',
      merchant: 'COOP',
      chfAmount: 12,
      category: 'Meals/Snacks',
    });
    insertTx(db, {
      id: 'missing-bill',
      date: '2024-10-04',
      source: 'fixed',
      merchant: 'Gym',
      chfAmount: 40,
      category: 'Living/Gym',
      fixedMissing: true,
      confidence: 1,
    });
    insertTx(db, {
      id: 'new-shop',
      date: '2024-10-05',
      merchant: 'New Shop',
      chfAmount: 5,
      category: 'Shopping/Purchases',
      newMerchant: true,
      confidence: 0.9,
    });

    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.flagged, 2);
    assert.deepStrictEqual(summary.flaggedBreakdown, {
      fixedChanged: 0,
      fixedMissing: 1,
      lowConfidence: 0,
      newMerchant: 1,
    });
    const text = formatSummary(summary);
    assert.match(text, /Flagged: 2/);
    assert.match(text, /fixedMissing: 1/);
    assert.match(text, /new merchant: 1/);
    assert.match(text, /low confidence: 0/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary does not flag a reviewed new merchant after correct', () => {
  const dbPath = './test-output-flagged-reviewed.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'shop-1',
      date: '2024-10-10',
      merchant: 'Shop',
      chfAmount: 20,
    });
    categorizeMonth(db, '2024-10');
    const before = db.getTransaction('shop-1');
    assert.strictEqual(before?.newMerchant, true);
    assert.strictEqual(before?.reviewed, false);
    const flagged = buildSummary(db, '2024-10');
    assert.strictEqual(flagged.flagged, 1);
    assert.strictEqual(flagged.flaggedBreakdown.newMerchant, 1);
    assert.match(formatSummary(flagged), /new merchant: 1/);

    correctTransaction(db, 'shop-1', 'Meals/Snacks');
    const after = db.getTransaction('shop-1');
    assert.strictEqual(after?.reviewed, true);
    assert.strictEqual(after?.newMerchant, true);
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.flagged, 0);
    assert.strictEqual(summary.flaggedBreakdown.newMerchant, 0);
    assert.strictEqual(summary.flaggedBreakdown.lowConfidence, 0);
    assert.match(formatSummary(summary), /new merchant: 0/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary skips reviewed rows for confidence flags and for fixed flags once reviewed', () => {
  const dbPath = './test-output-flagged-reviewed-bits.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'reviewed-low',
      date: '2024-10-06',
      merchant: 'Cafe',
      chfAmount: 8,
      confidence: 0.2,
      reviewed: true,
    });
    insertTx(db, {
      id: 'reviewed-changed',
      date: '2024-10-07',
      merchant: 'Gym',
      chfAmount: 40,
      source: 'fixed',
      fixedChanged: true,
      reviewed: true,
      confidence: 1,
    });
    insertTx(db, {
      id: 'open-changed',
      date: '2024-10-08',
      merchant: 'Internet',
      chfAmount: 60,
      source: 'fixed',
      fixedChanged: true,
      reviewed: false,
      confidence: 1,
    });
    insertTx(db, {
      id: 'open-missing',
      date: '2024-10-09',
      merchant: 'Insurance',
      chfAmount: 20,
      source: 'fixed',
      fixedMissing: true,
      reviewed: false,
      confidence: 1,
    });

    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.flagged, 2);
    assert.deepStrictEqual(summary.flaggedBreakdown, {
      fixedChanged: 1,
      fixedMissing: 1,
      lowConfidence: 0,
      newMerchant: 0,
    });
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary omits month-over-month delta when the previous month is empty', () => {
  withMonth('./test-output-summary-nodelta.sqlite', db => {
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.previousMonth, '2024-09');
    assert.strictEqual(summary.delta, undefined);
    const text = formatSummary(summary);
    assert.match(text, /previous month not loaded/);
    assert.doesNotMatch(text, /vs 2024-09/);
  });
});

test('summary treats a stray non-bank previous-month row as not loaded', () => {
  withMonth('./test-output-summary-stray.sqlite', db => {
    insertTx(db, {
      id: 'sep-sw',
      date: '2024-09-10',
      source: 'splitwise',
      merchant: 'Stray',
      chfAmount: 5,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.delta, undefined);
    assert.match(formatSummary(summary), /previous month not loaded/);
  });
});

function parsedBank(date: string, merchant: string, amount: number, fileRowIndex: number): ParsedTransaction {
  return {
    date,
    merchant,
    originalAmount: amount,
    originalCurrency: 'CHF',
    source: 'neon',
    fileRowIndex,
  };
}

test('summary ignores statement spill-over dates when deciding previous month loaded', async () => {
  const dbPath = './test-output-summary-spillover.sqlite';
  const db = new DB(dbPath);
  try {
    const rows: ParsedTransaction[] = [
      parsedBank('2024-09-30', 'Spill A', 10, 0),
      parsedBank('2024-09-30', 'Spill B', 11, 1),
      parsedBank('2024-09-30', 'Spill C', 12, 2),
    ];
    for (let day = 1; day <= 6; day++) {
      rows.push(parsedBank(`2024-10-0${day}`, `Oct ${day}`, 5, 2 + day));
    }
    await importTransactions(db, rows, { file: 'october-neon.csv' });

    assert.strictEqual(db.monthCoveredByImport('2024-10'), true);
    assert.strictEqual(db.monthCoveredByImport('2024-09'), false);
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.delta, undefined);
    assert.match(formatSummary(summary), /previous month not loaded/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary treats five distinct bank dates in an import as covering the month', async () => {
  const dbPath = './test-output-summary-five-dates.sqlite';
  const db = new DB(dbPath);
  try {
    const rows = [1, 2, 3, 4, 5].map(day =>
      parsedBank(`2024-09-0${day}`, `Sep ${day}`, 10, day)
    );
    await importTransactions(db, rows, { file: 'september-neon.csv' });
    assert.strictEqual(db.monthCoveredByImport('2024-09'), true);

    insertTx(db, {
      id: 'oct-1',
      date: '2024-10-10',
      merchant: 'October',
      chfAmount: 7,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.previousMonth, '2024-09');
    assert.ok(summary.delta !== undefined);
    assert.doesNotMatch(formatSummary(summary), /previous month not loaded/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary does not treat four distinct dates as covering the month', async () => {
  const dbPath = './test-output-summary-four-dates.sqlite';
  const db = new DB(dbPath);
  try {
    const rows = [1, 2, 3, 4].map(day =>
      parsedBank(`2024-09-0${day}`, `Sep ${day}`, 10, day)
    );
    await importTransactions(db, rows, { file: 'september-partial.csv' });
    assert.strictEqual(db.monthCoveredByImport('2024-09'), false);
    insertTx(db, {
      id: 'oct-1',
      date: '2024-10-10',
      merchant: 'October',
      chfAmount: 7,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const summary = buildSummary(db, '2024-10');
    assert.strictEqual(summary.delta, undefined);
    assert.match(formatSummary(summary), /previous month not loaded/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('summary treats an import --month as covering that month even with one date', async () => {
  const dbPath = './test-output-summary-statement-month.sqlite';
  const db = new DB(dbPath);
  try {
    await importTransactions(
      db,
      [parsedBank('2024-09-30', 'Late', 3, 0)],
      { file: 'september-neon.csv', statementMonth: '2024-09' }
    );
    assert.strictEqual(db.monthCoveredByImport('2024-09'), true);
    insertTx(db, {
      id: 'oct-1',
      date: '2024-10-10',
      merchant: 'October',
      chfAmount: 7,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const summary = buildSummary(db, '2024-10');
    assert.ok(summary.delta !== undefined);
    assert.doesNotMatch(formatSummary(summary), /previous month not loaded/);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('Splitwise adjustment matches token overlap within 31 days and does not change totals', () => {
  const dbPath = './test-output-sw-window.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'fest-bank',
      date: '2024-10-01',
      merchant: 'Festival',
      chfAmount: 100,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    insertTx(db, {
      id: 'fest-sw',
      date: '2024-10-05',
      source: 'splitwise',
      merchant: 'Festival tickets',
      chfAmount: -50,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    insertTx(db, {
      id: 'too-big-sw',
      date: '2024-10-06',
      source: 'splitwise',
      merchant: 'Festival merch',
      chfAmount: -120,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const totalBefore = db.getMonthTotal('2024-10');
    const rows = buildLedger(db, '2024-10');
    const bank = rows.find(r => r.id === 'fest-bank');
    assert.strictEqual(bank?.splitwiseAdjustment, -50);
    assert.ok(!rows.some(r => r.splitwiseAdjustment === -120), 'share larger than the charge must not link');
    assert.strictEqual(db.getMonthTotal('2024-10'), totalBefore);
    const amountSum = rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0);
    assert.strictEqual(amountSum, Math.round(totalBefore * 100));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('Splitwise links each share at most once and prefers the closer date', () => {
  const dbPath = './test-output-sw-once.sqlite';
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'cafe-1',
      date: '2024-10-01',
      merchant: 'Café Central',
      chfAmount: 40,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    insertTx(db, {
      id: 'cafe-2',
      date: '2024-10-20',
      merchant: 'Cafe Central',
      chfAmount: 40,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    insertTx(db, {
      id: 'cafe-sw',
      date: '2024-10-03',
      source: 'splitwise',
      merchant: 'Cafe dinner',
      chfAmount: -15,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    const rows = buildLedger(db, '2024-10');
    const first = rows.find(r => r.id === 'cafe-1');
    const second = rows.find(r => r.id === 'cafe-2');
    assert.strictEqual(first?.splitwiseAdjustment, -15);
    assert.strictEqual(second?.splitwiseAdjustment, null);
    assert.ok(merchantsMatch('Café Central', 'Cafe dinner'));
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('ledger and expences-row round with largest remainder so displayed amounts sum to the month total', () => {
  const dbPath = './test-output-round.sqlite';
  const prev = process.env.CATEGORY_CONFIG;
  process.env.CATEGORY_CONFIG = categoryConfig;
  const db = new DB(dbPath);
  try {
    insertTx(db, {
      id: 'half-a',
      date: '2024-10-01',
      merchant: 'A',
      chfAmount: 0.005,
      category: 'Meals/Snacks',
      confidence: 1,
    });
    insertTx(db, {
      id: 'half-b',
      date: '2024-10-02',
      merchant: 'B',
      chfAmount: 0.005,
      category: 'Shopping/Purchases',
      confidence: 1,
    });
    assert.strictEqual(db.getMonthTotal('2024-10'), 0.01);

    const rows = buildLedger(db, '2024-10');
    const ledgerSum = rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0);
    assert.strictEqual(ledgerSum, 1);
    assert.ok(rows.every(r => Number.isInteger(Math.round(r.amount * 100))));
    const csv = ledgerCsv(rows);
    const csvAmounts = [...csv.matchAll(/,(\d+\.\d{2}),/g)].map(m => m[1]);
    const csvSum = csvAmounts.reduce((sum, n) => sum + Math.round(Number(n) * 100), 0);
    assert.strictEqual(csvSum, 1);

    const expences = buildExpencesRow(db, '2024-10', loadCategories(categoryConfig));
    const cellsSum = Math.round(Object.values(expences.cells).reduce((s, n) => s + n, 0) * 100);
    assert.strictEqual(expences.total, 0.01);
    assert.strictEqual(cellsSum, 1);
    assert.strictEqual(Math.round(expences.cellsSum * 100), 1);
  } finally {
    db.close();
    unlinkSync(dbPath);
    if (prev === undefined) delete process.env.CATEGORY_CONFIG;
    else process.env.CATEGORY_CONFIG = prev;
  }
});

test('ledger and expences-row CLI write --out files', () => {
  const dbPath = './test-output-cli.sqlite';
  const csvPath = './test-output-cli-ledger.csv';
  const jsonPath = './test-output-cli-expences.json';
  withMonth(dbPath, () => {
    try {
      const ledger = spawnSync(
        process.execPath,
        ['dist/cli.js', 'ledger', '--month', '2024-10', '--out', csvPath],
        { encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath, CATEGORY_CONFIG: categoryConfig } }
      );
      assert.strictEqual(ledger.status, 0, ledger.stderr);
      const csv = readFileSync(csvPath, 'utf8');
      assert.match(csv, /Department Store,20\.00,Meals\/Snacks/);
      assert.doesNotMatch(csv, /Hidden/);

      const expences = spawnSync(
        process.execPath,
        ['dist/cli.js', 'expences-row', '--month', '2024-10', '--out', jsonPath],
        { encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath, CATEGORY_CONFIG: categoryConfig } }
      );
      assert.strictEqual(expences.status, 0, expences.stderr);
      const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
      assert.strictEqual(json.month, '2024-10');
      assert.strictEqual(json.cells.C, 35);
      assert.strictEqual(json.cells.E, 0);
      assert.strictEqual(json.unmapped[0].category, 'Misc/Unmapped');

      const summary = spawnSync(
        process.execPath,
        ['dist/cli.js', 'summary', '--month', '2024-10'],
        { encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath, CATEGORY_CONFIG: categoryConfig } }
      );
      assert.strictEqual(summary.status, 0, summary.stderr);
      assert.match(summary.stdout, /Total: 73\.00/);
      assert.match(summary.stdout, /Flagged: 2/);
    } finally {
      try { unlinkSync(csvPath); } catch {}
      try { unlinkSync(jsonPath); } catch {}
    }
  });
});
