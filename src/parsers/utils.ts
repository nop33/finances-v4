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

// Repair double-encoded UTF-8 (mojibake) by round-tripping through latin1
export function repairMojibake(text: string): string {
  if (!text) return text;
  
  try {
    // Common mojibake patterns that indicate double-encoding
    // Look for Ã followed by various characters typical in mojibake
    const hasMojibake = /Ã[\x80-\xBF]/.test(text);
    if (!hasMojibake) {
      return text;
    }
    
    // Try to repair by encoding as latin1 and decoding as utf8
    const buffer = Buffer.from(text, 'latin1');
    const repaired = buffer.toString('utf8');
    
    // Verify the repair worked by checking if we removed mojibake patterns
    // and didn't introduce replacement characters
    if (repaired !== text && !/Ã[\x80-\xBF]/.test(repaired) && !/\uFFFD/.test(repaired)) {
      return repaired;
    }
  } catch {
    // If anything goes wrong, return original
  }
  
  return text;
}
