import Papa from 'papaparse';
import { ParsedTransaction } from '../types.js';
import { parseDate, swisscardSignedAmount, repairMojibake } from './utils.js';

export function parseSwisscard(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  const transactions: ParsedTransaction[] = [];

  result.data.forEach((row: any, index: number) => {
    const transactionDate = row['Transaction date'];
    const merchant = repairMojibake(row['Merchant'] || row['Description'] || '');
    const description = repairMojibake(row['Description'] || '');
    const cardNumber = row['Card number'] || '';
    const currency = row['Currency'] || 'CHF';
    const amount = parseFloat(row['Amount']) || 0;
    const debitCredit = row['Debit/Credit'];
    const status = row['Status'] || '';

    if (!transactionDate) return;
    
    // Skip pending transactions
    if (status.toLowerCase() === 'pending') return;

    const date = parseDate(transactionDate, 'DD.MM.YYYY');
    
    // Spending is positive, credits/refunds are negative.
    // Debit/Credit is the source of truth: some exports already sign Amount.
    const isCredit = debitCredit === 'Credit';
    const originalAmount = swisscardSignedAmount(amount, isCredit);

    // Detect transaction kind
    let kind: ParsedTransaction['kind'] = 'expense';
    const descLower = description.toLowerCase();
    const merchantLower = merchant.toLowerCase();
    if (isCredit && (descLower.includes('payment') || merchantLower.includes('swisscard') || 
        descLower.includes('card payment') || descLower.includes('bill payment'))) {
      kind = 'card-payment';
    }

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: currency,
      source: 'swisscard',
      sourceCard: cardNumber,
      fileRowIndex: index,
      kind,
    });
  });

  return transactions;
}
