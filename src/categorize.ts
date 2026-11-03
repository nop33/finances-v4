import { DB } from './db.js';
import { Transaction } from './types.js';
import { OUTGOING_PERSON_TRANSFER } from './parsers/revolut.js';

const PAYMENT_PROCESSOR_PREFIXES = [
  'sumup\\*',
  'zettle\\*',
  'paypal\\s*\\*',
  'sq\\s*\\*',
  'square\\*',
  'stripe\\*',
  'twint\\*'
];

const CARD_NOISE_PATTERNS = [
  /\d{4,}/g,
  /\*{4,}/g,
  /card\s*\d+/gi,
  /\bcard\b/gi
];

const CITY_SUFFIX_PATTERNS = [
  /\s+zurich$/i,
  /\s+zürich$/i,
  /\s+zuerich$/i,
  /\s+zh$/i,
  /\s+switzerland$/i,
  /\s+ch$/i,
  /\s+geneva$/i,
  /\s+bern$/i,
  /\s+basel$/i
];

export function normalizeMerchant(merchant: string): string {
  let normalized = merchant.toLowerCase().trim();

  for (const prefix of PAYMENT_PROCESSOR_PREFIXES) {
    const regex = new RegExp(`^${prefix}\\s*`, 'i');
    normalized = normalized.replace(regex, '');
  }

  for (const pattern of CARD_NOISE_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }

  for (const pattern of CITY_SUFFIX_PATTERNS) {
    normalized = normalized.replace(pattern, '');
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

interface CategorizationResult {
  category: string;
  confidence: number;
  explanation: string;
  source: 'merchant_memory' | 'rule' | 'unknown';
}

interface AnomalyFlags {
  newMerchant: boolean;
  unusualAmount: boolean;
  possibleDuplicate: boolean;
  unconvertedFx: boolean;
}

export function categorizeTransaction(
  tx: Transaction,
  db: DB,
  allTransactions: Transaction[]
): CategorizationResult & { anomalies: AnomalyFlags } {
  const normalized = normalizeMerchant(tx.merchant);

  const memory = db.getMerchantMemory(normalized);
  if (memory) {
    const baseConfidence = Math.min(0.5 + memory.timesUsed * 0.1, 0.95);
    return {
      category: memory.category,
      confidence: baseConfidence,
      explanation: `merchant memory: you filed "${tx.merchant}" under ${memory.category} ${memory.timesUsed} time${memory.timesUsed > 1 ? 's' : ''}`,
      source: 'merchant_memory',
      anomalies: detectAnomalies(tx, normalized, db, allTransactions)
    };
  }

  const rules = db.getAllRules();
  for (const rule of rules) {
    const merchantLower = tx.merchant.toLowerCase();
    const patternLower = rule.pattern.toLowerCase();
    if (merchantLower.includes(patternLower)) {
      return {
        category: rule.category,
        confidence: 0.7,
        explanation: `rule: contains "${rule.pattern}"`,
        source: 'rule',
        anomalies: detectAnomalies(tx, normalized, db, allTransactions)
      };
    }
  }

  return {
    category: '',
    confidence: 0,
    explanation: 'unknown: no matching memory or rule',
    source: 'unknown',
    anomalies: detectAnomalies(tx, normalized, db, allTransactions)
  };
}

function detectAnomalies(
  tx: Transaction,
  normalizedMerchant: string,
  db: DB,
  allTransactions: Transaction[]
): AnomalyFlags {
  const allMerchantHistory = db.getAllMerchantHistory();
  const newMerchant = !allMerchantHistory.some(h => h.normalizedMerchant === normalizedMerchant);

  const merchantHistory = allTransactions.filter(t => 
    normalizeMerchant(t.merchant) === normalizedMerchant && t.id !== tx.id
  );
  let unusualAmount = false;
  if (merchantHistory.length >= 3) {
    const amounts = merchantHistory.map(t => t.chfAmount);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stdDev = Math.sqrt(
      amounts.map(a => Math.pow(a - mean, 2)).reduce((a, b) => a + b, 0) / amounts.length
    );
    if (Math.abs(tx.chfAmount - mean) > 2 * stdDev) {
      unusualAmount = true;
    }
  }

  const sevenDaysBefore = new Date(tx.date);
  sevenDaysBefore.setDate(sevenDaysBefore.getDate() - 7);
  const sevenDaysAfter = new Date(tx.date);
  sevenDaysAfter.setDate(sevenDaysAfter.getDate() + 7);

  const nearbyTransactions = allTransactions.filter(t => {
    if (t.id === tx.id) return false;
    const tDate = new Date(t.date);
    if (tDate < sevenDaysBefore || tDate > sevenDaysAfter) return false;
    if (t.date === tx.date) return false;
    return (
      normalizeMerchant(t.merchant) === normalizedMerchant &&
      Math.abs(t.chfAmount - tx.chfAmount) < 0.01
    );
  });
  const possibleDuplicate = nearbyTransactions.length > 0;

  const unconvertedFx = tx.originalCurrency !== 'CHF' && !tx.fxRate;

  return {
    newMerchant,
    unusualAmount,
    possibleDuplicate,
    unconvertedFx
  };
}

export function categorizeMonth(db: DB, yearMonth: string): void {
  const transactions = db.getTransactionsByMonth(yearMonth);

  for (const tx of transactions) {
    // Skip if reviewed, excluded, or already has a category (from fixed bills or manual correction)
    if (tx.reviewed || tx.excluded || tx.category) {
      continue;
    }
    if (tx.explanation === OUTGOING_PERSON_TRANSFER) {
      continue;
    }

    const result = categorizeTransaction(tx, db, transactions);
    db.updateTransactionCategorization(
      tx.id,
      result.category,
      result.confidence,
      result.explanation,
      result.source,
      result.anomalies
    );
  }
}

export function correctTransaction(db: DB, txId: string, category: string): void {
  const tx = db.getTransaction(txId);
  if (!tx) {
    throw new Error(`Transaction ${txId} not found`);
  }

  const normalized = normalizeMerchant(tx.merchant);
  db.recordCorrection(normalized, category);

  db.updateTransactionCategorization(
    txId,
    category,
    1.0,
    `corrected: you manually assigned ${category}`,
    'merchant_memory',
    {
      newMerchant: tx.newMerchant || false,
      unusualAmount: tx.unusualAmount || false,
      possibleDuplicate: tx.possibleDuplicate || false,
      unconvertedFx: tx.unconvertedFx || false
    }
  );

  db.markAsReviewed(txId);

  const yearMonth = tx.date.substring(0, 7);
  const startDate = `${yearMonth}-01`;
  const lastDay = new Date(parseInt(yearMonth.substring(0, 4)), parseInt(yearMonth.substring(5, 7)), 0);
  const endDate = `${yearMonth}-${lastDay.getDate().toString().padStart(2, '0')}`;
  
  const allTransactions = db.getTransactionsByDateRange(startDate, endDate);
  const sameMerchantTxs = allTransactions.filter(
    t => !t.reviewed && normalizeMerchant(t.merchant) === normalized
  );

  for (const sameTx of sameMerchantTxs) {
    const result = categorizeTransaction(sameTx, db, allTransactions);
    db.updateTransactionCategorization(
      sameTx.id,
      result.category,
      result.confidence,
      result.explanation,
      result.source,
      result.anomalies
    );
  }
}
