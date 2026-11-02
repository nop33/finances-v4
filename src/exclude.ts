import { existsSync, readFileSync } from 'fs';
import { DB } from './db.js';
import { ExcludeRule } from './types.js';

export function loadExcludeRules(): ExcludeRule[] {
  const configPath = process.env.EXCLUDE_RULES_CONFIG || './.exclude-rules.json';
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ExcludeRule[];
  } catch {
    return [];
  }
}

export function shouldExclude(
  tx: { merchant: string; description?: string; kind?: string },
  rules: ExcludeRule[] = loadExcludeRules()
): boolean {
  if (tx.kind && ['transfer', 'income', 'card-payment', 'top-up', 'exchange'].includes(tx.kind)) {
    return true;
  }

  const merchantLower = tx.merchant.toLowerCase();
  const descriptionLower = (tx.description || '').toLowerCase();

  for (const rule of rules) {
    const patternLower = rule.pattern.toLowerCase();
    if (merchantLower.includes(patternLower) || descriptionLower.includes(patternLower)) {
      return true;
    }
  }

  return false;
}

export function applyExcludeRules(db: DB, yearMonth: string): number {
  const rules = loadExcludeRules();
  const transactions = db.getTransactionsByMonth(yearMonth);
  let applied = 0;
  for (const tx of transactions) {
    if (shouldExclude(tx, rules) && !tx.excluded) {
      db.setExcluded(tx.id, true);
      applied++;
    }
  }
  return applied;
}

export function setTransactionExcluded(db: DB, txId: string, excluded: boolean): void {
  const tx = db.getTransaction(txId);
  if (!tx) {
    throw new Error(`Transaction ${txId} not found`);
  }
  db.setExcluded(txId, excluded);
}
