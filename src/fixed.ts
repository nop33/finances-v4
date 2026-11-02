import { DB } from './db.js';
import { Transaction } from './types.js';
import { loadFixedBills, isBillActive, isBillDue, getExpectedChargeAmount, matchesBillPattern, amountsMatchBill } from './fixed-bills.js';

export function applyFixedBills(db: DB, yearMonth: string): void {
  const bills = loadFixedBills();
  const activeBills = bills.filter(bill => isBillActive(bill, yearMonth));

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
      const isDue = isBillDue(bill, yearMonth);
      const expectedAmount = getExpectedChargeAmount(bill);
      const bankTransactions = allTransactions.filter(tx =>
        tx.source !== 'fixed' &&
        matchesBillPattern(tx.merchant, bill) &&
        amountsMatchBill(tx.chfAmount, expectedAmount)
      );

      if (isDue && bankTransactions.length === 0) {
        syntheticTx.fixedMissing = true;
      }

      for (const bankTx of bankTransactions) {
        const diff = Math.abs(bankTx.chfAmount - expectedAmount);
        const percentDiff = (diff / expectedAmount) * 100;
        const isChanged = percentDiff > 2;

        db.markAsCoveredByFixedBill(bankTx.id, bill.label, isChanged);
      }
    }

    db.insertTransaction(syntheticTx);
  }
}
