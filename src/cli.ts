#!/usr/bin/env node

import { DB } from './db.js';
import { parseFile } from './parsers/index.js';
import { importTransactions } from './import.js';
import { categorizeMonth, correctTransaction } from './categorize.js';
import { applyFixedBills } from './fixed.js';
import { importSplitwiseExpenses, importSplitwiseCsvFiles } from './splitwise.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`Usage:
  finances import <file1> [file2 ...]           Import transaction files
  finances splitwise import --month YYYY-MM     Import Splitwise expenses for a month
  finances splitwise import-csv --month YYYY-MM --me "Name" <file1> [file2 ...]
                                                Import Splitwise CSV exports
  finances list --month YYYY-MM                 List transactions for a month
  finances categorise --month YYYY-MM           Auto-categorise transactions for a month
  finances correct <txId> <category>            Correct a transaction's category
  finances fixed apply --month YYYY-MM          Apply fixed bills for a month
  finances total --month YYYY-MM                Show month total (excludes covered charges)
`);
  process.exit(0);
}

const dbPath = process.env.DB_PATH || './data/finances.sqlite';

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DB(dbPath);

try {
  if (command === 'import') {
    const files = args.slice(1);
    if (files.length === 0) {
      console.error('Error: No files specified');
      process.exit(1);
    }

    for (const file of files) {
      console.log(`Importing ${file}...`);
      const parsed = parseFile(file);
      console.log(`  Parsed ${parsed.length} transactions`);
      await importTransactions(db, parsed);
      console.log(`  Imported successfully`);
    }
  } else if (command === 'list') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    const transactions = db.getTransactionsByMonth(month);
    console.log(`\nTransactions for ${month}: ${transactions.length} found\n`);

    for (const tx of transactions) {
      const fxInfo = tx.fxConversionFailed
        ? ' [FX FAILED]'
        : tx.fxRate
        ? ` (${tx.originalAmount.toFixed(2)} ${tx.originalCurrency} @ ${tx.fxRate.toFixed(4)})`
        : '';

      console.log(
        `${tx.date}  ${tx.merchant.padEnd(30)}  CHF ${tx.chfAmount.toFixed(2)}${fxInfo}`
      );
    }

    const total = transactions.reduce((sum, tx) => sum + tx.chfAmount, 0);
    console.log(`\nTotal: CHF ${total.toFixed(2)}`);
  } else if (command === 'categorise') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    console.log(`Categorising transactions for ${month}...`);
    categorizeMonth(db, month);

    const transactions = db.getTransactionsByMonth(month);
    const categorised = transactions.filter(t => t.category);
    console.log(`Categorised ${categorised.length} of ${transactions.length} transactions`);
  } else if (command === 'correct') {
    if (args.length < 3) {
      console.error('Error: Usage: finances correct <txId> <category>');
      process.exit(1);
    }

    const txId = args[1];
    const category = args[2];

    const tx = db.getTransaction(txId);
    if (!tx) {
      console.error(`Error: Transaction ${txId} not found`);
      process.exit(1);
    }

    console.log(`Correcting transaction ${txId} to category ${category}...`);
    correctTransaction(db, txId, category);
    console.log(`Done. Merchant memory updated.`);
  } else if (command === 'fixed' && args[1] === 'apply') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    console.log(`Applying fixed bills for ${month}...`);
    applyFixedBills(db, month);
    console.log(`Fixed bills applied successfully`);
  } else if (command === 'total') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    const total = db.getMonthTotal(month);
    console.log(`\nTotal for ${month}: CHF ${total.toFixed(2)}`);
    console.log(`(Excludes bank charges covered by fixed bills)\n`);
  } else if (command === 'splitwise' && args[1] === 'import') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    const apiKey = process.env.SPLITWISE_API_KEY;
    if (!apiKey) {
      console.error('Error: SPLITWISE_API_KEY environment variable is required');
      console.error('Set it with: export SPLITWISE_API_KEY=your_api_key');
      process.exit(1);
    }

    console.log(`Importing Splitwise expenses for ${month}...`);
    const result = await importSplitwiseExpenses(db, month, apiKey);
    console.log(`Import complete:`);
    console.log(`  Imported: ${result.imported} new expenses`);
    console.log(`  Updated: ${result.updated} existing expenses`);
    console.log(`  Skipped: ${result.skipped} (payments/deleted/zero net)`);
  } else if (command === 'splitwise' && args[1] === 'import-csv') {
    const monthIndex = args.indexOf('--month');
    if (monthIndex === -1 || !args[monthIndex + 1]) {
      console.error('Error: --month YYYY-MM required');
      process.exit(1);
    }

    const month = args[monthIndex + 1];
    if (!/^\d{4}-\d{2}$/.test(month)) {
      console.error('Error: Month must be in YYYY-MM format');
      process.exit(1);
    }

    const meIndex = args.indexOf('--me');
    let meName = meIndex !== -1 ? args[meIndex + 1] : process.env.SPLITWISE_ME;
    
    if (!meName) {
      console.error('Error: --me parameter or SPLITWISE_ME environment variable is required');
      console.error('Usage: finances splitwise import-csv --month YYYY-MM --me "Your Name" <file...>');
      process.exit(1);
    }

    // Find all files (args after --me value, excluding --month and its value)
    const files: string[] = [];
    for (let i = 2; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--month' || arg === '--me') {
        i++; // Skip the next arg (the value)
        continue;
      }
      if (arg === month || arg === meName) {
        continue; // Skip values
      }
      files.push(arg);
    }

    if (files.length === 0) {
      console.error('Error: No CSV files specified');
      process.exit(1);
    }

    console.log(`Importing Splitwise CSV files for ${month} (user: ${meName})...`);
    const result = await importSplitwiseCsvFiles(db, month, meName, files);
    console.log(`Import complete:`);
    console.log(`  Imported: ${result.imported} new expenses`);
    console.log(`  Updated: ${result.updated} existing expenses`);
    console.log(`  Skipped: ${result.skipped} (payments/zero/wrong month)`);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
} finally {
  db.close();
}
