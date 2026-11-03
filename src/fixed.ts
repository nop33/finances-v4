import { DB } from './db.js';
import { Transaction } from './types.js';
import { loadFixedBills, isBillActive, isBillDue, getExpectedChargeAmount, matchesBillPattern, amountsMatchBill, FixedBill } from './fixed-bills.js';

function centsOff(amount: number, expected: number): number {
  return Math.abs(Math.round(amount * 100) - Math.round(expected * 100));
}

function percentOff(amount: number, expected: number): number {
  if (expected === 0) return amount === 0 ? 0 : Infinity;
  return (Math.abs(amount - expected) / expected) * 100;
}

function closestCharge(txs: Transaction[], expected: number): Transaction {
  return txs.reduce((best, tx) =>
    centsOff(tx.chfAmount, expected) < centsOff(best.chfAmount, expected) ? tx : best
  );
}

function clearMonthCoverage(db: DB, yearMonth: string): void {
  for (const tx of db.getTransactionsByMonth(yearMonth)) {
    if (tx.source === 'fixed') continue;
    if (tx.coveredByFixedBill || tx.fixedChanged) {
      db.clearFixedCoverage(tx.id);
    }
  }
}

export function unlinkFixedCharge(db: DB, txId: string): void {
  const tx = db.getTransaction(txId);
  if (!tx) {
    throw new Error(`Transaction ${txId} not found`);
  }
  db.setFixedOverride(txId, 'unlink');
  if (tx.coveredByFixedBill || tx.fixedChanged) {
    db.clearFixedCoverage(txId);
  }
}

export function relinkFixedCharge(db: DB, txId: string): void {
  const tx = db.getTransaction(txId);
  if (!tx) {
    throw new Error(`Transaction ${txId} not found`);
  }
  db.setFixedOverride(txId, 'relink');
}

export function applyFixedBills(db: DB, yearMonth: string): void {
  const bills = loadFixedBills();
  const activeBills = bills.filter(bill => isBillActive(bill, yearMonth));

  db.runInTransaction(() => {
    clearMonthCoverage(db, yearMonth);
    const allTransactions = db.getTransactionsByMonth(yearMonth);

    for (const bill of activeBills) {
      const syntheticTxId = `fixed:${bill.id}:${yearMonth}`;
      const existingTx = db.getTransaction(syntheticTxId);

      const syntheticTx: Transaction = {
        id: syntheticTxId,
        date: `${yearMonth}-15`,
        source: 'fixed',
        merchant: bill.label,
        originalAmount: bill.monthlyAmount,
        originalCurrency: 'CHF',
        chfAmount: bill.monthlyAmount,
        fileRowIndex: 0,
        importedAt: new Date().toISOString(),
        category: bill.category,
        confidence: 1,
        explanation: `fixed bill: ${bill.label}`,
        reviewed: existingTx?.reviewed || false
      };

      if (bill.merchantPatterns && bill.merchantPatterns.length > 0) {
        const coverage = pickCoverage(bill, allTransactions, yearMonth);
        syntheticTx.fixedMissing = coverage.missing;
        syntheticTx.fixedChanged = coverage.changed;

        if (coverage.cover) {
          db.markAsCoveredByFixedBill(coverage.cover.id, bill.label, coverage.changed);
        }
        for (const tx of coverage.flagUncovered) {
          db.flagAmountChanged(tx.id);
        }
      }

      db.insertTransaction(syntheticTx);
      db.setFixedReviewFlags(syntheticTx.id, !!syntheticTx.fixedMissing, !!syntheticTx.fixedChanged);
    }

    const keepIds = new Set(activeBills.map(bill => `fixed:${bill.id}:${yearMonth}`));
    for (const tx of db.getTransactionsByMonth(yearMonth)) {
      if (tx.source === 'fixed' && !keepIds.has(tx.id)) {
        db.deleteTransaction(tx.id);
      }
    }
  });
}

function pickCoverage(bill: FixedBill, allTransactions: Transaction[], yearMonth: string): {
  cover?: Transaction;
  flagUncovered: Transaction[];
  missing: boolean;
  changed: boolean;
} {
  const isDue = isBillDue(bill, yearMonth);
  const expectedAmount = getExpectedChargeAmount(bill);
  const patternMatches = allTransactions.filter(tx =>
    tx.source !== 'fixed' &&
    tx.fixedOverride !== 'unlink' &&
    matchesBillPattern(tx.merchant, bill)
  );
  const inBand = patternMatches.filter(tx => amountsMatchBill(tx.chfAmount, expectedAmount));

  if (inBand.length > 0) {
    const cover = closestCharge(inBand, expectedAmount);
    return {
      cover,
      flagUncovered: [],
      missing: false,
      changed: percentOff(cover.chfAmount, expectedAmount) > 2
    };
  }

  const offBandCover = patternMatches.filter(tx =>
    bill.coverAnyAmount ||
    (bill.shareOf && Math.round(tx.chfAmount * 100) >= Math.round(expectedAmount * 100))
  );
  if (offBandCover.length > 0) {
    const cover = closestCharge(offBandCover, expectedAmount);
    return {
      cover,
      flagUncovered: [],
      missing: false,
      changed: !bill.shareOf
    };
  }

  if (patternMatches.length > 0) {
    return {
      flagUncovered: patternMatches,
      missing: isDue,
      changed: false
    };
  }

  return {
    flagUncovered: [],
    missing: isDue,
    changed: false
  };
}
