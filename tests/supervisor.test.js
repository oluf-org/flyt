// The supervisor, the ledger and the stall detectors (DESIGN-SPEC.md §8).
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
import { Heartbeat, detectStall, workSignature, nextIntervention, DEFAULT_THRESHOLDS } from '../core/heartbeat.js';
import { providerRefusal,
  Supervisor, renderReport, providerBlocked, modelUnavailable, UNAVAILABLE_RETRIES, LEASE_WAIT_MS,
} from '../core/supervisor.js';
import { openIncidents, resolveIncident, incidentHeadline } from '../core/incidents.js';
import { briefNotes } from '../core/brief.js';
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

  // A RUNNING node's output is a streaming buffer — the model talking, not
  // work accomplished. It moves every 250ms, and treating it as headway is
  // what made three of the five detectors unreachable.
  hb.observe(snap({ b: 'running' }, { b: 'thinking about it' }), { now: 4000 });
  assert.equal(hb.observe(snap({ b: 'running' }, { b: 'thinking about it, at length' }), { now: 5000 }), false,
    'a model mid-sentence has not accomplished anything');
  assert.equal(hb.observe(snap({ b: 'running' }, { b: 'still thinking' }), { now: 6000 }), false);

  // A FINISHED output changing is progress: something was produced.
  assert.equal(hb.observe(snap({ b: 'done' }, { b: 'still thinking' }), { now: 7000 }), true);

  // ...and a rewrite of the same size is not, because the content is hashed —
  // a model asked to try again often produces exactly that.
  hb.observe(snap({ b: 'done' }, { b: 'hello world' }), { now: 8000 });
  assert.equal(hb.observe(snap({ b: 'done' }, { b: 'hello world' }), { now: 9000 }), false);
  assert.equal(hb.observe(snap({ b: 'done' }, { b: 'HELLO WORLD' }), { now: 10000 }), true);
});

test('the workspace is the measure where there is one to look at', () => {
  const hb = new Heartbeat({ taskId: 't-1', runId: 'r1', now: 0 });
  const streaming = n => snap({ work: 'running' }, { work: `token ${n}` });

  hb.observe(streaming(1), { now: 1000, workspace: { status: {} } });
  // Eleven minutes of talking, with nothing changed in the workspace. This is
  // the run that cost $0.97 and reported idleMs: 0 on every poll.
  for (let i = 2; i < 20; i++) {
    assert.equal(hb.observe(streaming(i), { now: 1000 + i * 1000, workspace: { status: {} } }), false,
      `poll ${i} claimed headway`);
  }
  assert.equal(hb.repeats, 18, 'the detectors can finally see it');
  assert.ok(hb.idleMs >= 18_000);

  // A file appears: that is what the task promised, and it resets the clock.
  assert.equal(
    hb.observe(streaming(20), { now: 21_000, workspace: { status: { 'core/backlog.js': ' M' } } }), true);
  assert.equal(hb.repeats, 0);
});

test('reading is not progress', () => {
  // 66 tool calls, every one a read, no workspace change: the exact shape of
  // the attempt that produced nothing and was never stopped.
  const hb = new Heartbeat({ taskId: 't-1', runId: 'r1', now: 0 });
  const workspace = { status: {} };
  hb.observe(snap({ work: 'running' }), { now: 0, workspace });
  for (let i = 1; i <= 66; i++) {
    assert.equal(hb.observe(snap({ work: 'running' }), { now: i * 5000, workspace }), false);
  }
  assert.equal(detectStall(hb, { thresholds: { silentMs: 60_000, spinMs: 60_000, spinRepeats: 2 } })?.detector, 'spin');
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
function fakeEngine({ backlog = null, stages = {}, gateKind = 'pre', output = null, error = null, stream = false, land = () => ({ landed: true, stage: 'landed', mergeSha: 'abc12345' }) } = {}) {
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
      // One poll of unwinding, then the walk has let go. The real runner clears
      // its stop request in the walk's `finally`, so a restart issued in the
      // same breath as the stop is still refused; one issued a poll later is
      // not. The supervisor has to survive both.
      if (r.unwinding === true) r.unwinding = false;
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
          // `stream` is what a real agentTask does: streamInto() rewrites the
          // node's output every 250ms while the model talks, so every poll
          // shows different bytes under a node that is still running. Without
          // it a fake cannot exhibit the failure that made three detectors
          // unreachable.
          'work-1': stage === 'done' ? (output ?? 'finished') : (stream ? `thinking, ${r.polls} polls in` : 'thinking')
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
    // `restartNode` refuses a run that is still walking, and it stays refused
    // for a moment after `stop()` returns — the real runner clears its stop
    // request in the walk's `finally`, not in `stop()`. A fake that always said
    // yes hid the whole defect: the two cheapest rungs of the ladder called
    // this on a LIVE run, by definition, and got an exception every time.
    if (name === 'run:stop') { const r = runs.get(args.runId); if (r) r.unwinding = true; return true; }
    if (name === 'run:restartNode') {
      const r = runs.get(args.runId);
      if (!r || r.unwinding !== false) throw new Error('run is live — stop or pause it first');
      r.unwinding = undefined;   // it walks again
      return true;
    }
    if (name === 'run:approve') return true;
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
  // The sentence comes from core/blockers.js now, so the line at breakfast and
  // the line on the card are the same words rather than two accounts of one
  // fact (DECISIONS.md D45). It also says the consequence, which "(parked)" did
  // not: a parked dependency will not finish on its own.
  assert.match(idle.stopping, /t-0002 \(Waiting for t-0001, which is parked — it will not finish on its own\.\)/);

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

test('a nudge stops the run first, because a stalled run is a live one', async () => {
  // The defect, watched live: nudge called `run:restartNode` on the spinning
  // run, the runner refused it -- "run is live -- stop or pause it first" --
  // and the exception skipped the counter reset, so the next poll tripped the
  // same detector and burned the next rung. Nudge, restart and escalate went by
  // in eleven seconds and the two cheap rungs were never actually tried.
  const backlog = makeBacklog();
  backlog.add({ title: 'spins', goal: 'g', level: 'low' });
  const engine = fakeEngine({ backlog, stages: { default: ['running'] } });
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { thresholds: { spinRepeats: 1, spinMs: 0 } } }
  });

  await sup.run({ maxTasks: 1 });
  const names = engine.calls.filter(c => c.name === 'run:stop' || c.name === 'run:restartNode');
  assert.equal(names[0].name, 'run:stop', 'the run is stopped before the restart is asked for');
  const restart = engine.calls.find(c => c.name === 'run:restartNode');
  assert.ok(restart, 'and the restart is taken on a later poll rather than thrown away');
  assert.match(restart.args.guidance, /SUPERVISOR:/);
});

test('a restart the runner never accepts gives up its rung instead of holding the task', async () => {
  // The bound. A run that never lets go must still reach a decision: the ladder
  // gives up on the rung it cannot use and takes the next one, which is what it
  // already does with a stall it has nothing to restart.
  const backlog = makeBacklog();
  backlog.add({ title: 'never unwinds', goal: 'g', level: 'low' });
  const engine = fakeEngine({ backlog, stages: { default: ['running'] } });
  const stuck = async (name, args) => {
    if (name === 'run:restartNode') throw new Error('run is live — stop or pause it first');
    return engine.invoke(name, args);
  };
  const sup = new Supervisor({
    invoke: stuck, calls: engine.calls, projectId: 'p', backlog, pollMs: 1,
    config: { loop: { thresholds: { spinRepeats: 1, spinMs: 0 } } }
  });

  await sup.run({ maxTasks: 1 });
  const task = backlog.get('t-0001');
  assert.ok(['queued', 'parked'].includes(task.status), 'it reached a decision rather than spinning in flight');
  if (task.status === 'queued') assert.equal(task.level, 'medium', 'and it went up a band');
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

  // ...and so does the ATTEMPT. A run started, money was spent, nothing
  // landed, which is what `attempts` means everywhere else. Only escalate()
  // and work:land counted it, so a task that died at its cap recorded its
  // spend and no attempt: watched live, t-0011 reported "Spent $0.77 of its
  // $0.5 per-task cap over 0 attempt(s)", which is not a sentence about
  // anything that can happen.
  assert.equal(task.attempts, 1);
});

test('a park that never got as far as a run is not an attempt', async () => {
  // The other direction, and the reason this cannot just always count: a task
  // refused before it starts — unaffordable, or declaring a gate this machine
  // cannot run — never began, and charging it an attempt would exhaust a
  // ladder nobody climbed.
  const backlog = makeBacklog();
  backlog.add({ title: 'ungateable', goal: 'g', gates: ['definitely-not-a-command --x'] });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const task = backlog.get('t-0001');
  assert.equal(task.status, 'parked');
  assert.match(task.blockedReason, /gate that cannot run here/);
  assert.equal(task.attempts, 0, 'nothing was attempted, and nothing was spent');
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

test('the brief names the files the task said it would change', async () => {
  // Watched a worker spend 52 tool calls and four minutes without writing a
  // byte: it read the task, listed the backlog, opened two unrelated tasks,
  // globbed for a tsconfig, tried to cd into a path from another machine, and
  // read four files none of which were the contract it needed — while the task
  // file had named the two files it was supposed to create, in a field that
  // reached nothing.
  const backlog = makeBacklog();
  backlog.add({
    title: 'Build the read model',
    goal: 'A session log becomes nested turns and steps',
    blastRadius: ['src/traceModel.js', 'tests/traceModel.test.js']
  });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const brief = engine.calls.find(c => c.name === 'flow:run').args.userInput;
  assert.match(brief, /WHERE THIS WORK GOES/);
  assert.match(brief, /src\/traceModel\.js/);
  assert.match(brief, /tests\/traceModel\.test\.js/);
  // A hint about scope, never a fence: the ceiling is what bounds authority,
  // and a prompt line must not read as though it narrowed one.
  assert.match(brief, /hint about\s+scope rather than a fence/);
});

test('the brief says whether each named file exists, because those are different jobs', async () => {
  // A task file naming `tests/library.test.js` for a brand-new v2 library sends
  // the worker into two hundred lines about the v1 NODE library. It sent one
  // there for ninety-three calls and forty cents, with an empty diff at the end.
  // Saying which paths are new catches that from both sides: the worker reads
  // it, and so does whoever is about to write the task.
  const root = tmp();
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'library.test.js'), 'a\nb\nc\n');
  const backlog = makeBacklog();
  backlog.add({
    title: 'The library',
    goal: 'One search over everything',
    blastRadius: ['src/v2/Library.jsx', 'tests/library.test.js']
  });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: root, backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const brief = engine.calls.find(c => c.name === 'flow:run').args.userInput;
  assert.match(brief, /`src\/v2\/Library\.jsx` \(new\)/);
  assert.match(brief, /`tests\/library\.test\.js` \(exists, 4 lines/);
});

test('a task that named no files says nothing about where the work goes', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'Something', goal: 'Do something' });
  const engine = fakeEngine({ backlog });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });
  const brief = engine.calls.find(c => c.name === 'flow:run').args.userInput;
  assert.doesNotMatch(brief, /WHERE THIS WORK GOES/,
    'an empty section is a paragraph of instructions about nothing');
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

test('a model that never answered costs a rung of the ladder, so it does not', async () => {
  // Watched twice in one session:
  //
  //   ▶ t-0070 … on z-ai/glm-5.2:free (band medium)
  //     t-0070 run failed, $0.0000 across 2 call(s)
  //   ↑ retrying at "high"
  //
  // "$0.0000 across 2 call(s)" is the tell: nothing answered, so nothing about
  // the task was tried, and the rung was spent on silence.
  const rateLimited = 'OpenRouter API 429: {"error":{"code":429,"metadata":'
    + '{"raw":"z-ai/glm-5.2:free is temporarily rate-limited upstream"}}}';
  assert.match(modelUnavailable(rateLimited), /temporarily rate-limited upstream/);
  assert.match(modelUnavailable('HTTP 503 from upstream'), /503/);
  // A spent key is the OTHER thing, and it wins: it stops the loop entirely.
  assert.equal(modelUnavailable('OpenRouter API 403: {"error":{"message":"Key limit exceeded"}}'), null);
  assert.equal(modelUnavailable('the assertion failed'), null);

  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'medium' });
  const engine = fakeEngine({ backlog, stages: { default: ['failed'] }, error: rateLimited });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: 1 });

  const task = backlog.get('t-0001');
  assert.equal(task.status, 'queued', 'back in the queue, not parked and not in flight');
  assert.equal(task.level, 'medium', 'same band — a bigger model is not the missing piece');
  assert.equal(task.attempts, 0, 'and nothing was attempted, so nothing was spent');
});

test('a model that never comes back stops being waited for', async () => {
  // "Put it back and try later" with no ceiling is a loop spinning on a model
  // that is never coming back, reporting progress it is not making.
  const rateLimited = 'OpenRouter API 429: rate limited upstream';
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'medium' });
  const engine = fakeEngine({ backlog, stages: { default: ['failed'] }, error: rateLimited });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 });

  await sup.run({ maxTasks: UNAVAILABLE_RETRIES + 1 });

  const task = backlog.get('t-0001');
  assert.equal(task.attempts, 1, 'the last one counted, because patience is bounded');
  assert.match(task.blockedReason, /did not answer/,
    'and it is recorded as what it was, not as work that failed');
});

test('a lease left by a stopped loop is waited out, not spun on', async () => {
  // Watched both halves of this go wrong. First a park: a loop stopped
  // mid-attempt leaves the worktree lease held, and the next session parked the
  // task permanently rather than waiting for the heartbeat to go stale.
  //
  // Then, with the wait in place but no delay behind it, a spin — the picker
  // runs every five seconds and a lease takes ten MINUTES to expire, so all
  // three tries were spent inside a minute and the task parked anyway:
  //
  //   ↻ t-0071 set aside: already has a live attempt … Waiting.
  //   ↻ t-0071 set aside: already has a live attempt … Waiting.
  //   ⏸ t-0071 parked: Could not start …
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'medium' });
  const engine = fakeEngine({ backlog });
  const held = Object.assign(
    new Error('Task "t-0001" already has a live attempt (t-0001-abc).'),
    { code: 'attempt_live' },
  );
  let starts = 0;
  const inner = engine.invoke;
  engine.invoke = async (name, args) => {
    if (name === 'work:start' && starts++ === 0) throw held;
    return inner(name, args);
  };
  const said = [];
  const sup = new Supervisor({
    ...engine, projectId: 'p', backlog, pollMs: 1, log: m => said.push(String(m)),
  });

  // The clock is injected, so the wait can be watched rather than waited out.
  let clock = 0;
  sup.now = () => clock;
  const run = sup.run({ maxTasks: 2 });
  // Let it collide and set the task aside, then move past the wait.
  await new Promise(r => setTimeout(r, 30));
  assert.equal(starts, 1, 'it tried once and stopped trying — that is the wait');
  assert.ok(said.some(m => /set aside for \d+ min/.test(m)), said.join(' | '));
  clock = LEASE_WAIT_MS + 1;
  await run;

  const task = backlog.get('t-0001');
  assert.notEqual(task.status, 'blocked', 'a held lease is a wait, not a decision for a person');
  assert.ok(starts >= 2, 'and once the wait was over it tried again');
});

test('a restart resets every counter that measures headway, not just some of them', () => {
  // Watched three rungs burn on one observation:
  //
  //   … burn: $0.15 spent since anything last changed. → nudge
  //   … burn: $0.22 spent since anything last changed. → restart
  //   … burn: $0.23 spent since anything last changed. → escalate
  //
  // The threshold was $0.15. `repeats` was reset after each restart and
  // `usdSinceProgress` was not, so once it crossed it stayed crossed and every
  // later poll took the next rung — eight cents apart, two of them never given
  // a chance to work.
  const hb = new Heartbeat({ taskId: 't-1', runId: 'r-1', now: 0 });
  const snap = { meta: { stage: 'execution', nodeStatus: { a: 'active' } } };
  hb.observe(snap, { now: 1, usd: 0.08, workspace: 'same' });
  hb.observe(snap, { now: 2, usd: 0.08, workspace: 'same' });
  assert.ok(hb.usdSinceProgress >= 0.08, 'it was accumulating, which is its job');
  assert.ok(hb.repeats >= 1);

  hb.restarted(3);
  assert.equal(hb.usdSinceProgress, 0, 'the money spent before the restart is not evidence about after it');
  assert.equal(hb.tokensSinceProgress, 0);
  assert.equal(hb.repeats, 0);
  assert.deepEqual(hb.gateFailures, []);
  assert.equal(hb.signature, null,
    'the bytes the stopped run had are not evidence about the attempt starting');
  assert.equal(hb.lastProgressAt, 3);

  // And the detector agrees: the restarted attempt is not immediately stalled.
  assert.equal(detectStall(hb, { thresholds: { ...DEFAULT_THRESHOLDS, burnUsd: 0.15 } }), null);
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

test('a cap named at the start counts what THIS loop spent, not what today did', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 'this-morning', usd: 7.84, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    // What `flyt loop start --cap-usd 2` sends: a ceiling for this session.
    config: { loop: { caps: { hardUsd: 2 }, sessionCaps: { hardUsd: 2 } } }
  });
  await new Promise(r => setTimeout(r, 5));   // the morning's spend is in the past
  const status = await sup.run();

  assert.equal(status.landed, 1, 'money spent before the loop started is not this session ceiling');
  assert.ok(!/hard cap/.test(status.stopping ?? ''), `it should not refuse to start: ${status.stopping}`);
});

test('a standing cap already tripped says nothing was attempted, and over what span', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 'this-morning', usd: 7.84, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { hardUsd: 2 } } }   // the project's standing guard
  });
  const status = await sup.run();

  assert.match(status.stopping, /before any task started/);
  assert.match(status.stopping, /\$7\.84 already spent in the last 24h/);
  assert.match(status.stopping, /cap \$2\.00/);
  assert.match(status.stopping, /nothing was attempted/);
  assert.equal(status.completed, 0);
});

test('a session cap this loop DID reach still stops it', async () => {
  const backlog = makeBacklog();
  for (let i = 0; i < 3; i++) backlog.add({ title: `t${i}`, goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));

  // Money spent BY this loop, as its first task runs.
  const engine = fakeEngine({ backlog });
  const invoke = async (name, args) => {
    if (name === 'flow:run') ledger.record({ taskId: 'in-this-session', usd: 1.5, estimated: false });
    return engine.invoke(name, args);
  };

  const sup = new Supervisor({
    ...engine, invoke, projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { hardUsd: 1 }, sessionCaps: { hardUsd: 1 } } }
  });
  const status = await sup.run();

  assert.match(status.stopping, /hard cap reached \(\$1\.50\)/);
  assert.ok(!/before any task started/.test(status.stopping), 'this one it did reach');
  assert.equal(status.landed, 1, 'the task in flight finished; the next never started');
});

test('the ceiling counts what the run in flight is spending, not only what settled', async () => {
  const backlog = makeBacklog();
  for (let i = 0; i < 3; i++) backlog.add({ title: `t${i}`, goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));

  // A run that is spending right now. Recorded spend arrives only when a run
  // ends, so before this the window ceiling read $0 for the whole stretch.
  const store = {
    snapshot: () => ({ retrospectives: {} }),
    callTraceNodes: () => ['work'],
    readCallTrace: () => [{ usage: { cost: 1.5 }, provider: 'openrouter', model: 'a-model', ok: true }]
  };

  const sup = new Supervisor({
    ...fakeEngine({ backlog, stages: { default: ['execution', 'execution', 'done'] } }),
    projectId: 'p', backlog, ledger, store, pollMs: 1, parallelism: 2,
    config: { loop: { caps: { hardUsd: 1 } } }
  });
  const status = await sup.run();

  assert.match(status.stopping, /hard cap reached/);
  assert.match(status.stopping, /\$1\.50/, 'the number is the money being spent, not the money already banked');
  assert.ok(status.completed <= 1, 'it did not keep starting tasks under a ceiling that read zero');
});

test('a task with no room for another attempt is parked before it starts', async () => {
  const backlog = makeBacklog();
  const task = backlog.add({ title: 'expensive', goal: 'g' });
  backlog.update(task.id, { attempts: 1 });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: task.id, usd: 0.97, estimated: false });   // what attempt one cost

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { taskUsd: 1.2 } } }
  });
  const status = await sup.run();

  assert.equal(backlog.get(task.id).status, 'parked');
  assert.equal(status.landed, 0, 'no attempt was bought');
  const reason = backlog.get(task.id).blockedReason;
  assert.match(reason, /\$0\.23 left, against \$0\.97 an attempt/);
  assert.match(reason, /raise --task-usd/);
});

test('a task with room left is still worked', async () => {
  const backlog = makeBacklog();
  const task = backlog.add({ title: 'cheap so far', goal: 'g' });
  backlog.update(task.id, { attempts: 1 });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: task.id, usd: 0.10, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { taskUsd: 1.2 } } }
  });
  const status = await sup.run();
  assert.equal(status.landed, 1);
});

test('a first attempt is never refused for want of history', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'brand new', goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { taskUsd: 0.01 } } }
  });
  const status = await sup.run();
  assert.equal(status.landed, 1, 'a task nobody has spent anything on gets its first attempt');
});

test('the burn detector is handed real numbers', async () => {
  const backlog = makeBacklog();
  backlog.add({ title: 'busy and expensive', goal: 'g' });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  // A run that keeps spending while producing byte-identical work.
  // Cost climbs once per POLL, not per read: the supervisor reads a run's trace
  // more than once a tick, and a fake that charges per read measures the
  // supervisor's internals instead of the passage of the run.
  let polls = 0;
  const engine = fakeEngine({ backlog, stages: { default: ['execution'] } });
  const invoke = async (name, args) => {
    if (name === 'run:snapshot') polls += 1;
    return engine.invoke(name, args);
  };
  const store = {
    snapshot: () => ({ retrospectives: {} }),
    callTraceNodes: () => ['work'],
    readCallTrace: () => [{
      usage: { cost: 0.2 * polls, prompt_tokens: 1000 * polls, completion_tokens: 100 * polls },
      provider: 'openrouter', model: 'm', ok: true
    }]
  };

  const said = [];
  const sup = new Supervisor({
    ...engine, invoke,
    projectId: 'p', backlog, ledger, store, pollMs: 1,
    log: m => said.push(String(m)),
    config: { loop: { caps: { taskUsd: 2 }, thresholds: { silentMs: 1e9, spinMs: 1e9, spinRepeats: 1e9 } } }
  });
  const status = await sup.run({ maxTasks: 1 });

  const hb = status.inFlight[0];
  assert.ok(!hb, 'the task did not stay in flight forever');
  assert.ok(sup.history.length, 'it ended, one way or another');
  // What this test is FOR: the detector used to be handed a hard-coded zero on
  // every poll, so its counter could never reach any threshold — a safety net
  // that cannot fire is a comment. It fires.
  assert.ok(said.some(m => /burn: \$.*spent since anything last changed/.test(m)),
    `the burn detector should have fired: ${said.join(' | ')}`);
  // How it ENDS is the cap's business or the ladder's, depending on which
  // reaches it first, and both are correct outcomes for a run that is busy,
  // expensive and producing the same thing every time.
});

test('a park about the wallet keeps what was wrong with the work', async () => {
  const backlog = makeBacklog();
  const task = backlog.add({ title: 'nearly right', goal: 'g' });
  backlog.update(task.id, {
    attempts: 1,
    blockedReason: 'The reviewer rejected it: the cache is never invalidated when a task file is deleted.'
  });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: task.id, usd: 0.97, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { taskUsd: 1.2 } } }
  });
  await sup.run();

  const reason = backlog.get(task.id).blockedReason;
  assert.match(reason, /\$0\.23 left/, 'it still says why it stopped');
  assert.match(reason, /the cache is never invalidated/, 'and still says what was wrong with the work');

  // The next attempt's brief quotes blockedReason under "A PREVIOUS ATTEMPT
  // FAILED". Telling it the predecessor ran out of money would be a lie about
  // what actually happened.
  assert.match(reason, /rejected on the work, not the money/);
});

test('a budget park does not nest inside another budget park', async () => {
  const backlog = makeBacklog();
  const task = backlog.add({ title: 'expensive twice', goal: 'g' });
  backlog.update(task.id, {
    attempts: 1,
    blockedReason: 'Spent $0.97 of its $1.2 per-task cap over 1 attempt(s), with nothing left for another — raise --task-usd to work it again.'
  });
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: task.id, usd: 0.97, estimated: false });

  const sup = new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, ledger, pollMs: 1,
    config: { loop: { caps: { taskUsd: 1.2 } } }
  });
  await sup.run();

  const reason = backlog.get(task.id).blockedReason;
  assert.equal(reason.match(/per-task cap/g).length, 1, 'one budget message, not two');
});

test('a task that streams steadily while accomplishing nothing is intervened on', async () => {
  // The failure this whole redefinition exists for: eleven minutes, forty
  // model calls, no workspace change, and a ladder that never fired because
  // the streaming buffer looked like progress on every poll.
  const backlog = makeBacklog();
  backlog.add({ title: 'talks a lot', goal: 'g' });
  const said = [];

  const sup = new Supervisor({
    ...fakeEngine({ backlog, stages: { default: ['execution'] }, stream: true }),
    projectId: 'p', backlog, pollMs: 1, log: line => said.push(line),
    config: { loop: { thresholds: { silentMs: 50, spinMs: 50, spinRepeats: 2 } } }
  });
  await sup.run({ maxTasks: 1 });

  const intervened = said.filter(l => /spin|silent|burn|outlier/.test(l));
  assert.ok(intervened.length, `nothing intervened: ${said.join(' | ')}`);
  assert.match(intervened[0], /→ (nudge|restart|escalate|park)/, 'and it climbed a rung');
});

test('a task that is genuinely working is left alone', async () => {
  // The other direction, which matters just as much: a harness that stops good
  // tasks is worse than one that stops none.
  const backlog = makeBacklog();
  backlog.add({ title: 'actually working', goal: 'g' });
  const said = [];

  const sup = new Supervisor({
    ...fakeEngine({ backlog, stages: { default: ['execution', 'execution', 'done'] }, stream: true }),
    projectId: 'p', backlog, pollMs: 1, log: line => said.push(line),
    config: { loop: { thresholds: { silentMs: 50, spinMs: 50, spinRepeats: 2 } } }
  });
  const status = await sup.run({ maxTasks: 1 });

  assert.equal(status.landed, 1);
  assert.deepEqual(said.filter(l => /spin|silent|burn|outlier/.test(l)), [],
    'a node reaching done is progress, whatever its buffer was doing');
});

test('the outlier detector times attempts where a model actually answered', async () => {
  // An attempt that died in twenty seconds because a free model was
  // rate-limited says nothing about how long this work takes — it says how fast
  // that failure is. Counting those made the median a median of how quickly
  // things break.
  const backlog = makeBacklog();
  for (let i = 0; i < 3; i++) backlog.add({ title: `t${i}`, goal: 'g' });
  const quiet = new Supervisor({ ...fakeEngine({ backlog }), projectId: 'p', backlog, pollMs: 1 });
  await quiet.run();
  assert.deepEqual(quiet.durations, [],
    'no model answered in any of them, so none of them is a sample of anything');

  const spending = makeBacklog();
  for (let i = 0; i < 3; i++) spending.add({ title: `t${i}`, goal: 'g' });
  const store = {
    snapshot: () => ({ retrospectives: {} }),
    callTraceNodes: () => ['work'],
    readCallTrace: () => [{
      usage: { cost: 0.02, prompt_tokens: 900, completion_tokens: 100 },
      provider: 'openrouter', model: 'm', ok: true
    }]
  };
  const real = new Supervisor({
    ...fakeEngine({ backlog: spending }), projectId: 'p', backlog: spending, store, pollMs: 1,
    // Both, because seeing what a run spent needs the trace AND the prices.
    ledger: new Ledger(path.join(tmp(), 'ledger'))
  });
  await real.run();
  assert.equal(real.durations.length, 3, 'attempts that reached a model are timed');
  assert.ok(real.durations.every(d => Number.isFinite(d) && d >= 0));
});

test('an attempt is not an outlier for being slower than a session of fast deaths', () => {
  // Watched this eat a task whole. Several attempts had died in seconds, so the
  // median was seconds, and "4× the usual" was under two minutes:
  //
  //   … t-0069 outlier: Running 2 minutes; 4× the usual → nudge
  //   … t-0069 outlier: Running 2 minutes; 4× the usual → restart
  //   … t-0069 outlier: Running 2 minutes; 4× the usual → escalate
  //
  // Twice over, medium to the top of the ladder in nine minutes, for an empty
  // diff. And self-reinforcing: each fast death lowered the median again.
  const twoMinutes = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  twoMinutes.observe(snap({ a: 'running' }), { now: 0 });
  twoMinutes.observe(snap({ a: 'running' }), { now: 2 * 60 * 1000, workspace: 'moved' });
  assert.equal(detectStall(twoMinutes, { medianMs: 20_000 }), null,
    'two minutes of real work is not an outlier, whatever a session of failures averaged');

  // The floor is a floor, not a replacement: past it, the comparison decides.
  const anHour = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  anHour.observe(snap({ a: 'running' }), { now: 0 });
  anHour.observe(snap({ a: 'done', b: 'running' }), { now: 60 * 60 * 1000 });
  assert.equal(detectStall(anHour, { medianMs: 60_000 }).detector, 'outlier');
  assert.equal(detectStall(anHour, { medianMs: null }), null, 'and it stays quiet without a median');

  // A genuinely slow session raises the bar rather than lowering it.
  const twelve = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  twelve.observe(snap({ a: 'running' }), { now: 0 });
  twelve.observe(snap({ a: 'running' }), { now: 12 * 60 * 1000, workspace: 'moved' });
  assert.equal(detectStall(twelve, { medianMs: 10 * 60 * 1000 }), null,
    'twelve minutes against a ten-minute median is ordinary');
});

test('every reader counts what is in flight, not only what settled', async () => {
  const { liveSpend, totalsWithLive } = await import('../core/ledger.js');
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 't-1', usd: 0.25, estimated: false });

  // A run that is spending right now. Its calls are in the trace; the ledger
  // will not hear about them until it ends.
  const store = {
    snapshot: () => ({ retrospectives: {} }),
    callTraceNodes: () => ['work'],
    readCallTrace: () => [{ usage: { cost: 0.4 }, provider: 'openrouter', model: 'm', ok: true }]
  };

  assert.deepEqual(liveSpend(store, ['run-1'], {}), { usd: 0.4, calls: 1 });
  assert.deepEqual(liveSpend(store, [], {}), { usd: 0, calls: 0 }, 'nothing in flight costs nothing');
  assert.deepEqual(liveSpend(null, ['run-1'], {}), { usd: 0, calls: 0 }, 'and no store is not a crash');

  const totals = totalsWithLive(ledger, {}, { store, runIds: ['run-1'] });
  assert.equal(Number(totals.usd.toFixed(2)), 0.65, 'settled plus in flight');
  assert.equal(totals.live, 0.4, 'and the two stay distinguishable');
  assert.equal(totalsWithLive(ledger, {}, {}).usd, 0.25, 'with nothing in flight it is the settled total');
});

test('the morning report says how much of the spend is still in flight', () => {
  const backlog = makeBacklog();
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  ledger.record({ taskId: 't-1', usd: 1, estimated: false });
  const store = {
    snapshot: () => ({ retrospectives: {} }),
    callTraceNodes: () => ['work'],
    readCallTrace: () => [{ usage: { cost: 0.5 }, provider: 'openrouter', model: 'm', ok: true }]
  };

  const report = renderReport({
    status: { running: true, stopping: null, inFlight: [{ taskId: 't-1', runId: 'run-1' }], landed: 0, completed: 0 },
    backlog, ledger, store
  });
  assert.match(report, /\$1\.50 across 2 call\(s\) \(of which \$0\.50 is still in flight\)/);
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

// `--only` narrows what the loop may take, so it has to narrow the EXPLANATION
// too. A run over two named tasks that had both parked reported "nothing ready
// — 1 task(s) blocked: t-0008 (Waiting for t-0006, which does not exist.)",
// naming a task nobody had asked it to work. Three restarts went looking at
// t-0008 before anyone read the backlog directory.
test('a --only loop explains the tasks it was told to work, not the rest of the backlog', async () => {
  const backlog = new Backlog(tmp());
  const mine = backlog.add({ title: 'Mine', goal: 'g' });
  const other = backlog.add({ title: 'Someone else', goal: 'g' });
  backlog.update(mine.id, { status: 'parked', blockedReason: 'a stale attempt record' });
  backlog.update(other.id, { dependsOn: ['t-9999'] });

  const status = await new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, pollMs: 1, only: [mine.id]
  }).run();

  assert.match(status.stopping, new RegExp(mine.id), 'the task it was told to work must be named');
  assert.match(status.stopping, /parked/);
  assert.match(status.stopping, /stale attempt record/, 'and the reason it is stuck');
  assert.doesNotMatch(status.stopping, new RegExp(other.id), 'a task nobody asked about is not the answer');
});

test('an --only naming nothing says so rather than reporting an empty backlog', async () => {
  const backlog = new Backlog(tmp());
  backlog.add({ title: 'Real', goal: 'g' });
  const status = await new Supervisor({
    ...fakeEngine({ backlog }), projectId: 'p', backlog, pollMs: 1, only: ['t-9999']
  }).run();
  assert.match(status.stopping, /no task matched --only t-9999/);
});

test('a slow model reading is not a spin, and a stopped one still is', () => {
  // "Byte-identical work" is what a spin looks like AND what READING looks
  // like. A worker on a long context can take two minutes a turn, so six
  // minutes of that is three turns of legitimate exploration with nothing
  // durable written yet. Watched one get nudged and restarted for exactly
  // that, twenty-five distinct tool calls in.
  //
  // What tells them apart is whether the meter is still running.
  const snap2 = { meta: { stage: 'execution', nodeStatus: { a: 'active' } } };
  const thresholds = { ...DEFAULT_THRESHOLDS, burnUsd: null };

  const working = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  working.observe(snap2, { now: 0, workspace: 'same' });
  for (let i = 1; i <= 100; i++) {
    // Polls with nothing written, but calls settling: tokens keep arriving.
    working.observe(snap2, { now: i * 5000, workspace: 'same', tokens: i % 20 === 0 ? 900 : 0, usd: 0 });
  }
  assert.ok(working.idleMs > DEFAULT_THRESHOLDS.spinMs, 'long enough to have tripped the old rule');
  assert.ok(working.quietMs < DEFAULT_THRESHOLDS.spinMs, 'because something was spent recently');
  assert.equal(detectStall(working, { thresholds }), null,
    'a run still settling calls is exploring, not spinning — nor silent, which was'
    + ' measured the same wrong way');

  const stopped = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  stopped.observe(snap2, { now: 0, workspace: 'same' });
  for (let i = 1; i <= 100; i++) stopped.observe(snap2, { now: i * 5000, workspace: 'same' });
  assert.equal(detectStall(stopped, { thresholds })?.detector, 'spin',
    'nothing written, nothing spent, and nothing said: that is stuck');

  // And a polite infinite loop is still caught — by BURN, in dollars, which is
  // the honest unit for "busy, expensive and producing the same thing".
  const busy = new Heartbeat({ taskId: 't', runId: 'r', now: 0 });
  busy.observe(snap2, { now: 0, workspace: 'same' });
  for (let i = 1; i <= 40; i++) busy.observe(snap2, { now: i * 5000, workspace: 'same', usd: 0.02, tokens: 500 });
  assert.equal(detectStall(busy, { thresholds: { ...thresholds, burnUsd: 0.5 } })?.detector, 'burn');
});

test('a session cap counts this session, for the task as well as the window', async () => {
  // The CLI help says the caps are "THIS session's spend, from now", and
  // `#checkBudget` already made that true for the window. The per-task cap read
  // the task's WHOLE HISTORY regardless, so a task that cost $1.65 six days ago
  // parked instantly under a $1.20 session cap it had not spent a cent of —
  // and said so in a sentence nobody could act on: "$1.65 over 0 attempt(s)".
  const ledger = new Ledger(path.join(tmp(), 'ledger'));
  const longAgo = new Date(Date.now() - 6 * 24 * 3600_000).toISOString();
  ledger.record({ at: longAgo, taskId: 't-0001', usd: 1.65, estimated: false });

  // Over the whole history, that money is there.
  assert.equal(ledger.totals({ taskId: 't-0001' }).usd, 1.65);
  // Over this session, it is not, and the cap is what asks.
  const session = ledger.check({ caps: { taskUsd: 1.2 }, taskId: 't-0001', windowMs: 60_000 });
  assert.equal(session.task.usd, 0, 'nothing was spent on it in the last minute');
  assert.deepEqual(session.hits, [], 'so the cap it has not reached does not fire');

  // A standing cap over the project's rolling day still sees a day's spending.
  ledger.record({ taskId: 't-0001', usd: 0.9, estimated: false });
  const today = ledger.check({ caps: { taskUsd: 0.5 }, taskId: 't-0001', windowMs: 24 * 3600_000 });
  assert.deepEqual(today.hits, ['task']);
  assert.equal(today.action, 'park');
});

// --- an empty account stops everything, once, loudly (2026-08-24) ----------
//
// The night this is written from: an OpenRouter balance ran out mid-loop.
// `providerBlocked` matched 401 and 403 and the refusal was a 402, so the loop
// read every one as the task failing, counted the attempt, escalated a rung,
// retried, escalated again, and worked down the queue doing it to each task in
// turn. Five ended parked with reasons describing work that had never run; one
// climbed from `medium` to `xhigh` across six attempts without receiving a
// single model call.

const REAL_402 = 'OpenRouter API 402: {"error":{"message":"This request requires more '
  + 'credits, or fewer max_tokens. You requested up to 12288 tokens, but can only afford '
  + '1411","code":402}}';

test('an empty account stops the loop and is charged to nobody', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-incident-'));
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'low' });
  backlog.add({ title: 'second', goal: 'g', value: 4, effort: 1, level: 'low' });
  const engine = fakeEngine({
    backlog, error: REAL_402, stages: { default: ['running', 'failed'] },
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1, stateRoot: root });

  await sup.run();

  // The task keeps everything. It was never tried.
  const first = backlog.get('t-0001');
  assert.equal(first.status, 'queued', 'released, not parked and not failed');
  assert.equal(first.attempts, 0, "an attempt that never reached a model is not an attempt");
  assert.equal(first.level, 'low', 'and it costs no rung of the effort ladder');
  assert.ok(!first.blockedReason, `nothing describing work that never ran: ${first.blockedReason}`);

  // And it stopped, rather than proving the same thing against the next one.
  assert.equal(backlog.get('t-0002').status, 'queued', 'the second task was never touched');
  assert.equal(backlog.get('t-0002').attempts, 0);
  assert.match(sup.status().stopping, /provider refused/);
});

test('the refusal leaves a record that outlives the process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-incident-'));
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', level: 'low' });
  const engine = fakeEngine({
    backlog, error: REAL_402, stages: { default: ['running', 'failed'] },
  });
  await new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1, stateRoot: root }).run();

  // A log line is not telling anybody: the process that wrote it exits.
  const open = openIncidents(root);
  assert.equal(open.length, 1, 'one incident');
  assert.equal(open[0].kind, 'provider');
  assert.equal(open[0].code, 'credit');
  assert.match(open[0].remedy, /Add credit/);
  assert.match(incidentHeadline(root), /credit|Add credit/);

  // And it stays in the way until somebody says otherwise.
  resolveIncident(root, open[0].id, { by: 'test' });
  assert.equal(openIncidents(root).length, 0);
  assert.equal(incidentHeadline(root), null);
});

test('a rate limit is not an incident: it clears on its own', async () => {
  // The distinction that did not exist. Waiting fixes a 429 and never fixes a
  // 402, and while they shared one code neither could be handled honestly.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-incident-'));
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', level: 'low' });
  const engine = fakeEngine({
    backlog, error: 'OpenRouter API 429: rate limited', stages: { default: ['running', 'failed'] },
  });
  await new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1, stateRoot: root }).run();

  assert.equal(openIncidents(root).length, 0, 'nobody is woken for a rate limit');
});

test('escalating amends the brief, so the dearer model reads what the cheap one hit', async () => {
  // The point of a rung is that the next attempt does better. A bigger model
  // given the identical brief mostly makes the identical mistake, more
  // expensively — so what the last attempt ran into goes into the task before
  // the rung is spent.
  const backlog = makeBacklog();
  backlog.add({ title: 'work', goal: 'g', level: 'low', blastRadius: ['core/a.js'] });
  const engine = fakeEngine({
    backlog, error: 'the run failed', stages: { default: ['running', 'failed'] },
  });
  await new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 }).run({ maxTasks: 1 });

  const task = backlog.get('t-0001');
  assert.equal(task.level, 'medium', 'the rung was still spent');
  assert.match(task.body, /What previous attempts hit/, "and the brief now says what happened");
  assert.match(task.body, /Attempt 1/);
  assert.deepEqual(briefNotes(task.body).length, 1, 'recorded so the next one adds to it');
});

test('the amendment never replaces what the author wrote', async () => {
  const backlog = makeBacklog();
  backlog.add({
    title: 'work', goal: 'the original instruction', level: 'low',
    doneWhen: ['the original acceptance'],
  });
  const engine = fakeEngine({
    backlog, error: 'the run failed', stages: { default: ['running', 'failed'] },
  });
  await new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1 }).run({ maxTasks: 1 });

  const body = backlog.get('t-0001').body;
  assert.match(body, /the original instruction/);
  assert.match(body, /the original acceptance/);
  assert.ok(body.indexOf('the original instruction') < body.indexOf('What previous attempts hit'),
    'the task still opens with the task');
});

test('a reviewer that could not be reached keeps the work and stops the loop', async () => {
  // The gate this branch guards is the expensive one: the work is finished and
  // the gates are green, and the only thing that went wrong is that nothing
  // could be asked to look at it. Charged as a rejection it costs the attempt,
  // the rung and the diff. Nothing exercised it until now.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-review-refusal-'));
  const backlog = makeBacklog();
  backlog.add({ title: 'first', goal: 'g', value: 5, effort: 1, level: 'low' });
  backlog.add({ title: 'second', goal: 'g', value: 4, effort: 1, level: 'low' });
  const engine = fakeEngine({
    backlog,
    land: () => ({
      landed: false, stage: 'review',
      review: {
        verdict: 'request-changes',
        reason: 'The review could not be completed: OpenRouter API 402: out of credit',
        refusal: { code: 'credit', remedy: 'Add credit. Waiting will not clear it.' }
      }
    })
  });
  const sup = new Supervisor({ ...engine, projectId: 'p', backlog, pollMs: 1, stateRoot: root });

  await sup.run();

  const first = backlog.get('t-0001');
  assert.equal(first.status, 'queued', 'the work is unreviewed, not rejected');
  assert.equal(first.attempts, 0, 'and nothing about it was judged, so nothing is charged');
  assert.equal(first.level, 'low', 'no rung spent on a reviewer that never answered');
  assert.equal(first.resumeFrom ?? null, null, 'nothing to resume in this fixture');
  assert.equal(backlog.get('t-0002').status, 'queued', 'the next task is untouched');

  assert.match(sup.status().stopping, /reviewer could not be reached/);
  const open = openIncidents(root);
  assert.equal(open.length, 1);
  assert.equal(open[0].code, 'credit');
  assert.match(incidentHeadline(root), /Add credit/);
});
