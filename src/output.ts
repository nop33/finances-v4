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

export interface FlaggedBreakdown {
  fixedChanged: number;
  fixedMissing: number;
  lowConfidence: number;
  newMerchant: number;
}

export interface MonthSummary {
  month: string;
  total: number;
  topCategories: Array<{ category: string; amount: number }>;
  flagged: number;
  flaggedBreakdown: FlaggedBreakdown;
  previousMonth?: string;
  delta?: number;
}

const SPLITWISE_WINDOW_DAYS = 31;

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

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  return Math.abs(end - start) / 86400000;
}

function monthBounds(yearMonth: string): { start: string; end: string } {
  const start = `${yearMonth}-01`;
  const [year, month] = yearMonth.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export function roundToCentsSum(values: number[], target: number): number[] {
  if (values.length === 0) return [];
  const targetCents = Math.round(target * 100);
  const items = values.map((value, index) => {
    const exact = value * 100;
    const base = Math.trunc(exact);
    return { index, base, remainder: exact - base };
  });
  let leftover = targetCents - items.reduce((sum, item) => sum + item.base, 0);
  const byRemainder = leftover >= 0
    ? [...items].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    : [...items].sort((a, b) => a.remainder - b.remainder || a.index - b.index);
  const step = leftover > 0 ? 1 : -1;
  let i = 0;
  while (leftover !== 0 && byRemainder.length > 0) {
    byRemainder[i % byRemainder.length].base += step;
    leftover -= step;
    i++;
  }
  const rounded = new Array<number>(values.length);
  for (const item of items) {
    rounded[item.index] = item.base / 100;
  }
  return rounded;
}

function countedTransactions(db: DB, yearMonth: string): Transaction[] {
  return db.getTransactionsByMonth(yearMonth)
    .filter(tx => !tx.excluded && !tx.coveredByFixedBill)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function merchantTokens(text: string): Set<string> {
  return new Set(
    foldDiacritics(text).split(/[^a-z0-9]+/).filter(token => token.length >= 2)
  );
}

export function merchantsMatch(a: string, b: string): boolean {
  const left = merchantTokens(a);
  const right = merchantTokens(b);
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function splitwiseAdjustments(db: DB, yearMonth: string, txs: Transaction[]): Map<string, number> {
  const { start, end } = monthBounds(yearMonth);
  const nearby = db.getTransactionsByDateRange(
    addDays(start, -SPLITWISE_WINDOW_DAYS),
    addDays(end, SPLITWISE_WINDOW_DAYS)
  );
  const splitwise = nearby.filter(tx => tx.source === 'splitwise' && !tx.excluded);
  const banks = txs.filter(tx => tx.source !== 'splitwise');

  type Pair = { bank: Transaction; sw: Transaction; days: number };
  const pairs: Pair[] = [];
  for (const bank of banks) {
    const charge = Math.abs(Math.round(bank.chfAmount * 100));
    for (const sw of splitwise) {
      const share = Math.abs(Math.round(sw.chfAmount * 100));
      if (share > charge) continue;
      if (daysBetween(bank.date, sw.date) > SPLITWISE_WINDOW_DAYS) continue;
      if (!merchantsMatch(bank.merchant, sw.merchant)) continue;
      pairs.push({ bank, sw, days: daysBetween(bank.date, sw.date) });
    }
  }

  pairs.sort((a, b) =>
    a.days - b.days ||
    a.bank.id.localeCompare(b.bank.id) ||
    a.sw.id.localeCompare(b.sw.id)
  );

  const usedBank = new Set<string>();
  const usedSw = new Set<string>();
  const links = new Map<string, number>();
  for (const pair of pairs) {
    if (usedBank.has(pair.bank.id) || usedSw.has(pair.sw.id)) continue;
    usedBank.add(pair.bank.id);
    usedSw.add(pair.sw.id);
    links.set(pair.bank.id, pair.sw.chfAmount);
  }
  return links;
}

export function buildLedger(db: DB, yearMonth: string): LedgerRow[] {
  const txs = countedTransactions(db, yearMonth);
  const adjustments = splitwiseAdjustments(db, yearMonth, txs);
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

  const rounded = roundToCentsSum(rows.map(row => row.amount), db.getMonthTotal(yearMonth));
  rows.forEach((row, i) => {
    row.amount = rounded[i];
  });
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
      cells[cat.column] = (cells[cat.column] || 0) + amount;
    } else if (amount !== 0) {
      unmapped.push({ category, amount });
    }
  }
  unmapped.sort((a, b) => a.category.localeCompare(b.category));

  const cellKeys = Object.keys(cells);
  const toRound = [...cellKeys.map(key => cells[key]), ...unmapped.map(row => row.amount)];
  const total = money(db.getMonthTotal(yearMonth));
  const rounded = roundToCentsSum(toRound, total);
  cellKeys.forEach((key, i) => {
    cells[key] = rounded[i];
  });
  unmapped.forEach((row, i) => {
    row.amount = rounded[cellKeys.length + i];
  });

  const cellsSum = money(Object.values(cells).reduce((sum, n) => sum + n, 0));
  return { month: yearMonth, cells, unmapped, total, cellsSum };
}

export function writeExpencesRow(db: DB, yearMonth: string, outPath: string): ExpencesRow {
  const row = buildExpencesRow(db, yearMonth);
  writeFileSync(outPath, JSON.stringify(row, null, 2) + '\n');
  return row;
}

function isReviewable(tx: Transaction): boolean {
  return !tx.excluded && !tx.coveredByFixedBill;
}

function isLowConfidence(tx: Transaction): boolean {
  return tx.confidence != null && tx.confidence < 0.7;
}

function isFlagged(tx: Transaction): boolean {
  if (!isReviewable(tx)) return false;
  return !!tx.fixedChanged || !!tx.fixedMissing || isLowConfidence(tx) || !!tx.newMerchant;
}

export function buildSummary(db: DB, yearMonth: string): MonthSummary {
  const totals = getCategoryTotals(db, yearMonth);
  const topCategories = Object.entries(totals)
    .map(([category, amount]) => ({ category, amount: money(amount) }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category))
    .slice(0, 5);

  const reviewable = db.getTransactionsByMonth(yearMonth).filter(isReviewable);
  const flaggedRows = reviewable.filter(isFlagged);
  const flaggedBreakdown: FlaggedBreakdown = {
    fixedChanged: reviewable.filter(tx => !!tx.fixedChanged).length,
    fixedMissing: reviewable.filter(tx => !!tx.fixedMissing).length,
    lowConfidence: reviewable.filter(isLowConfidence).length,
    newMerchant: reviewable.filter(tx => !!tx.newMerchant).length,
  };
  const summary: MonthSummary = {
    month: yearMonth,
    total: money(db.getMonthTotal(yearMonth)),
    topCategories,
    flagged: flaggedRows.length,
    flaggedBreakdown,
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
  lines.push(`  fixedChanged: ${summary.flaggedBreakdown.fixedChanged}`);
  lines.push(`  fixedMissing: ${summary.flaggedBreakdown.fixedMissing}`);
  lines.push(`  low confidence: ${summary.flaggedBreakdown.lowConfidence}`);
  lines.push(`  new merchant: ${summary.flaggedBreakdown.newMerchant}`);
  if (summary.previousMonth !== undefined && summary.delta !== undefined) {
    const signed = summary.delta > 0 ? `+${formatDecimal(summary.delta)}` : formatDecimal(summary.delta);
    lines.push(`vs ${summary.previousMonth}: ${signed}`);
  }
  return lines.join('\n') + '\n';
}
