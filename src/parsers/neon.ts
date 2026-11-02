import Papa from 'papaparse';
import { ParsedTransaction } from '../types.js';
import { normalizeAmount } from './utils.js';

export function parseNeon(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: ';',
  });

  const transactions: ParsedTransaction[] = [];

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
