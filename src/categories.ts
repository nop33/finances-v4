import { readFileSync } from 'fs';
import { Category } from './types.js';

interface CategoryConfig {
  columns: Array<{
    column: string;
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

      categories.push({
        column: col.column,
        group: col.group,
        leaf: col.header,
        tier,
      });
    }
  }

  return categories;
}
