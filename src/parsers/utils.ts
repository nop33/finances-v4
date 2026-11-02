import crypto from 'crypto';

export function generateId(prefix: string, ...parts: (string | number)[]): string {
  const combined = parts.join('-');
  const hash = crypto.createHash('md5').update(combined).digest('hex').substring(0, 8);
  return `${prefix}-${hash}`;
}

export function importTransactionId(
  source: string,
  date: string,
  amount: number,
  merchant: string,
  occurrence: number
): string {
  return generateId(source.substring(0, 3), date, amount, merchant, occurrence);
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

export function swisscardSignedAmount(amount: number, isCredit: boolean): number {
  const magnitude = Math.abs(normalizeAmount(amount));
  return isCredit ? -magnitude : magnitude;
}

// Bytes 0x80-0x9F that Windows-1252 maps to punctuation (not latin1 C1 controls).
const CP1252_EXTRA: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
};

function bytesFromMisdecoded(text: string): Buffer | null {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 256) {
      bytes.push(code);
    } else if (CP1252_EXTRA[code] !== undefined) {
      bytes.push(CP1252_EXTRA[code]);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

function utf8IfClean(bytes: Buffer, original: string): string | null {
  const repaired = bytes.toString('utf8');
  if (repaired === original || /\uFFFD/.test(repaired)) return null;
  if (!Buffer.from(repaired, 'utf8').equals(bytes)) return null;
  return repaired;
}

function isLatin1String(text: string): boolean {
  for (const ch of text) {
    if (ch.codePointAt(0)! > 255) return false;
  }
  return true;
}

// Repair UTF-8 that was decoded as Latin-1 or Windows-1252 (mojibake).
export function repairMojibake(text: string): string {
  if (!text) return text;

  try {
    if (isLatin1String(text)) {
      const fromLatin1 = utf8IfClean(Buffer.from(text, 'latin1'), text);
      if (fromLatin1) return fromLatin1;
    }

    const cp1252 = bytesFromMisdecoded(text);
    if (cp1252) {
      const fromCp1252 = utf8IfClean(cp1252, text);
      if (fromCp1252) return fromCp1252;
    }
  } catch {
    // leave original
  }

  return text;
}
