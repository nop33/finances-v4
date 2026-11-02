import { BANK_SOURCES, DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction, ParsedTransaction } from './types.js';
import { importTransactionId, repairMojibake } from './parsers/utils.js';
import { loadExcludeRules, shouldExclude } from './exclude.js';

export type ImportStats = { new: number; unchanged: number };

export type ImportOptions = {
  file?: string;
  statementMonth?: string;
};

export function formatImportStats(stats: ImportStats): string {
  return `${stats.new} new, ${stats.unchanged} unchanged`;
}

export async function importTransactions(
  db: DB,
  parsedTransactions: ParsedTransaction[],
  options: ImportOptions = {}
): Promise<ImportStats> {
  const fx = new FxConverter(db);
  const transactions: Transaction[] = [];
  const importedAt = new Date().toISOString();
  const excludeRules = loadExcludeRules();

  const sourceOccurrences = new Map<string, number>();

  for (const parsed of parsedTransactions) {
    const merchant = repairMojibake(parsed.merchant);
    const naturalKey = `${parsed.date}-${parsed.source}-${merchant}-${parsed.originalAmount}`;
    const occurrence = (sourceOccurrences.get(naturalKey) || 0) + 1;
    sourceOccurrences.set(naturalKey, occurrence);

    const id = parsed.id || importTransactionId(
      parsed.source,
      parsed.date,
      parsed.originalAmount,
      merchant,
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

  const stats: ImportStats = { new: 0, unchanged: 0 };
  for (const tx of transactions) {
    if (db.getTransaction(tx.id)) stats.unchanged++;
    else stats.new++;
  }
  db.insertTransactions(transactions);

  const bankTxs = transactions.filter(tx => BANK_SOURCES.has(tx.source));
  if (bankTxs.length > 0 || options.statementMonth) {
    db.recordFileImport({
      file: options.file || '(unknown)',
      source: bankTxs[0]?.source || transactions[0]?.source,
      statementMonth: options.statementMonth,
      dates: bankTxs.map(tx => tx.date),
      importedAt,
    });
  }
  return stats;
}
