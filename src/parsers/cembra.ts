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
    const isCredit = type === 'Credit';
    const isCashback = description.toLowerCase().includes('cashback');
    const descLower = description.toLowerCase();
    const merchantLower = merchant.toLowerCase();

    // Spending is positive, credits/cashback are negative
    const originalAmount = (isCredit || isCashback) ? -normalizeAmount(amount) : normalizeAmount(amount);

    // Detect transaction kind
    let kind: ParsedTransaction['kind'] = 'expense';
    if (isCredit && (descLower.includes('payment') || merchantLower.includes('cembra') || 
        descLower.includes('card payment') || descLower.includes('bill payment'))) {
      kind = 'card-payment';
    }

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: 'CHF',
      source: 'cembra',
      sourceCard: creditCard,
      fileRowIndex: index,
      kind,
    });
  });

  return transactions;
}
