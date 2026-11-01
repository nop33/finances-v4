export type BankFormat =
  | 'cembra'
  | 'swisscard'
  | 'neon'
  | 'revolut-csv'
  | 'revolut-xlsx'
  | 'unknown';

export function detectFormat(content: string | Buffer, filename?: string): BankFormat {
  if (Buffer.isBuffer(content)) {
    return 'revolut-xlsx';
  }

  const text = content.toString();
  const firstLine = text.split('\n')[0] || '';

  if (firstLine.includes('Account number')) {
    return 'cembra';
  }

  if (firstLine.includes('Transaction date')) {
    return 'swisscard';
  }

  if (firstLine.includes('"Date";"Amount"')) {
    return 'neon';
  }

  if (firstLine.includes('Type,Product') || firstLine.includes('Started Date')) {
    return 'revolut-csv';
  }

  return 'unknown';
}
