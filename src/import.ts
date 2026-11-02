import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction, ParsedTransaction } from './types.js';
import { importTransactionId, repairMojibake } from './parsers/utils.js';
import { loadExcludeRules, shouldExclude } from './exclude.js';

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

  db.insertTransactions(transactions);
}
