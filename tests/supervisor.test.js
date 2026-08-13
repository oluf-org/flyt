// The supervisor, the ledger and the stall detectors (LOOP-PLAN §9, §10, §11).
//
// The loop is driven through a fake command surface here rather than a real
// engine: what is under test is the DECISIONS — when to park, when to nudge,
// when to escalate, when to stop — and a real runner would make those decisions
// slow and non-deterministic without making them any more true. The pieces
// those decisions rest on (gates, landing, backlog) have their own tests
// against real git and real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, costOf, spendFromRun } from '../core/ledger.js';
import { Heartbeat, detectStall, workSignature, nextIntervention } from '../core/heartbeat.js';
import { Supervisor, renderReport } from '../core/supervisor.js';
import { Backlog } from '../core/backlog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-sup-'));

// --- the ledger ------------------------------------------------------------

test('a cost the provider reported beats one we computed, and neither beats admitting we do not know', () => {
  // OpenRouter reports what it charged, so there is no table to maintain.
  assert.deepEqual(costOf({ usage: { cost: 0.0412 } }), { usd: 0.0412, estimated: false });

  // A provider that reports nothing falls back to a local table, marked.
  const est = costOf({
    usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
    provider: 'anthropic', model: 'claude-sonnet-5',
    prices: { 'anthropic/claude-sonnet-5': { in: 3, out: 15 } }
  });
  assert.equal(est.estimated, true);
  assert.equal(Number(est.usd.toFixed(2)), 10.5);

  // Unknown is null, never zero: "$0" must only ever mean "it was free".
  assert.deepEqual(costOf({ usage: { prompt_tokens: 100 }, provider: 'x', model: 'y' }), { usd: null, estimated: true });
});

test('the ledger totals a rolling window and says how much of it is guesswork', () => {
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 't-1', usd: 0.10, estimated: false });
  ledger.record({ taskId: 't-1', usd: 0.05, estimated: true });
  ledger.record({ taskId: 't-2', usd: null, estimated: true });

  const all = ledger.totals();
  assert.equal(all.usd, 0.15);
  assert.equal(all.calls, 3);
  assert.equal(all.estimated, 1);
  // A total with an unpriced call behind it is a different fact from one without.
  assert.equal(all.unknown, 1);
  assert.equal(ledger.totals({ taskId: 't-1' }).usd, 0.15);
  assert.equal(ledger.totals({ taskId: 't-2' }).usd, 0);
});

test('the three ceilings mean three different things', () => {
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 't-1', usd: 4, estimated: false });

  assert.equal(ledger.check({ caps: { softUsd: 10, hardUsd: 20 } }).action, null);
  // Soft: stop reaching for the expensive answer, keep working.
  assert.equal(ledger.check({ caps: { softUsd: 3, hardUsd: 20 } }).action, 'no-escalate');
  // Hard outranks everything: finish cleanly and stop.
  assert.equal(ledger.check({ caps: { softUsd: 3, hardUsd: 4 } }).action, 'stop');
  // Per-task: this one has had its allowance, whatever the day looks like.
  assert.equal(ledger.check({ caps: { taskUsd: 2 }, taskId: 't-1' }).action, 'park');
});

test('a run is priced from the artifacts it already wrote', () => {
  // No hook threaded through every call site: retrospectives carry usage and
  // model because they always did.
  const store = {
    snapshot: () => ({
      retrospectives: {
        'work-1': { usage: { cost: 0.02 }, model: { provider: 'openrouter', model: 'auto' } },
        'work-2': { usage: { cost: 0.03 }, model: { provider: 'openrouter', model: 'auto' } },
        'no-model': { usage: null }
      }
    })
  };
  const entries = spendFromRun(store, 'r1');
  assert.equal(entries.length, 2, 'a node that never called a model is not a ledger entry');
  assert.equal(entries.reduce((n, e) => n + e.usd, 0), 0.05);
});

// --- headway ---------------------------------------------------------------

const snap = (statuses, outputs = {}) => ({ meta: { nodeStatus: statuses }, nodeOutputs: outputs, retrospectives: {} });

test('headway is change in the work, not elapsed time or tokens burned', () => {
  const hb = new Heartbeat({ taskId: 't-1', runId: 'r1', now: 0 });

  assert.equal(hb.observe(snap({ a: 'running' }), { now: 1000 }), true, 'the first poll establishes a baseline');
  // Same work, more time, more tokens: not progress.
  assert.equal(hb.observe(snap({ a: 'running' }), { now: 2000, tokens: 5000 }), false);
  assert.equal(hb.tokensSinceProgress, 5000, 'the counter that catches a polite infinite loop');
  // A node completing is progress, and resets everything.
  assert.equal(hb.observe(snap({ a: 'done', b: 'running' }), { now: 3000 }), true);
  assert.equal(hb.tokensSinceProgress, 0);

  // A rewrite of the same size is NOT progress — hashing the content is the
  // point, since a model asked to try again often produces exactly that.
  hb.observe(snap({ b: 'running' }, { b: 'hello world' }), { now: 4000 });
  assert.equal(hb.observe(snap({ b: 'running' }, { b: 'hello world' }), { now: 5000 }), false);
  assert.equal(hb.observe(snap({ b: 'running' }, { b: 'HELLO WORLD' }), { now: 6000 }), true);
});

test('a different error is progress; the same error three times is a groundhog', () => {
  const hb = new Heartbeat({ taskId: 't-1', runId: 'r1', now: 0 });
  const fail = out => ({ command: 'npm test', status: 'fail', code: 1, output: out });

  hb.observeGate(fail('2 tests failed'));
  hb.observeGate(fail('2 tests failed'));
  assert.equal(detectStall(hb), null, 'twice is not yet a pattern');
  hb.observeGate(fail('2 tests failed'));
  assert.equal(detectStall(hb).detector, 'groundhog');

  // A DIFFERENT failure means the last attempt changed something real.
  hb.observeGate(fail('1 test failed'));
  assert.equal(detectStall(hb), null);
  hb.observeGate(null);
  assert.deepEqual(hb.gateFailures, []);
});

test('the detectors fire on evidence, and say what it was', () => {
  const spinning = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  spinning.observe(snap({ a: 'running' }), { now: 0 });
  spinning.observe(snap({ a: 'running' }), { now: 1 });
  spinning.observe(snap({ a: 'running' }), { now: 2 });
  const spin = detectStall(spinning);
  assert.equal(spin.detector, 'spin');
  assert.match(spin.detail, /byte-identical/);

  const silent = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  silent.observe(snap({ a: 'running' }), { now: 0 });
  silent.observe(snap({ a: 'running' }), { now: 11 * 60 * 1000 });
  // Spin trips first here by design: it is the more specific finding, and it
  // carries the more useful evidence.
  assert.ok(['spin', 'silent'].includes(detectStall(silent).detector));

  const slow = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  slow.observe(snap({ a: 'running' }), { now: 0 });
  slow.observe(snap({ a: 'done', b: 'running' }), { now: 60 * 60 * 1000 });
  assert.equal(detectStall(slow), null, 'slow but moving is not stuck');
  assert.equal(detectStall(slow, { medianMs: 60_000 }).detector, 'outlier');
});

test('the ladder is climbed once per rung, then stays at the bottom', () => {
  const hb = new Heartbeat({ taskId: 't', runId: 'r' });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const rung = nextIntervention(hb);
    seen.push(rung);
    hb.interventions.push(rung);
  }
  assert.deepEqual(seen, ['nudge', 'restart', 'escalate', 'park', 'park']);
});

// --- the loop --------------------------------------------------------------

// A fake command surface: enough of the engine's contract for the supervisor's
// decisions to be real ones.
//
// One coupling this makes explicit rather than hides: `work:land` is the single
// writer of a task's post-landing status. It has the full outcome and it is the
// same command the CLI calls by hand, so the supervisor reads the result rather
// than duplicating the transition. The fake therefore has to apply it too, or
// the test would be simulating a different system.
function fakeEngine({ backlog = null, stages = {}, gateKind = 'pre', land = () => ({ landed: true, stage: 'landed', mergeSha: 'abc12345' }) } = {}) {
  const calls = [];
  let runSeq = 0;
  const runs = new Map(); // runId -> { polls, taskId }
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'work:start') return { dir: '/tmp/wt', branch: 'b' };
    if (name === 'flow:run') {
      const runId = `run-${++runSeq}`;
      runs.set(runId, { polls: 0, taskId: args.userInput });
      return runId;
    }
    if (name === 'run:snapshot') {
      const r = runs.get(args.runId);
      r.polls += 1;
      const plan = stages[args.runId] ?? stages.default ?? ['done'];
      const stage = plan[Math.min(r.polls - 1, plan.length - 1)];
      return {
        meta: {
          stage, pendingGateKind: stage === 'awaiting_approval' ? gateKind : null,
          nodeStatus: { 'work-1': stage === 'done' ? 'done' : 'running' }
        },
        nodeOutputs: { 'work-1': stage === 'done' ? 'finished' : 'thinking' },
        retrospectives: {}
      };
    }
    if (name === 'work:land') {
      const result = land(args);
      if (backlog) {
        if (result.landed) backlog.update(args.taskId, { status: 'landed', blockedReason: null });
        else backlog.escalate(args.taskId, { reason: 'failed', note: result.guidance ?? result.stage });
      }
      return result;
    }
    if (name === 'run:stop' || name === 'run:restartNode' || name === 'run:approve') return true;
    if (name === 'work:discard') return { removed: true };
    throw new Error(`unexpected command ${name}`);
  };
  return { invoke, calls };
}

const makeBacklog = () => new Backlog(path.join(tmp(), 'backlog'));

test('the loop works the queue and stops when there is nothing ready', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1 });
  backlog.add({ title: 'second', goal: 'g', value: 3, effort: 3 });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  const status = await sup.run();
  assert.equal(status.stopping, 'backlog empty');
  assert.equal(status.landed, 2);
  assert.deepEqual(backlog.list().map(t => t.status), ['landed', 'landed']);
  // Highest score first: the picker's order is the loop's order.
  const started = engine.calls.filter(c => c.name === 'work:start').map(c => c.args.taskId);
  assert.deepEqual(started, ['t-0001', 't-0002']);
});

test('a gate the loop may not answer parks its task; the loop takes the next one', async () => {
  // Unattended, one approval request must not cost the rest of the day (§10).
  // An ESCALATION gate is the case: step-eval concluded a human must decide,
  // which is exactly the decision this loop exists to defer rather than answer.
  const backlog = makeBacklog();
  backlog.add({ title: 'asks a question', goal: 'g', value: 5, effort: 1 });
  backlog.add({ title: 'gets on with it', goal: 'g', value: 4, effort: 1 });
  const engine = fakeEngine({
    backlog, gateKind: 'escalation',
    stages: { 'run-1': ['running', 'awaiting_approval'], default: ['done'] }
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  const status = await sup.run();
  assert.equal(backlog.get('t-0001').status, 'parked');
  assert.match(backlog.get('t-0001').blockedReason, /escalation gate asked for a decision/);
  assert.equal(backlog.get('t-0002').status, 'landed', 'the loop kept working');
  assert.equal(status.parked.length, 1);
  // The run was stopped rather than left parked at a gate nobody will answer.
  assert.ok(engine.calls.some(c => c.name === 'run:stop'));
});

test('a stalled task is nudged before it is escalated', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'spins', goal: 'g', level: 'low' });
  // Never finishes, never changes: the spin detector's exact case.
  const engine = fakeEngine({ stages: { default: ['running'] } });
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { thresholds: { spinRepeats: 1 } } }
  });

  await sup.run({ maxTasks: 1 });
  const restarts = engine.calls.filter(c => c.name === 'run:restartNode');
  assert.ok(restarts.length >= 1, 'the cheapest rung is tried first');
  assert.match(restarts[0].args.guidance, /SUPERVISOR:/);
  assert.match(restarts[0].args.guidance, /byte-identical/, 'the evidence goes with the nudge');

  // ...and when nudging does not help, the task goes up a band and back to the
  // queue rather than being retried at the same capability forever.
  const task = backlog.get('t-0001');
  assert.ok(['queued', 'parked'].includes(task.status));
  if (task.status === 'queued') assert.equal(task.level, 'medium');
});

test('a failed landing escalates instead of retrying the same band', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'fails review', goal: 'g', level: 'low' });
  const engine = fakeEngine({
    backlog,
    land: () => ({ landed: false, stage: 'review', guidance: 'Refactors unrelated code.' })
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'queued');
  assert.equal(task.level, 'medium');
  assert.match(task.blockedReason, /Refactors unrelated code/, 'the next attempt is told why');
});

test('the hard cap stops the loop; the soft cap only stops it reaching', async () => {
  const backlog = makeBacklog();
  for (let i = 0; i < 3; i++) backlog.add({ title: `t${i}`, goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 'earlier', usd: 25, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { softUsd: 10, hardUsd: 20 } } }
  });
  const status = await sup.run();
  assert.match(status.stopping, /hard cap reached/);
  assert.equal(status.completed, 0, 'nothing new was started past the ceiling');
  assert.deepEqual(backlog.list().map(t => t.status), ['queued', 'queued', 'queued']);

  // Under the soft cap only, work continues — it just stops escalating.
  const soft = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { softUsd: 10, hardUsd: 1000 } } }
  });
  const softStatus = await soft.run();
  assert.equal(softStatus.noEscalate, true);
  assert.equal(softStatus.landed, 3, 'the loop kept working at the cheapest band');
});

test('the report puts what needs a person above what does not', () => {
  const backlog = makeBacklog();
  const landed = backlog.add({ title: 'shipped', goal: 'g' });
  backlog.update(landed.id, { status: 'landed' });
  const parked = backlog.add({ title: 'needs you', goal: 'g' });
  backlog.update(parked.id, { status: 'parked', blockedReason: 'A gate asked something.' });
  backlog.add({ title: 'waiting', goal: 'g' });

  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ usd: 1.25, estimated: false });
  ledger.record({ usd: null, estimated: true });

  const md = renderReport({
    status: { running: false, stopping: 'backlog empty', inFlight: [], landed: 1, completed: 2 },
    backlog, ledger
  });
  assert.match(md, /\$1\.25 across 2 call\(s\) — 1 call\(s\) with no cost reported/);
  assert.ok(md.indexOf('Waiting on you') < md.indexOf('## Queued'),
    'the only part asking you for something comes first');
  assert.match(md, /A gate asked something\./);
});

test('a planning gate is answered, because something stricter judges the change later', async () => {
  // The shipped default pipeline has one of these. Parking on it would park
  // EVERY task and the loop would achieve nothing — while the landing sequence
  // (harness-run gates, a reviewer on the diff, a canary on the merge) judges
  // the actual change rather than the intention, afterwards.
  const backlog = makeBacklog();
  backlog.add({ title: 'plans first', goal: 'g' });
  const engine = fakeEngine({
    backlog, gateKind: 'pre',
    stages: { default: ['running', 'awaiting_approval', 'done'] }
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  assert.ok(engine.calls.some(c => c.name === 'run:approve'), 'the loop answered it');
  assert.equal(backlog.get('t-0001').status, 'landed');
});

test('a task that cannot be observed is parked rather than spun on forever', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'unobservable', goal: 'g' });
  const engine = fakeEngine({ backlog });
  const broken = async (name, args) => {
    if (name === 'run:snapshot') throw new Error('snapshot exploded');
    return engine.invoke(name, args);
  };
  const sup = new Supervisor({
    invoke: broken, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { maxPollErrors: 3 } }
  });

  // Without a ceiling on consecutive poll failures the loop spins here forever,
  // doing nothing — worse than either succeeding or giving up.
  const status = await sup.run({ maxTasks: 1 });
  assert.equal(backlog.get('t-0001').status, 'parked');
  assert.match(backlog.get('t-0001').blockedReason, /Could not be observed: snapshot exploded/);
  assert.equal(status.inFlight.length, 0);
});

test('a task records when work began, and a retry does not reset it', async () => {
  // Wall clock per task is a scored axis of the benchmark (§12.1), and the only
  // honest place to read it from is the file the supervisor wrote — process
  // memory does not survive the night.
  const backlog = makeBacklog();
  backlog.add({ title: 'takes two goes', goal: 'g', value: 5, effort: 1 });
  let tries = 0;
  let firstStart = null;
  const engine = fakeEngine({
    backlog,
    land: () => {
      firstStart ??= backlog.get('t-0001').startedAt;
      return ++tries === 1
        ? { landed: false, stage: 'gates', guidance: 'red' }
        : { landed: true, stage: 'landed', mergeSha: 'abc12345' };
    }
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });
  await sup.run();

  const task = backlog.get('t-0001');
  assert.equal(task.status, 'landed');
  assert.equal(engine.calls.filter(c => c.name === 'work:start').length, 2, 'both attempts really ran');
  assert.ok(firstStart, 'the first attempt stamped it');
  // The question is how long the TASK took, not the last try at it, so the
  // second attempt must not move the stamp.
  assert.equal(task.startedAt, firstStart);
  assert.ok(Date.parse(task.updatedAt) >= Date.parse(task.startedAt));
});

test('the last green canary becomes the next task\'s test-count baseline', async () => {
  // Without this, `testCountRegression` has no "before" and silently skips —
  // and deleting tests to go green is the cheapest exit an agent has (§7.3).
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1 });
  backlog.add({ title: 'second', goal: 'g', value: 4, effort: 1 });
  const engine = fakeEngine({
    backlog,
    land: () => ({ landed: true, stage: 'landed', mergeSha: 'abc12345', canaryOutput: '# tests 42' })
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });
  await sup.run();

  const lands = engine.calls.filter(c => c.name === 'work:land');
  assert.equal(lands[0].args.baselineOutput, null, 'the first task has nothing to compare against, honestly');
  assert.equal(lands[1].args.baselineOutput, '# tests 42');
});
