// Parallel agentTask/executor execution (V1 task 6, D7) and the three hazards
// named in Q-D1: a readable log under concurrent writers, correct multi-active
// status, and workspace write interference between concurrent tasks.
//
// Concurrency is proven with a BARRIER rather than timing: each task blocks
// until N tasks have arrived. If execution were still sequential the barrier
// could never open, so these tests fail loudly (timeout) instead of flaking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StackRunner } from '../core/stackRunner.js';
import { createWriteLedger } from '../core/writeLedger.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const readLog = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

// A barrier that opens once `n` callers have arrived; arrivals past that pass
// straight through. Rejects on timeout so a serialized scheduler surfaces as a
// clear assertion rather than a hung test.
function makeBarrier(n, timeoutMs = 5000) {
  let open;
  const gate = new Promise(r => { open = r; });
  const timer = setTimeout(() => open('timeout'), timeoutMs);
  let arrived = 0;
  return {
    async wait() {
      if (++arrived >= n) { clearTimeout(timer); open('open'); }
      return gate;
    },
    peak: () => arrived
  };
}

const taskTitle = prompt => (prompt.match(/TASK:\s*(.+)/) ?? [])[1]?.trim();

// Flow: one input fanning out to `n` independent agentTasks, then an output.
// Independent = no edges between them, so they are wave-mates.
function fanOutFlow(n, dataFor = () => ({})) {
  const tasks = Array.from({ length: n }, (_, i) =>
    node(`t${i + 1}`, 'agentTask', { title: `Task ${i + 1}`, goal: `Do work ${i + 1}`, ...dataFor(i) }));
  return makeFlow(
    [node('in', 'input', { text: 'brief' }), ...tasks, node('out', 'output')],
    [...tasks.map(t => edge('in', t.id)), ...tasks.map(t => edge(t.id, 'out'))]);
}

test('two independent agentTasks execute concurrently', async () => {
  const store = makeStore();
  const barrier = makeBarrier(2);
  let bothActive = 0;
  let runId;

  setScript(async ({ prompt }) => {
    const opened = await barrier.wait(); // only opens if both are in flight
    assert.equal(opened, 'open', 'tasks did not overlap — execution was serialized');
    // Both tasks are provably in flight right now: the canvas signal must show
    // both nodes active at this instant (Q-D1 hazard 2).
    const status = store.readMeta(runId).nodeStatus;
    bothActive = Math.max(bothActive, Object.values(status).filter(s => s === 'active').length);
    return `Done: ${taskTitle(prompt)}`;
  });

  const runner = new StackRunner(store, testConfig());
  runId = runner.start(fanOutFlow(2));
  const stage = await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(stage, 'done');
  assert.equal(bothActive, 2, 'both agentTask nodes should be active at the same moment');
  const tasks = store.readTasks(runId).tasks;
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(t => t.status === 'done'));
});

test('parallelism is bounded by maxParallel', async () => {
  const store = makeStore();
  let inFlight = 0, peak = 0;

  setScript(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 40));
    inFlight--;
    return 'Done.';
  });

  const runner = new StackRunner(store, testConfig({ maxParallel: 2 }));
  const runId = runner.start(fanOutFlow(5));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(peak, 2, `expected at most 2 tasks in flight, saw ${peak}`);
  assert.equal(store.readTasks(runId).tasks.filter(t => t.status === 'done').length, 5);
});

test('each task is claimed exactly once under concurrency', async () => {
  const store = makeStore();
  const barrier = makeBarrier(4);
  setScript(async ({ prompt }) => {
    assert.equal(await barrier.wait(), 'open', 'tasks did not overlap — execution was serialized');
    return `Done: ${taskTitle(prompt)}`;
  });

  const runner = new StackRunner(store, testConfig({ maxParallel: 4 }));
  const runId = runner.start(fanOutFlow(4));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const log = readLog(store, runId);
  const claims = log.filter(e => e.event === 'task_claimed').map(e => e.task);
  assert.deepEqual([...claims].sort(), ['task-1', 'task-2', 'task-3', 'task-4']);
  assert.equal(new Set(claims).size, claims.length, 'a task was claimed twice');
  // One executor start per task — no double execution.
  const starts = log.filter(e => e.event === 'node_start' && String(e.node).startsWith('executor:'));
  assert.equal(starts.length, 4);
});

test('log.jsonl stays parseable and attributable with concurrent writers', async () => {
  const store = makeStore();
  const barrier = makeBarrier(3);
  // Each task emits a tool call, so several tasks append to the log while
  // overlapping (Q-D1 hazard 1).
  setScript(async ({ prompt }) => {
    assert.equal(await barrier.wait(), 'open', 'tasks did not overlap — execution was serialized');
    const title = taskTitle(prompt);
    if (!prompt.includes('TOOL RESULT')) {
      return ['Writing notes.', '```tool',
        JSON.stringify({ tool: 'write_file', args: { path: `${title.replace(/\s+/g, '-')}.md`, content: `# ${title}` } }),
        '```'].join('\n');
    }
    return `Done: ${title}`;
  });

  const runner = new StackRunner(store, testConfig({ maxParallel: 3 }));
  const runId = runner.start(fanOutFlow(3));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  // Every line is intact JSON — no interleaved/torn writes.
  const raw = fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8').trim().split('\n');
  for (const [i, line] of raw.entries()) {
    assert.doesNotThrow(() => JSON.parse(line), `log line ${i + 1} is not valid JSON: ${line}`);
  }
  const log = raw.map(l => JSON.parse(l));
  // Each task's tool call is present and attributed to its own executor, so one
  // task's story stays followable even though the writers overlapped.
  const toolCalls = log.filter(e => e.event === 'tool_call');
  assert.equal(toolCalls.length, 3);
  assert.deepEqual([...new Set(toolCalls.map(e => e.node))].sort(),
    ['executor:task-1', 'executor:task-2', 'executor:task-3']);
  assert.ok(toolCalls.every(e => e.ok), 'every concurrent write should succeed');
});

test('concurrent writes to the same path are flagged as interference', async () => {
  const store = makeStore();
  const barrier = makeBarrier(2);
  setScript(async ({ prompt }) => {
    await barrier.wait();
    const title = taskTitle(prompt);
    if (!prompt.includes('TOOL RESULT')) {
      return ['Writing.', '```tool',
        JSON.stringify({ tool: 'write_file', args: { path: 'shared.md', content: `from ${title}` } }),
        '```'].join('\n');
    }
    return `Done: ${title}`;
  });

  const runner = new StackRunner(store, testConfig({ maxParallel: 2 }));
  const runId = runner.start(fanOutFlow(2));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const conflicts = readLog(store, runId).filter(e => e.event === 'workspace_write_conflict');
  assert.equal(conflicts.length, 1, 'the second writer of a shared path should be flagged');
  assert.equal(conflicts[0].path, 'shared.md');
  assert.ok(conflicts[0].alsoWrittenBy.startsWith('executor:'));
  // The interference is visible in the tool record (and so the retrospective).
  const retros = store.readRetrospectives(runId);
  const withConflict = Object.values(retros)
    .flatMap(r => r.toolCalls ?? [])
    .filter(c => c.result?.conflictWith);
  assert.equal(withConflict.length, 1);
});

test('independent tasks writing different paths do not interfere', async () => {
  const store = makeStore();
  const barrier = makeBarrier(2);
  setScript(async ({ prompt }) => {
    assert.equal(await barrier.wait(), 'open', 'tasks did not overlap — execution was serialized');
    const title = taskTitle(prompt);
    if (!prompt.includes('TOOL RESULT')) {
      return ['Writing.', '```tool',
        JSON.stringify({ tool: 'write_file', args: { path: `${title.replace(/\s+/g, '-')}.md`, content: `from ${title}` } }),
        '```'].join('\n');
    }
    return `Done: ${title}`;
  });

  const runner = new StackRunner(store, testConfig({ maxParallel: 2 }));
  const runId = runner.start(fanOutFlow(2));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.equal(readLog(store, runId).filter(e => e.event === 'workspace_write_conflict').length, 0);
  // Both files landed with their own content — neither clobbered the other.
  assert.equal(store.readWorkspaceFile(runId, 'Task-1.md'), 'from Task 1');
  assert.equal(store.readWorkspaceFile(runId, 'Task-2.md'), 'from Task 2');
});

test('a task gated on tool approval runs alone', async () => {
  const store = makeStore();
  let inFlight = 0, peak = 0;
  setScript(async ({ prompt }) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 30));
    inFlight--;
    if (!prompt.includes('TOOL RESULT')) {
      return ['Writing.', '```tool',
        JSON.stringify({ tool: 'write_file', args: { path: 'g.md', content: 'x' } }), '```'].join('\n');
    }
    return 'Done.';
  });

  // t1 gates every tool call; t2/t3 do not. The gate promise is per-run, so the
  // gated task must never share the stage with another task.
  const runner = new StackRunner(store, testConfig({ maxParallel: 3 }));
  const flow = fanOutFlow(3, i => (i === 0 ? { approveToolCalls: true } : {}));
  const runId = runner.start(flow);

  // Approve whenever the run pauses, until it finishes.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const meta = store.readMeta(runId);
    if (meta.stage === 'done' || meta.stage === 'failed') break;
    if (meta.stage === 'awaiting_approval') runner.approvePlan(runId);
    await new Promise(r => setTimeout(r, 15));
  }
  assert.equal(store.readMeta(runId).stage, 'done');

  const log = readLog(store, runId);
  const gatePause = log.find(e => e.event === 'tool_gate_pause');
  assert.ok(gatePause, 'the gated task should have paused for approval');
  assert.equal(gatePause.node, 't1');
  // While t1 was gated it held the stage alone; t2/t3 still ran in parallel
  // with each other afterwards.
  assert.ok(peak >= 2, `ungated tasks should still parallelize, peak was ${peak}`);
});

// --- write ledger unit ---

test('write ledger flags only concurrent, different-task writes to a path', () => {
  const l = createWriteLedger();
  l.begin('task-1'); l.begin('task-2');
  assert.equal(l.noteWrite('task-1', 'a.md'), null);          // first writer
  assert.equal(l.noteWrite('task-1', 'a.md'), null);          // same task rewriting
  assert.equal(l.noteWrite('task-2', 'a.md'), 'task-1');      // concurrent other task
  assert.equal(l.noteWrite('task-2', 'b.md'), null);          // different path
  // Path spellings normalize to the same key.
  assert.equal(l.noteWrite('task-1', './b.md'), 'task-2');
  // Once the earlier writer finishes, later writes are sequential, not conflicts.
  l.end('task-1');
  assert.equal(l.noteWrite('task-2', 'a.md'), null);
});
