import Database from 'better-sqlite3';
import { Transaction, FxRate, TransactionSplit } from './types.js';
import { importTransactionId, repairMojibake } from './parsers/utils.js';

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
        imported_at TEXT NOT NULL,
        category TEXT,
        confidence REAL,
        explanation TEXT,
        categorization_source TEXT,
        reviewed INTEGER DEFAULT 0,
        new_merchant INTEGER DEFAULT 0,
        unusual_amount INTEGER DEFAULT 0,
        possible_duplicate INTEGER DEFAULT 0,
        unconverted_fx INTEGER DEFAULT 0,
        fixed_missing INTEGER DEFAULT 0,
        fixed_changed INTEGER DEFAULT 0,
        covered_by_fixed_bill TEXT,
        kind TEXT,
        excluded INTEGER DEFAULT 0,
        exclude_override TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
      CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source);
      CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant);

      CREATE TABLE IF NOT EXISTS fx_rates (
        date TEXT NOT NULL,
        currency TEXT NOT NULL,
        rate_from_chf REAL NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (date, currency)
      );

      CREATE INDEX IF NOT EXISTS idx_fx_rates_currency ON fx_rates(currency, date);

      CREATE TABLE IF NOT EXISTS merchant_memory (
        normalized_merchant TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        times_used INTEGER DEFAULT 1,
        last_used TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categorization_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS transaction_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL,
        category TEXT NOT NULL,
        chf_amount REAL NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_splits_transaction ON transaction_splits(transaction_id);
    `);
    this.ensureColumn('transactions', 'exclude_override', 'TEXT');
    this.migrateImportIds();
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private migrateImportIds(): void {
    type Row = {
      id: string;
      date: string;
      source: string;
      merchant: string;
      description: string | null;
      originalAmount: number;
      fileRowIndex: number;
      importedAt: string;
      reviewed: number;
      category: string | null;
    };

    const rows = this.db.prepare(`
      SELECT
        id, date, source, merchant, description,
        original_amount as originalAmount,
        file_row_index as fileRowIndex,
        imported_at as importedAt,
        reviewed, category
      FROM transactions
      WHERE source NOT IN ('fixed', 'splitwise', 'sbb', 'twint')
        AND id NOT LIKE 'fixed:%'
        AND id NOT LIKE 'sw-%'
        AND id NOT LIKE 'twi-%'
    `).all() as Row[];

    if (rows.length === 0) return;

    const repairMerchant = this.db.prepare('UPDATE transactions SET merchant = ? WHERE id = ?');
    for (const row of rows) {
      const repaired = repairMojibake(row.merchant);
      if (repaired !== row.merchant) {
        repairMerchant.run(repaired, row.id);
        row.merchant = repaired;
      }
    }

    const deleteTx = this.db.prepare('DELETE FROM transactions WHERE id = ?');
    const deleteSplits = this.db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?');
    const moveSplits = this.db.prepare(
      'UPDATE transaction_splits SET transaction_id = ? WHERE transaction_id = ?'
    );
    const rename = this.db.prepare('UPDATE transactions SET id = ? WHERE id = ?');

    const score = (row: Row) => (row.reviewed ? 100 : 0) + (row.category ? 10 : 0);

    const collapseInto = (survivor: Row, extra: Row) => {
      const survivorHasSplits = this.db.prepare(
        'SELECT 1 FROM transaction_splits WHERE transaction_id = ?'
      ).get(survivor.id);
      if (!survivorHasSplits) {
        moveSplits.run(survivor.id, extra.id);
      } else {
        deleteSplits.run(extra.id);
      }
      deleteTx.run(extra.id);
    };

    const apply = this.db.transaction(() => {
      const byRow = new Map<string, Row[]>();
      for (const row of rows) {
        const key = `${row.source}|${row.date}|${row.originalAmount}|${row.merchant}|${row.fileRowIndex}`;
        const group = byRow.get(key) || [];
        group.push(row);
        byRow.set(key, group);
      }

      const surviving: Row[] = [];
      for (const group of byRow.values()) {
        group.sort((a, b) => {
          const byScore = score(b) - score(a);
          if (byScore !== 0) return byScore;
          return a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : a.id.localeCompare(b.id);
        });
        const survivor = group[0];
        for (const extra of group.slice(1)) {
          collapseInto(survivor, extra);
        }
        surviving.push(survivor);
      }

      surviving.sort((a, b) => {
        if (a.source !== b.source) return a.source.localeCompare(b.source);
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.originalAmount !== b.originalAmount) return a.originalAmount - b.originalAmount;
        if (a.merchant !== b.merchant) return a.merchant.localeCompare(b.merchant);
        if (a.fileRowIndex !== b.fileRowIndex) return a.fileRowIndex - b.fileRowIndex;
        return a.id.localeCompare(b.id);
      });

      const occurrence = new Map<string, number>();
      for (const row of surviving) {
        const tuple = `${row.source}|${row.date}|${row.originalAmount}|${row.merchant}`;
        const n = (occurrence.get(tuple) || 0) + 1;
        occurrence.set(tuple, n);
        const newId = importTransactionId(row.source, row.date, row.originalAmount, row.merchant, n);
        if (newId === row.id) continue;

        const taken = this.db.prepare('SELECT id FROM transactions WHERE id = ?').get(newId) as { id: string } | undefined;
        if (taken) {
          collapseInto({ ...row, id: taken.id }, row);
        } else {
          moveSplits.run(newId, row.id);
          rename.run(newId, row.id);
          row.id = newId;
        }
      }
    });
    apply();
  }

  insertTransaction(tx: Transaction): void {
    const existing = this.getTransaction(tx.id);
    
    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE transactions
        SET date = ?, source = ?, source_card = ?, merchant = ?, description = ?,
            original_amount = ?, original_currency = ?, chf_amount = ?,
            fx_rate = ?, fx_rate_date = ?, fx_conversion_failed = ?,
            file_row_index = ?, imported_at = ?, kind = ?
        WHERE id = ?
      `);
      
      updateStmt.run(
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
        tx.importedAt,
        tx.kind || null,
        tx.id
      );
    } else {
      const insertStmt = this.db.prepare(`
        INSERT INTO transactions (
          id, date, source, source_card, merchant, description,
          original_amount, original_currency, chf_amount,
          fx_rate, fx_rate_date, fx_conversion_failed,
          file_row_index, imported_at,
          category, confidence, explanation, categorization_source, reviewed,
          new_merchant, unusual_amount, possible_duplicate, unconverted_fx,
          fixed_missing, fixed_changed, covered_by_fixed_bill, kind, excluded,
          exclude_override
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
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
        tx.importedAt,
        tx.category || null,
        tx.confidence ?? null,
        tx.explanation || null,
        tx.categorizationSource || null,
        tx.reviewed ? 1 : 0,
        tx.newMerchant ? 1 : 0,
        tx.unusualAmount ? 1 : 0,
        tx.possibleDuplicate ? 1 : 0,
        tx.unconvertedFx ? 1 : 0,
        tx.fixedMissing ? 1 : 0,
        tx.fixedChanged ? 1 : 0,
        tx.coveredByFixedBill || null,
        tx.kind || null,
        tx.excluded ? 1 : 0,
        tx.excludeOverride || null
      );
    }
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
        file_row_index as fileRowIndex, imported_at as importedAt,
        category, confidence, explanation,
        categorization_source as categorizationSource, reviewed,
        new_merchant as newMerchant, unusual_amount as unusualAmount,
        possible_duplicate as possibleDuplicate, unconverted_fx as unconvertedFx,
        fixed_missing as fixedMissing, fixed_changed as fixedChanged,
        covered_by_fixed_bill as coveredByFixedBill, kind, excluded,
        exclude_override as excludeOverride
      FROM transactions
      WHERE date LIKE ? || '%'
      ORDER BY date, file_row_index
    `);
    const rows = stmt.all(yearMonth) as any[];
    return this.attachSplits(rows.map(row => this.mapTransaction(row)));
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

  getTransaction(id: string): Transaction | undefined {
    const stmt = this.db.prepare(`
      SELECT
        id, date, source, source_card as sourceCard, merchant, description,
        original_amount as originalAmount, original_currency as originalCurrency,
        chf_amount as chfAmount, fx_rate as fxRate, fx_rate_date as fxRateDate,
        fx_conversion_failed as fxConversionFailed,
        file_row_index as fileRowIndex, imported_at as importedAt,
        category, confidence, explanation,
        categorization_source as categorizationSource, reviewed,
        new_merchant as newMerchant, unusual_amount as unusualAmount,
        possible_duplicate as possibleDuplicate, unconverted_fx as unconvertedFx,
        fixed_missing as fixedMissing, fixed_changed as fixedChanged,
        covered_by_fixed_bill as coveredByFixedBill, kind, excluded,
        exclude_override as excludeOverride
      FROM transactions
      WHERE id = ?
    `);
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.attachSplits([this.mapTransaction(row)])[0];
  }

  deleteTransaction(id: string): void {
    const stmt = this.db.prepare('DELETE FROM transactions WHERE id = ?');
    stmt.run(id);
  }

  updateTransactionCategorization(
    id: string,
    category: string,
    confidence: number,
    explanation: string,
    source: 'merchant_memory' | 'rule' | 'unknown',
    anomalies: {
      newMerchant: boolean;
      unusualAmount: boolean;
      possibleDuplicate: boolean;
      unconvertedFx: boolean;
    }
  ): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET category = ?, confidence = ?, explanation = ?, categorization_source = ?,
          new_merchant = ?, unusual_amount = ?, possible_duplicate = ?, unconverted_fx = ?
      WHERE id = ?
    `);
    stmt.run(
      category,
      confidence,
      explanation,
      source,
      anomalies.newMerchant ? 1 : 0,
      anomalies.unusualAmount ? 1 : 0,
      anomalies.possibleDuplicate ? 1 : 0,
      anomalies.unconvertedFx ? 1 : 0,
      id
    );
  }

  recordCorrection(normalizedMerchant: string, category: string): void {
    const now = new Date().toISOString();
    const existing = this.getMerchantMemory(normalizedMerchant);
    
    if (existing && existing.category !== category) {
      const stmt = this.db.prepare(`
        UPDATE merchant_memory
        SET category = ?, times_used = 1, last_used = ?
        WHERE normalized_merchant = ?
      `);
      stmt.run(category, now, normalizedMerchant);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO merchant_memory (normalized_merchant, category, times_used, last_used)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(normalized_merchant) DO UPDATE SET
          category = excluded.category,
          times_used = times_used + 1,
          last_used = excluded.last_used
      `);
      stmt.run(normalizedMerchant, category, now);
    }
  }

  getMerchantMemory(normalizedMerchant: string): { category: string; timesUsed: number } | undefined {
    const stmt = this.db.prepare(`
      SELECT category, times_used as timesUsed
      FROM merchant_memory
      WHERE normalized_merchant = ?
    `);
    return stmt.get(normalizedMerchant) as { category: string; timesUsed: number } | undefined;
  }

  getAllMerchantHistory(): Array<{ normalizedMerchant: string; timesUsed: number }> {
    const stmt = this.db.prepare(`
      SELECT normalized_merchant as normalizedMerchant, times_used as timesUsed
      FROM merchant_memory
    `);
    return stmt.all() as Array<{ normalizedMerchant: string; timesUsed: number }>;
  }

  getTransactionsByMerchant(normalizedMerchant: string): Transaction[] {
    const stmt = this.db.prepare(`
      SELECT
        id, date, source, source_card as sourceCard, merchant, description,
        original_amount as originalAmount, original_currency as originalCurrency,
        chf_amount as chfAmount, fx_rate as fxRate, fx_rate_date as fxRateDate,
        fx_conversion_failed as fxConversionFailed,
        file_row_index as fileRowIndex, imported_at as importedAt,
        category, confidence, explanation,
        categorization_source as categorizationSource, reviewed,
        new_merchant as newMerchant, unusual_amount as unusualAmount,
        possible_duplicate as possibleDuplicate, unconverted_fx as unconvertedFx,
        fixed_missing as fixedMissing, fixed_changed as fixedChanged,
        covered_by_fixed_bill as coveredByFixedBill, kind, excluded,
        exclude_override as excludeOverride
      FROM transactions
      WHERE merchant = ?
      ORDER BY date DESC
    `);
    const rows = stmt.all(normalizedMerchant) as any[];
    return this.attachSplits(rows.map(row => this.mapTransaction(row)));
  }

  getTransactionsByDateRange(startDate: string, endDate: string): Transaction[] {
    const stmt = this.db.prepare(`
      SELECT
        id, date, source, source_card as sourceCard, merchant, description,
        original_amount as originalAmount, original_currency as originalCurrency,
        chf_amount as chfAmount, fx_rate as fxRate, fx_rate_date as fxRateDate,
        fx_conversion_failed as fxConversionFailed,
        file_row_index as fileRowIndex, imported_at as importedAt,
        category, confidence, explanation,
        categorization_source as categorizationSource, reviewed,
        new_merchant as newMerchant, unusual_amount as unusualAmount,
        possible_duplicate as possibleDuplicate, unconverted_fx as unconvertedFx,
        fixed_missing as fixedMissing, fixed_changed as fixedChanged,
        covered_by_fixed_bill as coveredByFixedBill, kind, excluded,
        exclude_override as excludeOverride
      FROM transactions
      WHERE date >= ? AND date <= ?
      ORDER BY date, file_row_index
    `);
    const rows = stmt.all(startDate, endDate) as any[];
    return this.attachSplits(rows.map(row => this.mapTransaction(row)));
  }

  getAllRules(): Array<{ id: number; pattern: string; category: string; description?: string }> {
    const stmt = this.db.prepare(`
      SELECT id, pattern, category, description
      FROM categorization_rules
      ORDER BY id
    `);
    return stmt.all() as Array<{ id: number; pattern: string; category: string; description?: string }>;
  }

  addRule(pattern: string, category: string, description?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO categorization_rules (pattern, category, description)
      VALUES (?, ?, ?)
    `);
    stmt.run(pattern, category, description || null);
  }

  markAsReviewed(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET reviewed = 1
      WHERE id = ?
    `);
    stmt.run(id);
  }

  markAsCoveredByFixedBill(id: string, billLabel: string, fixedChanged: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET covered_by_fixed_bill = ?,
          explanation = ?,
          fixed_changed = ?
      WHERE id = ?
    `);
    stmt.run(
      billLabel,
      `paid via fixed bill: ${billLabel}`,
      fixedChanged ? 1 : 0,
      id
    );
  }

  flagAmountChanged(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE transactions SET fixed_changed = 1 WHERE id = ?
    `);
    stmt.run(id);
  }

  setFixedReviewFlags(id: string, missing: boolean, changed: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE transactions
      SET fixed_missing = ?, fixed_changed = ?
      WHERE id = ?
    `);
    stmt.run(missing ? 1 : 0, changed ? 1 : 0, id);
  }

  getMonthTotal(yearMonth: string): number {
    const stmt = this.db.prepare(`
      SELECT SUM(chf_amount) as total
      FROM transactions
      WHERE date LIKE ? || '%'
        AND covered_by_fixed_bill IS NULL
        AND (excluded IS NULL OR excluded = 0)
    `);
    const result = stmt.get(yearMonth) as { total: number | null };
    return result.total || 0;
  }

  setSplits(transactionId: string, splits: TransactionSplit[]): void {
    const tx = this.getTransaction(transactionId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found`);
    }
    if (splits.length < 2) {
      throw new Error('A split needs at least two parts');
    }
    for (const part of splits) {
      if (!part.category.trim()) {
        throw new Error('Each split part needs a category');
      }
      if (!Number.isFinite(part.chfAmount)) {
        throw new Error(`Invalid amount for ${part.category}`);
      }
    }

    const sumCents = splits.reduce((acc, s) => acc + Math.round(s.chfAmount * 100), 0);
    const txCents = Math.round(tx.chfAmount * 100);
    if (sumCents !== txCents) {
      const sum = (sumCents / 100).toFixed(2);
      throw new Error(`Split amounts (${sum}) must sum to transaction amount (${tx.chfAmount.toFixed(2)})`);
    }

    const replace = this.db.transaction((parts: TransactionSplit[]) => {
      this.db.prepare('DELETE FROM transaction_splits WHERE transaction_id = ?').run(transactionId);
      const insert = this.db.prepare(`
        INSERT INTO transaction_splits (transaction_id, category, chf_amount)
        VALUES (?, ?, ?)
      `);
      for (const part of parts) {
        insert.run(transactionId, part.category, part.chfAmount);
      }
    });
    replace(splits);
  }

  setExcluded(id: string, excluded: boolean, manual = false): void {
    if (manual) {
      const stmt = this.db.prepare(`
        UPDATE transactions
        SET excluded = ?, exclude_override = ?
        WHERE id = ?
      `);
      stmt.run(excluded ? 1 : 0, excluded ? 'exclude' : 'include', id);
      return;
    }
    const stmt = this.db.prepare('UPDATE transactions SET excluded = ? WHERE id = ?');
    stmt.run(excluded ? 1 : 0, id);
  }

  getSplits(transactionId: string): TransactionSplit[] {
    const stmt = this.db.prepare(`
      SELECT category, chf_amount as chfAmount
      FROM transaction_splits
      WHERE transaction_id = ?
      ORDER BY id
    `);
    return stmt.all(transactionId) as TransactionSplit[];
  }

  private mapTransaction(row: any): Transaction {
    return {
      ...row,
      fxConversionFailed: !!row.fxConversionFailed,
      reviewed: !!row.reviewed,
      newMerchant: !!row.newMerchant,
      unusualAmount: !!row.unusualAmount,
      possibleDuplicate: !!row.possibleDuplicate,
      unconvertedFx: !!row.unconvertedFx,
      fixedMissing: !!row.fixedMissing,
      fixedChanged: !!row.fixedChanged,
      excluded: !!row.excluded,
      excludeOverride: row.excludeOverride || undefined
    };
  }

  private attachSplits(transactions: Transaction[]): Transaction[] {
    if (transactions.length === 0) return transactions;

    const ids = transactions.map(t => t.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT transaction_id as transactionId, category, chf_amount as chfAmount
      FROM transaction_splits
      WHERE transaction_id IN (${placeholders})
      ORDER BY id
    `).all(...ids) as Array<{ transactionId: string; category: string; chfAmount: number }>;

    const byId = new Map<string, TransactionSplit[]>();
    for (const row of rows) {
      const list = byId.get(row.transactionId) || [];
      list.push({ category: row.category, chfAmount: row.chfAmount });
      byId.set(row.transactionId, list);
    }

    return transactions.map(tx => {
      const splits = byId.get(tx.id);
      return splits && splits.length > 0 ? { ...tx, splits } : tx;
    });
  }

  close(): void {
    this.db.close();
  }
}
