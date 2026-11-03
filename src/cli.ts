#!/usr/bin/env node

import { DB } from './db.js';
import { parseFile } from './parsers/index.js';
import { importTransactions, formatImportStats } from './import.js';
import { categorizeMonth, correctTransaction } from './categorize.js';
import { applyFixedBills, unlinkFixedCharge, relinkFixedCharge } from './fixed.js';
import { importSplitwiseExpenses, importSplitwiseCsvFiles } from './splitwise.js';
import { parseSplitParts, splitTransaction, getCategoryTotals } from './split.js';
import { applyExcludeRules, setTransactionExcluded } from './exclude.js';
import { startServer } from './web-server.js';
import { writeLedger, writeExpencesRow, buildSummary, formatSummary } from './output.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`Usage:
  finances import [--month YYYY-MM] <file1> [file2 ...]
                                                Import transaction files
                                                Optional --month records the statement month
  finances sbb import <file1.txt> [file2.txt ...]  Import SBB EasyRide receipt files
  finances splitwise import --month YYYY-MM     Import Splitwise expenses for a month
  finances splitwise import-csv --month YYYY-MM --me "Name" <file1> [file2 ...]
                                                Import Splitwise CSV exports
  finances list --month YYYY-MM                 List transactions for a month
  finances categorise --month YYYY-MM           Auto-categorise transactions for a month
  finances correct <txId> <category>            Correct a transaction's category
  finances split <txId> <category>=<chf> [...]  Split one charge across categories
  finances exclude-apply --month YYYY-MM        Apply exclude-rules to a month
  finances exclude <txId>                       Exclude a transaction from totals
  finances include <txId>                       Include a transaction in totals
  finances fixed apply --month YYYY-MM          Apply fixed bills for a month
  finances fixed unlink <txId>                  Never treat this charge as a bill payment
  finances fixed relink <txId>                  Allow fixed apply to cover this charge again
  finances total --month YYYY-MM                Show month total (excludes covered charges)
  finances ledger --month YYYY-MM --out file.csv
                                                Write counted transactions as CSV
  finances expences-row --month YYYY-MM --out file.json
                                                Write one Expences sheet row as JSON
  finances summary --month YYYY-MM              Print a month summary
  finances serve [--port 4321] [--host 127.0.0.1]  Start web review server
`);
}

function requireMonth(argv: string[]): string {
  const monthIndex = argv.indexOf('--month');
  const month = monthIndex !== -1 ? argv[monthIndex + 1] : undefined;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    console.error('Error: --month YYYY-MM required');
    process.exit(1);
  }
  return month;
}

function takeOptionalMonth(argv: string[]): { month?: string; rest: string[] } {
  const rest: string[] = [];
  let month: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month') {
      const value = argv[i + 1];
      if (!value || !/^\d{4}-\d{2}$/.test(value)) {
        console.error('Error: --month YYYY-MM required');
        process.exit(1);
      }
      month = value;
      i++;
      continue;
    }
    rest.push(argv[i]);
  }
  return { month, rest };
}

function requireOut(argv: string[]): string {
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex !== -1 ? argv[outIndex + 1] : undefined;
  if (!outPath) {
    console.error('Error: --out <file> required');
    process.exit(1);
  }
  return outPath;
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

const dbPath = process.env.DB_PATH || './data/finances.sqlite';

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DB(dbPath);

try {
  if (command === 'import') {
    const { month: statementMonth, rest: files } = takeOptionalMonth(args.slice(1));
    if (files.length === 0) {
      console.error('Error: No files specified');
      process.exit(1);
    }

    for (const file of files) {
      console.log(`Importing ${file}...`);
      const parsed = parseFile(file);
      console.log(`  Parsed ${parsed.length} transactions`);
      const stats = await importTransactions(db, parsed, { file, statementMonth });
      console.log(`  ${formatImportStats(stats)}`);
    }
  } else if (command === 'sbb' && args[1] === 'import') {
    const files = args.slice(2);
    if (files.length === 0) {
      console.error('Error: No files specified');
      process.exit(1);
    }

    const totals = { new: 0, unchanged: 0 };
    let skipped = 0;

    for (const file of files) {
      console.log(`Processing ${file}...`);
      try {
        const parsed = parseFile(file);
        console.log(`  Parsed ${parsed.length} transactions`);
        const stats = await importTransactions(db, parsed);
        console.log(`  ${formatImportStats(stats)}`);
        totals.new += stats.new;
        totals.unchanged += stats.unchanged;
      } catch (error) {
        console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`  Skipping ${file}`);
        skipped++;
      }
    }

    console.log(`\nImport complete: ${formatImportStats(totals)}, ${skipped} skipped`);
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
      if (tx.splits && tx.splits.length > 0) {
        for (const part of tx.splits) {
          console.log(
            `          ${part.category.padEnd(30)}  CHF ${part.chfAmount.toFixed(2)}`
          );
        }
      }
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

    const transactions = db.getTransactionsByMonth(month).filter(t => !t.excluded);
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
  } else if (command === 'split') {
    const txId = args[1];
    if (!txId || args.length < 4) {
      console.error('Error: Usage: finances split <txId> <category>=<chf> [<category>=<chf> ...]');
      process.exit(1);
    }

    try {
      const parts = parseSplitParts(args.slice(2));
      splitTransaction(db, txId, parts);
      console.log(`Split ${txId} into ${parts.length} parts:`);
      for (const part of parts) {
        console.log(`  ${part.category}: CHF ${part.chfAmount.toFixed(2)}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else if (command === 'exclude-apply') {
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

    const applied = applyExcludeRules(db, month);
    console.log(`Excluded ${applied} transaction(s) for ${month}`);
  } else if (command === 'exclude' || command === 'include') {
    const txId = args[1];
    if (!txId) {
      console.error(`Error: Usage: finances ${command} <txId>`);
      process.exit(1);
    }

    try {
      setTransactionExcluded(db, txId, command === 'exclude');
      console.log(`${command === 'exclude' ? 'Excluded' : 'Included'} ${txId}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
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
  } else if (command === 'fixed' && (args[1] === 'unlink' || args[1] === 'relink')) {
    const txId = args[2];
    if (!txId) {
      console.error(`Error: Usage: finances fixed ${args[1]} <txId>`);
      process.exit(1);
    }
    try {
      if (args[1] === 'unlink') {
        unlinkFixedCharge(db, txId);
        console.log(`Unlinked ${txId} from fixed-bill coverage`);
      } else {
        relinkFixedCharge(db, txId);
        console.log(`Relinked ${txId} for fixed-bill coverage`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
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
    const byCategory = getCategoryTotals(db, month);
    const categories = Object.keys(byCategory).sort();
    if (categories.length > 0) {
      console.log('By category:');
      for (const category of categories) {
        console.log(`  ${category}: CHF ${byCategory[category].toFixed(2)}`);
      }
    }
  } else if (command === 'ledger') {
    const month = requireMonth(args);
    const outPath = requireOut(args);
    mkdirSync(dirname(outPath) || '.', { recursive: true });
    const rows = writeLedger(db, month, outPath);
    console.log(`Wrote ${rows.length} ledger row(s) to ${outPath}`);
  } else if (command === 'expences-row') {
    const month = requireMonth(args);
    const outPath = requireOut(args);
    mkdirSync(dirname(outPath) || '.', { recursive: true });
    const row = writeExpencesRow(db, month, outPath);
    console.log(`Wrote Expences row for ${row.month} to ${outPath}`);
    if (row.unmapped.length > 0) {
      console.log(`Unmapped categories: ${row.unmapped.map(u => u.category).join(', ')}`);
    }
    if (row.cellsSum !== row.total) {
      console.log(`cells sum ${row.cellsSum} != total ${row.total}`);
    }
  } else if (command === 'summary') {
    const month = requireMonth(args);
    process.stdout.write(formatSummary(buildSummary(db, month)));
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
  } else if (command === 'serve') {
    const portIndex = args.indexOf('--port');
    const port = portIndex !== -1 && args[portIndex + 1] 
      ? parseInt(args[portIndex + 1]) 
      : 4321;

    const hostIndex = args.indexOf('--host');
    const host = hostIndex !== -1 && args[hostIndex + 1]
      ? args[hostIndex + 1]
      : '127.0.0.1';

    console.log(`Starting web server...`);
    // Don't close DB - server needs it
    startServer(db, port, host);
    // Server runs indefinitely, process stays alive
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
} finally {
  if (command !== 'serve') {
    db.close();
  }
}
