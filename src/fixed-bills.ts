import { readFileSync } from 'fs';
import { loadCategories } from './categories.js';

export interface FixedBill {
  id: string;
  label: string;
  category: string;
  monthlyAmount: number;
  renewalMonth?: number;
  merchantPatterns?: string[];
  activeFrom?: string;
  activeUntil?: string;
}

interface FixedBillsConfig {
  bills: FixedBill[];
}

export function loadFixedBills(configPath?: string): FixedBill[] {
  const path = configPath || process.env.FIXED_BILLS_CONFIG || './data/fixed-bills.json';

  let config: FixedBillsConfig;
  try {
    const content = readFileSync(path, 'utf-8');
    config = JSON.parse(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Fixed bills configuration not found at ${path}.\n` +
        `Set FIXED_BILLS_CONFIG environment variable or create the file.\n` +
        `See data/fixed-bills.example.json for the expected format.`
      );
    }
    throw error;
  }

  validateFixedBills(config.bills);

  return config.bills;
}

function validateFixedBills(bills: FixedBill[]): void {
  const categories = loadCategories();
  const validCategories = new Set(categories.map(c => `${c.group}/${c.leaf}`));

  for (const bill of bills) {
    if (!bill.id || typeof bill.id !== 'string') {
      throw new Error(`Bill missing valid id: ${JSON.stringify(bill)}`);
    }

    if (!bill.label || typeof bill.label !== 'string') {
      throw new Error(`Bill ${bill.id} missing valid label`);
    }

    if (!bill.category || typeof bill.category !== 'string') {
      throw new Error(`Bill ${bill.id} missing valid category`);
    }

    if (!validCategories.has(bill.category)) {
      throw new Error(
        `Bill ${bill.id} has invalid category "${bill.category}". ` +
        `Category must exist in the category configuration (format: "Group/Leaf").`
      );
    }

    if (typeof bill.monthlyAmount !== 'number' || bill.monthlyAmount <= 0) {
      throw new Error(`Bill ${bill.id} has invalid monthlyAmount: must be a positive number`);
    }

    if (bill.renewalMonth !== undefined) {
      if (!Number.isInteger(bill.renewalMonth) || bill.renewalMonth < 1 || bill.renewalMonth > 12) {
        throw new Error(`Bill ${bill.id} has invalid renewalMonth: must be an integer between 1 and 12`);
      }
    }

    if (bill.activeFrom && !/^\d{4}-\d{2}$/.test(bill.activeFrom)) {
      throw new Error(`Bill ${bill.id} has invalid activeFrom: must be in YYYY-MM format`);
    }

    if (bill.activeUntil && !/^\d{4}-\d{2}$/.test(bill.activeUntil)) {
      throw new Error(`Bill ${bill.id} has invalid activeUntil: must be in YYYY-MM format`);
    }
  }
}

export function isBillActive(bill: FixedBill, yearMonth: string): boolean {
  if (bill.activeFrom && yearMonth < bill.activeFrom) {
    return false;
  }
  if (bill.activeUntil && yearMonth > bill.activeUntil) {
    return false;
  }
  return true;
}

export function isBillDue(bill: FixedBill, yearMonth: string): boolean {
  if (!bill.renewalMonth) {
    return true;
  }
  
  const month = parseInt(yearMonth.split('-')[1]);
  return month === bill.renewalMonth;
}

export function getExpectedChargeAmount(bill: FixedBill): number {
  if (bill.renewalMonth) {
    return bill.monthlyAmount * 12;
  }
  return bill.monthlyAmount;
}

// A bank charge is covered by a bill only when |amount - expected| / expected <= 10%.
export function amountsMatchBill(chfAmount: number, expectedAmount: number): boolean {
  if (expectedAmount === 0) return chfAmount === 0;
  const diffCents = Math.abs(Math.round(chfAmount * 100) - Math.round(expectedAmount * 100));
  const limitCents = Math.round(Math.abs(expectedAmount) * 10); // 10%
  return diffCents <= limitCents;
}

export function matchesBillPattern(merchant: string, bill: FixedBill): boolean {
  if (!bill.merchantPatterns || bill.merchantPatterns.length === 0) {
    return false;
  }

  const merchantLower = merchant.toLowerCase();
  
  for (const pattern of bill.merchantPatterns) {
    const patternLower = pattern.toLowerCase();
    
    try {
      const regex = new RegExp(patternLower, 'i');
      if (regex.test(merchantLower)) {
        return true;
      }
    } catch {
      if (merchantLower.includes(patternLower)) {
        return true;
      }
    }
  }
  
  return false;
}
