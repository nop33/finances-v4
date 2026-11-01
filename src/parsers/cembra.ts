import Papa from 'papaparse';
import { ParsedTransaction } from '../types.js';
import { parseDate, generateId, normalizeAmount } from './utils.js';

export function parseCembra(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  const transactions: ParsedTransaction[] = [];

  result.data.forEach((row: any, index: number) => {
    const bookingDate = row['Booking date'];
    const merchant = row['Merchant'] || '';
    const description = row['Description'] || '';
    const type = row['Type'];
    const amount = parseFloat(row['Amount (CHF)']) || 0;
    const creditCard = row['Credit Card'] || '';

    if (!bookingDate) return;

    const date = parseDate(bookingDate, 'DD-MM-YYYY');
    const isDebit = type === 'Debit';
    const isCashback = description.toLowerCase().includes('cashback');

    const originalAmount = normalizeAmount(amount);

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: 'CHF',
      source: 'cembra',
      sourceCard: creditCard,
      fileRowIndex: index,
    });
  });

  return transactions;
}
