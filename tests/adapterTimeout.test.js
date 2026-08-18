// Per-call deadlines (DESIGN-SPEC.md §8).
//
// The defect these pin: cancellation was threaded everywhere but nothing ever
// fired it, so a provider that opened a connection and went quiet hung the node
// forever. Attended that costs a click; unattended it costs the rest of the day.
//
// The tests use tiny idleMs values and adapters that deliberately hang, so a
// regression shows up as a FAILING test rather than a suite that takes forever:
// every case here must settle in milliseconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel, registerProvider, DEFAULT_TIMEOUT } from '../core/adapters/index.js';

// A call that never answers.
//
// Anchored by a timer, because node:test cancels the rest of a file the moment
// the event loop drains with promises still pending — and a stalled adapter is
// precisely an unsettled promise. Every anchor is released after the last test
// so the process still exits. `hang` honors abort the way the real adapters do;
// `hangIgnoringSignal` deliberately does not, to prove the backstop.
const anchors = [];
const anchor = () => { const t = setTimeout(() => {}, 30_000); anchors.push(t); return t; };
// The anchor deliberately outlives the call it belongs to — releasing it on
// abort would drain the loop between tests and cancel the rest of the file,
// which is the very failure it exists to prevent.
const hang = ({ signal } = {}) => new Promise((_, reject) => {
  anchor();
  signal?.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true });
});
const hangIgnoringSignal = () => new Promise(() => { anchor(); });
test.after(() => { for (const t of anchors) clearTimeout(t); });

test('a hung call ends on its idle deadline instead of hanging', async () => {
  registerProvider('hangs', hang);
  const started = Date.now();
  await assert.rejects(
    () => callModel({
      provider: 'hangs', model: 'm', prompt: 'p',
      retry: { attempts: 1, baseMs: 1 },
      timeout: { idleMs: 40 }
    }),
    err => err.timedOut === true && err.timeoutKind === 'idle' && /stalled/.test(err.message));
  assert.ok(Date.now() - started < 2000, 'settled promptly rather than hanging');
});

test('a timeout is transient, so the retry budget engages', async () => {
  let calls = 0;
  registerProvider('stalls-once', async ({ onText, signal }) => {
    calls += 1;
    if (calls === 1) return hang({ signal });
    onText?.('recovered');
    return { text: 'recovered', usage: null };
  });
  const r = await callModel({
    provider: 'stalls-once', model: 'm', prompt: 'p',
    onText: () => {},
    retry: { attempts: 3, baseMs: 1 },
    timeout: { idleMs: 40 }
  });
  assert.equal(r.text, 'recovered');
  assert.equal(r.retries, 1, 'the stalled attempt was retried, not surfaced');
  assert.equal(calls, 2);
});

test('each attempt gets a fresh deadline', async () => {
  let calls = 0;
  registerProvider('always-stalls', async ({ signal }) => { calls += 1; return hang({ signal }); });
  await assert.rejects(
    () => callModel({
      provider: 'always-stalls', model: 'm', prompt: 'p',
      retry: { attempts: 3, baseMs: 1 },
      timeout: { idleMs: 30 }
    }),
    err => err.timedOut === true);
  assert.equal(calls, 3, 'a stalled attempt did not consume the whole budget at once');
});

test('a retry is reported as a timeout, not an anonymous failure', async () => {
  const seen = [];
  let calls = 0;
  registerProvider('stall-report', async ({ signal }) => {
    calls += 1;
    if (calls === 1) return hang({ signal });
    return { text: 'ok', usage: null };
  });
  await callModel({
    provider: 'stall-report', model: 'm', prompt: 'p',
    retry: { attempts: 2, baseMs: 1 },
    timeout: { idleMs: 30 },
    onRetry: info => seen.push(info)
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timedOut, true);
  assert.equal(seen[0].timeoutKind, 'idle');
});

test('streaming resets the deadline, so a slow but live stream is never cut', async () => {
  // Emits well inside the idle window, for longer than the window itself: a
  // total-duration timeout would kill this, a progress deadline must not.
  registerProvider('slow-stream', async ({ onText }) => {
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 15));
      onText(`chunk ${i}`);
    }
    return { text: 'complete', usage: null };
  });
  const r = await callModel({
    provider: 'slow-stream', model: 'm', prompt: 'p',
    onText: () => {},
    retry: { attempts: 1, baseMs: 1 },
    timeout: { idleMs: 60 }
  });
  assert.equal(r.text, 'complete');
});

test('a hard ceiling bounds a call that keeps streaming forever', async () => {
  registerProvider('endless', async ({ onText, signal }) => {
    // Checks the signal between chunks, exactly as the real streaming adapters
    // do — so the hard ceiling is what stops it, not the test giving up.
    for (;;) {
      await new Promise(r => setTimeout(r, 5));
      if (signal?.aborted) throw new Error('aborted mid-stream');
      onText('still going');
    }
  });
  await assert.rejects(
    () => callModel({
      provider: 'endless', model: 'm', prompt: 'p',
      onText: () => {},
      retry: { attempts: 1, baseMs: 1 },
      timeout: { idleMs: 1000, hardMs: 60 }
    }),
    err => err.timedOut === true && err.timeoutKind === 'hard');
});

test('a deliberate stop outranks a deadline that fired alongside it', async () => {
  // Both land at once. The caller asked to stop, so it must read as an abort
  // (never retried) rather than as a transient timeout (retried).
  registerProvider('hangs-2', hang);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(
    () => callModel({
      provider: 'hangs-2', model: 'm', prompt: 'p',
      retry: { attempts: 3, baseMs: 1 },
      timeout: { idleMs: 20 },
      signal: ctl.signal
    }),
    err => err.aborted === true && !err.timedOut);
});

test('the deadline aborts the adapter, releasing the underlying request', async () => {
  let sawAbort = false;
  registerProvider('watches-signal', async ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted by signal')); });
  }));
  await assert.rejects(
    () => callModel({
      provider: 'watches-signal', model: 'm', prompt: 'p',
      retry: { attempts: 1, baseMs: 1 },
      timeout: { idleMs: 30 }
    }),
    err => err.timedOut === true);
  assert.equal(sawAbort, true, 'the adapter was told to stop, not merely abandoned');
});

test('an adapter that ignores its signal still cannot hold the call open', async () => {
  // Adapters are pluggable (registerProvider), so honoring abort is a property
  // of today's adapters, not a guarantee. The race is the backstop.
  registerProvider('ignores-signal', () => hangIgnoringSignal());
  await assert.rejects(
    () => callModel({
      provider: 'ignores-signal', model: 'm', prompt: 'p',
      retry: { attempts: 1, baseMs: 1 },
      timeout: { idleMs: 30 }
    }),
    err => err.timedOut === true);
});

test('a self-timed adapter opts out of the idle deadline but keeps the hard one', async () => {
  // The CLI-delegation providers bound their own child process and can be
  // legitimately quiet for minutes; an idle deadline there fails healthy work.
  const quiet = async () => { await new Promise(r => setTimeout(r, 60)); return { text: 'cli done', usage: null }; };
  quiet.selfTimed = true;
  registerProvider('cli-like', quiet);
  const r = await callModel({
    provider: 'cli-like', model: 'm', prompt: 'p',
    retry: { attempts: 1, baseMs: 1 },
    timeout: { idleMs: 10 }
  });
  assert.equal(r.text, 'cli done');

  const endless = async ({ signal }) => hang({ signal });
  endless.selfTimed = true;
  registerProvider('cli-wedged', endless);
  await assert.rejects(
    () => callModel({
      provider: 'cli-wedged', model: 'm', prompt: 'p',
      retry: { attempts: 1, baseMs: 1 },
      timeout: { idleMs: 10, hardMs: 40 }
    }),
    err => err.timedOut === true && err.timeoutKind === 'hard');
});

test('the shipped default is a generous idle deadline and no hard ceiling', () => {
  // A tight default would cut long non-streaming reasoning calls, which have no
  // progress signal at all; a hard ceiling by default would cut healthy agent
  // runs. Both are deliberate — assert them so a casual change is a decision.
  assert.equal(DEFAULT_TIMEOUT.idleMs, 300_000);
  assert.equal(DEFAULT_TIMEOUT.hardMs, null);
});
