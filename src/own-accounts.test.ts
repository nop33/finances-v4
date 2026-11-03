import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'fs';
import { isOwnAccountMerchant, loadOwnAccountNames } from './own-accounts.js';

describe('own accounts', () => {
  it('loads OWN_ACCOUNTS_CONFIG and matches To/From counterparts', () => {
    const path = './test-own-accounts-match.json';
    writeFileSync(path, JSON.stringify(['savings space', 'neon personal']));
    const prev = process.env.OWN_ACCOUNTS_CONFIG;
    process.env.OWN_ACCOUNTS_CONFIG = path;
    try {
      const names = loadOwnAccountNames();
      assert.deepStrictEqual(names, ['savings space', 'neon personal']);
      assert.strictEqual(isOwnAccountMerchant('To savings space', names), true);
      assert.strictEqual(isOwnAccountMerchant('FROM Neon Personal', names), true);
      assert.strictEqual(isOwnAccountMerchant('Alex Friend', names), false);
    } finally {
      if (prev === undefined) delete process.env.OWN_ACCOUNTS_CONFIG;
      else process.env.OWN_ACCOUNTS_CONFIG = prev;
      unlinkSync(path);
    }
  });

  it('returns no names when the config file is missing', () => {
    const prev = process.env.OWN_ACCOUNTS_CONFIG;
    process.env.OWN_ACCOUNTS_CONFIG = './test-own-accounts-missing.json';
    try {
      assert.deepStrictEqual(loadOwnAccountNames(), []);
    } finally {
      if (prev === undefined) delete process.env.OWN_ACCOUNTS_CONFIG;
      else process.env.OWN_ACCOUNTS_CONFIG = prev;
    }
  });
});
