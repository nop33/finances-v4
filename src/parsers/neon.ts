import Papa from 'papaparse';
import { ParsedTransaction } from '../types.js';
import { normalizeAmount } from './utils.js';
import { loadExcludeRules, ruleMatches } from '../exclude.js';

export function parseNeon(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: ';',
  });

  const transactions: ParsedTransaction[] = [];
  const transferRules = loadExcludeRules().filter(rule => rule.kind === 'transfer');

  result.data.forEach((row: any, index: number) => {
    const date = row['Date'];
    const amount = parseFloat(row['Amount']) || 0;
    const merchant = row['Description'] || '';
    const description = row['Subject'] || '';

    if (!date) return;

    // Neon CSV has spending as negative, income as positive
    // We use convention: spending positive, credits/income negative
    const originalAmount = -normalizeAmount(amount);

    // Detect transaction kind
    let kind: ParsedTransaction['kind'] = 'expense';
    const merchantLower = merchant.toLowerCase();
    const descriptionLower = (description || '').toLowerCase();

    // Incoming money (positive in CSV, becomes negative in our convention)
    if (amount > 0) {
      kind = 'income';
    }
    // Own-account transfers
    if (merchantLower.includes('neon') || descriptionLower.includes('transfer') || 
        merchantLower.includes('transfer')) {
      kind = 'transfer';
    }
    for (const rule of transferRules) {
      if (ruleMatches(rule, { merchant, description, source: 'neon', originalAmount })) {
        kind = 'transfer';
        break;
      }
    }

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: 'CHF',
      source: 'neon',
      fileRowIndex: index,
      kind,
    });
  });

  return transactions;
}
