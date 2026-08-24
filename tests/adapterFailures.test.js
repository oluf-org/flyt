// Honest CLI failures and attempt supersession (WR-05).
//
// Two production defects, one file:
//
// 1. The default planning attempt died with `spawn EPERM` before the Codex CLI
//    could do any model work. Every adapter error arrived as an
//    indistinguishable `Error`, so auto routing could not tell "this runtime
//    cannot start" from "this model answered badly", and diagnostics could not
//    name a remedy.
// 2. Retrying through OpenRouter worked, but the prior failure stayed on screen
//    while the new attempt was live — a run with two "current" states, showing
//    the wrong one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAdapterError, mayFallThrough, withFailureCode,
  isInfrastructureFailure, isTransientFailure, needsHuman, blamesTask,
  sanitizeFailureDetail, FAILURE_CODES
} from '../core/adapters/failures.js';
import { preflightCli } from '../core/adapters/cliDelegate.js';
import { autoFallbackTargets } from '../core/modelSource.js';
import {
  recordAttempt, settleAttempt, currentAttempt, priorAttempts, isSuperseded, attemptSummary
} from '../src/attempts.js';

const errWith = (message, props = {}) => Object.assign(new Error(message), props);

// --- classification ---------------------------------------------------------

test('spawn EPERM is a runtime-permission failure with a remedy naming the setting', () => {
  const r = classifyAdapterError(errWith('spawn EPERM', { code: 'EPERM' }), {
    provider: 'codex', executable: '/usr/local/bin/codex'
  });
  assert.equal(r.code, 'runtime-permission');
  assert.equal(r.infrastructure, true);
  assert.match(r.remedy, /Settings → Providers → codex/);
  assert.match(r.remedy, /\/usr\/local\/bin\/codex/);
});

test('a missing CLI is distinguished from one that will not launch', () => {
  assert.equal(classifyAdapterError(errWith('spawn ENOENT', { code: 'ENOENT' }), { provider: 'codex' }).code, 'runtime-missing');
  assert.equal(classifyAdapterError(errWith('spawn EACCES', { code: 'EACCES' }), { provider: 'codex' }).code, 'runtime-permission');
});

test('the rest of the failure vocabulary is classified from structured signals first', () => {
  const cases = [
    [errWith('nope', { status: 401 }), 'auth'],
    [errWith('nope', { status: 429 }), 'quota'],
    [errWith('nope', { status: 404 }), 'capability'],
    [errWith('nope', { status: 503 }), 'network'],
    [errWith('socket hang up', { code: 'ECONNRESET' }), 'network'],
    [errWith('CLI call timed out after 600s'), 'timeout'],
    [errWith('aborted', { aborted: true }), 'cancelled'],
    [errWith('unknown variant `priority`'), 'protocol'],
    [errWith('something nobody predicted'), 'unknown']
  ];
  for (const [err, code] of cases) {
    assert.equal(classifyAdapterError(err, { provider: 'p' }).code, code, `${err.message} -> ${code}`);
  }
  for (const [, code] of cases) assert.ok(FAILURE_CODES.includes(code));
});

test('a classification carries no secrets', () => {
  const r = classifyAdapterError(errWith('failed with Authorization: Bearer sk-abcdef123456789'), { provider: 'p' });
  assert.doesNotMatch(r.detail, /sk-abcdef123456789/);
  assert.match(r.detail, /\[redacted\]/);
  assert.equal(sanitizeFailureDetail('api_key = zzzzzzzzzzzz'), '[redacted]');
});

test('an adapter-assigned code survives being re-thrown', () => {
  const err = withFailureCode(new Error('boom'), 'runtime-permission', { executable: '/x/codex' });
  assert.equal(classifyAdapterError(err, { provider: 'codex', executable: err.executable }).code, 'runtime-permission');
});

// --- fallback eligibility ---------------------------------------------------

test('only infrastructure failures may fall through, and only for an auto source', () => {
  assert.equal(mayFallThrough('runtime-permission', 'auto'), true);
  assert.equal(mayFallThrough('runtime-missing', 'auto'), true);
  // Pinned means pinned: an explicit source must fail rather than spend elsewhere.
  assert.equal(mayFallThrough('runtime-permission', 'codex'), false);
  assert.equal(mayFallThrough('runtime-missing', 'anthropic'), false);
  // A bad key or a rate limit fails identically elsewhere — trying costs money
  // to learn nothing.
  for (const code of ['auth', 'quota', 'capability', 'protocol', 'timeout', 'network', 'cancelled', 'unknown']) {
    assert.equal(mayFallThrough(code, 'auto'), false, `${code} must not fall through`);
    assert.equal(isInfrastructureFailure(code), false);
  }
});

test('auto fallback is bounded, ordered by priority, and never revisits a provider', () => {
  const config = {
    providerPriority: ['codex', 'openrouter', 'anthropic', 'kimi'],
    resolveModelSource: (model, pinned) => {
      if (pinned === 'kimi') throw new Error('not connected');
      return { provider: pinned, model, apiKey: 'k' };
    }
  };
  const targets = autoFallbackTargets({ provider: 'auto', model: 'x' }, config, { tried: ['codex'] });
  // Exclusion also works when given a resolved target rather than a bare id.
  assert.deepEqual(
    autoFallbackTargets({ provider: 'auto', model: 'x' }, config,
      { tried: [{ provider: 'codex', model: 'x' }] }).map(t => t.provider),
    ['openrouter', 'anthropic']);
  assert.deepEqual(targets.map(t => t.provider), ['openrouter', 'anthropic']); // capped at 2
  // A disconnected provider is skipped rather than offered.
  assert.equal(targets.some(t => t.provider === 'kimi'), false);
  // The one already tried is never offered again — no cycling.
  assert.equal(targets.some(t => t.provider === 'codex'), false);
});

test('a PINNED worker gets no fallback candidates at all', () => {
  const config = {
    providerPriority: ['codex', 'openrouter'],
    resolveModelSource: (model, pinned) => ({ provider: pinned, model, apiKey: 'k' })
  };
  assert.deepEqual(autoFallbackTargets({ provider: 'codex', model: 'x' }, config), []);
});

// --- preflight --------------------------------------------------------------

test('preflight reports a missing CLI without spawning anything', () => {
  const r = preflightCli({ names: ['definitely-not-a-real-cli-xyz'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runtime-missing');
});

test('preflight rejects a configured path that is not a runnable file', () => {
  const r = preflightCli({ override: '/no/such/binary/anywhere', names: ['codex'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'runtime-missing');
  assert.match(r.detail, /does not resolve|does not exist/);
});

// --- attempt supersession ---------------------------------------------------

test('a retry supersedes the failure it replaces instead of competing with it', () => {
  let attempts = recordAttempt({}, 'plan', { worker: { provider: 'codex', model: 'gpt-5.2-codex' } });
  attempts = settleAttempt(attempts, 'plan', { status: 'failed', error: 'spawn EPERM', code: 'runtime-permission' });

  // The user retries on OpenRouter while the old failure is still on screen.
  attempts = recordAttempt(attempts, 'plan', { worker: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' } });

  const current = currentAttempt(attempts, 'plan');
  assert.equal(current.status, 'active');
  assert.equal(current.worker.provider, 'openrouter');

  // The old failure is not erased — it is demoted to history.
  const prior = priorAttempts(attempts, 'plan');
  assert.equal(prior.length, 1);
  assert.equal(prior[0].code, 'runtime-permission');
  assert.equal(isSuperseded(attempts, 'plan', prior[0].attemptId), true);
  assert.deepEqual(attemptSummary(attempts, 'plan'), { seq: 2, total: 2, hasHistory: true });
});

test('when the new attempt also fails, the NEWEST failure is primary and both stay inspectable', () => {
  let attempts = recordAttempt({}, 'plan', { worker: { provider: 'codex', model: 'a' } });
  attempts = settleAttempt(attempts, 'plan', { status: 'failed', error: 'spawn EPERM', code: 'runtime-permission' });
  attempts = recordAttempt(attempts, 'plan', { worker: { provider: 'openrouter', model: 'b' } });
  attempts = settleAttempt(attempts, 'plan', { status: 'failed', error: 'rate limited', code: 'quota' });

  const current = currentAttempt(attempts, 'plan');
  assert.equal(current.code, 'quota', 'the newest failure is the primary one');
  assert.equal(priorAttempts(attempts, 'plan')[0].code, 'runtime-permission');
  assert.equal(attempts.plan.length, 2);
});

test('a cancelled attempt is recorded as cancelled, never as a provider failure', () => {
  let attempts = recordAttempt({}, 'work', { worker: { provider: 'script', model: 'm' } });
  attempts = settleAttempt(attempts, 'work', { status: 'cancelled' });
  const current = currentAttempt(attempts, 'work');
  assert.equal(current.status, 'cancelled');
  assert.equal(current.code, undefined);
  // …and it is classified as a stop, not as something to retry elsewhere.
  assert.equal(classifyAdapterError(errWith('aborted', { aborted: true })).code, 'cancelled');
  assert.equal(mayFallThrough('cancelled', 'auto'), false);
});

test('a node with a single attempt shows no history badge', () => {
  const attempts = recordAttempt({}, 'solo', { worker: { provider: 'script', model: 'm' } });
  assert.equal(attemptSummary(attempts, 'solo'), null);
  assert.equal(priorAttempts(attempts, 'solo').length, 0);
});

// --- through the real executor ----------------------------------------------

test('an auto route falls through to the next provider when the runtime cannot start', async () => {
  const { makeStore, setScript, testConfig } = await import('./helpers.js');
  const { runExecutorTask } = await import('../core/nodes/executor.js');

  const store = makeStore();
  const runId = store.createRun('plan the work');
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Plan', goal: 'Describe the approach.',
    inputs: ['prompt.md'], constraints: [], tools: [],
    // `auto` is what makes this eligible: the task asked to be routed.
    worker: { provider: 'auto', model: 'some-model' }, status: 'pending'
  }] });

  const tried = [];
  setScript(({ model }) => {
    tried.push(model);
    if (model === 'via-codex') {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    }
    return '## Plan\n\nTwo passes.';
  });

  // First choice is the broken CLI; the next connected provider works.
  const config = testConfig({
    providerPriority: ['codex', 'openrouter'],
    resolveModelSource: (model, pinned) => pinned === 'openrouter'
      ? { provider: 'script', model: 'via-openrouter', apiKey: 'k' }
      : { provider: 'script', model: 'via-codex', apiKey: 'k' }
  });

  const retro = await runExecutorTask(store, runId, 'task-1', config);

  assert.equal(retro.status, 'success', 'the task completed on the fallback provider');
  assert.deepEqual(tried, ['via-codex', 'via-openrouter']);

  // The fallback is visible activity, not a silent substitution.
  const fell = (store.readLog(runId) ?? []).find(e => e.event === 'route_fallback');
  assert.ok(fell, 'route_fallback was logged');
  assert.equal(fell.code, 'runtime-permission');
  assert.match(fell.remedy, /Settings → Providers/);
});

test('a PINNED source that cannot start fails instead of spending elsewhere', async () => {
  const { makeStore, setScript, testConfig } = await import('./helpers.js');
  const { runExecutorTask } = await import('../core/nodes/executor.js');

  const store = makeStore();
  const runId = store.createRun('plan the work');
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Plan', goal: 'Describe the approach.',
    inputs: ['prompt.md'], constraints: [], tools: [],
    // Explicitly pinned — never re-routed, whatever the priority list says.
    worker: { provider: 'script', model: 'via-codex' }, status: 'pending'
  }] });

  const tried = [];
  setScript(({ model }) => {
    tried.push(model);
    throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig({
    providerPriority: ['codex', 'openrouter'],
    resolveModelSource: () => ({ provider: 'script', model: 'via-openrouter', apiKey: 'k' })
  }));

  assert.equal(retro.status, 'failed');
  assert.deepEqual(tried, ['via-codex'], 'the pinned target was called once and nothing else was');
  assert.equal((store.readLog(runId) ?? []).some(e => e.event === 'route_fallback'), false);
});

// --- an empty account is not a bad task (2026-08-24) -----------------------
//
// An OpenRouter balance ran out mid-loop. Every attempt after it failed with a
// 402 before a single token was generated, and the loop read each one as the
// task failing on its merits: counted the attempt, escalated a rung, retried,
// escalated again, then parked the task with a reason describing work that had
// never run. Five tasks in one session; one climbed from medium to xhigh over
// six attempts without receiving a model call.
//
// The cause was here: the 402 matched none of the wording, so it classified
// `unknown`, and nothing downstream could tell it apart from a bad answer.

test('the 402 OpenRouter actually sends is recognised', () => {
  // Verbatim, because a paraphrase is what made this pass by inspection and
  // fail in production.
  const message = 'OpenRouter API 402: {"error":{"message":"This request requires more '
    + 'credits, or fewer max_tokens. You requested up to 12288 tokens, but can only '
    + 'afford 1411","code":402}}';
  const err = Object.assign(new Error(message), { status: 402 });

  const out = classifyAdapterError(err, { provider: 'openrouter' });
  assert.equal(out.code, 'credit');
  assert.equal(needsHuman(out.code), true, "no retry, rung or model change resolves an empty account");
  assert.equal(out.retryable, false, "and waiting never clears it");
  assert.match(out.remedy, /Add credit/);
  assert.match(out.remedy, /Waiting will not clear it/);
});

test('a 402 is recognised from the status alone, whatever the wording', () => {
  // Vendors rewrite these strings. The status is the stable half.
  const err = Object.assign(new Error('Payment Required'), { status: 402 });
  assert.equal(classifyAdapterError(err, { provider: 'openrouter' }).code, 'credit');
});

test('being out of money and being rate limited are different answers', () => {
  // They shared one code, and so shared one response — which was wrong for
  // both: waiting on a 402 is a loop that never ends, and refusing to wait on
  // a 429 throws away a call that would have worked.
  const broke = classifyAdapterError(Object.assign(new Error('x'), { status: 402 }), { provider: 'p' });
  const limited = classifyAdapterError(Object.assign(new Error('x'), { status: 429 }), { provider: 'p' });

  assert.equal(broke.code, 'credit');
  assert.equal(limited.code, 'quota');
  assert.equal(broke.retryable, false);
  assert.equal(limited.retryable, true, "a rate limit clears on its own");
  assert.equal(needsHuman(broke.code), true);
  assert.equal(needsHuman(limited.code), false, "nobody needs waking for a rate limit");
});

test('every failure that needs a human is one no retry could fix', () => {
  for (const code of ['auth', 'credit', 'capability', 'runtime-missing', 'runtime-permission']) {
    assert.equal(needsHuman(code), true, code);
    assert.equal(isTransientFailure(code), false,
      `${code} must not also be retryable — that is a loop that cannot end`);
  }
  for (const code of ['network', 'timeout', 'quota']) {
    assert.equal(needsHuman(code), false, code);
    assert.equal(isTransientFailure(code), true, code);
  }
});

test('no adapter failure is ever the task\'s fault', () => {
  // The call did not complete, so nothing the task asked for was judged.
  // Whether the work was any good is decided by gates, by review, and by
  // whether the workspace changed — none of which are adapter errors.
  for (const code of FAILURE_CODES) {
    assert.equal(blamesTask(code), false, code);
  }
});
