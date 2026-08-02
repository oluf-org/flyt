// PIVOT-PLAN §5.2 / verification item 5 — the per-attempt timeout.
//
// DESIGN-SPEC §11.1 recorded the gap: an AbortSignal was threaded everywhere by
// RUN-CONTROL, but nothing ever fired it on a timer, so a provider that simply
// stopped answering hung a node forever (a live run sat for 347 seconds). A
// timeout must abort the attempt AND engage the retry budget — a stall is a
// transient failure, not a user pressing stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStore } from './helpers.js';
import { callModel, registerProvider, isTransientError, isAbortError } from '../core/adapters/index.js';
import { makeCallLedger } from '../core/callLedger.js';

// A provider that never answers until its signal fires.
registerProvider('stalled', async ({ signal }) => new Promise((_, reject) => {
  signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
}));

test('a stalled provider is aborted at timeoutMs and the retry budget engages', async () => {
  const store = makeStore();
  const runId = store.createRun('timeout test');
  const started = Date.now();
  await assert.rejects(
    () => callModel({
      provider: 'stalled', model: 'm', prompt: 'p',
      timeoutMs: 60, retry: { attempts: 3, baseMs: 1 },
      ledger: makeCallLedger(store, runId, { nodeId: 'stuck' })
    }),
    err => {
      // The stall must NOT surface as an abort: an abort is a deliberate stop
      // and is never retried, which is exactly the wrong reading here.
      assert.equal(isAbortError(err), false);
      assert.equal(err.timedOut, true);
      assert.equal(isTransientError(err), true);
      return true;
    }
  );
  // Three attempts, each capped at 60ms — a hang would have run forever.
  assert.ok(Date.now() - started < 3000);
  const calls = store.readCalls(runId);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => /timeout/i.test(c.error)));
  assert.ok(calls.every(c => c.durationMs < 1000));
});

test('a user stop during a timed call still reads as an abort, not a timeout', async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(
    () => callModel({
      provider: 'stalled', model: 'm', prompt: 'p',
      timeoutMs: 5000, signal: ctl.signal, retry: { attempts: 3, baseMs: 1 }
    }),
    err => {
      assert.equal(isAbortError(err), true);
      assert.notEqual(err.timedOut, true);
      return true;
    }
  );
});

test('no timeoutMs keeps the pre-pivot behaviour: the call waits', async () => {
  registerProvider('slowish', async () => {
    await new Promise(r => setTimeout(r, 120));
    return { text: 'eventually', usage: null };
  });
  const r = await callModel({ provider: 'slowish', model: 'm', prompt: 'p' });
  assert.equal(r.text, 'eventually');
});
