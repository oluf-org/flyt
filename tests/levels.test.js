// Effort levels and escalation (LOOP-PLAN §8).
//
// The plan wanted a price table and a tier ladder. OpenRouter's Auto Router
// already sells that: a cost_tier band, a capable model chosen inside it, kept
// current by someone who updates it daily. So a "tier" here is a band we ask
// for, and escalation is one function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEVELS, DEFAULT_LEVEL, normalizeLevel, nextLevel, maxLevel,
  workerForLevel, workerForLevelMap, escalate, levelFor, AUTO_MODEL
} from '../core/levels.js';
import { Backlog } from '../core/backlog.js';
import { openrouterAdapter } from '../core/adapters/openrouter.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-levels-'));

test('the ladder has rungs, and the top of it is not another rung', () => {
  assert.deepEqual(LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(nextLevel('low'), 'medium');
  assert.equal(nextLevel('xhigh'), 'max');
  // null is the important half: "out of ladder" must be distinguishable from
  // "try again", or the loop re-runs `max` forever at the priciest band there is.
  assert.equal(nextLevel('max'), null);
  assert.equal(normalizeLevel('LOUD'), DEFAULT_LEVEL);
  assert.equal(normalizeLevel(undefined, 'high'), 'high');
});

test('a level never quietly goes back down', () => {
  assert.equal(maxLevel('high', 'low'), 'high');
  assert.equal(maxLevel('low', 'xhigh'), 'xhigh');
  // A project floor lifts every task without editing any of them.
  assert.equal(levelFor({ level: 'low' }, { loop: { minLevel: 'high' } }), 'high');
  assert.equal(levelFor({ level: 'max' }, { loop: { minLevel: 'high' } }), 'max');
  assert.equal(levelFor({}, {}), DEFAULT_LEVEL);
  // `tier` was this field's name for one commit.
  assert.equal(levelFor({ tier: 'xhigh' }, {}), 'xhigh');
});

test('a level is a request for a band, not a model we picked', () => {
  const w = workerForLevel('high');
  assert.equal(w.provider, 'openrouter');
  assert.equal(w.model, AUTO_MODEL);
  assert.equal(w.routing.costTier, 'high');
  assert.equal(w.routing.allowedModels, undefined);

  // A project can pin itself to providers it trusts without naming models.
  const narrowed = workerForLevel('max', { allowedModels: ['anthropic/*'] });
  assert.deepEqual(narrowed.routing.allowedModels, ['anthropic/*']);

  // ...and a model somebody NAMED carries no routing at all. Sending a cost
  // tier alongside a pinned id asks the router to overrule the pin, and the
  // caller would never see which model actually answered.
  const pinned = workerForLevel('high', { model: 'deepseek/deepseek-v4-pro' });
  assert.deepEqual(pinned, { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' });
});

test('a sparse band→model map is a complete answer, and escalation is what reaches the expensive one', () => {
  const models = { low: 'deepseek/deepseek-v4-pro', high: 'moonshotai/kimi-k3' };

  // Fills DOWNWARD from the nearest band at or below the one asked for, so
  // naming two bands answers all five. This is the shape that makes a backlog
  // affordable: the cheap model does the ordinary work, and only a task that
  // has already failed twice costs what the expensive one costs.
  assert.equal(workerForLevelMap('low', models).model, 'deepseek/deepseek-v4-pro');
  assert.equal(workerForLevelMap('medium', models).model, 'deepseek/deepseek-v4-pro');
  assert.equal(workerForLevelMap('high', models).model, 'moonshotai/kimi-k3');
  assert.equal(workerForLevelMap('xhigh', models).model, 'moonshotai/kimi-k3');
  assert.equal(workerForLevelMap('max', models).model, 'moonshotai/kimi-k3');
  // The band the answer came FROM, so a log line can say which rung is talking.
  assert.equal(workerForLevelMap('xhigh', models).level, 'high');

  // A level below everything mapped still gets a model: "nothing" is not a
  // useful answer to a task that is ready to run.
  assert.equal(workerForLevelMap('low', { high: 'x' }).model, 'x');

  // Nothing mapped at all means "ask for a band instead", which the caller
  // distinguishes by the null.
  assert.equal(workerForLevelMap('low', {}), null);
  assert.equal(workerForLevelMap('low', { high: '  ' }), null);
  assert.equal(workerForLevelMap('low', null), null);

  // 'auto' because the id is the decision and who serves it is the priority
  // walk's business — the same shape every picker in the app produces.
  assert.equal(workerForLevelMap('low', models).provider, 'auto');
});

test('escalation moves up a rung, and running out of ladder is a human decision', () => {
  const up = escalate({ level: 'low', reason: 'failed', attempts: 1 });
  assert.equal(up.escalated, true);
  assert.equal(up.level, 'medium');
  assert.match(up.reason, /Attempt 1 failed at "low"/);

  // Stalling is the other trigger the supervisor owns (§11.4): more capability
  // is the cheapest thing to try before parking a task that is going nowhere.
  const stalled = escalate({ level: 'high', reason: 'stalled' });
  assert.equal(stalled.level, 'xhigh');
  assert.match(stalled.reason, /No headway at "high"/);

  const spent = escalate({ level: 'max', attempts: 4 });
  assert.equal(spent.escalated, false);
  assert.equal(spent.exhausted, true);
  assert.equal(spent.level, null);
  assert.match(spent.reason, /A bigger model is not the missing piece/);
});

// --- the backlog side ------------------------------------------------------

test('a failed task returns to the queue one rung up, and releases its lease', () => {
  const backlog = new Backlog(path.join(tmp(), 'backlog'));
  const task = backlog.add({ title: 'Flaky work', goal: 'g', level: 'low' });
  backlog.claim(task.id, 'worker-a');

  const first = backlog.escalate(task.id, { reason: 'failed', note: 'the suite was red' });
  assert.equal(first.status, 'queued');
  assert.equal(first.level, 'medium');
  assert.equal(first.attempts, 1);
  assert.equal(first.claimedBy, null);
  assert.match(first.blockedReason, /the suite was red/);
  // A task queued while still holding its lock could never be picked up again.
  assert.ok(backlog.claim(task.id, 'worker-b'), 'the lease went with it');
  backlog.release(task.id);

  backlog.update(task.id, { level: 'max' });
  const spent = backlog.escalate(task.id, { reason: 'failed' });
  assert.equal(spent.status, 'parked', 'out of ladder is a human decision, not another attempt');
  assert.equal(spent.escalation.exhausted, true);
});

test('an escalated task is picked before an equal one that has not failed', () => {
  const backlog = new Backlog(path.join(tmp(), 'backlog'));
  const a = backlog.add({ title: 'a', goal: 'g', value: 3, effort: 3 });
  backlog.add({ title: 'b', goal: 'g', value: 3, effort: 3 });
  backlog.escalate(a.id, { reason: 'failed' });
  // Same score, so the tie breaks toward the older task — which is the one that
  // already failed. Work in progress finishes before new work starts.
  assert.equal(backlog.ready()[0].id, a.id);
  assert.equal(backlog.ready()[0].level, 'medium');
});

// --- the wire --------------------------------------------------------------

async function captureRequest(params) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { await openrouterAdapter({ ...params, apiKey: 'k', maxTokens: 100 }); }
  finally { globalThis.fetch = original; }
  return captured;
}

test('a level rides to OpenRouter as the auto-router plugin', async () => {
  const worker = workerForLevel('xhigh', { allowedModels: ['anthropic/*', 'openai/*'] });
  const req = await captureRequest({ model: worker.model, routing: worker.routing, prompt: 'p', system: 's' });

  assert.equal(req.body.model, 'openrouter/auto');
  assert.deepEqual(req.body.plugins, [{
    id: 'auto-router',
    cost_tier: 'xhigh',
    allowed_models: ['anthropic/*', 'openai/*']
  }]);
});

test('a call with no level is byte-identical to one made before levels existed', async () => {
  // Every existing path — a pinned model, the agent loop, the retrospective
  // turn — must produce exactly the request it produced before this feature.
  const plain = await captureRequest({ model: 'openai/gpt-5.6', prompt: 'p', system: 's' });
  assert.equal('plugins' in plain.body, false);

  // An empty or malformed routing object is not a request for routing.
  const empty = await captureRequest({ model: 'openai/gpt-5.6', prompt: 'p', system: 's', routing: {} });
  assert.equal('plugins' in empty.body, false);
});
