// Diagnostics (D40): the three questions a failing run raises, answered from
// what the run already wrote down.
//
// The occasion was a fan-out that failed four evenings running, every time on
// the same sentence — "<model> returned an empty response" — which names the
// one fact the reader already had. These tests pin the part that matters: that
// the report points at a NEXT STEP, and that it never invents one when the
// evidence is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explainRun, probeModel, modelsInFlow, staleIndexLock } from '../core/diagnostics.js';
import { registerProvider } from '../core/adapters/index.js';
import { makeStore } from './helpers.js';

// A run built by hand, so the report is tested against known evidence rather
// than against whatever a live model happened to do.
function seedRun(store, { meta = {}, log = [], calls = {} } = {}) {
  const runId = store.createRun('a prompt');
  store.writeMeta(runId, { ...store.readMeta(runId), ...meta });
  for (const entry of log) store.appendLog(runId, entry);
  for (const [node, records] of Object.entries(calls)) {
    for (const r of records) store.writeCallTrace(runId, node, r);
  }
  return runId;
}

test('a truncated node is diagnosed as a budget problem, with the budget named', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', flowName: 'Learn from a repo', error: 'Node read failed', nodeStatus: { read: 'failed' } },
    log: [{ event: 'node_start', node: 'read', role: 'analyze', worker: { provider: 'openrouter', model: 'deepseek/x' } },
      { event: 'node_error', node: 'read', role: 'analyze', error: 'openrouter/deepseek/x returned no content' }],
    calls: {
      read: [{ ok: true, provider: 'openrouter', model: 'deepseek/x', maxTokens: 4096, finishReason: 'length', contentChars: 0, reasoningChars: 18503, ms: 69000 }]
    }
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'failed');
  const node = r.nodes.find(n => n.node === 'read');
  assert.equal(node.calls.truncated, 1);
  assert.equal(node.calls.reasoningShare, 100);
  assert.ok(r.suggestions.some(s => /finish_reason "length"/.test(s) && /4096/.test(s)),
    'the suggestion must name the budget that was hit');
});

test('rate limiting is called rate limiting, not a model problem', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', nodeStatus: { step: 'failed' } },
    log: [
      { event: 'node_start', node: 'step', role: 'execute' },
      ...Array.from({ length: 4 }, () => ({ event: 'model_retry', node: 'step', attempt: 1, error: 'OpenRouter API 429' })),
      { event: 'node_error', node: 'step', error: 'OpenRouter API 429: rate limited' }
    ],
    calls: { step: [{ ok: false, provider: 'openrouter', model: 'm', error: 'OpenRouter API 429', ms: 900 }] }
  });

  const r = explainRun(store, runId);
  assert.ok(r.suggestions.some(s => /transient retries/.test(s) && /throttling/.test(s)));
});

// The failure mode a diagnostic tool must not have: confident nonsense about a
// run whose evidence was never recorded. Every run made before the black box
// existed is in this state, and reading "no trace" as "no calls" would tell the
// reader to go looking upstream of a provider that was in fact called.
test('a run with no call trace says so instead of guessing', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', nodeStatus: { step: 'failed' } },
    log: [{ event: 'node_start', node: 'step' },
      { event: 'node_error', node: 'step', error: 'openrouter/m returned an empty response' }]
  });

  const r = explainRun(store, runId);
  const node = r.nodes.find(n => n.node === 'step');
  assert.equal(node.traced, false);
  assert.ok(r.suggestions.some(s => /predates the model-call black box/.test(s)));
  assert.ok(!r.suggestions.some(s => /failed before any model call was made/.test(s)),
    'must not claim no call was made when it only means no record was kept');
});

// A node mid-agent-loop legitimately produces turns with no prose in them. The
// share is computed over ANSWERING turns only, so a healthy run being watched
// does not report itself as pathological.
test('tool-calling turns do not count as "all reasoning, no answer"', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'execution', nodeStatus: { orient: 'active' } },
    log: [{ event: 'node_start', node: 'orient', role: 'orient' }],
    calls: {
      orient: Array.from({ length: 5 }, () => ({
        ok: true, provider: 'openrouter', model: 'm', finishReason: 'tool_calls',
        contentChars: 0, reasoningChars: 1500, ms: 6000
      }))
    }
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'still running');
  const node = r.nodes.find(n => n.node === 'orient');
  assert.equal(node.calls.reasoningShare, null, 'no answering turn yet — no share to report');
  assert.deepEqual(r.suggestions, [], 'a healthy loop mid-flight has nothing to suggest');
});

// The command exists to be usable on the run you are staring at, which is the
// one still going. meta.nodeStatus lags behind a node deep in an agent loop, so
// the in-flight view is derived from the log.
test('a live run reports which node is in flight and for how long', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'execution', nodeStatus: { input: 'done', read: 'pending' } },
    log: [
      { event: 'node_start', node: 'input' },
      { event: 'node_start', node: 'read', role: 'analyze' }
    ]
  });

  const r = explainRun(store, runId);
  const read = r.nodes.find(n => n.node === 'read');
  assert.ok(read.inFlight);
  assert.ok(read.runningForMs >= 0);
  // The input node is done in meta, so it must not be reported as running
  // merely because it emitted no terminal event of its own.
  assert.ok(!r.nodes.some(n => n.node === 'input'));
});

test('cost and call counts are summed across every round of every agent loop', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'done', nodeStatus: {} },
    log: [
      { event: 'model_call', node: 'a', ms: 1000, usage: { cost: 0.01 } },
      { event: 'model_call', node: 'a', ms: 2000, usage: { cost: 0.02 } },
      { event: 'model_call', node: 'b', ms: 500, usage: { cost: 0.005 } },
      { event: 'tool_call', node: 'a', tool: 'read_file' }
    ]
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'completed');
  assert.equal(r.signals.modelCalls, 3);
  assert.equal(r.signals.modelMs, 3500);
  assert.equal(r.signals.usd, 0.035);
});

test('the report names which tools were called, and how many of them failed', () => {
  // "64 tool call(s)" is a number nobody can act on. Watching a live attempt,
  // the useful fact was the shape: seventeen bash, fifteen read_file, ten glob
  // and four writes — an attempt that spent its budget on discovery, which is
  // what every expensive run that changed nothing looks like from outside.
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'done', nodeStatus: {} },
    log: [
      { event: 'tool_call', node: 'a', tool: 'read_file' },
      { event: 'tool_call', node: 'a', tool: 'read_file' },
      { event: 'tool_call', node: 'a', tool: 'read_file' },
      { event: 'tool_call', node: 'a', tool: 'bash', ok: false, error: 'exit 1' },
      { event: 'tool_call', node: 'a', tool: 'bash' },
      { event: 'tool_call', node: 'a', tool: 'edit_file' }
    ]
  });

  const r = explainRun(store, runId);
  assert.deepEqual(r.signals.tools, [
    { name: 'read_file', calls: 3, failed: 0 },
    { name: 'bash', calls: 2, failed: 1 },
    { name: 'edit_file', calls: 1, failed: 0 }
  ], 'most-used first, so the shape of the attempt is the first thing read');
  assert.equal(r.signals.toolCalls, 6, 'and the total still agrees with the parts');
});

test('a run that called no tools reports none rather than nothing', () => {
  const store = makeStore();
  const runId = seedRun(store, { meta: { stage: 'done', nodeStatus: {} }, log: [] });
  assert.deepEqual(explainRun(store, runId).signals.tools, []);
});

// --- probeModel -----------------------------------------------------------

registerProvider('probe-empty', async () => ({
  text: '', reasoning: 'x'.repeat(4000), finishReason: 'length',
  usage: { completion_tokens_details: { reasoning_tokens: 1024 } }
}));
registerProvider('probe-good', async () => ({
  text: 'A real answer.', reasoning: '', finishReason: 'stop', usage: {}
}));
registerProvider('probe-broken', async () => { throw new Error('OpenRouter API 401: bad key'); });

// The verdict is the product. "It returned nothing" was already known; what was
// missing is whether that is the model, the budget, or the configuration.
test('probeModel tells a starved reasoning model apart from a broken one', async () => {
  const starved = await probeModel({ provider: 'probe-empty', model: 'm' }, { maxTokens: 4096, stream: false });
  assert.equal(starved.ok, false);
  assert.equal(starved.reasons, true);
  assert.match(starved.verdict, /reasoning only at max_tokens 4096/);

  const broken = await probeModel({ provider: 'probe-broken', model: 'm' }, { stream: false });
  assert.equal(broken.ok, false);
  assert.match(broken.verdict, /unreachable/);
  assert.match(broken.error, /401/);

  const good = await probeModel({ provider: 'probe-good', model: 'm' }, { stream: false });
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'usable');
  assert.equal(good.reasons, false);
});

// --- modelsInFlow ---------------------------------------------------------

// doctor checks the models a flow actually pins, including the ones only a
// fan-out lane names — those are exactly the ones that had never been checked.
test('modelsInFlow finds lane workers, not just node workers', () => {
  const flow = {
    nodes: [
      { id: 'a', data: { worker: { provider: 'auto', model: 'deepseek/x' } } },
      {
        id: 'read',
        data: {
          worker: { provider: 'auto', model: 'deepseek/x' },
          lanes: [{ id: 'l1', worker: { model: 'moonshotai/k' } }, { id: 'l2', worker: { model: 'other/z' } }]
        }
      },
      { id: 'out', data: {} }
    ]
  };
  assert.deepEqual(modelsInFlow(flow).sort(), ['deepseek/x', 'moonshotai/k', 'other/z']);
});

// --- a run parked on a question -------------------------------------------
//
// `flyt why` is the command for "why did this stall". On a run parked at the
// input gate it used to print the stage and the call stats and nothing else —
// telling the person who ran it exactly what they already knew, and not the one
// thing that would unstick it: the question, and that they are the answer.

test('explain names the question, who asked it, and that nothing is running', () => {
  const store = makeStore();
  const runId = store.createRun('an idea worth interrogating');
  store.writeFlow(runId, {
    id: 'f', name: 'F',
    nodes: [{ id: 'ask', type: 'aiStep', data: { role: 'interrogate', title: 'What are we actually building?' } }],
    edges: []
  });
  store.setStage(runId, 'awaiting_input', {
    pendingNodeId: 'ask',
    pendingGateKind: 'input',
    pendingQuestions: [
      { id: 'shape', text: 'Node or flow?', why: 'changes the whole build', options: ['a node', 'a flow'] },
      { id: 'scope', text: 'Who consumes the spec?' }
    ]
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'waiting for your answer', 'not "still running" — nothing is');
  assert.equal(r.asking.node, 'ask');
  assert.equal(r.asking.title, 'What are we actually building?', 'the title, not the node id');
  assert.deepEqual(r.asking.questions.map(q => q.text), ['Node or flow?', 'Who consumes the spec?']);
  assert.deepEqual(r.asking.questions[0].options, ['a node', 'a flow']);
});

test('a run that is not parked carries no question block', () => {
  const store = makeStore();
  const runId = store.createRun('an ordinary run');
  store.setStage(runId, 'done');
  assert.equal(explainRun(store, runId).asking, undefined);
});

// --- a run parked on an approval gate ---------------------------------------
//
// awaiting_approval parks for three different reasons (flowRunner's
// pendingGateKind), and every one of them used to render as bare stage +
// call stats: not which node was waiting, not why, and not the command that
// releases it — which is the only thing the person running `flyt why` needs.
// The report carries the gate as data (`r.gate`), so the HTTP API and the
// desktop app read exactly what the CLI renders.

test('a pre gate names the node waiting at the checkpoint', () => {
  const store = makeStore();
  const runId = store.createRun('a run someone must wave through');
  store.writeFlow(runId, {
    id: 'f', name: 'F',
    nodes: [{ id: 'deploy', type: 'agentTask', data: { title: 'Deploy to production' } }],
    edges: []
  });
  store.setStage(runId, 'awaiting_approval', { pendingNodeId: 'deploy', pendingGateKind: 'pre' });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'waiting for your decision', 'not "still running" — nothing is');
  assert.equal(r.gate.kind, 'pre');
  assert.equal(r.gate.node, 'deploy');
  assert.equal(r.gate.title, 'Deploy to production', 'the title, not the node id');
  assert.match(r.gate.meaning, /checkpoint/);
});

test('a tool gate says what the call wanted and why it stopped', () => {
  const store = makeStore();
  const runId = store.createRun('a run held at the tool ceiling');
  store.writeFlow(runId, {
    id: 'f', name: 'F',
    nodes: [{ id: 'work', type: 'aiStep', data: { title: 'Do the work' } }],
    edges: []
  });
  store.setStage(runId, 'awaiting_approval', {
    pendingNodeId: 'work',
    pendingGateKind: 'tool',
    pendingToolCall: {
      tool: 'bash', summary: 'rm -rf ./build', risk: 'high',
      reason: 'approvalMode is "ask" and bash is a shell command',
      checkedBy: 'screen'
    }
  });

  const g = explainRun(store, runId).gate;
  assert.equal(g.kind, 'tool');
  assert.equal(g.tool, 'bash');
  assert.equal(g.summary, 'rm -rf ./build');
  assert.equal(g.risk, 'high');
  assert.match(g.reason, /approvalMode/);
  assert.equal(g.checkedBy, 'screen');
});

test('an escalation quotes the reason the evaluator escalated', () => {
  const store = makeStore();
  const runId = store.createRun('a run whose eval wants a human');
  store.setStage(runId, 'awaiting_approval', { pendingNodeId: 'eval-1', pendingGateKind: 'escalation' });
  // The reason lives in the log, not in meta: step_eval_escalate /
  // feedback_review_escalate are where the runner writes it.
  store.appendLog(runId, { event: 'step_eval_escalate', node: 'eval-1', reason: 'three retries still fail lint' });

  const g = explainRun(store, runId).gate;
  assert.equal(g.kind, 'escalation');
  assert.match(g.reason, /three retries still fail lint/, 'the reason is worth quoting and must survive');
});

test('a run that is not parked carries no approval-gate block', () => {
  const store = makeStore();
  const runId = store.createRun('another ordinary run');
  store.setStage(runId, 'done');
  assert.equal(explainRun(store, runId).gate, undefined);
});

// An agentTask's calls are traced under `executor:<taskId>`, and nothing in the
// log ties that name back to the flow node that spawned it — the executor path
// logs `task_claimed`, not `node_start`. So a report built only from flow-node
// ids explained the input node and had nothing to say about the one that made
// every model call and every tool call in the run: `flyt why` reported "0 model
// call(s)" on a run that had just billed forty of them, and then advised
// re-running it because the evidence supposedly predated the black box.
test('an executor task\'s calls are counted, attributed and explained', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: {
      stage: 'failed', flowName: 'Work one backlog task',
      error: 'Task task-1 failed: required workspace change was not produced',
      nodeStatus: { work: 'failed' }
    },
    log: [
      { event: 'task_claimed', task: 'task-1', node: 'executor:task-1' },
      { event: 'node_error', node: 'work', error: 'required workspace change was not produced' },
      { event: 'tool_call', node: 'executor:task-1', tool: 'read_file', ok: true },
      { event: 'tool_call', node: 'executor:task-1', tool: 'bash', ok: true }
    ],
    calls: {
      'executor:task-1': [
        { ok: true, provider: 'openrouter', model: 'deepseek/x', finishReason: 'tool_calls', ms: 1200, usage: { cost: 0.01 } },
        { ok: true, provider: 'openrouter', model: 'deepseek/x', finishReason: 'stop', contentChars: 400, ms: 800, usage: { cost: 0.02 } }
      ]
    }
  });

  const r = explainRun(store, runId);
  assert.equal(r.signals.modelCalls, 2, 'the run made calls and the report has to say so');
  assert.equal(r.signals.usd, 0.03);

  const executor = r.nodes.find(n => /task-1/.test(n.node));
  assert.ok(executor, 'the name that made the calls belongs in the report');
  assert.equal(executor.calls.total, 2);
  assert.equal(executor.calls.toolCalls, 2, 'the trace file flattens the colon; the log does not');

  const work = r.nodes.find(n => n.node === 'work');
  assert.equal(work.traced, true, 'this run has a black box — it just files under another name');
  assert.ok(r.suggestions.some(s => /executor/.test(s)),
    'pointing at the executor entry beats telling someone to re-run a run whose evidence is on disk');
  assert.ok(!r.suggestions.some(s => /predates the model-call black box/.test(s)));
});

// --- a stale index.lock (HT-05) --------------------------------------------

test('an empty, old index.lock is reported with the command to clear it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-lock-'));
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');

    const now = Date.now() + 10 * 60 * 1000;   // ten minutes later
    const finding = staleIndexLock(root, { now });
    assert.equal(finding.level, 'warn');
    assert.match(finding.message, /empty for 10 minute\(s\)/);
    assert.match(finding.message, /every git write in this repository fails/);
    assert.match(finding.message, /rm "/, 'and says exactly what to do');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a fresh lock, a lock with content, and no lock at all are not reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-lock-'));
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    assert.equal(staleIndexLock(root), null, 'no lock');

    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    assert.equal(staleIndexLock(root), null, 'a git that started a second ago is not stale');

    // A git mid-write has put the new index INTO the lock.
    fs.writeFileSync(lock, 'DIRC…the new index…');
    assert.equal(staleIndexLock(root, { now: Date.now() + 60 * 60 * 1000 }), null,
      'somebody is writing; that is not ours to judge');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reporting a lock never removes it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-lock-'));
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    staleIndexLock(root, { now: Date.now() + 10 * 60 * 1000 });
    assert.ok(fs.existsSync(lock), 'deleting another process lock is how a real write gets corrupted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a path that is not a repository is not a finding', () => {
  assert.equal(staleIndexLock(null), null);
  assert.equal(staleIndexLock(path.join(os.tmpdir(), 'flyt-not-a-repo-at-all')), null);
});
