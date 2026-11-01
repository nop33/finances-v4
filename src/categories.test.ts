import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadCategories } from './categories.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const syntheticFixture = resolve(__dirname, 'test-fixtures/synthetic-categories.json');

describe('Categories module', () => {
  it('should load categories from a JSON file', () => {
    const categories = loadCategories(syntheticFixture);

    assert.strictEqual(categories.length, 28);

    const uniqueColumns = new Set(categories.map(c => c.column));
    assert.strictEqual(uniqueColumns.size, 28);

    assert.ok(categories.every(c => c.column && c.group && c.leaf && c.tier));
  });

  it('should throw clear error when config file missing', () => {
    assert.throws(
      () => loadCategories('./nonexistent.json'),
      /Category configuration not found/
    );
  });

  it('should assign correct tiers based on tierGroups', () => {
    const categories = loadCategories(syntheticFixture);

    const snacks = categories.find(c => c.column === 'C');
    assert.strictEqual(snacks?.tier, 'need');
    assert.strictEqual(snacks?.group, 'Meals');

    const music = categories.find(c => c.column === 'P');
    assert.strictEqual(music?.tier, 'want');
    assert.strictEqual(music?.group, 'Entertainment');

    const familySupport = categories.find(c => c.column === 'AA');
    assert.strictEqual(familySupport?.tier, 'gifting');
    assert.strictEqual(familySupport?.group, 'Giving');

    const retirement = categories.find(c => c.column === 'AD');
    assert.strictEqual(retirement?.tier, 'savings');
    assert.strictEqual(retirement?.group, 'Savings');
  });

  it('should preserve exact spelling including typos', () => {
    const categories = loadCategories(syntheticFixture);

    const typo = categories.find(c => c.column === 'G');
    assert.strictEqual(typo?.leaf, 'Maintainence');
  });

  it('should handle multiple categories with same leaf name', () => {
    const categories = loadCategories(syntheticFixture);

    const others = categories.filter(c => c.leaf === 'Other');
    assert.ok(others.length >= 4);

    const uniqueGroups = new Set(others.map(c => c.group));
    assert.ok(uniqueGroups.size >= 4);
  });
});
