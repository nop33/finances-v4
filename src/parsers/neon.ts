import Papa from 'papaparse';
import { existsSync, readFileSync } from 'fs';
import { ParsedTransaction, ExcludeRule } from '../types.js';
import { normalizeAmount } from './utils.js';

function loadTransferPatterns(): string[] {
  const configPath = process.env.EXCLUDE_RULES_CONFIG || './.exclude-rules.json';
  if (!existsSync(configPath)) return [];
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    const rules: ExcludeRule[] = Array.isArray(data) ? data : [];
    return rules
      .filter(rule => rule.kind === 'transfer' && rule.pattern)
      .map(rule => rule.pattern.toLowerCase());
  } catch {
    return [];
  }
}

export function parseNeon(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: ';',
  });

  const transactions: ParsedTransaction[] = [];
  const transferPatterns = loadTransferPatterns();

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
    const haystack = `${merchantLower} ${descriptionLower}`;
    
    // Incoming money (positive in CSV, becomes negative in our convention)
    if (amount > 0) {
      kind = 'income';
    }
    // Own-account transfers
    if (merchantLower.includes('neon') || descriptionLower.includes('transfer') || 
        merchantLower.includes('transfer')) {
      kind = 'transfer';
    }
    for (const pattern of transferPatterns) {
      if (haystack.includes(pattern)) {
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
