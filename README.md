# Finances v4

Personal monthly expense tracker for Zürich. Imports transactions from Swiss banks into SQLite, converts foreign currencies at historical rates, and provides a foundation for expense categorization and monthly close workflows.

## Status

This is the first slice: the ingest core. It parses bank exports, converts currencies, and stores transactions. Categorization rules, Splitwise, SBB, the review UI, and Google Sheets export are future work.

## Supported banks

- **Cembra** (two cards): comma CSV with columns `Account number`, `Credit Card`, `Booking date`, `Merchant`, `Description`, `Type`, `Amount (CHF)`
- **Swisscard** (two cards): comma CSV with columns `Transaction date`, `Merchant`, `Card number`, `Currency`, `Amount`, `Debit/Credit`
- **Neon**: semicolon CSV with quoted headers `"Date";"Amount";...`. Amounts are already in CHF.
- **Revolut**: comma CSV or XLSX with columns `Type`, `Started Date`, `Completed Date`, `Description`, `Amount`, `Currency`, `State`

Files are auto-detected by their header format.

## Setup

### 1. Install dependencies

```bash
npm install
npm run build
```

### 2. Create category configuration

Extract your Google Sheet's header rows to a local JSON file. The file should contain the two header rows (group and leaf names) plus tier assignments.

**How to extract from Google Sheets:**

1. Export the Expences tab as CSV or use the Sheets API to read rows 1-2
2. Convert to the following JSON structure:

```json
{
  "columns": [
    {"column": "A", "header": "Year", "group": null, "role": "year"},
    {"column": "B", "header": "Date", "group": null, "role": "month_date"},
    {"column": "C", "header": "Category1", "group": "Group1", "role": "leaf_category"},
    {"column": "D", "header": "Category2", "group": "Group1", "role": "leaf_category"}
  ],
  "tierGroups": {
    "need": ["Group1", "Group2"],
    "want": ["Group3"],
    "gifting": ["Group4"],
    "savings": ["Group5"]
  }
}
```

3. Save to `./data/expences-columns.json` (or another path set via `CATEGORY_CONFIG` env var)

**Important:** This file contains your personal category names and is gitignored. Never commit it.

If the file is missing, the CLI will fail with a clear error message explaining how to create it.

## What it does

- **Parsing**: Reads bank CSV/XLSX exports, normalizes dates and amounts
- **FX conversion**: Fetches historical rates from frankfurter.app for the transaction date, caches them in SQLite. Unconverted amounts stay flagged and are never silently treated as CHF.
- **Stable IDs**: Includes file row index and occurrence count to keep same-day duplicate purchases distinct
- **Idempotent imports**: Re-importing the same file updates existing records by ID
- **Category map**: Loads expense categories from your local config with group, leaf name, column letter, and tier (need/want/gifting/savings)

## CLI

```bash
npm run build
node dist/cli.js import exports/cembra.csv exports/neon.csv
node dist/cli.js list --month 2024-10
```

## Schema

### transactions

- `id`: stable hash from date, merchant, amount, row index, and occurrence
- `date`: ISO date YYYY-MM-DD
- `source`: cembra, swisscard, neon, revolut
- `source_card`: card number if applicable
- `merchant`: merchant name
- `description`: transaction description
- `original_amount`, `original_currency`: amount in the original currency
- `chf_amount`: converted amount in CHF
- `fx_rate`, `fx_rate_date`: the rate used and the date it was fetched for
- `fx_conversion_failed`: 1 if conversion failed
- `file_row_index`: row number in the source file
- `imported_at`: timestamp of import

### fx_rates

- `date`, `currency`: composite key
- `rate_from_chf`: CHF to currency rate (e.g. 0.95 for EUR means 1 CHF = 0.95 EUR)
- `fetched_at`: timestamp

## Bugs fixed from v3

1. **Neon double-conversion**: v3 treated Neon's CHF amounts as foreign currency and converted them again. v4 keeps Neon amounts as CHF.
2. **Same-day duplicate loss**: v3 hashed date+merchant+amount without row context, collapsing genuine same-day duplicates. v4 includes file row index and occurrence count in the ID.
3. **FX at today's rate**: v3 used latest rates for all transactions. v4 fetches the rate for each transaction's date and caches it.

## Tests

```bash
npm test
```

Tests cover:
- Each parser on synthetic fixtures
- Same-day duplicates kept distinct
- Neon not double-converted
- Historical FX rates (mocked in tests)
- Idempotent re-import
- Category loading from config file

## Configuration

Set environment variables to override defaults:

- `DB_PATH`: Database location (default: `./data/finances.sqlite`)
- `CATEGORY_CONFIG`: Category configuration file (default: `./data/expences-columns.json`)

## Repository rules

This is a **PUBLIC** repository. Never commit real financial data. The `.gitignore` covers `data/`, `*.sqlite*`, `*.db`, `uploads/`, `exports/`, `.env*`, category config files, and CSV/XLSX files.

Tests use small synthetic fixtures with invented merchants and amounts only.
