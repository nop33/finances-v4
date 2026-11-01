export interface Transaction {
  id: string;
  date: string; // ISO date YYYY-MM-DD
  source: string;
  sourceCard?: string;
  merchant: string;
  description?: string;
  originalAmount: number;
  originalCurrency: string;
  chfAmount: number;
  fxRate?: number;
  fxRateDate?: string;
  fxConversionFailed?: boolean;
  fileRowIndex: number;
  importedAt: string;
  category?: string;
  confidence?: number;
  explanation?: string;
  categorizationSource?: 'merchant_memory' | 'rule' | 'unknown';
  reviewed?: boolean;
  newMerchant?: boolean;
  unusualAmount?: boolean;
  possibleDuplicate?: boolean;
  unconvertedFx?: boolean;
  fixedMissing?: boolean;
  fixedChanged?: boolean;
  coveredByFixedBill?: string;
}

export interface Category {
  column: string;
  group: string;
  leaf: string;
  tier: 'need' | 'want' | 'gifting' | 'savings';
}

export interface FxRate {
  date: string;
  currency: string;
  rateFromCHF: number;
  fetchedAt: string;
}

export interface ParsedTransaction {
  id?: string;
  date: string;
  merchant: string;
  description?: string;
  originalAmount: number;
  originalCurrency: string;
  source: string;
  sourceCard?: string;
  fileRowIndex: number;
}

export interface ParserResult {
  transactions: ParsedTransaction[];
  source: string;
}

export interface MerchantMemory {
  normalizedMerchant: string;
  category: string;
  timesUsed: number;
  lastUsed: string;
}

export interface CategorizationRule {
  id?: number;
  pattern: string;
  category: string;
  description?: string;
}
