#!/usr/bin/env node

import { DB } from './db.js';
import { Transaction } from './types.js';
import { writeFileSync } from 'fs';

const dbPath = process.env.DB_PATH || './data/test-demo.sqlite';
const configPath = process.env.CATEGORY_CONFIG || './data/expences-columns.json';

// Create synthetic category config
const categoryConfig = {
  columns: [
    { column: 'A', header: 'Year', role: 'year' },
    { column: 'B', header: 'Month', role: 'month_date' },
    { column: 'C', header: 'Groceries', group: 'Food', role: 'leaf_category' },
    { column: 'D', header: 'Restaurant', group: 'Food', role: 'leaf_category' },
    { column: 'E', header: 'Coffee', group: 'Food', role: 'leaf_category' },
    { column: 'F', header: 'Train', group: 'Transport', role: 'leaf_category' },
    { column: 'G', header: 'Taxi', group: 'Transport', role: 'leaf_category' },
    { column: 'H', header: 'Movies', group: 'Entertainment', role: 'leaf_category' },
    { column: 'I', header: 'Books', group: 'Entertainment', role: 'leaf_category' },
    { column: 'J', header: 'Gym', group: 'Health', role: 'leaf_category' }
  ],
  tierGroups: {
    need: ['Food', 'Transport', 'Health'],
    want: ['Entertainment']
  }
};

writeFileSync(configPath, JSON.stringify(categoryConfig, null, 2));
console.log(`Created test category config at ${configPath}`);

const db = new DB(dbPath);

// Seed transactions with various states
const transactions: Transaction[] = [
  // High confidence, unreviewed
  {
    id: 'tx1',
    date: '2024-10-01',
    source: 'neon',
    merchant: 'Coop Supermarket',
    originalAmount: 87.45,
    originalCurrency: 'CHF',
    chfAmount: 87.45,
    fileRowIndex: 1,
    importedAt: new Date().toISOString(),
    category: 'Food/Groceries',
    confidence: 0.9,
    explanation: 'merchant memory: you filed "Coop Supermarket" under Food/Groceries 5 times',
    categorizationSource: 'merchant_memory',
    reviewed: false
  },
  // Low confidence, unreviewed
  {
    id: 'tx2',
    date: '2024-10-02',
    source: 'neon',
    merchant: 'Unknown Shop Ltd',
    originalAmount: 42.30,
    originalCurrency: 'CHF',
    chfAmount: 42.30,
    fileRowIndex: 2,
    importedAt: new Date().toISOString(),
    category: '',
    confidence: 0,
    explanation: 'unknown: no matching memory or rule',
    categorizationSource: 'unknown',
    reviewed: false
  },
  // New merchant flag, unreviewed
  {
    id: 'tx3',
    date: '2024-10-03',
    source: 'swisscard',
    merchant: 'Brand New Restaurant',
    originalAmount: 65.80,
    originalCurrency: 'CHF',
    chfAmount: 65.80,
    fileRowIndex: 3,
    importedAt: new Date().toISOString(),
    category: 'Food/Restaurant',
    confidence: 0.7,
    explanation: 'rule: contains "restaurant"',
    categorizationSource: 'rule',
    reviewed: false,
    newMerchant: true
  },
  // Foreign currency with FX, unreviewed
  {
    id: 'tx4',
    date: '2024-10-05',
    source: 'swisscard',
    sourceCard: '1234',
    merchant: 'Amazon EU',
    originalAmount: 49.99,
    originalCurrency: 'EUR',
    chfAmount: 52.64,
    fxRate: 0.95,
    fxRateDate: '2024-10-05',
    fileRowIndex: 4,
    importedAt: new Date().toISOString(),
    category: 'Entertainment/Books',
    confidence: 0.85,
    explanation: 'merchant memory: you filed "Amazon EU" under Entertainment/Books 3 times',
    categorizationSource: 'merchant_memory',
    reviewed: false
  },
  // Unusual amount flag, unreviewed
  {
    id: 'tx5',
    date: '2024-10-06',
    source: 'neon',
    merchant: 'Migros',
    originalAmount: 234.50,
    originalCurrency: 'CHF',
    chfAmount: 234.50,
    fileRowIndex: 5,
    importedAt: new Date().toISOString(),
    category: 'Food/Groceries',
    confidence: 0.8,
    explanation: 'merchant memory: you filed "Migros" under Food/Groceries 8 times',
    categorizationSource: 'merchant_memory',
    reviewed: false,
    unusualAmount: true
  },
  // Already reviewed
  {
    id: 'tx6',
    date: '2024-10-07',
    source: 'neon',
    merchant: 'SBB CFF FFS',
    originalAmount: 45.00,
    originalCurrency: 'CHF',
    chfAmount: 45.00,
    fileRowIndex: 6,
    importedAt: new Date().toISOString(),
    category: 'Transport/Train',
    confidence: 0.95,
    explanation: 'merchant memory: you filed "SBB CFF FFS" under Transport/Train 12 times',
    categorizationSource: 'merchant_memory',
    reviewed: true
  },
  // Possible duplicate flag, unreviewed
  {
    id: 'tx7',
    date: '2024-10-08',
    source: 'swisscard',
    merchant: 'Spotify',
    originalAmount: 12.90,
    originalCurrency: 'CHF',
    chfAmount: 12.90,
    fileRowIndex: 7,
    importedAt: new Date().toISOString(),
    category: 'Entertainment/Music',
    confidence: 0.75,
    explanation: 'rule: contains "spotify"',
    categorizationSource: 'rule',
    reviewed: false,
    possibleDuplicate: true
  },
  // Covered by fixed bill, unreviewed
  {
    id: 'tx8',
    date: '2024-10-10',
    source: 'swisscard',
    merchant: 'Annual Fee',
    originalAmount: 50.00,
    originalCurrency: 'CHF',
    chfAmount: 50.00,
    fileRowIndex: 8,
    importedAt: new Date().toISOString(),
    category: 'Banking/Fees',
    confidence: 0.9,
    explanation: 'paid via fixed bill: Swisscard Annual Fee',
    categorizationSource: 'merchant_memory',
    reviewed: false,
    coveredByFixedBill: 'Swisscard Annual Fee'
  },
  // Normal transaction, unreviewed
  {
    id: 'tx9',
    date: '2024-10-12',
    source: 'neon',
    merchant: 'Cafe Centrale',
    originalAmount: 8.50,
    originalCurrency: 'CHF',
    chfAmount: 8.50,
    fileRowIndex: 9,
    importedAt: new Date().toISOString(),
    category: 'Food/Coffee',
    confidence: 0.85,
    explanation: 'merchant memory: you filed "Cafe Centrale" under Food/Coffee 7 times',
    categorizationSource: 'merchant_memory',
    reviewed: false
  },
  // High confidence, unreviewed
  {
    id: 'tx10',
    date: '2024-10-15',
    source: 'neon',
    merchant: 'Fitness First',
    originalAmount: 89.00,
    originalCurrency: 'CHF',
    chfAmount: 89.00,
    fileRowIndex: 10,
    importedAt: new Date().toISOString(),
    category: 'Health/Gym',
    confidence: 0.95,
    explanation: 'merchant memory: you filed "Fitness First" under Health/Gym 6 times',
    categorizationSource: 'merchant_memory',
    reviewed: false
  }
];

db.insertTransactions(transactions);

// Add merchant memory for some merchants
db.recordCorrection('coop supermarket', 'Food/Groceries');
db.recordCorrection('migros', 'Food/Groceries');
db.recordCorrection('sbb cff ffs', 'Transport/Train');
db.recordCorrection('amazon eu', 'Entertainment/Books');
db.recordCorrection('cafe centrale', 'Food/Coffee');
db.recordCorrection('fitness first', 'Health/Gym');

// Add a rule
db.addRule('restaurant', 'Food/Restaurant', 'Auto-categorize restaurants');

console.log(`Seeded ${transactions.length} test transactions for 2024-10`);
console.log(`Database: ${dbPath}`);
console.log(`\nTransactions breakdown:`);
console.log(`  - ${transactions.filter(t => !t.reviewed && !t.coveredByFixedBill).length} in review queue (full mode)`);
console.log(`  - ${transactions.filter(t => !t.reviewed && !t.coveredByFixedBill && ((t.confidence || 0) < 0.7 || t.newMerchant || t.unusualAmount || t.possibleDuplicate)).length} in review queue (exceptions mode)`);
console.log(`  - ${transactions.filter(t => t.reviewed).length} already reviewed`);
console.log(`  - ${transactions.filter(t => t.coveredByFixedBill).length} covered by fixed bills`);

db.close();
