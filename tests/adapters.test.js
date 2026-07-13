// Unit tests for the adapter layer's transient-error retry (core/adapters).
import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel, registerProvider, isTransientError } from '../core/adapters/index.js';

test('callModel retries transient errors and reports the retry count', async () => {
  let calls = 0;
  registerProvider('flaky', async () => {
    calls += 1;
    if (calls < 3) throw new Error('Fake API 429: rate limited');
    return { text: 'ok', usage: null };
  });
  const r = await callModel({ provider: 'flaky', model: 'm', system: '', prompt: 'p', retry: { attempts: 3, baseMs: 1 } });
  assert.equal(r.text, 'ok');
  assert.equal(r.retries, 2);
  assert.equal(calls, 3);
});

test('callModel does not retry permanent errors', async () => {
  let calls = 0;
  registerProvider('denied', async () => {
    calls += 1;
    throw new Error('Fake API 401: unauthorized');
  });
  await assert.rejects(
    () => callModel({ provider: 'denied', model: 'm', prompt: 'p', retry: { attempts: 3, baseMs: 1 } }),
    /401/);
  assert.equal(calls, 1);
});

test('callModel gives up after the attempt budget', async () => {
  let calls = 0;
  registerProvider('down', async () => {
    calls += 1;
    throw new Error('Fake API 503: unavailable');
  });
  await assert.rejects(
    () => callModel({ provider: 'down', model: 'm', prompt: 'p', retry: { attempts: 2, baseMs: 1 } }),
    /503/);
  assert.equal(calls, 2);
});

test('isTransientError classification', () => {
  assert.equal(isTransientError(new Error('Anthropic API 429: rate limited')), true);
  assert.equal(isTransientError(new Error('OpenRouter API 500: oops')), true);
  assert.equal(isTransientError(new TypeError('fetch failed')), true);
  assert.equal(isTransientError(new Error('read ECONNRESET')), true);
  assert.equal(isTransientError(new Error('Anthropic API 400: bad request')), false);
  assert.equal(isTransientError(new Error('OpenRouter API key is not set.')), false);
});
