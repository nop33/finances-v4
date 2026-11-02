import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction, ParsedTransaction, ExcludeRule } from './types.js';
import { generateId } from './parsers/utils.js';
import { existsSync, readFileSync } from 'fs';

function loadExcludeRules(): ExcludeRule[] {
  const configPath = './.exclude-rules.json';
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

function shouldExclude(tx: ParsedTransaction, rules: ExcludeRule[]): boolean {
  // Exclude by transaction kind
  if (tx.kind && ['transfer', 'income', 'card-payment', 'top-up', 'exchange'].includes(tx.kind)) {
    return true;
  }

  // Exclude by pattern rules
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

export async function importTransactions(
  db: DB,
  parsedTransactions: ParsedTransaction[]
): Promise<void> {
  const fx = new FxConverter(db);
  const transactions: Transaction[] = [];
  const importedAt = new Date().toISOString();
  const excludeRules = loadExcludeRules();

  const sourceOccurrences = new Map<string, number>();

  for (const parsed of parsedTransactions) {
    const naturalKey = `${parsed.date}-${parsed.source}-${parsed.merchant}-${parsed.originalAmount}`;
    const occurrence = (sourceOccurrences.get(naturalKey) || 0) + 1;
    sourceOccurrences.set(naturalKey, occurrence);

    const id = parsed.id || generateId(
      parsed.source.substring(0, 3),
      parsed.date,
      parsed.merchant,
      parsed.originalAmount,
      parsed.fileRowIndex,
      occurrence
    );

    let chfAmount = parsed.originalAmount;
    let fxRate: number | undefined;
    let fxRateDate: string | undefined;
    let fxConversionFailed = false;

    if (parsed.originalCurrency !== 'CHF') {
      const conversion = await fx.convertToCHF(
        parsed.originalAmount,
        parsed.originalCurrency,
        parsed.date
      );
      chfAmount = conversion.chfAmount;
      fxRate = conversion.rate;
      fxRateDate = conversion.rateDate;
      fxConversionFailed = conversion.failed || false;
    }

    const excluded = shouldExclude(parsed, excludeRules);

    transactions.push({
      id,
      date: parsed.date,
      source: parsed.source,
      sourceCard: parsed.sourceCard,
      merchant: parsed.merchant,
      description: parsed.description,
      originalAmount: parsed.originalAmount,
      originalCurrency: parsed.originalCurrency,
      chfAmount,
      fxRate,
      fxRateDate,
      fxConversionFailed,
      fileRowIndex: parsed.fileRowIndex,
      importedAt,
      kind: parsed.kind,
      excluded,
    });
  }

  db.insertTransactions(transactions);
}
