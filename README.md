# Finances v4

Personal monthly expense tracker for Zürich. Imports transactions from Swiss banks into SQLite, converts foreign currencies at historical rates, and provides a foundation for expense categorization and monthly close workflows.

## Status

This is the v4 feature set with auto-categorisation. It parses bank exports, converts currencies, stores transactions, and automatically categorises them using merchant memory and rules.

## Features

- **Parsing**: Reads bank CSV/XLSX exports, normalizes dates and amounts
- **FX conversion**: Fetches historical rates from frankfurter.app for the transaction date, caches them in SQLite
- **Stable IDs**: Includes file row index and occurrence count to keep same-day duplicate purchases distinct
- **Idempotent imports**: Re-importing the same file updates existing records by ID
- **Category map**: Loads expense categories from your local config with group, leaf name, column letter, and tier
- **Auto-categorisation**: Assigns categories using merchant memory (learned from corrections) and user-defined rules
- **Anomaly detection**: Flags new merchants, unusual amounts, possible duplicates, and unconverted FX
- **Merchant normalisation**: Strips payment processor prefixes (SumUp, Zettle, PayPal), card numbers, and city suffixes

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
- **Auto-categorisation**: Categorises transactions using:
  - **Merchant memory** (priority 1): Learned from user corrections, with smart merchant normalisation
  - **User rules** (priority 2): Pattern-based rules stored in SQLite
  - **Unknown** (priority 3): Uncategorised transactions flagged for review
- **Merchant normalisation**: Strips payment processor prefixes (SumUp*/Zettle*/PayPal*), card numbers, asterisks, and city suffixes (Zurich/ZH/CH)
- **Anomaly detection**: Each transaction is checked for:
  - **New merchant**: Never seen before
  - **Unusual amount**: More than 2 standard deviations from this merchant's history (requires ≥3 past transactions)
  - **Possible duplicate**: Same merchant and amount within 7 days (but NOT same-day identical, which are legitimate)
  - **Unconverted FX**: Foreign currency without an FX rate

## CLI

```bash
npm run build
node dist/cli.js import exports/cembra.csv exports/neon.csv
node dist/cli.js categorise --month 2024-10
node dist/cli.js list --month 2024-10
node dist/cli.js correct <txId> Meals/Snacks
node dist/cli.js ledger --month 2024-10 --out /tmp/2024-10-ledger.csv
node dist/cli.js expences-row --month 2024-10 --out /tmp/2024-10-expences.json
node dist/cli.js summary --month 2024-10
```

### Commands

- **import**: Import one or more transaction files
- **categorise --month YYYY-MM**: Auto-categorise all unreviewed transactions for the specified month
- **list --month YYYY-MM**: List all transactions for the specified month
- **correct <txId> <category>**: Manually correct a transaction's category, teaching merchant memory for future similar transactions
- **ledger --month YYYY-MM --out file.csv**: Counted (non-excluded, not covered-by-bill) transactions as CSV. Splits become one row per part. Columns: date, source, merchant, amount, category, splitwise_adjustment, reviewed. Sorted by date then id. A bank charge on the same day with a matching Splitwise merchant gets that share in `splitwise_adjustment`.
- **expences-row --month YYYY-MM --out file.json**: One monthly Expences row from `CATEGORY_CONFIG` leaf columns (letters C–CL). JSON `{month, cells, unmapped, total, cellsSum}`. Every mapped column is present (0 if no spend). Categories with spend but no column are listed in `unmapped`. Formula columns are not written.
- **summary --month YYYY-MM**: Total, top 5 categories, flagged row count (`fixedChanged`, `fixedMissing`, confidence below 0.7), and month-over-month delta when the previous month exists in the DB.

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
- `category`: assigned category (group/leaf format, e.g. "Meals/Snacks")
- `confidence`: confidence score (0..1)
- `explanation`: human-readable explanation of categorisation decision
- `categorization_source`: merchant_memory, rule, or unknown
- `reviewed`: 1 if the user has reviewed/corrected this transaction
- `new_merchant`: 1 if this merchant was never seen before
- `unusual_amount`: 1 if amount is >2σ from this merchant's history
- `possible_duplicate`: 1 if same merchant+amount within 7 days (excluding same-day)
- `unconverted_fx`: 1 if foreign currency without FX rate

### fx_rates

- `date`, `currency`: composite key
- `rate_from_chf`: CHF to currency rate (e.g. 0.95 for EUR means 1 CHF = 0.95 EUR)
- `fetched_at`: timestamp

### merchant_memory

- `normalized_merchant`: primary key, the normalised merchant name
- `category`: the category learned from corrections
- `times_used`: number of times this merchant was corrected to this category
- `last_used`: timestamp of last correction

### categorization_rules

- `id`: auto-increment primary key
- `pattern`: substring pattern to match (case-insensitive)
- `category`: category to assign when pattern matches
- `description`: optional description of the rule

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
- **Merchant normalisation**: Payment processor prefix stripping, card number removal, city suffix removal
- **Categorisation sources**: Merchant memory, rules, unknown
- **Confidence progression**: Confidence rises with repeated corrections
- **Anomaly detection**: New merchant, unusual amount, possible duplicate (excluding same-day identical), unconverted FX
- **Correction workflow**: Manual correction updates merchant memory and re-categorises similar transactions
- **Human-readable explanations**: Each categorisation includes a meaningful explanation

## Configuration

Set environment variables to override defaults:

- `DB_PATH`: Database location (default: `./data/finances.sqlite`)
- `CATEGORY_CONFIG`: Category configuration file (default: `./data/expences-columns.json`)
- `FIXED_BILLS_CONFIG`: Fixed bills JSON (default: `./data/fixed-bills.json`)

## Fixed bills

`finances fixed apply --month YYYY-MM` inserts one synthetic row per bill (the listed `monthlyAmount`) and may mark a bank charge as covered so it does not also count.

Coverage needs a merchant pattern match **and** an amount within 10% of the expected charge (`monthlyAmount`, or `monthlyAmount * 12` in `renewalMonth`). Among several in-band matches, the closest amount wins. Other pattern matches stay as normal expenses.

A match outside that 10% band is treated as a possible extra purchase from the same merchant. It still counts and is flagged `fixedChanged` for review (possible price change). The synthetic bill still counts and, in a month the bill is due, is flagged `fixedMissing` so the review UI can show that the annual/monthly charge was not seen. Nothing is dropped or double-counted by covering the extra.

Set `"coverAnyAmount": true` on a bill when a charge of any amount should cover it, for example rent paid in full and later partly repaid. That flag applies to one match or many. With several off-band matches it covers the closest.

```json
{
  "bills": [
    {
      "id": "rent",
      "label": "Rent",
      "category": "Living/Rent",
      "monthlyAmount": 1000,
      "merchantPatterns": ["landlord"],
      "coverAnyAmount": true
    }
  ]
}
```

## Repository rules

This is a **PUBLIC** repository. Never commit real financial data. The `.gitignore` covers `data/`, `*.sqlite*`, `*.db`, `uploads/`, `exports/`, `.env*`, category config files, and CSV/XLSX files.

Tests use small synthetic fixtures with invented merchants and amounts only.
