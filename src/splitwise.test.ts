import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { importSplitwiseExpenses } from './splitwise.js';
import { unlinkSync } from 'fs';

describe('Splitwise import', () => {
  const testDbPath = './test-splitwise.sqlite';
  let db: DB;

  before(() => {
    db = new DB(testDbPath);
    // Pre-populate FX rates to avoid real network calls
    db.saveFxRate({
      date: '2024-10-15',
      currency: 'EUR',
      rateFromCHF: 0.95,
      fetchedAt: new Date().toISOString(),
    });
    db.saveFxRate({
      date: '2024-10-20',
      currency: 'USD',
      rateFromCHF: 1.10,
      fetchedAt: new Date().toISOString(),
    });
  });

  after(() => {
    db.close();
    try {
      unlinkSync(testDbPath);
    } catch {}
  });

  it('should throw error when API key is missing', async () => {
    await assert.rejects(
      async () => {
        await importSplitwiseExpenses(db, '2024-10', '', mockFetch({}));
      },
      { message: 'SPLITWISE_API_KEY environment variable is required' }
    );
  });

  it('should import expense where user owes someone else', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1001,
            description: 'Dinner at Restaurant',
            date: '2024-10-15',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '25.50', net_balance: '25.50' },
              { user_id: 456, paid_share: '51.00', owed_share: '25.50', net_balance: '-25.50' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.skipped, 0);

    const tx = db.getTransaction('sw-1001');
    assert.ok(tx);
    assert.strictEqual(tx.merchant, 'Dinner at Restaurant');
    assert.strictEqual(tx.originalAmount, 25.50);
    assert.strictEqual(tx.chfAmount, 25.50);
    assert.strictEqual(tx.source, 'splitwise');
  });

  it('should import negative transaction when user paid and is owed', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1002,
            description: 'Groceries',
            date: '2024-10-16',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '100.00', owed_share: '50.00', net_balance: '-50.00' },
              { user_id: 456, paid_share: '0.00', owed_share: '50.00', net_balance: '50.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);

    const tx = db.getTransaction('sw-1002');
    assert.ok(tx);
    assert.strictEqual(tx.merchant, 'Groceries');
    assert.strictEqual(tx.originalAmount, -50.00);
    assert.strictEqual(tx.chfAmount, -50.00);
    assert.strictEqual(tx.source, 'splitwise');
  });

  it('should skip payment entries', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1003,
            description: 'Payment',
            date: '2024-10-17',
            currency_code: 'CHF',
            deleted_at: null,
            payment: true,
            users: [
              { user_id: 123, paid_share: '50.00', owed_share: '0.00', net_balance: '-50.00' },
              { user_id: 456, paid_share: '0.00', owed_share: '50.00', net_balance: '50.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.skipped, 1);

    const tx = db.getTransaction('sw-1003');
    assert.strictEqual(tx, undefined);
  });

  it('should handle deleted expenses by zeroing amount', async () => {
    // First import the expense
    const initialMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1004,
            description: 'Deleted Expense',
            date: '2024-10-18',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '30.00', net_balance: '30.00' },
              { user_id: 456, paid_share: '60.00', owed_share: '30.00', net_balance: '-30.00' },
            ],
          },
        ],
      },
    };

    await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(initialMockData));

    let tx = db.getTransaction('sw-1004');
    assert.ok(tx);
    assert.strictEqual(tx.chfAmount, 30.00);

    // Now re-import with the expense deleted
    const deletedMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1004,
            description: 'Deleted Expense',
            date: '2024-10-18',
            currency_code: 'CHF',
            deleted_at: '2024-10-19T10:00:00Z',
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '30.00', net_balance: '30.00' },
              { user_id: 456, paid_share: '60.00', owed_share: '30.00', net_balance: '-30.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(deletedMockData));

    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.skipped, 1);

    tx = db.getTransaction('sw-1004');
    assert.ok(tx);
    assert.strictEqual(tx.chfAmount, 0);
    assert.strictEqual(tx.originalAmount, 0);
  });

  it('should handle user no longer involved by zeroing amount', async () => {
    // First import with user involved
    const initialMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1005,
            description: 'Removed User Expense',
            date: '2024-10-19',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '20.00', net_balance: '20.00' },
              { user_id: 456, paid_share: '40.00', owed_share: '20.00', net_balance: '-20.00' },
            ],
          },
        ],
      },
    };

    await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(initialMockData));

    let tx = db.getTransaction('sw-1005');
    assert.ok(tx);
    assert.strictEqual(tx.chfAmount, 20.00);

    // Re-import with user no longer in the expense
    const removedUserMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1005,
            description: 'Removed User Expense',
            date: '2024-10-19',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 456, paid_share: '40.00', owed_share: '40.00', net_balance: '0.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(
      db,
      '2024-10',
      'test-key',
      mockFetch(removedUserMockData)
    );

    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.skipped, 1);

    tx = db.getTransaction('sw-1005');
    assert.ok(tx);
    assert.strictEqual(tx.chfAmount, 0);
  });

  it('should convert foreign currency to CHF', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1006,
            description: 'Euro Expense',
            date: '2024-10-15',
            currency_code: 'EUR',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '95.00', net_balance: '95.00' },
              { user_id: 456, paid_share: '95.00', owed_share: '0.00', net_balance: '-95.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);

    const tx = db.getTransaction('sw-1006');
    assert.ok(tx);
    assert.strictEqual(tx.originalAmount, 95.00);
    assert.strictEqual(tx.originalCurrency, 'EUR');
    assert.strictEqual(tx.chfAmount, 100); // 95 / 0.95
    assert.strictEqual(tx.fxRate, 0.95);
  });

  it('should preserve sign when converting negative foreign amounts', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1007,
            description: 'USD Expense (user paid)',
            date: '2024-10-20',
            currency_code: 'USD',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '110.00', owed_share: '55.00', net_balance: '-55.00' },
              { user_id: 456, paid_share: '0.00', owed_share: '55.00', net_balance: '55.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);

    const tx = db.getTransaction('sw-1007');
    assert.ok(tx);
    assert.strictEqual(tx.originalAmount, -55.00);
    assert.strictEqual(tx.originalCurrency, 'USD');
    assert.ok(Math.abs(tx.chfAmount - (-50)) < 0.01); // -(55 / 1.10), allow small floating-point error
    assert.strictEqual(tx.fxRate, 1.10);
  });

  it('should preserve category and reviewed on re-import', async () => {
    // First import
    const initialMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1008,
            description: 'Re-import Test',
            date: '2024-10-21',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '40.00', net_balance: '40.00' },
              { user_id: 456, paid_share: '80.00', owed_share: '40.00', net_balance: '-40.00' },
            ],
          },
        ],
      },
    };

    await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(initialMockData));

    // Manually categorize and review the transaction
    db.updateTransactionCategorization(
      'sw-1008',
      'need.food.groceries',
      0.95,
      'Test categorization',
      'merchant_memory',
      { newMerchant: false, unusualAmount: false, possibleDuplicate: false, unconvertedFx: false }
    );
    db.markAsReviewed('sw-1008');

    // Re-import with updated amount
    const updatedMockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1008,
            description: 'Re-import Test',
            date: '2024-10-21',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '45.00', net_balance: '45.00' },
              { user_id: 456, paid_share: '90.00', owed_share: '45.00', net_balance: '-45.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(updatedMockData));

    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.imported, 0);

    const tx = db.getTransaction('sw-1008');
    assert.ok(tx);
    assert.strictEqual(tx.chfAmount, 45.00); // Updated amount
    assert.strictEqual(tx.category, 'need.food.groceries'); // Preserved
    assert.strictEqual(tx.reviewed, true); // Preserved
    assert.strictEqual(tx.confidence, 0.95); // Preserved
  });

  it('should handle pagination correctly', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      // Mock will be called multiple times for pagination
      expenses_page1: {
        expenses: Array.from({ length: 100 }, (_, i) => ({
          id: 2000 + i,
          description: `Expense ${i}`,
          date: '2024-10-25',
          currency_code: 'CHF',
          deleted_at: null,
          payment: false,
          users: [
            { user_id: 123, paid_share: '0.00', owed_share: '10.00', net_balance: '10.00' },
            { user_id: 456, paid_share: '10.00', owed_share: '0.00', net_balance: '-10.00' },
          ],
        })),
      },
      expenses_page2: {
        expenses: Array.from({ length: 50 }, (_, i) => ({
          id: 2100 + i,
          description: `Expense ${100 + i}`,
          date: '2024-10-26',
          currency_code: 'CHF',
          deleted_at: null,
          payment: false,
          users: [
            { user_id: 123, paid_share: '0.00', owed_share: '10.00', net_balance: '10.00' },
            { user_id: 456, paid_share: '10.00', owed_share: '0.00', net_balance: '-10.00' },
          ],
        })),
      },
    };

    const mockFetchWithPaging = (url: string) => {
      if (url.includes('get_current_user')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockData.currentUser,
        } as Response);
      }

      if (url.includes('offset=0')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockData.expenses_page1,
        } as Response);
      }

      if (url.includes('offset=100')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockData.expenses_page2,
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ expenses: [] }),
      } as Response);
    };

    const result = await importSplitwiseExpenses(
      db,
      '2024-10',
      'test-key',
      mockFetchWithPaging as any
    );

    assert.strictEqual(result.imported, 150);
  });

  it('should skip expenses with net zero position', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 1009,
            description: 'Zero Net Expense',
            date: '2024-10-22',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '50.00', owed_share: '50.00', net_balance: '0.00' },
              { user_id: 456, paid_share: '50.00', owed_share: '50.00', net_balance: '0.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.skipped, 1);

    const tx = db.getTransaction('sw-1009');
    assert.strictEqual(tx, undefined);
  });
});

// Helper to create mock fetch function
function mockFetch(mockData: any): typeof fetch {
  return ((url: string | URL) => {
    const urlStr = url.toString();

    if (urlStr.includes('get_current_user')) {
      return Promise.resolve({
        ok: true,
        json: async () => mockData.currentUser,
      } as Response);
    }

    if (urlStr.includes('get_expenses')) {
      return Promise.resolve({
        ok: true,
        json: async () => mockData.expenses,
      } as Response);
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);
  }) as typeof fetch;
}
