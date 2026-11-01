import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { Transaction } from './types.js';

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
  
  // Parse month and get date range
  const [year, monthNum] = month.split('-').map(Number);
  const startDate = new Date(year, monthNum - 1, 1);
  const endDate = new Date(year, monthNum, 0); // Last day of month
  
  const datedAfter = startDate.toISOString().split('T')[0];
  const datedBefore = endDate.toISOString().split('T')[0];

  // Fetch all expenses for the month with pagination
  const expenses = await fetchAllExpenses(apiKey, datedAfter, datedBefore, httpFetch);

  const fx = new FxConverter(db);
  const transactions: Transaction[] = [];
  const importedAt = new Date().toISOString();
  
  let imported = 0;
  let skipped = 0;
  let updated = 0;

  for (const expense of expenses) {
    // Skip payments (settle-ups/repayments)
    if (expense.payment) {
      skipped++;
      continue;
    }

    // Find user's involvement in this expense
    const userShare = expense.users.find(u => u.user_id === currentUser.id);
    
    // Skip if deleted or user not involved
    if (expense.deleted_at || !userShare) {
      const txId = `sw-${expense.id}`;
      const existing = db.getTransaction(txId);
      
      if (existing) {
        // Mark as deleted/uninvolved by setting chfAmount to 0
        // This way it doesn't affect totals but remains in the database
        const updatedTx: Transaction = {
          ...existing,
          chfAmount: 0,
          originalAmount: 0,
          importedAt,
        };
        db.insertTransaction(updatedTx);
        updated++;
      }
      skipped++;
      continue;
    }

    const paidShare = parseFloat(userShare.paid_share);
    const owedShare = parseFloat(userShare.owed_share);
    const netPosition = paidShare - owedShare;

    // Calculate the transaction amount based on net position
    let transactionAmount: number;
    if (netPosition > 0) {
      // User paid more than they owe (others owe them)
      // Store as NEGATIVE to reduce spending
      transactionAmount = -(paidShare - owedShare);
    } else if (netPosition < 0) {
      // User owes someone else
      // Store as positive expense
      transactionAmount = owedShare;
    } else {
      // Net zero - skip
      skipped++;
      continue;
    }

    // Convert to CHF if needed
    let chfAmount = transactionAmount;
    let fxRate: number | undefined;
    let fxRateDate: string | undefined;
    let fxConversionFailed = false;

    if (expense.currency_code !== 'CHF') {
      const conversion = await fx.convertToCHF(
        Math.abs(transactionAmount),
        expense.currency_code,
        expense.date
      );
      // Preserve sign
      chfAmount = transactionAmount < 0 ? -conversion.chfAmount : conversion.chfAmount;
      fxRate = conversion.rate;
      fxRateDate = conversion.rateDate;
      fxConversionFailed = conversion.failed || false;
    }

    const txId = `sw-${expense.id}`;
    const existing = db.getTransaction(txId);

    const transaction: Transaction = {
      id: txId,
      date: expense.date,
      source: 'splitwise',
      merchant: expense.description,
      originalAmount: transactionAmount,
      originalCurrency: expense.currency_code,
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
      updated++;
    } else {
      imported++;
    }
  }

  return { imported, skipped, updated };
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
