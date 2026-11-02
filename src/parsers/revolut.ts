import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { ParsedTransaction } from '../types.js';
import { normalizeAmount } from './utils.js';

export function parseRevolutCsv(content: string): ParsedTransaction[] {
  const result = Papa.parse(content, { header: true, skipEmptyLines: true });
  return processRevolutRows(result.data);
}

export function parseRevolutXlsx(buffer: Buffer): ParsedTransaction[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);
  return processRevolutRows(data);
}

function processRevolutRows(rows: any[]): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  rows.forEach((row: any, index: number) => {
    const state = row['State'];
    if (state !== 'COMPLETED') return;

    const startedDate = row['Started Date'];
    const merchant = row['Description'] || '';
    const description = row['Type'] || '';
    const amount = parseFloat(row['Amount']) || 0;
    const currency = row['Currency'] || 'CHF';

    if (!startedDate) return;

    const date = startedDate.split(' ')[0];
    // Revolut CSV has spending as negative, income as positive
    // We use convention: spending positive, credits/income negative
    const originalAmount = -normalizeAmount(amount);

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: currency,
      source: 'revolut',
      fileRowIndex: index,
    });
  });

  return transactions;
}
