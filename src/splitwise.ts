import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction } from './types.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

interface SplitwiseUser {
  id: number;
  first_name: string;
  last_name: string;
}

interface SplitwiseExpenseUser {
  user_id: number;
  paid_share: string;
  owed_share: string;
  net_balance: string;
}

interface SplitwiseExpense {
  id: number;
  description: string;
  date: string;
  currency_code: string;
  deleted_at: string | null;
  payment: boolean;
  users: SplitwiseExpenseUser[];
}

interface SplitwiseApiResponse {
  expenses: SplitwiseExpense[];
}

interface SplitwiseCurrentUser {
  id: number;
}

interface SplitwiseExpenseData {
  id: string;
  description: string;
  date: string;
  currency: string;
  amount: number;
  isPayment: boolean;
  isDeleted: boolean;
}

function normalizeToZurichDate(isoDatetime: string): string {
  // Convert ISO datetime to Europe/Zurich calendar date
  // Splitwise dates are like "2024-10-18T13:00:00Z" or "2024-10-18"
  const date = new Date(isoDatetime);
  
  // Format in Europe/Zurich timezone
  const zurichDateStr = date.toLocaleDateString('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  
  return zurichDateStr;
}

async function bookSplitwiseExpense(
  db: DB,
  fx: FxConverter,
  expenseData: SplitwiseExpenseData,
  stats: { imported: number; skipped: number; updated: number }
): Promise<void> {
  const importedAt = new Date().toISOString();
  
  // Skip payments (settle-ups/repayments)
  if (expenseData.isPayment) {
    stats.skipped++;
    return;
  }

  // Handle deleted expenses
  if (expenseData.isDeleted) {
    const existing = db.getTransaction(expenseData.id);
    
    if (existing) {
      const updatedTx: Transaction = {
        ...existing,
        chfAmount: 0,
        originalAmount: 0,
        importedAt,
      };
      db.insertTransaction(updatedTx);
      stats.updated++;
    }
    stats.skipped++;
    return;
  }

  // Skip if net zero
  if (expenseData.amount === 0) {
    stats.skipped++;
    return;
  }

  // Convert to CHF if needed
  let chfAmount = expenseData.amount;
  let fxRate: number | undefined;
  let fxRateDate: string | undefined;
  let fxConversionFailed = false;

  if (expenseData.currency !== 'CHF') {
    const conversion = await fx.convertToCHF(
      Math.abs(expenseData.amount),
      expenseData.currency,
      expenseData.date
    );
    // Preserve sign
    chfAmount = expenseData.amount < 0 ? -conversion.chfAmount : conversion.chfAmount;
    fxRate = conversion.rate;
    fxRateDate = conversion.rateDate;
    fxConversionFailed = conversion.failed || false;
  }

  const existing = db.getTransaction(expenseData.id);

  const transaction: Transaction = {
    id: expenseData.id,
    date: expenseData.date,
    source: 'splitwise',
    merchant: expenseData.description,
    originalAmount: expenseData.amount,
    originalCurrency: expenseData.currency,
    chfAmount,
    fxRate,
    fxRateDate,
    fxConversionFailed,
    fileRowIndex: 0,
    importedAt,
    // Preserve existing categorization on re-import
    category: existing?.category,
    confidence: existing?.confidence,
    explanation: existing?.explanation,
    categorizationSource: existing?.categorizationSource,
    reviewed: existing?.reviewed,
  };

  db.insertTransaction(transaction);
  
  if (existing) {
    stats.updated++;
  } else {
    stats.imported++;
  }
}

export async function importSplitwiseExpenses(
  db: DB,
  month: string,
  apiKey: string,
  httpFetch: typeof fetch = fetch
): Promise<{ imported: number; skipped: number; updated: number }> {
  if (!apiKey) {
    throw new Error('SPLITWISE_API_KEY environment variable is required');
  }

  // Get current user
  const currentUser = await getCurrentUser(apiKey, httpFetch);
  
  // Build date range from plain strings to avoid timezone shifts
  const [year, monthNum] = month.split('-').map(Number);
  const datedAfter = `${year}-${monthNum.toString().padStart(2, '0')}-01`;
  
  // Calculate first day of next month
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  const nextYear = monthNum === 12 ? year + 1 : year;
  const datedBefore = `${nextYear}-${nextMonth.toString().padStart(2, '0')}-01`;

  // Fetch all expenses for the month with pagination
  const expenses = await fetchAllExpenses(apiKey, datedAfter, datedBefore, httpFetch);

  // Filter to only include expenses within the target month
  // (to handle any boundary leakage from the API)
  const targetMonthPrefix = `${year}-${monthNum.toString().padStart(2, '0')}-`;
  const filteredExpenses = expenses.filter(expense => {
    const expenseDate = normalizeToZurichDate(expense.date);
    return expenseDate.startsWith(targetMonthPrefix);
  });

  const fx = new FxConverter(db);
  const stats = { imported: 0, skipped: 0, updated: 0 };

  for (const expense of filteredExpenses) {
    // Find user's involvement in this expense
    const userShare = expense.users.find(u => u.user_id === currentUser.id);
    
    // Handle as deleted if user not involved
    if (!userShare) {
      await bookSplitwiseExpense(db, fx, {
        id: `sw-${expense.id}`,
        description: expense.description,
        date: normalizeToZurichDate(expense.date),
        currency: expense.currency_code,
        amount: 0,
        isPayment: false,
        isDeleted: true,
      }, stats);
      continue;
    }

    const paidShare = parseFloat(userShare.paid_share);
    const owedShare = parseFloat(userShare.owed_share);
    
    // Net position: owedShare - paidShare
    // Positive = user owes money (expense)
    // Negative = user is owed money (reduces spending)
    const transactionAmount = owedShare - paidShare;

    await bookSplitwiseExpense(db, fx, {
      id: `sw-${expense.id}`,
      description: expense.description,
      date: normalizeToZurichDate(expense.date),
      currency: expense.currency_code,
      amount: transactionAmount,
      isPayment: expense.payment,
      isDeleted: !!expense.deleted_at,
    }, stats);
  }

  return stats;
}

async function getCurrentUser(
  apiKey: string,
  httpFetch: typeof fetch = fetch
): Promise<SplitwiseCurrentUser> {
  const response = await httpFetch('https://secure.splitwise.com/api/v3.0/get_current_user', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get current user: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { user: SplitwiseCurrentUser };
  return data.user;
}

async function fetchAllExpenses(
  apiKey: string,
  datedAfter: string,
  datedBefore: string,
  httpFetch: typeof fetch = fetch
): Promise<SplitwiseExpense[]> {
  const allExpenses: SplitwiseExpense[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = new URL('https://secure.splitwise.com/api/v3.0/get_expenses');
    url.searchParams.set('dated_after', datedAfter);
    url.searchParams.set('dated_before', datedBefore);
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());

    const response = await httpFetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch expenses: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as SplitwiseApiResponse;
    
    if (data.expenses.length === 0) {
      break;
    }

    allExpenses.push(...data.expenses);
    
    if (data.expenses.length < limit) {
      break;
    }

    offset += limit;
  }

  return allExpenses;
}

export async function importSplitwiseCsvFiles(
  db: DB,
  month: string,
  meName: string,
  files: string[]
): Promise<{ imported: number; skipped: number; updated: number }> {
  if (!meName) {
    throw new Error('--me parameter or SPLITWISE_ME environment variable is required');
  }

  const [year, monthNum] = month.split('-').map(Number);
  const targetMonthPrefix = `${year}-${monthNum.toString().padStart(2, '0')}-`;

  const fx = new FxConverter(db);
  const stats = { imported: 0, skipped: 0, updated: 0 };

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
      continue;
    }

    const header = lines[0].split(',').map(h => h.trim());
    
    // Find the user's column
    const meIndex = header.indexOf(meName);
    if (meIndex === -1) {
      throw new Error(`Column "${meName}" not found in CSV header. Available columns: ${header.join(', ')}`);
    }

    const dateIndex = header.indexOf('Date');
    const descIndex = header.indexOf('Description');
    const categoryIndex = header.indexOf('Category');
    const costIndex = header.indexOf('Cost');
    const currencyIndex = header.indexOf('Currency');

    if (dateIndex === -1 || descIndex === -1 || categoryIndex === -1 || costIndex === -1 || currencyIndex === -1) {
      throw new Error(`CSV header missing required columns. Found: ${header.join(', ')}`);
    }

    // Track identical rows for stable ID generation
    const rowCounts = new Map<string, number>();
    
    // Generate a file key for stable IDs across re-imports
    const fileKey = createHash('sha256')
      .update(file)
      .digest('hex')
      .substring(0, 8);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const fields = parseCSVLine(line);
      
      // Skip Total balance row
      const description = fields[descIndex]?.trim() || '';
      if (description === 'Total balance') {
        stats.skipped++;
        continue;
      }

      // Skip payment rows
      const category = fields[categoryIndex]?.trim() || '';
      if (category === 'Payment') {
        stats.skipped++;
        continue;
      }

      const date = fields[dateIndex]?.trim() || '';
      if (!date.startsWith(targetMonthPrefix)) {
        stats.skipped++;
        continue;
      }

      const cost = fields[costIndex]?.trim() || '';
      const currency = fields[currencyIndex]?.trim() || '';
      const meValue = fields[meIndex]?.trim() || '';

      if (!meValue || meValue === '0' || meValue === '0.00') {
        stats.skipped++;
        continue;
      }

      // Parse user's net balance
      const meNet = parseFloat(meValue);
      if (isNaN(meNet) || meNet === 0) {
        stats.skipped++;
        continue;
      }

      // User's amount is negative of their net balance
      // If user's net is -12.50 (they owe), amount is +12.50
      // If user's net is +40 (they are owed), amount is -40
      const amount = -meNet;

      // Generate stable ID
      const rowKey = `${date}|${description}|${cost}|${currency}`;
      const occurrence = rowCounts.get(rowKey) || 0;
      rowCounts.set(rowKey, occurrence + 1);

      const idData = `${date}|${description}|${cost}|${currency}|${fileKey}|${occurrence}`;
      const id = `sw-csv-${createHash('sha256').update(idData).digest('hex').substring(0, 16)}`;

      await bookSplitwiseExpense(db, fx, {
        id,
        description,
        date,
        currency,
        amount,
        isPayment: false,
        isDeleted: false,
      }, stats);
    }
  }

  return stats;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  
  fields.push(current);
  return fields;
}
