import { test } from 'node:test';
import assert from 'node:assert/strict';

test('basic truthiness check', () => {
  assert.strictEqual(true, true);
});

test('basic equality check', () => {
  assert.strictEqual(42, 42);
});

test('node environment setup', () => {
  assert.ok(typeof process !== 'undefined');
  assert.ok(typeof globalThis !== 'undefined');
});
