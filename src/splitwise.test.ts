import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DB } from './db.js';
import { importSplitwiseExpenses, importSplitwiseCsvFiles } from './splitwise.js';
import { unlinkSync, writeFileSync } from 'fs';

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

  it('should handle month boundaries correctly in Europe/Zurich timezone', async () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = 'Europe/Zurich';

    try {
      const mockData = {
        currentUser: { user: { id: 123 } },
        expenses: {
          expenses: [
            {
              id: 3001,
              description: 'October Expense',
              date: '2024-10-15',
              currency_code: 'CHF',
              deleted_at: null,
              payment: false,
              users: [
                { user_id: 123, paid_share: '0.00', owed_share: '30.00', net_balance: '30.00' },
                { user_id: 456, paid_share: '30.00', owed_share: '0.00', net_balance: '-30.00' },
              ],
            },
          ],
        },
      };

      let capturedUrl = '';
      const mockFetchWithCapture = (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('get_expenses')) {
          capturedUrl = urlStr;
        }
        return mockFetch(mockData)(url);
      };

      const result = await importSplitwiseExpenses(
        db,
        '2024-10',
        'test-key',
        mockFetchWithCapture as any
      );

      // Should use correct date boundaries
      assert.ok(capturedUrl.includes('dated_after=2024-10-01'), 'dated_after should be 2024-10-01');
      assert.ok(capturedUrl.includes('dated_before=2024-11-01'), 'dated_before should be 2024-11-01');

      assert.strictEqual(result.imported, 1);
    } finally {
      if (originalTZ) {
        process.env.TZ = originalTZ;
      } else {
        delete process.env.TZ;
      }
    }
  });

  it('should normalize Splitwise datetime to Europe/Zurich calendar date', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 3002,
            description: 'Late Evening UTC',
            date: '2024-10-15T23:30:00Z', // 23:30 UTC = next day (01:30) in Zurich
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '40.00', net_balance: '40.00' },
              { user_id: 456, paid_share: '40.00', owed_share: '0.00', net_balance: '-40.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);

    const tx = db.getTransaction('sw-3002');
    assert.ok(tx);
    // Should store as 2024-10-16 (next day in Zurich timezone)
    assert.strictEqual(tx.date, '2024-10-16');
  });

  it('should handle partial payer correctly (paid part, owes rest)', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 3003,
            description: 'Partial Payment',
            date: '2024-10-20',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '20.00', owed_share: '25.00', net_balance: '5.00' },
              { user_id: 456, paid_share: '80.00', owed_share: '75.00', net_balance: '-5.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 1);

    const tx = db.getTransaction('sw-3003');
    assert.ok(tx);
    // User paid 20 but owes 25, so net is +5 (owes 5 more)
    assert.strictEqual(tx.originalAmount, 5.00);
    assert.strictEqual(tx.chfAmount, 5.00);
  });

  it('should handle partial payer edge cases', async () => {
    const mockData = {
      currentUser: { user: { id: 123 } },
      expenses: {
        expenses: [
          {
            id: 3004,
            description: 'Paid 100, owed 50',
            date: '2024-10-21',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '100.00', owed_share: '50.00', net_balance: '-50.00' },
              { user_id: 456, paid_share: '0.00', owed_share: '50.00', net_balance: '50.00' },
            ],
          },
          {
            id: 3005,
            description: 'Paid 0, owed 25',
            date: '2024-10-22',
            currency_code: 'CHF',
            deleted_at: null,
            payment: false,
            users: [
              { user_id: 123, paid_share: '0.00', owed_share: '25.00', net_balance: '25.00' },
              { user_id: 456, paid_share: '50.00', owed_share: '25.00', net_balance: '-25.00' },
            ],
          },
        ],
      },
    };

    const result = await importSplitwiseExpenses(db, '2024-10', 'test-key', mockFetch(mockData));

    assert.strictEqual(result.imported, 2);

    const tx3004 = db.getTransaction('sw-3004');
    assert.ok(tx3004);
    // Paid 100, owed 50 => net -50 (owed to them)
    assert.strictEqual(tx3004.originalAmount, -50.00);
    assert.strictEqual(tx3004.chfAmount, -50.00);

    const tx3005 = db.getTransaction('sw-3005');
    assert.ok(tx3005);
    // Paid 0, owed 25 => net +25 (owes them)
    assert.strictEqual(tx3005.originalAmount, 25.00);
    assert.strictEqual(tx3005.chfAmount, 25.00);
  });
});

describe('Splitwise CSV import', () => {
  const testDbPath = './test-splitwise-csv.sqlite';
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

  it('should import expense where user owes', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Bob,Me
2024-10-15,Dinner,Food,50.00,CHF,0.00,-37.50,12.50`;
    
    const testFile = './test-csv-owes.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.skipped, 0);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant === 'Dinner');
      
      assert.ok(tx);
      assert.strictEqual(tx.originalAmount, -12.50); // User net +12.50 => amount -12.50
      assert.strictEqual(tx.chfAmount, -12.50);
      assert.strictEqual(tx.source, 'splitwise');
      assert.strictEqual(tx.date, '2024-10-15');
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should import expense where user is owed', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Bob,Me
2024-10-16,Groceries,Food,100.00,CHF,0.00,50.00,-50.00`;
    
    const testFile = './test-csv-owed.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 1);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant === 'Groceries');
      
      assert.ok(tx);
      assert.strictEqual(tx.originalAmount, 50.00); // User net -50 => amount +50
      assert.strictEqual(tx.chfAmount, 50.00);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should skip payment rows', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-17,Payment,Payment,30.00,CHF,-30.00,30.00`;
    
    const testFile = './test-csv-payment.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 0);
      assert.strictEqual(result.skipped, 1);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should skip total balance rows', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-18,Lunch,Food,40.00,CHF,-20.00,20.00
,Total balance,,,,-20.00,20.00`;
    
    const testFile = './test-csv-total.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(result.skipped, 1);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant === 'Lunch');
      assert.ok(tx);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should convert foreign currency', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-15,Euro Expense,Food,95.00,EUR,0.00,47.50`;
    
    const testFile = './test-csv-fx.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 1);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant === 'Euro Expense');
      
      assert.ok(tx);
      assert.strictEqual(tx.originalAmount, -47.50);
      assert.strictEqual(tx.originalCurrency, 'EUR');
      assert.strictEqual(tx.fxRate, 0.95);
      assert.strictEqual(Math.round(tx.chfAmount * 100) / 100, -50); // -47.50 / 0.95 ≈ -50
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should generate distinct IDs for identical rows in same file', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-19,Coffee,Food,10.00,CHF,-5.00,5.00
2024-10-19,Coffee,Food,10.00,CHF,-5.00,5.00`;
    
    const testFile = './test-csv-identical.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 2);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const coffees = transactions.filter(t => t.merchant === 'Coffee');
      
      assert.strictEqual(coffees.length, 2);
      assert.notStrictEqual(coffees[0].id, coffees[1].id);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should generate distinct IDs for same expense in different files', async () => {
    const csvContent1 = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-20,Shared Expense,Food,30.00,CHF,-15.00,15.00`;
    
    const csvContent2 = `Date,Description,Category,Cost,Currency,Bob,Me
2024-10-20,Shared Expense,Food,30.00,CHF,-15.00,15.00`;
    
    const testFile1 = './test-csv-file1.csv';
    const testFile2 = './test-csv-file2.csv';
    writeFileSync(testFile1, csvContent1);
    writeFileSync(testFile2, csvContent2);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile1, testFile2]);
      
      assert.strictEqual(result.imported, 2);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const shared = transactions.filter(t => t.merchant === 'Shared Expense');
      
      assert.strictEqual(shared.length, 2);
      assert.notStrictEqual(shared[0].id, shared[1].id);
    } finally {
      unlinkSync(testFile1);
      unlinkSync(testFile2);
    }
  });

  it('should preserve category and reviewed on re-import', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-21,Re-import Test,Food,80.00,CHF,-40.00,40.00`;
    
    const testFile = './test-csv-reimport.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      // First import
      await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant === 'Re-import Test');
      assert.ok(tx);
      
      // Categorize and review
      db.updateTransactionCategorization(
        tx.id,
        'need.food.groceries',
        0.95,
        'Test categorization',
        'merchant_memory',
        { newMerchant: false, unusualAmount: false, possibleDuplicate: false, unconvertedFx: false }
      );
      db.markAsReviewed(tx.id);
      
      // Re-import
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.updated, 1);
      assert.strictEqual(result.imported, 0);
      
      const txAfter = db.getTransaction(tx.id);
      assert.ok(txAfter);
      assert.strictEqual(txAfter.category, 'need.food.groceries');
      assert.strictEqual(txAfter.reviewed, true);
      assert.strictEqual(txAfter.confidence, 0.95);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should error if --me column not found', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Bob
2024-10-22,Test,Food,20.00,CHF,-10.00,10.00`;
    
    const testFile = './test-csv-missing-me.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      await assert.rejects(
        async () => {
          await importSplitwiseCsvFiles(db, '2024-10', 'NotFound', [testFile]);
        },
        { message: /Column "NotFound" not found in CSV header/ }
      );
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should filter by month', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-09-30,September Expense,Food,20.00,CHF,-10.00,10.00
2024-10-01,October Start,Food,30.00,CHF,-15.00,15.00
2024-10-31,October End,Food,40.00,CHF,-20.00,20.00
2024-11-01,November Expense,Food,50.00,CHF,-25.00,25.00`;
    
    const testFile = './test-csv-month-filter.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.skipped, 2);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const imported = transactions.filter(t => 
        t.merchant === 'October Start' || t.merchant === 'October End'
      );
      
      assert.strictEqual(imported.length, 2);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should skip zero net rows', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Bob,Me
2024-10-23,Zero Net,Food,60.00,CHF,-30.00,-30.00,0.00`;
    
    const testFile = './test-csv-zero.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 0);
      assert.strictEqual(result.skipped, 1);
    } finally {
      unlinkSync(testFile);
    }
  });

  it('should handle CSV with quoted fields', async () => {
    const csvContent = `Date,Description,Category,Cost,Currency,Alice,Me
2024-10-24,"Dinner at ""Best"" Restaurant",Food,70.00,CHF,-35.00,35.00`;
    
    const testFile = './test-csv-quotes.csv';
    writeFileSync(testFile, csvContent);
    
    try {
      const result = await importSplitwiseCsvFiles(db, '2024-10', 'Me', [testFile]);
      
      assert.strictEqual(result.imported, 1);
      
      const transactions = db.getTransactionsByMonth('2024-10');
      const tx = transactions.find(t => t.merchant.includes('Best'));
      
      assert.ok(tx);
      assert.strictEqual(tx.merchant, 'Dinner at "Best" Restaurant');
    } finally {
      unlinkSync(testFile);
    }
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
