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

    const originalAmount = normalizeAmount(amount);

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: 'CHF',
      source: 'neon',
      fileRowIndex: index,
    });
  });

  return transactions;
}
