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
import { Supervisor, renderReport, providerBlocked } from '../core/supervisor.js';
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

test('a poll count is not a measure of the work', () => {
  // The supervisor polls every five seconds, so "2 consecutive polls with
  // identical work" meant FIFTEEN SECONDS. A node thinking its way through one
  // call on a reasoning model produces nothing observable for minutes, so a
  // healthy task — 12 model calls and 10 tool calls behind it — was declared a
  // spin and parked. Repeats alone say how often we looked, not what happened.
  const busy = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  busy.observe(snap({ a: 'active' }), { now: 0 });
  busy.observe(snap({ a: 'active' }), { now: 5_000 });
  busy.observe(snap({ a: 'active' }), { now: 10_000 });
  assert.equal(busy.repeats, 2);
  assert.equal(detectStall(busy), null, 'fifteen seconds of thinking is not a spin');

  // The floor sits above the per-call idle deadline (config.json timeout.idleMs,
  // 5 min): a call quiet for longer than that is already being killed and
  // retried by the adapter, so anything the supervisor cuts sooner is work the
  // adapter would have rescued.
  busy.observe(snap({ a: 'active' }), { now: 4 * 60_000 });
  assert.equal(detectStall(busy), null);
  busy.observe(snap({ a: 'active' }), { now: 7 * 60_000 });
  assert.equal(detectStall(busy).detector, 'spin');
});

test('the detectors fire on evidence, and say what it was', () => {
  const spinning = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  spinning.observe(snap({ a: 'running' }), { now: 0 });
  spinning.observe(snap({ a: 'running' }), { now: 1 });
  spinning.observe(snap({ a: 'running' }), { now: 7 * 60 * 1000 });
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
function fakeEngine({ backlog = null, stages = {}, gateKind = 'pre', output = null, error = null, land = () => ({ landed: true, stage: 'landed', mergeSha: 'abc12345' }) } = {}) {
  const calls = [];
  let runSeq = 0;
  const runs = new Map(); // runId -> { polls, taskId }
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (name === 'work:start') return { dir: '/tmp/wt', branch: 'b' };
    if (name === 'flow:run') {
      const runId = `run-${++runSeq}`;
      runs.set(runId, { polls: 0, taskId: args.userInput, prompt: String(args.userInput ?? '') });
      return runId;
    }
    if (name === 'run:snapshot') {
      const r = runs.get(args.runId);
      r.polls += 1;
      const plan = stages[args.runId] ?? stages.default ?? ['done'];
      const stage = plan[Math.min(r.polls - 1, plan.length - 1)];
      return {
        meta: {
          stage, error: stage === 'failed' ? error : null,
          pendingGateKind: stage === 'awaiting_approval' ? gateKind : null,
          // 'active' is what FlowRunner.setNodeStatus actually writes for a node
          // it is executing. This fake said 'running', which nothing writes, so
          // the supervisor's currentNodeOf() matched here and matched NOTHING in
          // a real run — the nudge and restart rungs were dead in production and
          // green in the suite. A fake that models a state the system cannot
          // produce tests the fake.
          nodeStatus: { 'work-1': stage === 'done' ? 'done' : 'active' }
        },
        // The prompt the supervisor actually sent, and the echo of it that a
        // real run's first node writes as its output. Both were missing here,
        // and their absence hid a defect that cost a night: the brief carried a
        // worked example of the TASK-IMPOSSIBLE line, the echo made it a node
        // output, and every task parked quoting the example. A fake with no
        // prompt and no echo cannot see that.
        prompt: r.prompt,
        nodeOutputs: {
          'user-input': r.prompt,
          'work-1': stage === 'done' ? (output ?? 'finished') : 'thinking'
        },
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
    if (name === 'work:discard') {
      // Modelled, not stubbed. A no-op here hid a real bug for a week: the
      // command releases the lease, and passing a status into it overwrote the
      // escalation that had just been decided, so every failed landing parked.
      // A fake that does less than the command it stands for cannot catch that.
      if (backlog) backlog.release(args.taskId, { status: args.status ?? null });
      return { removed: true };
    }
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
  // "Nothing ready" is two different pieces of news and the morning reader
  // needs to know which. A task parked with three tasks depending on it leaves
  // the queue full and the loop idle; reporting that as "backlog empty" says
  // the night went fine.
  const stuck = makeBacklog();
  const blocker = stuck.add({ title: 'blocker', goal: 'g' });
  stuck.add({ title: 'waits', goal: 'g', dependsOn: [blocker.id] });
  stuck.update(blocker.id, { status: 'parked' });
  const idle = await new Supervisor({
    ...fakeEngine({ backlog: stuck }), projectId: 'p', backlog: stuck, pollMs: 1
  }).run();
  assert.match(idle.stopping, /1 task\(s\) blocked/);
  assert.match(idle.stopping, /t-0002 \(waiting on t-0001 \(parked\)\)/);

  // Highest score first: the picker's order is the loop's order.
  const started = engine.calls.filter(c => c.name === 'work:start').map(c => c.args.taskId);
  assert.deepEqual(started, ['t-0001', 't-0002']);
});

test('a model the loop was pinned to is what every task runs on, and the ladder still ends', async () => {
  // A band asks someone else to name the model; naming it is the same decision
  // made earlier. What a pin must NOT do is disable the ladder — the rungs are
  // also the attempt counter, and without them a failing task retries forever.
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g', level: 'low' });
  const worker = { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' };
  const engine = fakeEngine({ backlog, land: () => ({ landed: false, stage: 'review', guidance: 'no' }) });
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { worker } }
  });

  await sup.run({ maxTasks: 1 });
  const run = engine.calls.find(c => c.name === 'flow:run');
  assert.deepEqual(run.args.worker, worker, 'the run is told which model to use');
  // The band still travels with the attempt, so escalation still counts.
  assert.equal(run.args.level, 'low');
  assert.equal(backlog.get('t-0001').level, 'medium', 'a failed attempt still moves up a rung');
  // And the panel reports what the loop is RUNNING on, not what settings say now.
  assert.equal(sup.status().model, 'deepseek/deepseek-v4-pro');
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
    // spinMs: 0 because this test is about the LADDER, not the threshold — the
    // shipped floor is six minutes of wall clock (see the poll-count test) and
    // a unit test must not wait for it.
    config: { loop: { thresholds: { spinRepeats: 1, spinMs: 0 } } }
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

test('with nothing to restart, the ladder moves down a rung instead of falling off it', async () => {
  // Between waves there is no node to nudge. The intent — "fall through to the
  // next rung" — was written in a comment and not in the code: the escalate
  // branch tests `rung`, which was still 'nudge', so the task went straight to
  // parked on its FIRST stall, skipping the rung that would have tried a bigger
  // model. With currentNodeOf() also matching a status nothing writes, that was
  // every stall in every run.
  const backlog = makeBacklog();
  backlog.add({ title: 'stalls between waves', goal: 'g', level: 'low' });
  const engine = fakeEngine({ backlog, stages: { default: ['running'] } });
  // No node is running: nothing to restart.
  const bare = async (name, args) => {
    if (name === 'run:snapshot') {
      const s = await engine.invoke(name, args);
      return { ...s, meta: { ...s.meta, nodeStatus: {} } };
    }
    return engine.invoke(name, args);
  };
  const sup = new Supervisor({
    invoke: bare, calls: engine.calls, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { thresholds: { spinRepeats: 1, spinMs: 0 } } }
  });

  await sup.run({ maxTasks: 1 });
  assert.equal(engine.calls.filter(c => c.name === 'run:restartNode').length, 0, 'there was nothing to restart');
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'queued', 'escalated back to the queue, not parked');
  assert.equal(task.level, 'medium');
});

test('a task is stopped at its own cap, and what it spent is recorded either way', async () => {
  // The per-task cap read the LEDGER, and the ledger is only written when a run
  // ends — so an in-flight task always reported $0.00 and the one ceiling whose
  // job is to stop a single runaway task could never fire. It reads the run's
  // own artifacts now, which is where the money is visible while it is spent.
  const backlog = makeBacklog();
  backlog.add({ title: 'expensive', goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  const store = {
    snapshot: () => ({
      retrospectives: { n1: { usage: { cost: 5 }, model: { provider: 'openrouter', model: 'm' } } }
    })
  };
  const engine = fakeEngine({ backlog, stages: { default: ['running'] } });
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, ledger, store, pollMs: 1,
    config: { loop: { caps: { taskUsd: 1 } } }
  });

  await sup.run({ maxTasks: 1 });
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'parked');
  assert.match(task.blockedReason, /per-task cap/);
  // ...and the spend survives the interruption. Only the tidy ending used to
  // record, so the burn-down omitted exactly the runs that went wrong — it read
  // lowest when the night was going worst.
  assert.ok(ledger.totals({ taskId: 't-0001' }).usd >= 5);
});

test('the brief says how the work will be judged, because the task file cannot know', async () => {
  // Landing means merging a diff. An answer written as prose leaves the
  // repository unchanged, which is an empty diff, which cannot land however
  // good the answer is. The agent cannot know that from the task text: it reads
  // "produce a cited report" and produces one, as its answer, exactly as asked.
  // Observed across five attempts on two models and three tasks — every one
  // read the right files, reasoned well, wrote nothing, and was rejected for
  // having no diff.
  const backlog = makeBacklog();
  backlog.add({ title: 'Write a report', goal: 'Analyse the store and report on it' });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const brief = engine.calls.find(c => c.name === 'flow:run').args.userInput;
  assert.match(brief, /Write a report/, 'the task itself still leads');
  assert.match(brief, /CHANGE IN THE FILES/);
  assert.match(brief, /create_file or write_file/);
  // And the honest exit, so a task that cannot be done here does not get
  // invented work to look busy.
  assert.match(brief, /do not invent work/);
});

test('a provider refusing everyone stops the loop instead of grinding the backlog', async () => {
  // A spent key is not a failed task. It fails every task after it the same way
  // in seconds, and the ladder turns that into a parked backlog: up a band,
  // fail identically, up again, out of ladder, parked — then the next task.
  // Watched live when a key hit its spending limit: two tasks driven from their
  // own band to `max` and parked inside a minute, `$0.0000 across 0 call(s)` on
  // every attempt.
  assert.match(providerBlocked('OpenRouter API 403: {"error":{"message":"Key limit exceeded (total limit)"}}'),
    /Key limit exceeded/);
  assert.ok(providerBlocked('Anthropic API 401: unauthorized'));
  assert.ok(providerBlocked('insufficient credit'));
  // 429 is transient and the adapter already retries it with backoff; stopping
  // the night for one would be its own failure.
  assert.equal(providerBlocked('OpenRouter API 429: rate limited'), null);
  assert.equal(providerBlocked('the model returned no content'), null);
  assert.equal(providerBlocked(null), null);

  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'medium' });
  backlog.add({ title: 'second', goal: 'g', value: 3, effort: 3 });
  const engine = fakeEngine({
    backlog,
    stages: { default: ['failed'] },
    error: 'OpenRouter API 403: {"error":{"message":"Key limit exceeded (total limit)","code":403}}'
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  const status = await sup.run();
  assert.match(status.stopping, /provider refused the call/);
  assert.match(status.stopping, /Key limit exceeded/);
  // The task goes back untouched: same band, no attempt spent, and nothing in
  // its reason blaming work that never ran.
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'queued');
  assert.equal(task.level, 'medium');
  assert.equal(task.attempts, 0);
  // ...and the second task was never started, because it would have failed the
  // same way.
  assert.equal(backlog.get('t-0002').attempts, 0);
  assert.equal(engine.calls.filter(c => c.name === 'flow:run').length, 1);
});

test('a task the agent says cannot be done here is parked, not escalated', async () => {
  // The brief promises this: change nothing, say so, and it will be parked for
  // a person. A loop that then escalated the task to a more expensive model
  // would be punishing an agent for following instructions — seen live, a task
  // naming a Python file this repository does not contain, correctly reported
  // as impossible, climbing a band to be told the same thing by a dearer model.
  const backlog = makeBacklog();
  backlog.add({ title: 'Port the Python evaluator', goal: 'g', level: 'low' });
  const engine = fakeEngine({
    backlog,
    output: 'TASK-IMPOSSIBLE: this repository has no code_quality_manager.py\n\nI looked in every plausible place.'
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'parked');
  assert.match(task.blockedReason, /cannot be done in this repository/);
  assert.match(task.blockedReason, /no code_quality_manager\.py/);
  assert.equal(task.level, 'low', 'no band was bought to be told the same thing again');
  // ...and the landing sequence was never run: gates, a reviewer and a canary
  // on a task nobody can do is a bill for confirming what the agent just said.
  assert.equal(engine.calls.filter(c => c.name === 'work:land').length, 0);

  // A model that echoed the example instead of writing its finding has still
  // declared the task impossible, so it still parks — but the pile a person
  // reads must not contain a fill-in-the-blank. Seen on the first real use: the
  // parked reason was literally "<one line saying what is missing or already true>".
  const b3 = makeBacklog();
  b3.add({ title: 'Port it', goal: 'g', level: 'low' });
  const e3 = fakeEngine({ backlog: b3, output: 'TASK-IMPOSSIBLE: <one line saying what is missing or already true>' });
  await new Supervisor({ ...e3, projectId: 'p', backlog: b3, pollMs: 1 }).run({ maxTasks: 1 });
  assert.equal(b3.get('t-0001').status, 'parked');
  assert.match(b3.get('t-0001').blockedReason, /no reason given/);
  assert.ok(!b3.get('t-0001').blockedReason.includes('<one line'), 'the placeholder never reaches the pile');

  // A sentinel that came from the QUESTION is not an answer. The brief used to
  // carry a worked example of the line, the first node of a run echoes the
  // brief as its output, and the scan reads node outputs — so a task about a
  // JSONL session tree parked as "there is no code_quality_manager.py anywhere
  // in this repository", three dependent tasks blocked behind it, and a
  // finished worktree was deleted. A task whose own goal quotes the sentinel
  // (a task to fix this very function) would park itself the same way.
  const b4 = makeBacklog();
  b4.add({
    title: 'Fix the impossible detector',
    goal: 'The brief tells the agent to answer with a line like\n'
      + 'TASK-IMPOSSIBLE: there is no code_quality_manager.py anywhere in this repository\n'
      + 'and the scan reads that line back out of its own question.',
    level: 'low'
  });
  const e4 = fakeEngine({ backlog: b4, output: 'Done — I changed core/supervisor.js.' });
  await new Supervisor({ ...e4, projectId: 'p', backlog: b4, pollMs: 1 }).run({ maxTasks: 1 });
  assert.equal(b4.get('t-0001').status, 'landed', 'the question is not the answer');

  // An ordinary empty-handed run still escalates: "I could not" and "this
  // cannot be" are different claims, and only one is worth a person.
  const b2 = makeBacklog();
  b2.add({ title: 'Try harder', goal: 'g', level: 'low' });
  const e2 = fakeEngine({ backlog: b2, land: () => ({ landed: false, stage: 'no-changes', guidance: 'nothing changed' }) });
  await new Supervisor({ ...e2, projectId: 'p', backlog: b2, pollMs: 1 }).run({ maxTasks: 1 });
  assert.equal(b2.get('t-0001').status, 'queued');
  assert.equal(b2.get('t-0001').level, 'medium');
});

test('a task learned from another repository is told where to look', async () => {
  // The task names that repository's files; the agent claiming it stands here,
  // where those paths do not exist. Without being told, the only honest thing
  // it can report is that the task is impossible — which nine tasks got,
  // correctly, while a read-only clone containing every one of those files sat
  // in the reference library unmentioned.
  const backlog = makeBacklog();
  backlog.add({
    title: 'Port the evaluator', goal: 'Extract the evaluation logic',
    references: ['self_improving_coding_agent']
  });
  const engine = fakeEngine({ backlog });
  await new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 }).run({ maxTasks: 1 });

  const brief = engine.calls.find(c => c.name === 'flow:run').args.userInput;
  assert.match(brief, /reference:self_improving_coding_agent/);
  assert.match(brief, /search_references/);
  // The half that prevents the opposite mistake: read there, write here.
  assert.match(brief, /goes into THIS project/);

  // A task with no reference gets no such section — there is nowhere else to
  // look, and saying so would be noise in every ordinary brief.
  const b2 = makeBacklog();
  b2.add({ title: 'Ordinary work', goal: 'g' });
  const e2 = fakeEngine({ backlog: b2 });
  await new Supervisor({ ...e2, projectId: 'p', backlog: b2, pollMs: 1 }).run({ maxTasks: 1 });
  assert.ok(!e2.calls.find(c => c.name === 'flow:run').args.userInput.includes('WHERE THIS TASK CAME FROM'));
});

test('the loop publishes its status where another process can read it', async () => {
  // The supervisor outlives the window that started it, so a status kept only
  // in its own memory is a status nobody else can see: `flyt loop status` in a
  // second terminal, `flyt report`, and the desktop Loop view all answered "no
  // loop running" while one was working. For a system whose premise is running
  // when nobody is watching, that is the wrong shape.
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g' });
  const published = [];
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { models: { low: 'deepseek/deepseek-v4-pro' } } },
    writeStatus: s => published.push(s)
  });

  await sup.run({ maxTasks: 1 });

  assert.ok(published.length >= 2, 'published at the start and at the end, not once at the end');
  // Whoever reads it needs to know whether the writer is still alive — a status
  // file outlives the process that wrote it, and one still claiming work is in
  // flight is worse than no file at all.
  assert.equal(published[0].pid, process.pid);
  assert.match(published[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(published.at(-1).running, false, 'the last word is that it stopped');
  // And it carries the decision the session is working to, which a single
  // `model` cannot describe.
  assert.deepEqual(published.at(-1).models, { low: 'deepseek/deepseek-v4-pro' });

  // An unwritable status file must never take the loop down with it.
  const b2 = makeBacklog();
  b2.add({ title: 'work', goal: 'g' });
  const e2 = fakeEngine({ backlog: b2 });
  const noisy = new Supervisor({
    ...e2, projectId: 'p', backlog: b2, pollMs: 1,
    writeStatus: () => { throw new Error('disk full'); }
  });
  assert.equal((await noisy.run({ maxTasks: 1 })).landed, 1);
});

test('a dry run reaches the code that would have merged', async () => {
  // The flag's whole job is "do not touch the base branch", and it was decided
  // in loop:start and then never travelled: work:land defaults dryRun to false,
  // so a loop started with --dry-run merged anyway. The posture the first
  // nights are supposed to run in (§6.4) did not exist.
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g' });
  const engine = fakeEngine({ backlog, land: () => ({ landed: false, stage: 'dry-run', approved: true }) });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1, config: { loop: { dryRun: true } } });

  await sup.run({ maxTasks: 1 });
  assert.equal(engine.calls.find(c => c.name === 'work:land').args.dryRun, true);

  // ...and a loop that did not ask for one still lands.
  const b2 = makeBacklog();
  b2.add({ title: 'work', goal: 'g' });
  const e2 = fakeEngine({ backlog: b2 });
  await new Supervisor({ ...e2, projectId: 'p', backlog: b2, pollMs: 1 }).run({ maxTasks: 1 });
  assert.equal(e2.calls.find(c => c.name === 'work:land').args.dryRun, false);
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
