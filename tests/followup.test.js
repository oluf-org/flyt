// Follow-up turns (DECISIONS.md D21): replying to a finished run appends a
// continuation subgraph to its flow and the normal walk executes it. Completed
// nodes are never re-run (FU1); the feedback is a visible input node (FU4);
// every turn is closed by a feedback-review node (FU6); failed runs are
// re-openable with the failure path retired (FU7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const goalOf = prompt => (prompt.match(/GOAL:\n(.+)/) ?? [])[1]?.trim();
const json = obj => '```json\n' + JSON.stringify(obj, null, 2) + '\n```';

function simpleFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'build the thing' }),
      node('a', 'aiStep', { goal: 'A', title: 'Step A' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]);
}

const FIX_TRIAGE = {
  class: 'fix',
  reason: 'small correction to the produced output',
  contextNodes: ['a'],
  nodes: [{
    id: 'patch', template: 'code-general-step', category: 'Code general',
    title: 'Patch it', goal: 'PATCH'
  }]
};

const SOLVED = 'Review done.\n' + json({ verdict: 'solved', reason: 'feedback addressed' });

// Runs simpleFlow to completion under a script that answers work nodes with
// `output <GOAL>` and routes triage / feedback-review through `handlers`.
async function finishedRun(store, handlers = {}) {
  setScript(async ({ system, prompt }) => {
    const role = roleOf(system);
    if (handlers[role]) return handlers[role]({ system, prompt });
    return `output ${goalOf(prompt) ?? 'x'}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(simpleFlow());
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  return { runner, runId };
}

const turnFinished = (store, runId, reviewId = 'fu1-review') =>
  waitFor(() => store.readMeta(runId).stage === 'done'
    && store.readNodeOutput(runId, reviewId) != null, { label: 'turn finished' });

test('fix-class follow-up extends the graph and re-walks only the new nodes', async () => {
  const store = makeStore();
  const calls = [];
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => json(FIX_TRIAGE),
    'feedback-review': () => SOLVED
  });
  setScript(async ({ system, prompt }) => {
    const role = roleOf(system);
    if (role === 'followup-triage') { calls.push(role); return json(FIX_TRIAGE); }
    if (role === 'feedback-review') { calls.push(role); return SOLVED; }
    calls.push(goalOf(prompt) ?? role);
    return `output ${goalOf(prompt) ?? 'x'}`;
  });

  const { turn } = runner.followUp(runId, 'please fix the header');
  assert.equal(turn, 1);
  await turnFinished(store, runId);

  // FU8: the pre-turn snapshot + the turn's files exist.
  const fuDir = path.join(store.runDir(runId), 'followups', '1');
  assert.ok(fs.existsSync(path.join(fuDir, 'prompt.md')));
  assert.ok(fs.existsSync(path.join(fuDir, 'triage.json')));
  assert.ok(fs.existsSync(path.join(fuDir, 'before', 'flow.json')));
  assert.ok(fs.existsSync(path.join(fuDir, 'before', 'meta.json')));

  // FU4/FU5: the feedback is an input node on the canvas, nodes are fu1-
  // namespaced with provenance, and the review closes the turn.
  const flow = store.readFlow(runId);
  const ids = flow.nodes.map(n => n.id);
  assert.ok(ids.includes('fu1-input') && ids.includes('fu1-patch') && ids.includes('fu1-review'));
  const patch = flow.nodes.find(n => n.id === 'fu1-patch');
  assert.equal(patch.data.origin, 'followup');
  assert.equal(patch.data.turn, 1);
  assert.equal(flow.nodes.find(n => n.id === 'fu1-input').data.text, 'please fix the header');

  // FU1: context reached the new node via an edge from the selected done node.
  assert.ok(flow.edges.some(e => e.source === 'a' && e.target === 'fu1-patch'));
  assert.ok(flow.edges.some(e => e.source === 'fu1-patch' && e.target === 'fu1-review'));
  assert.ok(flow.edges.some(e => e.source === 'fu1-input' && e.target === 'fu1-review'));

  // Only the new work ran: A was not re-executed in the turn.
  assert.deepEqual(calls, ['followup-triage', 'PATCH', 'feedback-review']);
  assert.equal(store.readMeta(runId).turn, 1);
  assert.equal(store.readMeta(runId).nodeStatus['fu1-patch'], 'done');
  assert.ok(store.readNodeOutput(runId, 'fu1-patch').includes('output PATCH'));
});

test('question-class follow-up answers without touching the graph', async () => {
  const store = makeStore();
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => json({ class: 'question', reason: 'asks about the result', answer: 'It works like this.' })
  });
  const before = store.readFlow(runId).nodes.length;

  runner.followUp(runId, 'how does it work?');
  await waitFor(() => fs.existsSync(path.join(store.runDir(runId), 'followups', '1', 'answer.md')),
    { label: 'answer written' });
  await waitFor(() => store.readMeta(runId).stage === 'done', { label: 'stage restored' });

  assert.equal(fs.readFileSync(path.join(store.runDir(runId), 'followups', '1', 'answer.md'), 'utf8'),
    'It works like this.');
  assert.equal(store.readFlow(runId).nodes.length, before, 'no nodes were added');
});

test('feedback-review more-work materializes bounded extensions, then solves', async () => {
  const store = makeStore();
  let reviews = 0;
  const moreWork = json({
    verdict: 'more-work', reason: 'one more piece needed',
    nodes: [{ id: 'extra', template: 'code-general-step', category: 'Code general', title: 'Extra', goal: 'EXTRA' }]
  });
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => json(FIX_TRIAGE),
    'feedback-review': () => (++reviews === 1 ? moreWork : SOLVED)
  });

  runner.followUp(runId, 'fix it');
  await turnFinished(store, runId);

  assert.equal(reviews, 2, 'the review ran again after the extension');
  const flow = store.readFlow(runId);
  const extra = flow.nodes.find(n => n.id === 'fu1x1-extra');
  assert.ok(extra, 'extension node was materialized with its extension prefix');
  assert.equal(store.readMeta(runId).nodeStatus['fu1x1-extra'], 'done');
  assert.ok(flow.edges.some(e => e.source === 'fu1x1-extra' && e.target === 'fu1-review'));
  assert.equal(flow.nodes.find(n => n.id === 'fu1-review').data.extensionsUsed, 1);
});

test('the extension bound escalates to the human gate', async () => {
  const store = makeStore();
  let ext = 0;
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => json(FIX_TRIAGE),
    'feedback-review': () => json({
      verdict: 'more-work', reason: 'never satisfied',
      nodes: [{ id: `again-${++ext}`, template: 'code-general-step', category: 'Code general', title: 'Again', goal: `AGAIN-${ext}` }]
    })
  });

  runner.followUp(runId, 'fix it');
  // The run starts at 'done', so wait for the escalation gate specifically.
  await waitForStage(store, runId, ['awaiting_approval']);
  const meta = store.readMeta(runId);
  assert.equal(meta.pendingNodeId, 'fu1-review');
  assert.equal(meta.pendingGateKind, 'escalation');

  runner.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  // Exactly MAX_TURN_EXTENSIONS extensions ran before the escalation.
  assert.equal(store.readFlow(runId).nodes.find(n => n.id === 'fu1-review').data.extensionsUsed, 2);
});

test('feature-class follow-up runs the plan segment with its approval gate', async () => {
  const store = makeStore();
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => json({ class: 'feature', reason: 'new capability', contextNodes: ['a'], goal: 'Add export' }),
    'plan-start': () => '# Tasks\n\n## task-1: Do the feature',
    'plan-eval': () => json({
      nodes: [{ id: 'w1', template: 'code-general-step', category: 'Code general', title: 'Build it', goal: 'W1' }],
      summary: 'one node'
    }),
    stitch: () => 'Stitch report. All coherent.',
    'feedback-review': () => SOLVED
  });

  runner.followUp(runId, 'now add export to CSV');
  // The plan-eval node carries the human approval gate (FU3). The run starts
  // at 'done', so wait for the gate stage specifically.
  await waitForStage(store, runId, ['awaiting_approval']);
  assert.equal(store.readMeta(runId).pendingNodeId, 'fu1-plan-eval');

  runner.approvePlan(runId);
  await turnFinished(store, runId);

  const flow = store.readFlow(runId);
  const ids = flow.nodes.map(n => n.id);
  for (const id of ['fu1-input', 'fu1-plan', 'fu1-plan-eval', 'fu1-stitch', 'fu1-review', 'w1']) {
    assert.ok(ids.includes(id), `${id} should be in the extended flow`);
  }
  // The materialized executor sits between plan-eval and stitch, as in a fresh run.
  assert.ok(flow.edges.some(e => e.source === 'fu1-plan-eval' && e.target === 'w1'));
  assert.ok(flow.edges.some(e => e.source === 'w1' && e.target === 'fu1-stitch'));
  // Context edge from the selected done node into the plan node.
  assert.ok(flow.edges.some(e => e.source === 'a' && e.target === 'fu1-plan'));
  assert.equal(store.readMeta(runId).nodeStatus.w1, 'done');
});

test('a failed run takes a follow-up and its failure path stays retired', async () => {
  const store = makeStore();
  setScript(async ({ system, prompt }) => {
    const role = roleOf(system);
    if (role === 'followup-triage') return json(FIX_TRIAGE);
    if (role === 'feedback-review') return SOLVED;
    if (goalOf(prompt) === 'B') throw new Error('boom');
    return `output ${goalOf(prompt) ?? 'x'}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.b, 'failed');

  runner.followUp(runId, 'skip that step and just patch it');
  await turnFinished(store, runId);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  // FU7: the failed node was retired, not re-run.
  assert.equal(meta.nodeStatus.b, 'skipped');
  assert.equal(meta.nodeStatus.out, 'skipped');
  assert.equal(meta.nodeStatus['fu1-patch'], 'done');
  assert.equal(meta.error, null);
});

test('followUp refuses while the run is live or unfinished', async () => {
  const store = makeStore();
  let release;
  setScript(async ({ system, prompt }) => {
    const role = roleOf(system);
    if (role === 'followup-triage') return new Promise(r => { release = () => r(json(FIX_TRIAGE)); });
    if (role === 'feedback-review') return SOLVED;
    return `output ${goalOf(prompt) ?? 'x'}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(simpleFlow());

  // Not terminal yet -> refused.
  assert.throws(() => runner.followUp(runId, 'too early'));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  // One turn at a time (FU10): a second reply while the turn runs is refused.
  runner.followUp(runId, 'first');
  assert.throws(() => runner.followUp(runId, 'second'), /still working/);
  await waitFor(() => release, { label: 'triage in flight' });
  release();
  await turnFinished(store, runId);

  // Empty feedback is refused outright.
  assert.throws(() => runner.followUp(runId, '   '), /empty/);
});

test('an unparseable triage restores the run and reports in the thread', async () => {
  const store = makeStore();
  const { runner, runId } = await finishedRun(store, {
    'followup-triage': () => 'I cannot decide what this is.'
  });

  runner.followUp(runId, 'do something');
  await waitFor(() => fs.existsSync(path.join(store.runDir(runId), 'followups', '1', 'answer.md')),
    { label: 'triage-miss note' });
  await waitFor(() => store.readMeta(runId).stage === 'done', { label: 'stage restored' });
  const followups = store.readFollowups(runId);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].triage.class, null);
  assert.ok(followups[0].answer.includes('could not be triaged'));
  assert.equal(store.readFlow(runId).nodes.length, 3, 'no nodes were added');
});
