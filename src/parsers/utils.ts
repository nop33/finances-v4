import crypto from 'crypto';

export function generateId(prefix: string, ...parts: (string | number)[]): string {
  const combined = parts.join('-');
  const hash = crypto.createHash('md5').update(combined).digest('hex').substring(0, 8);
  return `${prefix}-${hash}`;
}

export function parseDate(dateStr: string, format: 'DD-MM-YYYY' | 'DD.MM.YYYY' | 'YYYY-MM-DD'): string {
  if (format === 'YYYY-MM-DD') {
    return dateStr;
  }

  const parts = dateStr.split(/[-./]/);
  if (format === 'DD-MM-YYYY' || format === 'DD.MM.YYYY') {
    const [day, month, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  throw new Error(`Unsupported date format: ${format}`);
}

// Sign convention: spending is positive, credits/refunds/cashback are negative
export function normalizeAmount(amount: number): number {
  return amount;
}
