import { writeFileSync } from 'fs';
import Papa from 'papaparse';
import { DB } from './db.js';
import { Category, Transaction } from './types.js';
import { loadCategories, columnIndex } from './categories.js';
import { getCategoryTotals } from './split.js';

export interface LedgerRow {
  date: string;
  source: string;
  merchant: string;
  amount: number;
  category: string;
  splitwiseAdjustment: number | null;
  reviewed: boolean;
  id: string;
}

export interface ExpencesRow {
  month: string;
  cells: Record<string, number>;
  unmapped: Array<{ category: string; amount: number }>;
  total: number;
  cellsSum: number;
}

export interface MonthSummary {
  month: string;
  total: number;
  topCategories: Array<{ category: string; amount: number }>;
  flagged: number;
  previousMonth?: string;
  delta?: number;
}

export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatDecimal(n: number): string {
  return money(n).toFixed(2);
}

export function previousMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function countedTransactions(db: DB, yearMonth: string): Transaction[] {
  return db.getTransactionsByMonth(yearMonth)
    .filter(tx => !tx.excluded && !tx.coveredByFixedBill)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function merchantsMatch(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  return left === right || left.includes(right) || right.includes(left);
}

function splitwiseAdjustments(txs: Transaction[]): Map<string, number> {
  const splitwise = txs.filter(tx => tx.source === 'splitwise');
  const used = new Set<string>();
  const links = new Map<string, number>();

  for (const tx of txs) {
    if (tx.source === 'splitwise') continue;
    const candidates = splitwise.filter(sw =>
      !used.has(sw.id) && sw.date === tx.date && merchantsMatch(tx.merchant, sw.merchant)
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      const da = Math.abs(Math.abs(a.chfAmount) - Math.abs(tx.chfAmount));
      const db = Math.abs(Math.abs(b.chfAmount) - Math.abs(tx.chfAmount));
      if (da !== db) return da - db;
      return a.id.localeCompare(b.id);
    });
    const pick = candidates[0];
    used.add(pick.id);
    links.set(tx.id, pick.chfAmount);
  }

  return links;
}

export function buildLedger(db: DB, yearMonth: string): LedgerRow[] {
  const txs = countedTransactions(db, yearMonth);
  const adjustments = splitwiseAdjustments(txs);
  const rows: LedgerRow[] = [];

  for (const tx of txs) {
    const adjustment = tx.source === 'splitwise' ? null : (adjustments.get(tx.id) ?? null);
    if (tx.splits && tx.splits.length > 0) {
      tx.splits.forEach((part, index) => {
        rows.push({
          date: tx.date,
          source: tx.source,
          merchant: tx.merchant,
          amount: part.chfAmount,
          category: part.category,
          splitwiseAdjustment: index === 0 ? adjustment : null,
          reviewed: !!tx.reviewed,
          id: tx.id,
        });
      });
    } else {
      rows.push({
        date: tx.date,
        source: tx.source,
        merchant: tx.merchant,
        amount: tx.chfAmount,
        category: tx.category || '',
        splitwiseAdjustment: adjustment,
        reviewed: !!tx.reviewed,
        id: tx.id,
      });
    }
  }

  return rows;
}

export function ledgerCsv(rows: LedgerRow[]): string {
  return Papa.unparse({
    fields: ['date', 'source', 'merchant', 'amount', 'category', 'splitwise_adjustment', 'reviewed'],
    data: rows.map(row => [
      row.date,
      row.source,
      row.merchant,
      formatDecimal(row.amount),
      row.category,
      row.splitwiseAdjustment === null ? '' : formatDecimal(row.splitwiseAdjustment),
      row.reviewed ? 'true' : 'false',
    ]),
  }, { newline: '\n' }) + '\n';
}

export function writeLedger(db: DB, yearMonth: string, outPath: string): LedgerRow[] {
  const rows = buildLedger(db, yearMonth);
  writeFileSync(outPath, ledgerCsv(rows));
  return rows;
}

export function buildExpencesRow(db: DB, yearMonth: string, categories?: Category[]): ExpencesRow {
  const cats = categories || loadCategories();
  const totals = getCategoryTotals(db, yearMonth);
  const mapped = new Map<string, Category>();
  for (const cat of cats) {
    if (!cat.column) continue;
    mapped.set(`${cat.group}/${cat.leaf}`, cat);
  }

  const cells: Record<string, number> = {};
  const withColumn = cats.filter(c => c.column).sort((a, b) => columnIndex(a.column) - columnIndex(b.column));
  for (const cat of withColumn) {
    cells[cat.column] = 0;
  }

  const unmapped: Array<{ category: string; amount: number }> = [];
  for (const [category, amount] of Object.entries(totals)) {
    const cat = mapped.get(category);
    if (cat) {
      cells[cat.column] = money((cells[cat.column] || 0) + amount);
    } else if (money(amount) !== 0) {
      unmapped.push({ category, amount: money(amount) });
    }
  }
  unmapped.sort((a, b) => a.category.localeCompare(b.category));

  const cellsSum = money(Object.values(cells).reduce((sum, n) => sum + n, 0));
  const total = money(db.getMonthTotal(yearMonth));

  return { month: yearMonth, cells, unmapped, total, cellsSum };
}

export function writeExpencesRow(db: DB, yearMonth: string, outPath: string): ExpencesRow {
  const row = buildExpencesRow(db, yearMonth);
  writeFileSync(outPath, JSON.stringify(row, null, 2) + '\n');
  return row;
}

function isFlagged(tx: Transaction): boolean {
  return !!tx.fixedChanged || !!tx.fixedMissing || (tx.confidence ?? 0) < 0.7;
}

export function buildSummary(db: DB, yearMonth: string): MonthSummary {
  const totals = getCategoryTotals(db, yearMonth);
  const topCategories = Object.entries(totals)
    .map(([category, amount]) => ({ category, amount: money(amount) }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category))
    .slice(0, 5);

  const flagged = db.getTransactionsByMonth(yearMonth).filter(isFlagged).length;
  const summary: MonthSummary = {
    month: yearMonth,
    total: money(db.getMonthTotal(yearMonth)),
    topCategories,
    flagged,
  };

  const prev = previousMonth(yearMonth);
  if (db.getTransactionsByMonth(prev).length > 0) {
    summary.previousMonth = prev;
    summary.delta = money(summary.total - db.getMonthTotal(prev));
  }

  return summary;
}

export function formatSummary(summary: MonthSummary): string {
  const lines = [
    `Month ${summary.month}`,
    `Total: ${formatDecimal(summary.total)}`,
    'Top categories:',
  ];
  if (summary.topCategories.length === 0) {
    lines.push('  (none)');
  } else {
    for (const row of summary.topCategories) {
      lines.push(`  ${row.category}: ${formatDecimal(row.amount)}`);
    }
  }
  lines.push(`Flagged: ${summary.flagged}`);
  if (summary.previousMonth !== undefined && summary.delta !== undefined) {
    const signed = summary.delta > 0 ? `+${formatDecimal(summary.delta)}` : formatDecimal(summary.delta);
    lines.push(`vs ${summary.previousMonth}: ${signed}`);
  }
  return lines.join('\n') + '\n';
}
