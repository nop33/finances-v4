import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction, ParsedTransaction } from './types.js';
import { generateId } from './parsers/utils.js';

export async function importTransactions(
  db: DB,
  parsedTransactions: ParsedTransaction[]
): Promise<void> {
  const fx = new FxConverter(db);
  const transactions: Transaction[] = [];
  const importedAt = new Date().toISOString();

  const sourceOccurrences = new Map<string, number>();

  for (const parsed of parsedTransactions) {
    const naturalKey = `${parsed.date}-${parsed.source}-${parsed.merchant}-${parsed.originalAmount}`;
    const occurrence = (sourceOccurrences.get(naturalKey) || 0) + 1;
    sourceOccurrences.set(naturalKey, occurrence);

    const id = generateId(
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
    });
  }

  db.insertTransactions(transactions);
}
