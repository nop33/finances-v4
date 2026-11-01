import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { FxConverter } from './fx.js';
import { unlinkSync } from 'fs';

describe('FX Converter', () => {
  const testDbPath = './test-fx.sqlite';
  let db: DB;
  let fx: FxConverter;

  before(() => {
    db = new DB(testDbPath);
    fx = new FxConverter(db);
  });

  after(() => {
    db.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });

  it('should return CHF amount unchanged for CHF currency', async () => {
    const result = await fx.convertToCHF(100, 'CHF', '2024-10-15');
    assert.strictEqual(result.chfAmount, 100);
    assert.strictEqual(result.rate, undefined);
    assert.strictEqual(result.failed, undefined);
  });

  it('should cache FX rates in database', async () => {
    db.saveFxRate({
      date: '2024-10-15',
      currency: 'EUR',
      rateFromCHF: 0.95,
      fetchedAt: new Date().toISOString(),
    });

    const result = await fx.convertToCHF(95, 'EUR', '2024-10-15');
    assert.strictEqual(result.chfAmount, 100);
    assert.strictEqual(result.rate, 0.95);
    assert.strictEqual(result.rateDate, '2024-10-15');
    assert.strictEqual(result.failed, undefined);
  });

  it('should mark conversion as failed when rate unavailable', async () => {
    const result = await fx.convertToCHF(100, 'XXX', '2024-10-15');
    assert.strictEqual(result.failed, true);
  });
});
