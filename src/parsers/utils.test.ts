import { test } from 'node:test';
import assert from 'node:assert';
import { repairMojibake } from './utils.js';

test('repairMojibake restores German umlauts from latin1-misread UTF-8', () => {
  const garbled = Buffer.from('Bäckerei Zürich', 'utf8').toString('latin1');
  assert.strictEqual(repairMojibake(garbled), 'Bäckerei Zürich');
});

test('repairMojibake restores Greek from latin1-misread UTF-8', () => {
  const garbled = Buffer.from('Ταβέρνα Αθηνά', 'utf8').toString('latin1');
  assert.strictEqual(repairMojibake(garbled), 'Ταβέρνα Αθηνά');
});

test('repairMojibake restores an en dash from latin1-misread UTF-8', () => {
  const garbled = Buffer.from('Shop – Zurich', 'utf8').toString('latin1');
  assert.strictEqual(repairMojibake(garbled), 'Shop – Zurich');
});

test('repairMojibake restores an en dash from Windows-1252-misread UTF-8', () => {
  const garbled = 'Shop \u00E2\u20AC\u201C Zurich';
  assert.strictEqual(repairMojibake(garbled), 'Shop – Zurich');
});

test('repairMojibake leaves already-correct UTF-8 alone', () => {
  assert.strictEqual(repairMojibake('Bäckerei Zürich'), 'Bäckerei Zürich');
  assert.strictEqual(repairMojibake('Ταβέρνα'), 'Ταβέρνα');
  assert.strictEqual(repairMojibake('Shop – Zurich'), 'Shop – Zurich');
});
