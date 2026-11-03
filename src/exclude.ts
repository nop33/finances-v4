import { existsSync, readFileSync } from 'fs';
import { DB } from './db.js';
import { ExcludeRule } from './types.js';

export type ExcludeCandidate = {
  merchant: string;
  description?: string;
  kind?: string;
  source?: string;
  originalAmount?: number;
  chfAmount?: number;
};

export type ExcludeHit = {
  id: string;
  merchant: string;
  reason: string;
  alreadyExcluded: boolean;
  includeOverride: boolean;
};

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

function signedAmount(tx: ExcludeCandidate): number | undefined {
  if (typeof tx.chfAmount === 'number') return tx.chfAmount;
  if (typeof tx.originalAmount === 'number') return tx.originalAmount;
  return undefined;
}

export function ruleMatches(rule: ExcludeRule, tx: ExcludeCandidate): boolean {
  if (!rule.pattern) return false;
  if (rule.source && rule.source.toLowerCase() !== (tx.source || '').toLowerCase()) {
    return false;
  }

  const amount = signedAmount(tx);
  if (rule.direction === 'out' && !(amount !== undefined && amount > 0)) return false;
  if (rule.direction === 'in' && !(amount !== undefined && amount < 0)) return false;

  const patternLower = rule.pattern.toLowerCase();
  const merchantLower = tx.merchant.toLowerCase();
  if (rule.match === 'exact') {
    return merchantLower === patternLower;
  }

  const descriptionLower = (tx.description || '').toLowerCase();
  return merchantLower.includes(patternLower) || descriptionLower.includes(patternLower);
}

export function matchingExcludeRule(
  tx: ExcludeCandidate,
  rules: ExcludeRule[] = loadExcludeRules()
): ExcludeRule | undefined {
  return rules.find(rule => ruleMatches(rule, tx));
}

export function excludeReason(
  tx: ExcludeCandidate,
  rules: ExcludeRule[] = loadExcludeRules()
): string | undefined {
  if (tx.kind && ['transfer', 'income', 'card-payment', 'top-up', 'exchange'].includes(tx.kind)) {
    return `kind:${tx.kind}`;
  }
  const rule = matchingExcludeRule(tx, rules);
  if (!rule) return undefined;
  return `rule:${rule.description || rule.pattern}`;
}

export function shouldExclude(
  tx: ExcludeCandidate,
  rules: ExcludeRule[] = loadExcludeRules()
): boolean {
  return excludeReason(tx, rules) !== undefined;
}

export function listExcludeHits(db: DB, yearMonth: string): ExcludeHit[] {
  const rules = loadExcludeRules();
  const hits: ExcludeHit[] = [];
  for (const tx of db.getTransactionsByMonth(yearMonth)) {
    const reason = excludeReason(tx, rules);
    if (!reason) continue;
    hits.push({
      id: tx.id,
      merchant: tx.merchant,
      reason,
      alreadyExcluded: !!tx.excluded,
      includeOverride: tx.excludeOverride === 'include'
    });
  }
  return hits;
}

export function formatExcludeHit(hit: ExcludeHit): string {
  const skip = hit.includeOverride ? '  (skipped include override)' : '';
  return `${hit.id}  ${hit.merchant}  ${hit.reason}${skip}`;
}

export function applyExcludeRules(db: DB, yearMonth: string): number {
  const rules = loadExcludeRules();
  const transactions = db.getTransactionsByMonth(yearMonth);
  let applied = 0;
  for (const tx of transactions) {
    if (tx.excludeOverride) continue;
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
  db.setExcluded(txId, excluded, true);
}
