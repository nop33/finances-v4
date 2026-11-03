import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'fs';
import {
  loadFixedBills,
  isBillActive,
  isBillDue,
  billPeriodMonths,
  getExpectedChargeAmount,
  matchesBillPattern,
  amountsMatchBill,
  FixedBill
} from './fixed-bills.js';

test('loadFixedBills loads valid configuration', () => {
  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  const bills = loadFixedBills('./dist/test-fixtures/test-fixed-bills.json');
  
  assert.strictEqual(bills.length, 5);
  assert.strictEqual(bills[0].id, 'test-monthly-rent');
  assert.strictEqual(bills[0].category, 'Living/Rent');
  assert.strictEqual(bills[0].monthlyAmount, 1000);
});

test('loadFixedBills throws on missing file', () => {
  assert.throws(
    () => loadFixedBills('./nonexistent.json'),
    /Fixed bills configuration not found/
  );
});

test('loadFixedBills throws on invalid category', () => {
  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  
  const invalidConfig = './test-invalid-category.json';
  writeFileSync(invalidConfig, JSON.stringify({
    bills: [{
      id: 'test',
      label: 'Test',
      category: 'Invalid/Category',
      monthlyAmount: 100
    }]
  }));

  try {
    assert.throws(
      () => loadFixedBills(invalidConfig),
      /invalid category/
    );
  } finally {
    unlinkSync(invalidConfig);
  }
});

test('loadFixedBills validates renewalMonth range', () => {
  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  
  const invalidConfig = './test-invalid-renewal.json';
  writeFileSync(invalidConfig, JSON.stringify({
    bills: [{
      id: 'test',
      label: 'Test',
      category: 'Living/Rent',
      monthlyAmount: 100,
      renewalMonth: 13
    }]
  }));

  try {
    assert.throws(
      () => loadFixedBills(invalidConfig),
      /invalid renewalMonth/
    );
  } finally {
    unlinkSync(invalidConfig);
  }
});

test('isBillActive returns true for bills without date constraints', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100
  };

  assert.strictEqual(isBillActive(bill, '2024-01'), true);
  assert.strictEqual(isBillActive(bill, '2024-12'), true);
});

test('isBillActive respects activeFrom', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    activeFrom: '2024-06'
  };

  assert.strictEqual(isBillActive(bill, '2024-05'), false);
  assert.strictEqual(isBillActive(bill, '2024-06'), true);
  assert.strictEqual(isBillActive(bill, '2024-07'), true);
});

test('isBillActive respects activeUntil', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    activeUntil: '2024-06'
  };

  assert.strictEqual(isBillActive(bill, '2024-05'), true);
  assert.strictEqual(isBillActive(bill, '2024-06'), true);
  assert.strictEqual(isBillActive(bill, '2024-07'), false);
});

test('isBillDue returns true for monthly bills', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100
  };

  assert.strictEqual(isBillDue(bill, '2024-01'), true);
  assert.strictEqual(isBillDue(bill, '2024-12'), true);
});

test('isBillDue returns true only in renewal month for annual bills', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    renewalMonth: 3
  };

  assert.strictEqual(isBillDue(bill, '2024-01'), false);
  assert.strictEqual(isBillDue(bill, '2024-03'), true);
  assert.strictEqual(isBillDue(bill, '2024-12'), false);
});

test('loadFixedBills validates periodMonths range and requires an anchor', () => {
  process.env.CATEGORY_CONFIG = './dist/test-fixtures/test-categories-fixed.json';
  const invalidConfig = './test-invalid-period.json';
  writeFileSync(invalidConfig, JSON.stringify({
    bills: [{
      id: 'test',
      label: 'Test',
      category: 'Living/Rent',
      monthlyAmount: 100,
      periodMonths: 3
    }]
  }));
  try {
    assert.throws(() => loadFixedBills(invalidConfig), /renewalMonth/);
  } finally {
    unlinkSync(invalidConfig);
  }
});

test('isBillDue uses periodMonths and renewalMonth as the anchor', () => {
  const quarterly: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 30,
    periodMonths: 3,
    renewalMonth: 1
  };
  assert.strictEqual(isBillDue(quarterly, '2024-01'), true);
  assert.strictEqual(isBillDue(quarterly, '2024-02'), false);
  assert.strictEqual(isBillDue(quarterly, '2024-04'), true);
  assert.strictEqual(isBillDue(quarterly, '2024-07'), true);
  assert.strictEqual(isBillDue(quarterly, '2024-10'), true);
  assert.strictEqual(isBillDue(quarterly, '2024-12'), false);
  assert.strictEqual(billPeriodMonths(quarterly), 3);
});

test('getExpectedChargeAmount returns monthlyAmount for monthly bills', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100
  };

  assert.strictEqual(getExpectedChargeAmount(bill), 100);
});

test('getExpectedChargeAmount returns annual amount for annual bills', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    renewalMonth: 3
  };

  assert.strictEqual(getExpectedChargeAmount(bill), 1200);
});

test('getExpectedChargeAmount multiplies monthlyAmount by periodMonths', () => {
  const quarterly: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 30,
    periodMonths: 3,
    renewalMonth: 1
  };
  assert.strictEqual(getExpectedChargeAmount(quarterly), 90);
});

test('matchesBillPattern returns false for bills without patterns', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100
  };

  assert.strictEqual(matchesBillPattern('Any Merchant', bill), false);
});

test('matchesBillPattern matches simple string patterns', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    merchantPatterns: ['landlord', 'property']
  };

  assert.strictEqual(matchesBillPattern('Landlord Inc', bill), true);
  assert.strictEqual(matchesBillPattern('Property Management', bill), true);
  assert.strictEqual(matchesBillPattern('Some Other Merchant', bill), false);
});

test('matchesBillPattern matches regex patterns', () => {
  const bill: FixedBill = {
    id: 'test',
    label: 'Test',
    category: 'Living/Rent',
    monthlyAmount: 100,
    merchantPatterns: ['^insurance.*co$']
  };

  assert.strictEqual(matchesBillPattern('Insurance Company Co', bill), true);
  assert.strictEqual(matchesBillPattern('Insurance Co', bill), true);
  assert.strictEqual(matchesBillPattern('Insurance Inc', bill), false);
  assert.strictEqual(matchesBillPattern('Best Insurance Co', bill), false);
});

test('amountsMatchBill allows a 10% band around the expected amount', () => {
  assert.strictEqual(amountsMatchBill(4, 4), true);
  assert.strictEqual(amountsMatchBill(4.40, 4), true);
  assert.strictEqual(amountsMatchBill(3.60, 4), true);
  assert.strictEqual(amountsMatchBill(26.95, 4), false);
  assert.strictEqual(amountsMatchBill(1090, 1000), true);
  assert.strictEqual(amountsMatchBill(1110, 1000), false);
});
