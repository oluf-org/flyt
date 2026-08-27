// The chain: flow → backlog → loop → done (DECISIONS.md D36).
//
// The contract and the wait policy are pure functions, tested directly. The
// node itself is tested against a real Backlog on disk with a stub supervisor,
// because the thing worth pinning is "did the hand-off produce work a
// supervisor can actually claim" — which is exactly the failure mode DECISIONS.md D36
// calls the real risk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StackRunner } from '../core/stackRunner.js';
import { Backlog } from '../core/backlog.js';
import {
  parseBacklogPlan, resolveDependsOn, validateBacklogEvidence
} from '../core/nodes/backlogPlan.js';
import { ReferenceLibrary } from '../core/references.js';
import {
  enqueuePlan, tallyTasks, isSettled, renderLoopReport, spendFor,
  readLoopState, writeLoopState, WAIT_POLICIES
} from '../core/nodes/loopNode.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const tmpBacklog = () => new Backlog(fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-backlog-')));

const PLAN = [
  { title: 'Add a retry to the fetcher', goal: 'Transient 5xx no longer fails the run.', doneWhen: ['npm test passes', 'a 503 retries three times'], value: 4, effort: 2, level: 'medium', gates: ['npm test'], blastRadius: ['core/fetch.js'] },
  { title: 'Document the retry', goal: 'The README says what the retry does.', doneWhen: ['README mentions the backoff'], dependsOn: ['Add a retry to the fetcher'] }
];
const fenced = obj => 'Here is what I would do.\n\n```json\n' + JSON.stringify(obj) + '\n```';

function evidenceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-plan-evidence-'));
  const repo = path.join(root, 'subject');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'retry.js'),
    'export function retry() {\n  return requestWithBackoff()\n}\n');
  fs.writeFileSync(path.join(repo, '.flyt-reference.json'), JSON.stringify({
    name: 'subject', url: 'https://example.invalid/subject', commit: 'abc123456789'
  }));
  return new ReferenceLibrary(root, {
    repos: [{ name: 'subject', url: 'https://example.invalid/subject', about: 'retry behavior' }]
  });
}

// --- the contract (P4.1 / B9) -----------------------------------------------

test('a well-formed plan parses into backlog-shaped tasks', () => {
  const r = parseBacklogPlan(fenced(PLAN));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks[0].gates, ['npm test']);
  assert.equal(r.tasks[0].value, 4);
  assert.equal(r.tasks[1].value, 3, 'value/effort default to the middle');
  assert.equal(r.tasks[1].level, undefined, 'no level means the project default');
});

test('a task nobody can verify is not a task', () => {
  const r = parseBacklogPlan(fenced([{ title: 'Make it better', goal: 'Better.' }]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /doneWhen: at least one checkable criterion/);
});

test('a task with no goal is rejected, and says which one', () => {
  const r = parseBacklogPlan(fenced([{ title: 'Do the thing', doneWhen: ['it is done'] }]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /"Do the thing" says what to do but not what done looks like/);
});

// --- one bad edge does not throw away four good tasks (t-0099) --------------
//
// Run 2026-08-23T20-13-13-426Z-l0df spent 16 model calls and produced five
// well-researched tasks for Phase 3, each with confirmed file paths and real
// acceptance criteria. It enqueued none of them, because ONE task's dependsOn
// read "Repeat container in kernel" while the task it meant was titled "Add
// Repeat N container to parser, types, scheduler". Two things were wrong: a
// plan's internal dependencies were matched by free-text TITLE, so the model
// had to reproduce a long sentence exactly in a second place; and a violation
// affecting one edge of one task rejected the whole document.

test('a dependency nothing matches drops that edge and queues the rest', () => {
  const r = parseBacklogPlan(fenced([
    { ...PLAN[0], dependsOn: ['A task that does not exist'] },
    PLAN[1]
  ]));
  assert.equal(r.ok, true, 'the plan still stands: ' + JSON.stringify(r.errors));
  assert.equal(r.tasks.length, 2, 'and every task in it is still there');
  assert.deepEqual(r.tasks[0].dependsOn, [], 'the one edge nothing matched is gone');
  assert.match(r.warnings.join(' '), /is not the ref or title of any task in/);
  assert.match(r.warnings.join(' '), /queued without it/);
});

test('a near miss is resolved, and says that it was', () => {
  // The shape that actually happened: a shortened title. Resolving it silently
  // would be a guess rewiring a dependency graph, so it is said out loud.
  const long = { ...PLAN[1], title: 'Add Repeat N container to parser, types, scheduler' };
  const r = parseBacklogPlan(fenced([
    { ...PLAN[0], dependsOn: ['Repeat N container'] },
    long
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].dependsOn, [long.title], 'read as the task it obviously meant');
  assert.match(r.warnings.join(' '), /did not match anything exactly/);
  assert.match(r.warnings.join(' '), /the only close match in this plan/);
});

test('an ambiguous near miss is dropped, not guessed at', () => {
  // "I could not tell which you meant" is an honest answer, and picking one is
  // not. Two candidates both contain the wanted string.
  const r = parseBacklogPlan(fenced([
    { ...PLAN[0], dependsOn: ['parser'] },
    { ...PLAN[1], title: 'Teach the parser about Repeat' },
    { ...PLAN[1], title: 'Teach the parser about Until' }
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.tasks[0].dependsOn, []);
  assert.match(r.warnings.join(' '), /is not the ref or title of any task/);
});

test('a ref is one word the planner cannot get wrong twice', () => {
  // The real fix: dependsOn names something the model CHOSE, not a long title
  // it has to reproduce exactly in a second place.
  const r = parseBacklogPlan(fenced([
    { ...PLAN[0], ref: 'parser', dependsOn: [] },
    { ...PLAN[1], ref: 'scheduler', dependsOn: ['parser'] }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [], 'an exact ref match is not worth a word');
  assert.equal(r.tasks[0].ref, 'parser');
  assert.deepEqual(r.tasks[1].dependsOn, ['parser']);
});

test('two tasks may not claim the same ref', () => {
  // A ref that is ambiguous is a real error, unlike a dependency that is: it
  // makes every edge naming it meaningless, and the planner can simply fix it.
  const r = parseBacklogPlan(fenced([
    { ...PLAN[0], ref: 'same' },
    { ...PLAN[1], ref: 'same' }
  ]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /duplicate ref "same"/);
});

test('titles still work, so a plan written the old way is unchanged', () => {
  const r = parseBacklogPlan(fenced([
    PLAN[0],
    { ...PLAN[1], dependsOn: [PLAN[0].title] }
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.tasks[1].dependsOn, [PLAN[0].title]);
});

test('near-misses are accepted rather than failed on a technicality', () => {
  const one = parseBacklogPlan(fenced(PLAN[0]));           // a bare object
  assert.equal(one.ok, true, JSON.stringify(one.errors));
  const wrapped = parseBacklogPlan(fenced({ tasks: PLAN })); // { tasks: [...] }
  assert.equal(wrapped.ok, true, JSON.stringify(wrapped.errors));
});

test('an empty plan and a missing block both fail honestly', () => {
  assert.match(parseBacklogPlan(fenced([])).errors[0], /empty/);
  assert.match(parseBacklogPlan('no json here at all').errors[0], /no JSON array of tasks found/);
});

test('unknown fields are dropped, not written into the frontmatter forever', () => {
  const r = parseBacklogPlan(fenced([{ ...PLAN[0], sneaky: 'value', status: 'landed' }]));
  assert.equal(r.ok, true);
  assert.ok(!('sneaky' in r.tasks[0]));
  assert.ok(!('status' in r.tasks[0]), 'a plan cannot declare its own work already done');
});

test('an unknown level is an error rather than a silent default', () => {
  const r = parseBacklogPlan(fenced([{ ...PLAN[0], level: 'turbo' }]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /level: must be one of/);
});

test('reference claims require structured evidence that verifies against this run', () => {
  const ref = 'reference:subject/src/retry.js';
  const task = {
    ...PLAN[0],
    goal: `Port the backoff from ${ref}.`,
    evidence: [{
      claim: 'the request is retried with backoff', ref, line: 2,
      excerpt: 'requestWithBackoff()'
    }]
  };
  const parsed = parseBacklogPlan(fenced([task]));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  const checked = validateBacklogEvidence(parsed.tasks, {
    references: evidenceFixture(),
    allowedReferences: [{ name: 'subject', commit: 'abc123456789' }]
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(checked.tasks[0].evidence[0].commit, 'abc123456789');
});

test('missing, stale, and out-of-run reference evidence is rejected', () => {
  const ref = 'reference:subject/src/retry.js';
  const base = { ...PLAN[0], goal: `Port the backoff from ${ref}.` };
  const noEvidence = parseBacklogPlan(fenced([base]));
  const missing = validateBacklogEvidence(noEvidence.tasks, {
    references: evidenceFixture(), allowedReferences: ['subject']
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(' '), /mentioned without a matching evidence entry/);

  const stale = parseBacklogPlan(fenced([{
    ...base,
    evidence: [{ claim: 'uses backoff', ref, line: 1, excerpt: 'requestWithBackoff()' }]
  }]));
  const staleResult = validateBacklogEvidence(stale.tasks, {
    references: evidenceFixture(), allowedReferences: ['subject']
  });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.errors.join(' '), /excerpt was not found/);

  const foreign = validateBacklogEvidence(stale.tasks, {
    references: evidenceFixture(), allowedReferences: ['another-repo']
  });
  assert.match(foreign.errors.join(' '), /not a reference repository recorded by this run/);

  const valid = parseBacklogPlan(fenced([{
    ...base,
    evidence: [{ claim: 'uses backoff', ref, line: 2, excerpt: 'requestWithBackoff()' }]
  }]));
  const moved = validateBacklogEvidence(valid.tasks, {
    references: evidenceFixture(), allowedReferences: [{ name: 'subject', commit: 'different-commit' }]
  });
  assert.match(moved.errors.join(' '), /this run pinned different-commit/);
});

test('a prose-only or malformed repository attribution cannot bypass evidence', () => {
  const parsed = parseBacklogPlan(fenced([{
    ...PLAN[0],
    goal: 'Adopt the <reference>opencode/src/session/prompt.ts context pattern.',
    notes: 'This comes from OpenCode but includes no exact line.'
  }]));
  const checked = validateBacklogEvidence(parsed.tasks, {
    references: evidenceFixture(), allowedReferences: ['opencode']
  });
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join(' '), /repository "opencode" is mentioned without a verified file citation/);

  const local = validateBacklogEvidence(parseBacklogPlan(fenced(PLAN)).tasks, {
    references: evidenceFixture(), allowedReferences: ['opencode']
  });
  assert.equal(local.ok, true, 'a purely local task does not need an invented external citation');
});

test('a hand-off can require evidence for every task learned from a reference', () => {
  const parsed = parseBacklogPlan(fenced(PLAN));
  const required = validateBacklogEvidence(parsed.tasks, {
    references: evidenceFixture(), allowedReferences: ['subject'], requireEvidence: true
  });
  assert.equal(required.ok, false);
  assert.match(required.errors.join(' '), /at least one verified citation is required/);

  const cited = parseBacklogPlan(fenced([{
    ...PLAN[0],
    evidence: [{
      claim: 'Retries are bounded',
      ref: 'reference:subject/src/retry.js',
      line: 2,
      excerpt: 'requestWithBackoff()'
    }]
  }]));
  const verified = validateBacklogEvidence(cited.tasks, {
    references: evidenceFixture(), allowedReferences: ['subject'], requireEvidence: true
  });
  assert.equal(verified.ok, true, verified.errors.join('\n'));
});

// --- enqueue (P4.5) ---------------------------------------------------------

test('enqueue writes claimable tasks, with provenance and resolved dependsOn', () => {
  const backlog = tmpBacklog();
  const { tasks } = parseBacklogPlan(fenced(PLAN));
  const ids = enqueuePlan(backlog, tasks, { runId: 'run-1', nodeId: 'loop', budgetUsd: 2 });
  assert.equal(ids.length, 2);

  const first = backlog.get(ids[0]);
  assert.equal(first.status, 'queued', 'a supervisor can claim it');
  assert.equal(first.title, 'Add a retry to the fetcher');
  assert.equal(first.createdBy, 'flow');
  assert.equal(first.sourceRunId, 'run-1', 'P4.5: the task links back to the run that queued it');
  assert.equal(first.sourceNodeId, 'loop');
  assert.equal(first.budgetUsd, 2);
  assert.match(first.body, /## Goal/);
  assert.match(first.body, /## Done when/);

  // dependsOn named a TITLE in the plan; ids only exist after add().
  assert.deepEqual(backlog.get(ids[1]).dependsOn, [ids[0]]);
  // A run that read nothing attaches nothing.
  assert.deepEqual(first.references, []);
});

test('a task learned from another repository says which one', () => {
  // Without this the task names the READ repository's files as if they were
  // ours, and whoever claims it is standing here, where those paths do not
  // exist. Every agent then reports it impossible — correctly — and a sound
  // backlog parks. Watched exactly that: nine tasks about
  // `code_quality_manager.py` and `agent.py`, with a read-only clone containing
  // both sitting in the reference library the whole time, named by nothing.
  const backlog = tmpBacklog();
  const { tasks } = parseBacklogPlan(fenced(PLAN));
  const ids = enqueuePlan(backlog, tasks, {
    runId: 'run-1', nodeId: 'loop',
    references: [{ name: 'self_improving_coding_agent', commit: 'abc1234' }]
  });

  // The NAME is the useful half: `reference:<name>/<path>` opens a file in it
  // and `search_references` scopes to it.
  assert.deepEqual(backlog.get(ids[0]).references, ['self_improving_coding_agent']);
  // Survives the round trip through the file, like every other field.
  assert.deepEqual(new Backlog(backlog.rootDir).get(ids[0]).references, ['self_improving_coding_agent']);
  // A plain string is accepted too — callers should not have to know the shape
  // the runner happens to record.
  const b2 = tmpBacklog();
  const id2 = enqueuePlan(b2, tasks, { runId: 'r', nodeId: 'l', references: ['opencode'] })[0];
  assert.deepEqual(b2.get(id2).references, ['opencode']);
});

test('verified evidence is carried into the claimable task body', () => {
  const backlog = tmpBacklog();
  const task = {
    ...PLAN[0],
    evidence: [{
      claim: 'requests use backoff', ref: 'reference:subject/src/retry.js',
      line: 2, excerpt: 'requestWithBackoff()', commit: 'abc123456789'
    }]
  };
  const id = enqueuePlan(backlog, [task], {
    runId: 'run-evidence', nodeId: 'loop', references: ['subject']
  })[0];
  const queued = backlog.get(id);
  assert.match(queued.body, /## Reference evidence/);
  assert.match(queued.body, /reference:subject\/src\/retry\.js:2/);
  assert.match(queued.body, /abc123456789/);
  assert.match(queued.body, /requestWithBackoff/);
  assert.equal(queued.evidence, undefined, 'evidence prose does not become nested YAML frontmatter');
});

test('resolveDependsOn drops names that were never enqueued', () => {
  assert.deepEqual(resolveDependsOn({ dependsOn: ['a', 'ghost'] }, new Map([['a', 't-0001']])), ['t-0001']);
});

// --- the wait policy (B11) --------------------------------------------------

const tallyOf = statuses => tallyTasks(statuses.map((s, i) => ({ id: `t-${i}`, task: s ? { status: s } : null })));

test('a parked task keeps the node waiting and never fails it', () => {
  const t = tallyOf(['landed', 'parked']);
  assert.deepEqual(t.parked, ['t-1']);
  assert.equal(isSettled(t, 'all'), false,
    'D35 rule 7: a gate parks a task and never blocks the loop — the node surfaces it and waits');
  assert.equal(isSettled(tallyOf(['landed', 'failed']), 'all'), true, 'failed IS terminal');
});

test('waitFor: all | any | none', () => {
  assert.deepEqual(WAIT_POLICIES, ['all', 'any', 'none']);
  assert.equal(isSettled(tallyOf(['running', 'running']), 'none'), true, 'fire and forget');
  assert.equal(isSettled(tallyOf(['landed', 'running']), 'any'), true);
  assert.equal(isSettled(tallyOf(['running', 'running']), 'any'), false);
  assert.equal(isSettled(tallyOf(['landed', 'running']), 'all'), false);
});

test('a task deleted from the backlog counts as settled rather than hanging forever', () => {
  const t = tallyOf(['landed', null]);
  assert.deepEqual(t.missing, ['t-1']);
  assert.equal(isSettled(t, 'all'), true);
});

// --- the report + spend (P4.6) ----------------------------------------------

test('the report says what landed, what failed and what is waiting on you', () => {
  const tasks = [
    { id: 'a', task: { title: 'Landed one', status: 'landed' } },
    { id: 'b', task: { title: 'Failed one', status: 'failed' } },
    { id: 'c', task: { title: 'Parked one', status: 'parked', blockedReason: 'needs a key' } }
  ];
  const md = renderLoopReport({
    nodeTitle: 'Work it', taskIds: ['a', 'b', 'c'], tasks,
    tally: tallyTasks(tasks), waitFor: 'all', spend: { usd: 1.5, unknown: 2 }
  });
  assert.match(md, /# Work it — 3 task\(s\) queued/);
  assert.match(md, /## Landed \(1\)/);
  assert.match(md, /## Failed \(1\)/);
  assert.match(md, /## Waiting on you \(1\)/);
  assert.match(md, /needs a key/);
  assert.match(md, /\$1\.50/);
  assert.match(md, /2 call\(s\) the ledger could not price/, 'an unpriced call is a different fact from $0');
});

test('spend is read from the ledger per task, never counted by the node', () => {
  const ledger = { totals: ({ taskId }) => ({ usd: taskId === 'a' ? 1.25 : 0.75, unknown: taskId === 'a' ? 1 : 0 }) };
  assert.deepEqual(spendFor(ledger, ['a', 'b']), { usd: 2, unknown: 1 });
  assert.equal(spendFor(null, ['a']), null, 'no ledger means no number, not a zero');
});

// --- the persisted record (B12) ---------------------------------------------

test('the node state is a file, so a run that waits days survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-loopstate-'));
  assert.equal(readLoopState(dir, 'loop'), null);
  writeLoopState(dir, 'loop', { nodeId: 'loop', taskIds: ['t-0001'], waitFor: 'all' });
  assert.deepEqual(readLoopState(dir, 'loop').taskIds, ['t-0001']);
});

// --- end to end -------------------------------------------------------------

function chainFlow(loopData = {}) {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('plan', 'aiStep', { role: 'plan-backlog', title: 'Backlog plan' }),
     node('work', 'loop', { title: 'Work it', ...loopData }),
     node('out', 'output')],
    [edge('in', 'plan'), edge('plan', 'work'), edge('work', 'out')]);
}

// A runner whose loopHost is a real backlog plus a stub supervisor: the
// supervisor's own behaviour is D35's, tested there.
function runnerWith(store, backlog, { onStart = () => ({ started: true }), ledger = null } = {}) {
  const runner = new StackRunner(store, testConfig({ loop: { pollMs: 10 } }));
  Object.defineProperty(runner, 'loopHost', {
    get: () => ({ projectId: 'p', backlog, ledger, start: onStart, status: () => null }),
    configurable: true
  });
  return runner;
}

test('a flow hands its plan to the loop and closes when the tasks land', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));

  let started = 0;
  const runner = runnerWith(store, backlog, {
    onStart: () => {
      started += 1;
      // Stand in for the supervisor: land everything it was handed.
      for (const t of backlog.list()) backlog.update(t.id, { status: 'landed' });
      return { started: true, joined: false };
    }
  });
  const runId = runner.start(chainFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done', meta.error ?? '');
  assert.equal(meta.nodeStatus.work, 'done');
  assert.equal(started, 1, 'the node starts (or joins) exactly one supervisor');

  // The tasks are real, queued, and traceable back to this run.
  const tasks = backlog.list();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].sourceRunId, runId);

  const report = store.readNodeOutput(runId, 'work');
  assert.match(report, /## Landed \(2\)/);
  assert.match(store.readNodeOutput(runId, 'out'), /Landed/);

  // B12: the record on disk names exactly what it queued.
  const state = readLoopState(store.runDir(runId), 'work');
  assert.equal(state.taskIds.length, 2);
  assert.equal(state.waitFor, 'all');
});

test('waitFor: none is fire-and-forget — the run does not wait, and no supervisor is started', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));
  let started = 0;
  const runner = runnerWith(store, backlog, { onStart: () => { started += 1; return {}; } });
  const runId = runner.start(chainFlow({ waitFor: 'none' }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.equal(started, 0, 'nothing to wait for means nothing to start');
  assert.equal(backlog.list().length, 2, 'the work is still queued for whoever picks it up');
  assert.equal(backlog.list()[0].status, 'queued');
  assert.ok(store.readLog(runId).some(e => e.event === 'backlog_evidence_verified'
    && e.tasks === 2 && e.citations === 0),
  'a successful evidence gate is visible even when the plan has no external claims');
});

test('maxTasks caps what a plan can queue in one go', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));
  const runner = runnerWith(store, backlog);
  const runId = runner.start(chainFlow({ waitFor: 'none', maxTasks: 1 }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.equal(backlog.list().length, 1);
  assert.equal(readLoopState(store.runDir(runId), 'work').dropped, 1, 'and it says what it dropped');
});

test('a plan that violates the contract fails the node and enqueues nothing', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? 'I think we should improve things.' : 'ok'));
  const runner = runnerWith(store, backlog);
  const runId = runner.start(chainFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'failed');
  assert.equal(meta.nodeStatus.work, 'failed');
  assert.equal(backlog.list().length, 0, 'a bad plan must not half-queue');
  assert.match(store.readNodeOutput(runId, 'work.errors'), /Backlog contract violations/);
});

test('the loop rejects unverified reference evidence before enqueue', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  const ref = 'reference:subject/src/retry.js';
  const plan = [{
    ...PLAN[0], goal: `Port the backoff from ${ref}.`,
    evidence: [{ claim: 'uses backoff', ref, line: 2, excerpt: 'requestWithBackoff()' }]
  }];
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(plan) : 'ok'));
  const runner = runnerWith(store, backlog);
  runner.references = evidenceFixture();
  const runId = runner.start(chainFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'failed');
  assert.equal(backlog.list().length, 0);
  assert.match(store.readNodeOutput(runId, 'work.errors'), /Backlog evidence violations/);
  assert.match(store.readNodeOutput(runId, 'work.errors'), /not a reference repository recorded by this run/);
});

test('a parked task holds the node open and shows as awaiting input, then settles', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));
  const runner = runnerWith(store, backlog, {
    onStart: () => {
      // One lands, one parks: the node must keep waiting, not fail.
      const [a, b] = backlog.list();
      backlog.update(a.id, { status: 'landed' });
      backlog.update(b.id, { status: 'parked', blockedReason: 'needs a human' });
      return {};
    }
  });
  const runId = runner.start(chainFlow(), { userInput: 'brief' });

  // The node parks rather than finishing.
  await new Promise(r => setTimeout(r, 400));
  // `awaiting_approval` is the node status the canvas already draws as a gate;
  // the answering happens on the Loop page, where the task's context is.
  assert.equal(store.readMeta(runId).nodeStatus.work, 'awaiting_approval');
  assert.match(store.readNodeOutput(runId, 'work'), /Waiting on you \(1\)/,
    'the node says what it is waiting for while it waits, not only at the end');
  assert.match(store.readNodeOutput(runId, 'work'), /needs a human/);

  // A human answers it on the Loop page; the supervisor lands it.
  const parked = backlog.list().find(t => t.status === 'parked');
  backlog.update(parked.id, { status: 'landed' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(store.readNodeOutput(runId, 'work'), /## Landed \(2\)/);
});

test('a failed task is reported, not fatal — three landed and one failed is a result', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));
  const runner = runnerWith(store, backlog, {
    onStart: () => {
      const [a, b] = backlog.list();
      backlog.update(a.id, { status: 'landed' });
      backlog.update(b.id, { status: 'failed' });
      return {};
    }
  });
  const runId = runner.start(chainFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done', 'the run completes');
  assert.equal(store.readRetrospectives(runId).work.status, 'partial');
  assert.match(store.readNodeOutput(runId, 'work'), /## Failed \(1\)/);
});

test('a loop node with no backlog to enqueue into fails honestly', async () => {
  const store = makeStore();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));
  const runner = new StackRunner(store, testConfig({ loop: { pollMs: 10 } }));
  const runId = runner.start(chainFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'failed');
  assert.match(store.readRetrospectives(runId).work.recommendation, /no backlog/);
});

test('reattach after a restart re-reads the backlog rather than re-enqueueing (P4.3)', async () => {
  const store = makeStore();
  const backlog = tmpBacklog();
  setScript(({ system }) => (roleOf(system) === 'plan-backlog' ? fenced(PLAN) : 'ok'));

  // Process one: enqueue, then sit waiting on tasks that never settle.
  const first = runnerWith(store, backlog, { onStart: () => ({}) });
  const runId = first.start(chainFlow(), { userInput: 'brief' });
  await waitFor(() => readLoopState(store.runDir(runId), 'work'), { label: 'the loop state file' });
  const queued = readLoopState(store.runDir(runId), 'work').taskIds;
  assert.equal(queued.length, 2);

  // Simulate the app dying mid-wait. stop() is only how this test frees the
  // poll timer — the meta it leaves behind is then rewritten to exactly what a
  // crash leaves: a non-terminal stage with nothing live.
  first.stop(runId);
  await waitFor(() => !first.live.has(runId), { label: 'the walk to unwind' });
  store.writeMeta(runId, {
    ...store.readMeta(runId), stage: 'execution', error: null, interrupted: false,
    nodeStatus: { ...store.readMeta(runId).nodeStatus, work: 'active' }
  });

  // Meanwhile the supervisor landed the work.
  for (const t of backlog.list()) backlog.update(t.id, { status: 'landed' });

  // Process two: the project opens, the run is flagged interrupted, the user
  // resumes. Nothing is re-enqueued and nothing is re-run — the node reads its
  // own file and then the backlog.
  const second = runnerWith(store, backlog, { onStart: () => ({}) });
  assert.ok(second.reconcileInterrupted().includes(runId), 'a run cut off mid-wait is resumable');
  second.resume(runId);
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.equal(backlog.list().length, 2, 'the plan was not queued twice');
  assert.deepEqual(readLoopState(store.runDir(runId), 'work').taskIds, queued);
  assert.match(store.readNodeOutput(runId, 'work'), /## Landed \(2\)/);
});
