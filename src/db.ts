import Database from 'better-sqlite3';
import { Transaction, FxRate } from './types.js';

export class DB {
  private db: Database.Database;

  constructor(path: string = './data/finances.sqlite') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        source_card TEXT,
        merchant TEXT NOT NULL,
        description TEXT,
        original_amount REAL NOT NULL,
        original_currency TEXT NOT NULL,
        chf_amount REAL NOT NULL,
        fx_rate REAL,
        fx_rate_date TEXT,
        fx_conversion_failed INTEGER DEFAULT 0,
        file_row_index INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source);

      CREATE TABLE IF NOT EXISTS fx_rates (
        date TEXT NOT NULL,
        currency TEXT NOT NULL,
        rate_from_chf REAL NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (date, currency)
      );

      CREATE INDEX IF NOT EXISTS idx_fx_rates_currency ON fx_rates(currency, date);
    `);
  }

  insertTransaction(tx: Transaction): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO transactions (
        id, date, source, source_card, merchant, description,
        original_amount, original_currency, chf_amount,
        fx_rate, fx_rate_date, fx_conversion_failed,
        file_row_index, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      tx.id,
      tx.date,
      tx.source,
      tx.sourceCard || null,
      tx.merchant,
      tx.description || null,
      tx.originalAmount,
      tx.originalCurrency,
      tx.chfAmount,
      tx.fxRate || null,
      tx.fxRateDate || null,
      tx.fxConversionFailed ? 1 : 0,
      tx.fileRowIndex,
      tx.importedAt
    );
  }

  insertTransactions(transactions: Transaction[]): void {
    const insert = this.db.transaction((txs: Transaction[]) => {
      for (const tx of txs) {
        this.insertTransaction(tx);
      }
    });
    insert(transactions);
  }

  getTransactionsByMonth(yearMonth: string): Transaction[] {
    const stmt = this.db.prepare(`
      SELECT
        id, date, source, source_card as sourceCard, merchant, description,
        original_amount as originalAmount, original_currency as originalCurrency,
        chf_amount as chfAmount, fx_rate as fxRate, fx_rate_date as fxRateDate,
        fx_conversion_failed as fxConversionFailed,
        file_row_index as fileRowIndex, imported_at as importedAt
      FROM transactions
      WHERE date LIKE ? || '%'
      ORDER BY date, file_row_index
    `);
    return stmt.all(yearMonth) as Transaction[];
  }

  saveFxRate(rate: FxRate): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO fx_rates (date, currency, rate_from_chf, fetched_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(rate.date, rate.currency, rate.rateFromCHF, rate.fetchedAt);
  }

  getFxRate(date: string, currency: string): FxRate | undefined {
    const stmt = this.db.prepare(`
      SELECT date, currency, rate_from_chf as rateFromCHF, fetched_at as fetchedAt
      FROM fx_rates
      WHERE date = ? AND currency = ?
    `);
    return stmt.get(date, currency) as FxRate | undefined;
  }

  close(): void {
    this.db.close();
  }
}
