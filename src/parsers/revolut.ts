import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { ParsedTransaction } from '../types.js';
import { normalizeAmount, repairMojibake } from './utils.js';
import { isOwnAccountMerchant } from '../own-accounts.js';

export const OUTGOING_PERSON_TRANSFER = 'outgoing transfer to a person';

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

function normalizeRevolutType(type: string): string {
  return type.toLowerCase().replace(/[\s_-]+/g, '');
}

function processRevolutRows(rows: any[]): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  rows.forEach((row: any, index: number) => {
    const state = row['State'];
    if (state !== 'COMPLETED') return;

    const startedDate = row['Started Date'];
    const merchant = repairMojibake(row['Description'] || '');
    const type = row['Type'] || '';
    const description = type;
    const amount = parseFloat(row['Amount']) || 0;
    const fee = parseFloat(row['Fee']) || 0;
    const currency = row['Currency'] || 'CHF';

    if (!startedDate) return;

    const date = startedDate.split(' ')[0];
    // Revolut CSV: spending Amount is negative. Fee is a separate row when present.
    const originalAmount = -normalizeAmount(amount);

    const typeKey = normalizeRevolutType(type);
    let kind: ParsedTransaction['kind'] = 'expense';
    if (typeKey === 'topup') {
      kind = 'top-up';
    } else if (typeKey === 'transfer') {
      if (isOwnAccountMerchant(merchant)) {
        kind = 'transfer';
      } else if (originalAmount > 0) {
        kind = 'expense';
      } else {
        // Incoming person-to-person: keep as transfer (auto-excluded).
        kind = 'transfer';
      }
    } else if (typeKey === 'exchange') {
      kind = 'exchange';
    }
    // Card Refund stays an expense (negative spend). Do not treat positive Amount as income.

    transactions.push({
      date,
      merchant,
      description,
      originalAmount,
      originalCurrency: currency,
      source: 'revolut',
      fileRowIndex: index,
      kind,
      explanation: typeKey === 'transfer' && kind === 'expense' ? OUTGOING_PERSON_TRANSFER : undefined,
    });

    if (fee !== 0) {
      transactions.push({
        date,
        merchant: `${merchant} fee`,
        description: 'Fee',
        originalAmount: normalizeAmount(Math.abs(fee)),
        originalCurrency: currency,
        source: 'revolut',
        fileRowIndex: index,
        kind: 'expense',
        category: process.env.REVOLUT_FEE_CATEGORY,
      });
    }
  });

  return transactions;
}
