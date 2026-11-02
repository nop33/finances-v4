import { readFileSync } from 'fs';
import { Category } from './types.js';

interface CategoryConfig {
  columns: Array<{
    column?: string;
    group?: string;
    header: string;
    role: string;
  }>;
  tierGroups?: {
    need?: string[];
    want?: string[];
    gifting?: string[];
    savings?: string[];
  };
}

export function loadCategories(configPath?: string): Category[] {
  const path = configPath || process.env.CATEGORY_CONFIG || './data/expences-columns.json';

  let config: CategoryConfig;
  try {
    const content = readFileSync(path, 'utf-8');
    config = JSON.parse(content);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Category configuration not found at ${path}.\n` +
        `Set CATEGORY_CONFIG environment variable or create the file.\n` +
        `See README for instructions on how to extract it from your Google Sheet.`
      );
    }
    throw error;
  }

  const tierGroups = config.tierGroups || {
    need: [],
    want: [],
    gifting: [],
    savings: [],
  };

  const needGroups = new Set(tierGroups.need || []);
  const giftingGroups = new Set(tierGroups.gifting || []);
  const savingsGroups = new Set(tierGroups.savings || []);

  const categories: Category[] = [];
  const seenColumns = new Set<string>();

  for (const col of config.columns) {
    if (col.role === 'leaf_category' && col.group) {
      let tier: 'need' | 'want' | 'gifting' | 'savings';

      if (needGroups.has(col.group)) {
        tier = 'need';
      } else if (giftingGroups.has(col.group)) {
        tier = 'gifting';
      } else if (savingsGroups.has(col.group)) {
        tier = 'savings';
      } else {
        tier = 'want';
      }

      const column = col.column || '';
      if (column) {
        if (!isSheetColumn(column)) {
          throw new Error(
            `Category ${col.group}/${col.header} has invalid column "${column}": must be a sheet letter from C to CL`
          );
        }
        if (seenColumns.has(column)) {
          throw new Error(`Duplicate sheet column ${column} in category config`);
        }
        seenColumns.add(column);
      }

      categories.push({
        column,
        group: col.group,
        leaf: col.header,
        tier,
      });
    }
  }

  return categories;
}

const MIN_LEAF_COLUMN = columnIndex('C');
const MAX_LEAF_COLUMN = columnIndex('CL');

export function columnIndex(column: string): number {
  let n = 0;
  for (const ch of column) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

export function isSheetColumn(column: string): boolean {
  if (!/^[A-Z]{1,2}$/.test(column)) return false;
  const index = columnIndex(column);
  return index >= MIN_LEAF_COLUMN && index <= MAX_LEAF_COLUMN;
}
