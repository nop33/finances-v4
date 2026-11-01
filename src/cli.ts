#!/usr/bin/env node

import { DB } from './db.js';
import { parseFile } from './parsers/index.js';
import { importTransactions } from './import.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`Usage:
  finances import <file1> [file2 ...]    Import transaction files
  finances list --month YYYY-MM          List transactions for a month
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
