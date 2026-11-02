import { DB } from './db.js';
import { TransactionSplit } from './types.js';

export function parseSplitParts(args: string[]): TransactionSplit[] {
  if (args.length === 0) {
    throw new Error('Usage: finances split <txId> <category>=<chf> [<category>=<chf> ...]');
  }

  return args.map(arg => {
    const eq = arg.lastIndexOf('=');
    if (eq <= 0 || eq === arg.length - 1) {
      throw new Error(`Invalid split part "${arg}". Expected category=amount`);
    }
    const category = arg.slice(0, eq).trim();
    const chfAmount = Number(arg.slice(eq + 1));
    if (!category) {
      throw new Error(`Invalid split part "${arg}". Expected category=amount`);
    }
    if (!Number.isFinite(chfAmount)) {
      throw new Error(`Invalid amount in "${arg}"`);
    }
    return { category, chfAmount };
  });
}

export function splitTransaction(db: DB, txId: string, parts: TransactionSplit[]): void {
  db.setSplits(txId, parts);
}

export function getCategoryTotals(db: DB, yearMonth: string): Record<string, number> {
  const totals: Record<string, number> = {};
  const transactions = db.getTransactionsByMonth(yearMonth);

  for (const tx of transactions) {
    if (tx.coveredByFixedBill || tx.excluded) continue;

    if (tx.splits && tx.splits.length > 0) {
      for (const part of tx.splits) {
        totals[part.category] = (totals[part.category] || 0) + part.chfAmount;
      }
    } else {
      const category = tx.category || '(uncategorised)';
      totals[category] = (totals[category] || 0) + tx.chfAmount;
    }
  }

  return totals;
}
