import { describe, it, before, after, test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { DB } from './db.js';
import { importTransactions } from './import.js';
import { ParsedTransaction, Transaction } from './types.js';
import { parseRevolutCsv } from './parsers/revolut.js';
import { importTransactionId } from './parsers/utils.js';
import { unlinkSync } from 'fs';

function parsed(partial: Partial<ParsedTransaction> & { date: string; merchant: string; originalAmount: number }): ParsedTransaction {
  return {
    originalCurrency: 'CHF',
    source: 'neon',
    fileRowIndex: 0,
    ...partial
  };
}

describe('Import module', () => {
  const testDbPath = './test-import.sqlite';
  let db: DB;

  before(() => {
    db = new DB(testDbPath);
  });

  after(() => {
    db.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });

  it('should generate unique IDs for same-day duplicates', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-15',
        merchant: 'MIGROS',
        originalAmount: 45.50,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 0,
      },
      {
        date: '2024-10-15',
        merchant: 'MIGROS',
        originalAmount: 45.50,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 1,
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    assert.strictEqual(transactions.length, 2);
    assert.notStrictEqual(transactions[0].id, transactions[1].id);
  });

  it('should be idempotent on re-import', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-16',
        merchant: 'COOP',
        originalAmount: 32.10,
        originalCurrency: 'CHF',
        source: 'cembra',
        fileRowIndex: 0,
      },
    ];

    const first = await importTransactions(db, parsed);
    assert.deepStrictEqual(first, { new: 1, unchanged: 0 });
    const firstImport = db.getTransactionsByMonth('2024-10');
    const initialCount = firstImport.length;

    const second = await importTransactions(db, parsed);
    assert.deepStrictEqual(second, { new: 0, unchanged: 1 });
    const secondImport = db.getTransactionsByMonth('2024-10');

    assert.strictEqual(secondImport.length, initialCount);
  });

  it('should preserve FX conversion metadata', async () => {
    db.saveFxRate({
      date: '2024-10-17',
      currency: 'EUR',
      rateFromCHF: 0.95,
      fetchedAt: new Date().toISOString(),
    });

    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-17',
        merchant: 'AMAZON',
        originalAmount: 95,
        originalCurrency: 'EUR',
        source: 'swisscard',
        fileRowIndex: 0,
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    const tx = transactions.find(t => t.merchant === 'AMAZON');

    assert.ok(tx);
    assert.strictEqual(tx.originalAmount, 95);
    assert.strictEqual(tx.originalCurrency, 'EUR');
    assert.strictEqual(tx.chfAmount, 100);
    assert.strictEqual(tx.fxRate, 0.95);
  });

  it('should exclude transfers, income, and top-ups by kind', async () => {
    const parsed: ParsedTransaction[] = [
      {
        date: '2024-10-18',
        merchant: 'MIGROS',
        originalAmount: 50,
        originalCurrency: 'CHF',
        source: 'revolut',
        fileRowIndex: 0,
        kind: 'expense',
      },
      {
        date: '2024-10-18',
        merchant: 'Salary',
        originalAmount: -5000,
        originalCurrency: 'CHF',
        source: 'revolut',
        fileRowIndex: 1,
        kind: 'income',
      },
      {
        date: '2024-10-18',
        merchant: 'Bank transfer',
        originalAmount: 100,
        originalCurrency: 'CHF',
        source: 'neon',
        fileRowIndex: 2,
        kind: 'transfer',
      },
    ];

    await importTransactions(db, parsed);

    const transactions = db.getTransactionsByMonth('2024-10');
    const expense = transactions.find(t => t.merchant === 'MIGROS' && t.date === '2024-10-18');
    const income = transactions.find(t => t.merchant === 'Salary');
    const transfer = transactions.find(t => t.merchant === 'Bank transfer');

    assert.ok(expense);
    assert.strictEqual(expense.excluded, false);
    
    assert.ok(income);
    assert.strictEqual(income.excluded, true);
    
    assert.ok(transfer);
    assert.strictEqual(transfer.excluded, true);
  });

  it('excludes Revolut Topup/Transfer/Exchange but keeps Card Refund as expense', async () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2024-11-01 10:30:00,2024-11-01 10:30:05,COOP,-12.00,0,CHF,COMPLETED,1000.00
Card Refund,Current,2024-11-02 11:00:00,2024-11-02 11:00:05,COOP Refund,5.00,0,CHF,COMPLETED,1005.00
Topup,Current,2024-11-03 09:00:00,2024-11-03 09:00:05,Top-up from debit card,80.00,0,CHF,COMPLETED,1085.00
Transfer,Current,2024-11-04 09:00:00,2024-11-04 09:00:15,To savings space,-40.00,0,CHF,COMPLETED,1045.00
Exchange,Current,2024-11-05 09:00:00,2024-11-05 09:00:15,Exchanged to EUR,-20.00,0.50,EUR,COMPLETED,1025.00`;

    await importTransactions(db, parseRevolutCsv(csv));

    const txs = db.getTransactionsByMonth('2024-11');
    const payment = txs.find(t => t.merchant === 'COOP');
    const refund = txs.find(t => t.merchant === 'COOP Refund');
    const topup = txs.find(t => t.kind === 'top-up');
    const transfer = txs.find(t => t.kind === 'transfer');
    const exchange = txs.find(t => t.kind === 'exchange');

    assert.strictEqual(payment?.excluded, false);
    assert.strictEqual(payment?.chfAmount, 12.00);

    assert.strictEqual(refund?.excluded, false);
    assert.strictEqual(refund?.kind, 'expense');
    assert.strictEqual(refund?.chfAmount, -5.00);

    assert.strictEqual(topup?.excluded, true);
    assert.strictEqual(transfer?.excluded, true);
    assert.strictEqual(exchange?.excluded, true);
  });
});

test('overlapping exports of the same source do not duplicate rows when earlier rows are prepended', async () => {
  const dbPath = './test-import-overlap.sqlite';
  const db = new DB(dbPath);
  try {
    const oneMonth: ParsedTransaction[] = [
      parsed({ date: '2024-12-10', merchant: 'COOP', originalAmount: 12, fileRowIndex: 0 }),
      parsed({ date: '2024-12-15', merchant: 'MIGROS', originalAmount: 40, fileRowIndex: 1 }),
    ];
    const twoMonth: ParsedTransaction[] = [
      parsed({ date: '2024-11-02', merchant: 'SBB', originalAmount: 5, fileRowIndex: 0 }),
      parsed({ date: '2024-11-20', merchant: 'Pending extra', originalAmount: 3, fileRowIndex: 1 }),
      parsed({ date: '2024-12-10', merchant: 'COOP', originalAmount: 12, fileRowIndex: 2 }),
      parsed({ date: '2024-12-15', merchant: 'MIGROS', originalAmount: 40, fileRowIndex: 3 }),
    ];

    await importTransactions(db, oneMonth);
    await importTransactions(db, twoMonth);

    const nov = db.getTransactionsByMonth('2024-11');
    const dec = db.getTransactionsByMonth('2024-12');
    assert.strictEqual(nov.length, 2);
    assert.strictEqual(dec.filter(t => t.merchant === 'COOP').length, 1);
    assert.strictEqual(dec.filter(t => t.merchant === 'MIGROS').length, 1);
    assert.strictEqual(dec.length, 2);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('two same-day identical purchases stay two rows across re-import', async () => {
  const dbPath = './test-import-identical-pair.sqlite';
  const db = new DB(dbPath);
  try {
    const file: ParsedTransaction[] = [
      parsed({ date: '2024-12-20', merchant: 'MIGROS', originalAmount: 45.5, fileRowIndex: 0 }),
      parsed({ date: '2024-12-20', merchant: 'MIGROS', originalAmount: 45.5, fileRowIndex: 1 }),
    ];

    await importTransactions(db, file);
    assert.strictEqual(db.getTransactionsByMonth('2024-12').length, 2);

    await importTransactions(db, file);
    assert.strictEqual(db.getTransactionsByMonth('2024-12').length, 2);

    const shifted: ParsedTransaction[] = [
      parsed({ date: '2024-12-01', merchant: 'Earlier', originalAmount: 1, fileRowIndex: 0 }),
      parsed({ date: '2024-12-20', merchant: 'MIGROS', originalAmount: 45.5, fileRowIndex: 4 }),
      parsed({ date: '2024-12-20', merchant: 'MIGROS', originalAmount: 45.5, fileRowIndex: 5 }),
    ];
    await importTransactions(db, shifted);
    const migros = db.getTransactionsByMonth('2024-12').filter(t => t.merchant === 'MIGROS');
    assert.strictEqual(migros.length, 2);
  } finally {
    db.close();
    unlinkSync(dbPath);
  }
});

test('re-import after mojibake repair does not duplicate a pre-fix row', async () => {
  const dbPath = './test-import-mojibake-migrate.sqlite';
  const garbled = Buffer.from('Ταβέρνα', 'utf8').toString('latin1');
  const db = new DB(dbPath);
  try {
    db.insertTransaction({
      id: 'old-garbled-id',
      date: '2024-12-08',
      source: 'swisscard',
      merchant: garbled,
      originalAmount: 18.5,
      originalCurrency: 'CHF',
      chfAmount: 18.5,
      fileRowIndex: 7,
      importedAt: '2024-12-08T10:00:00.000Z',
    } as Transaction);
  } finally {
    db.close();
  }

  const migrated = new DB(dbPath);
  try {
    await importTransactions(migrated, [
      parsed({
        date: '2024-12-08',
        merchant: 'Ταβέρνα',
        originalAmount: 18.5,
        source: 'swisscard',
        fileRowIndex: 0,
      }),
    ]);
    const txs = migrated.getTransactionsByMonth('2024-12').filter(t => t.originalAmount === 18.5);
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].merchant, 'Ταβέρνα');
    assert.notStrictEqual(txs[0].id, 'old-garbled-id');
  } finally {
    migrated.close();
    unlinkSync(dbPath);
  }
});

test('migration keeps splits when a transaction id is rewritten', () => {
  const dbPath = './test-import-migrate-splits.sqlite';
  const db = new DB(dbPath);
  try {
    db.insertTransaction({
      id: 'old-split-id',
      date: '2024-12-08',
      source: 'swisscard',
      merchant: 'Department Store',
      originalAmount: 51,
      originalCurrency: 'CHF',
      chfAmount: 51,
      fileRowIndex: 3,
      importedAt: '2024-12-08T10:00:00.000Z',
    } as Transaction);
    db.setSplits('old-split-id', [
      { category: 'Shopping', chfAmount: 25.50 },
      { category: 'General gifts', chfAmount: 25.50 }
    ]);
  } finally {
    db.close();
  }

  const migrated = new DB(dbPath);
  try {
    const txs = migrated.getTransactionsByMonth('2024-12');
    assert.strictEqual(txs.length, 1);
    assert.notStrictEqual(txs[0].id, 'old-split-id');
    assert.strictEqual(txs[0].splits?.length, 2);
    assert.strictEqual(txs[0].splits?.[0].category, 'Shopping');
    assert.strictEqual(txs[0].splits?.[0].chfAmount, 25.50);
    assert.strictEqual(txs[0].splits?.[1].category, 'General gifts');
    assert.strictEqual(txs[0].splits?.[1].chfAmount, 25.50);
  } finally {
    migrated.close();
    unlinkSync(dbPath);
  }
});

test('a failed import-id migration leaves the database unchanged', () => {
  const dbPath = './test-import-migrate-rollback.sqlite';
  const garbled = Buffer.from('Ταβέρνα', 'utf8').toString('latin1');
  const db = new DB(dbPath);
  try {
    db.insertTransaction({
      id: 'old-garbled-id',
      date: '2024-12-08',
      source: 'swisscard',
      merchant: garbled,
      originalAmount: 18.5,
      originalCurrency: 'CHF',
      chfAmount: 18.5,
      fileRowIndex: 7,
      importedAt: '2024-12-08T10:00:00.000Z',
    } as Transaction);
  } finally {
    db.close();
  }

  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TRIGGER abort_id_change
    BEFORE UPDATE OF id ON transactions
    BEGIN
      SELECT RAISE(ABORT, 'test rollback');
    END;
  `);
  sqlite.close();

  assert.throws(() => new DB(dbPath), /test rollback/);

  const inspect = new Database(dbPath);
  try {
    const row = inspect.prepare('SELECT id, merchant FROM transactions').get() as { id: string; merchant: string };
    assert.strictEqual(row.id, 'old-garbled-id');
    assert.strictEqual(row.merchant, garbled);
  } finally {
    inspect.close();
    unlinkSync(dbPath);
  }
});

test('migration collapses a pre-fix Swisscard credit stored with the old sign', () => {
  const dbPath = './test-import-swisscard-sign-migrate.sqlite';
  const correctedId = importTransactionId('swisscard', '2024-12-02', -15, 'MIGROS', 1);
  const db = new DB(dbPath);
  try {
    db.insertTransaction({
      id: 'old-positive-credit',
      date: '2024-12-02',
      source: 'swisscard',
      merchant: 'MIGROS',
      description: 'Refund',
      originalAmount: 15,
      originalCurrency: 'CHF',
      chfAmount: 15,
      fileRowIndex: 1,
      importedAt: '2024-12-02T10:00:00.000Z',
    } as Transaction);
    db.insertTransaction({
      id: correctedId,
      date: '2024-12-02',
      source: 'swisscard',
      merchant: 'MIGROS',
      description: 'Refund',
      originalAmount: -15,
      originalCurrency: 'CHF',
      chfAmount: -15,
      fileRowIndex: 1,
      importedAt: '2024-12-03T10:00:00.000Z',
    } as Transaction);
  } finally {
    db.close();
  }

  const migrated = new DB(dbPath);
  try {
    const txs = migrated.getTransactionsByMonth('2024-12').filter(t => t.merchant === 'MIGROS');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].originalAmount, -15);
    assert.strictEqual(txs[0].chfAmount, -15);
    assert.strictEqual(txs[0].id, correctedId);
  } finally {
    migrated.close();
    unlinkSync(dbPath);
  }
});
