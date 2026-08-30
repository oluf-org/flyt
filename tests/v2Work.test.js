// Work: the running stack, the active block lit, output streaming inline
// (t-0077).
//
// The claim that needs holding is the one about SOURCES. Work and Trace are
// two questions asked of one folded trace — "what is happening" and "what
// exactly happened" — and if they read the log twice they can disagree about a
// run they are both watching. So the view model here is derived from the same
// object Trace renders, and the test says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldTrace, feed, emptyTrace } from '../src/traceModel.js';
import { runView, blockStates, liveOutput, runStage } from '../src/v2/runView.js';
import { traceView } from '../src/v2/traceView.js';

const src = p => fs.readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

const RUN = [
  { seq: 1, at: 't0', type: 'run.created', data: { runId: 'r1', stackId: 'demo' } },
  { seq: 2, at: 't0', type: 'run.stage', data: { stage: 'execution' } },
  { seq: 3, at: 't1', type: 'block.status', data: { blockId: 'plan', status: 'active', use: 'demo:work' } },
  { seq: 4, at: 't1', type: 'turn.start', data: { runId: 'r1', turn: 1, blockId: 'plan' } },
  { seq: 5, at: 't1', type: 'step.start', data: { runId: 'r1', blockId: 'plan', step: 1 } },
  { seq: 6, at: 't1', type: 'llm.request', data: { callId: 'q1', model: 'a/model' } },
  { seq: 7, at: 't2', type: 'llm.response', data: { callId: 'q1', content: 'Half a thought so far', finishReason: 'stop' } },
];

const FINISHED = [
  ...RUN,
  { seq: 8, at: 't3', type: 'block.output', data: { blockId: 'plan', content: '# The plan\n\nDo the thing.' } },
  { seq: 9, at: 't3', type: 'block.status', data: { blockId: 'plan', status: 'done' } },
  { seq: 10, at: 't3', type: 'run.stage', data: { stage: 'done' } },
];

test('an active block shows what it is saying; a finished one shows what it produced', () => {
  const live = runView(foldTrace(RUN));
  assert.deepEqual(live.active, ['plan']);
  assert.equal(live.blocks.plan.status, 'active');
  assert.equal(live.blocks.plan.showing, 'Half a thought so far');
  assert.equal(live.running, true);

  const done = runView(foldTrace(FINISHED));
  assert.deepEqual(done.active, []);
  assert.equal(done.blocks.plan.status, 'done');
  assert.equal(done.blocks.plan.showing, '# The plan\n\nDo the thing.',
    'the deliverable, not the draft of it that was on screen a second earlier');
  assert.equal(done.running, false);
});

test('durable stream chunks survive a renderer reconnect before the response settles', () => {
  const partial = [
    ...RUN.slice(0, 6),
    { seq: 7, at: 't2', type: 'llm.stream', data: { callId: 'q1', text: 'Half a ' } },
    { seq: 8, at: 't2', type: 'llm.stream', data: { callId: 'q1', text: 'thought' } },
  ];
  const reopened = runView(foldTrace(partial));
  assert.equal(reopened.blocks.plan.showing, 'Half a thought');
  assert.equal(reopened.running, true);
});

test('parallel lanes are active together, and Work says so in the plural', () => {
  const fan = [
    ...RUN.slice(0, 2),
    { seq: 3, at: 't1', type: 'block.status', data: { blockId: 'la', status: 'active' } },
    { seq: 4, at: 't1', type: 'block.status', data: { blockId: 'ra', status: 'active' } },
  ];
  const view = runView(foldTrace(fan));
  assert.deepEqual(view.active.sort(), ['la', 'ra'],
    'rendering "the" active block would make lanes running together look like one running alone');
});

test('a failed block carries its reason', () => {
  const view = runView(foldTrace([
    ...RUN.slice(0, 2),
    { seq: 3, at: 't1', type: 'block.status', data: { blockId: 'plan', status: 'failed', error: 'the file was not there' } },
    { seq: 4, at: 't1', type: 'run.error', data: { error: 'Block "plan" failed: the file was not there', blockId: 'plan' } },
    { seq: 5, at: 't1', type: 'run.stage', data: { stage: 'failed' } },
  ]));
  assert.equal(view.blocks.plan.status, 'failed');
  assert.equal(view.blocks.plan.error, 'the file was not there');
  assert.match(view.error, /Block "plan" failed/);
  assert.equal(view.errorBlockId, 'plan');
  assert.equal(view.running, false);
});

test('a soft running-limit warning remains visible while active and clears after success', () => {
  const active = foldTrace([
    ...RUN.slice(0, 3),
    { seq: 4, at: 't2', type: 'block.warning', data: { blockId: 'plan', transient: true, code: 'soft_step_limit', reason: 'Still working after 120 steps.' } },
  ]);
  assert.deepEqual(runView(active).warnings, [{ blockId: 'plan', message: 'Still working after 120 steps.' }]);

  feed(active, [
    { seq: 5, at: 't3', type: 'block.status', data: { blockId: 'plan', status: 'done' } },
  ]);
  assert.deepEqual(runView(active).warnings, []);
});

test('the stage comes from the log, not from a caller remembering', () => {
  assert.deepEqual(runStage(foldTrace(RUN)), { stage: 'execution', error: null, errorBlockId: null });
  assert.deepEqual(runStage(foldTrace(FINISHED)), { stage: 'done', error: null, errorBlockId: null });
  assert.deepEqual(runStage(foldTrace([])), { stage: null, error: null, errorBlockId: null });
  // The LAST stage wins: a resumed run has been through several.
  assert.equal(runStage(foldTrace([
    { seq: 1, at: 't', type: 'run.stage', data: { stage: 'stopped' } },
    { seq: 2, at: 't', type: 'run.stage', data: { stage: 'resumed' } },
    { seq: 3, at: 't', type: 'run.stage', data: { stage: 'execution' } },
  ])).stage, 'execution');
});

test('Work and Trace read one folded trace, so they cannot disagree', () => {
  // Two questions of one object: "what is happening" and "what exactly
  // happened". A second read of the log would be a second answer, and the two
  // would drift on exactly the run somebody was watching closely.
  const trace = foldTrace(RUN);
  const work = runView(trace);
  const detail = traceView(trace);
  assert.equal(work.blocks.plan.showing, detail.turns[0].steps[0].request.content,
    'the text Work streams inline is the content Trace shows for that request');
  assert.equal(work.active[0], detail.turns[0].blockId);
});

test('a live view fed incrementally equals one folded whole', () => {
  const incremental = emptyTrace();
  feed(incremental, FINISHED.slice(0, 5));
  feed(incremental, FINISHED.slice(5));
  assert.deepEqual(runView(incremental), runView(foldTrace(FINISHED)));
});

test('a run with no blocks recorded yet is not a run with no blocks', () => {
  const view = runView(foldTrace(RUN.slice(0, 2)));
  assert.deepEqual(view.blocks, {});
  assert.deepEqual(view.active, []);
  assert.equal(view.running, true, 'the stage says execution — the blocks just have not started');
  assert.deepEqual(blockStates(null), {}, 'and no trace at all is not a crash');
  assert.equal(liveOutput(null, 'plan'), null);
});

test('Work draws the stack through the editor rather than drawing it again', () => {
  const work = src('v2/Work.jsx');
  assert.match(work, /import BlockEditor from '\.\/BlockEditor\.jsx'/,
    'two renderings of one stack are two renderings that drift');
  assert.doesNotMatch(work, /editorGeometry|layout\(/,
    'and the geometry is not recomputed here, which is how the drift would start');
  assert.match(work, /Retry \$\{view\.errorBlockId\}/, 'a failed workflow offers the failed block as an obvious retry');
  assert.match(work, /Inspect queries/);
  assert.match(work, /Request sent/);
  assert.match(work, /Internal reasoning/);
  assert.match(work, /Visible response/);
  assert.match(work, /Stop run/, 'a soft-unbounded worker remains manually stoppable');
});
