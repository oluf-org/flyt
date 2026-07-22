// MODES-COMPARE Phase 2 — the prompt refiner (T5) and the awaiting_input gate
// (T6). The refiner rewrites the run request into a brief and, only when an
// ambiguity would materially change the work, parks the run with clarifying
// questions answered from the composer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { parseRefineQuestions, stripRefineQuestions } from '../core/planEval.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, waitFor, makeFlow, node, edge } from './helpers.js';

const Q = qs => '```json\n' + JSON.stringify({ questions: qs }) + '\n```';

function refineFlow() {
  return makeFlow(
    [node('input', 'input', { text: 'make it good' }),
     node('refine', 'aiStep', { role: 'refine', title: 'Refiner' }),
     node('output', 'output')],
    [edge('input', 'refine'), edge('refine', 'output')]);
}

// --- T5: parseRefineQuestions / stripRefineQuestions -------------------------

test('parseRefineQuestions reads a questions block, caps at 3, drops junk', () => {
  const good = parseRefineQuestions('brief text\n' + Q([
    { id: 'scope', text: 'Web or CLI?', why: 'changes the whole build' },
    { question: 'Which DB?' },              // `question` synonym, no id -> q2
    { text: '' },                           // empty -> dropped
    { id: 'a', text: 'one' }, { id: 'b', text: 'two' } // over the cap of 3
  ]));
  assert.equal(good.questions.length, 3);
  assert.equal(good.questions[0].id, 'scope');
  assert.equal(good.questions[1].id, 'q2');
  assert.equal(good.questions[1].text, 'Which DB?');
});

test('parseRefineQuestions returns null for no block, empty list, or malformed JSON', () => {
  assert.equal(parseRefineQuestions('just a brief, no questions'), null);
  assert.equal(parseRefineQuestions(Q([])), null);
  assert.equal(parseRefineQuestions('brief\n```json\n{ questions: [ }\n```'), null);
});

test('stripRefineQuestions removes the trailing questions fence only', () => {
  const brief = '# Brief\n\n## Goal\nDo the thing.';
  assert.equal(stripRefineQuestions(brief + '\n\n' + Q([{ id: 'x', text: 'y' }])), brief);
  assert.equal(stripRefineQuestions(brief), brief); // nothing to strip
});

// --- T5: refined-prompt passthrough (no questions) --------------------------

test('a refine node with no questions passes its brief straight through', async () => {
  const store = makeStore();
  setScript(({ system }) => {
    if (roleOf(system) === 'refine') return '# Brief\n\n## Goal\nMake a good thing.';
    return 'downstream';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(refineFlow(), { userInput: 'make it good' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(store.readNodeOutput(runId, 'refine'), /Make a good thing\./);
  assert.equal(store.readNodeQuestions(runId, 'refine'), null); // never asked
});

// --- T6: questions park the run, an answer re-runs the node -----------------

test('refine questions park the run at awaiting_input; answering it finishes the run', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => {
    if (roleOf(system) !== 'refine') return 'downstream deliverable';
    // Second pass carries the user's answers — settle the brief, no more asks.
    if (prompt.includes('USER ANSWERS')) return '# Brief\n\n## Goal\nBuild the CLI tool.';
    return '# Brief (draft)\n\n' + Q([{ id: 'scope', text: 'Web or CLI?', why: 'changes everything' }]);
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(refineFlow(), { userInput: 'make it good' });

  await waitForStage(store, runId, 'awaiting_input');
  const meta = store.readMeta(runId);
  assert.equal(meta.pendingNodeId, 'refine');
  assert.equal(meta.pendingGateKind, 'input');
  assert.equal(meta.pendingQuestions[0].text, 'Web or CLI?');
  assert.ok(store.readNodeQuestions(runId, 'refine'), 'questions.json written');

  runner.answerInput(runId, 'A CLI tool, please.');
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(store.readNodeOutput(runId, 'refine.answers'), /CLI tool, please/);
  assert.match(store.readNodeOutput(runId, 'refine'), /Build the CLI tool\./);
  assert.ok(store.readMeta(runId).answeredInputs.includes('refine'));
});

// --- T6: one-round hard cap -------------------------------------------------

test('a refiner that asks again after answering is capped and proceeds', async () => {
  const store = makeStore();
  setScript(({ system }) => {
    // Always emits questions — even on the answered re-run.
    if (roleOf(system) !== 'refine') return 'downstream';
    return '# Brief\n\n' + Q([{ id: 'again', text: 'And what else?' }]);
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(refineFlow(), { userInput: 'x' });

  await waitForStage(store, runId, 'awaiting_input');
  runner.answerInput(runId, 'here are my answers');
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done'); // did NOT park a second time
  const log = store.readLog(runId);
  assert.ok(log.some(e => e.event === 'refine_questions_capped'), 'second-round questions logged as capped');
});

// --- T6: resume-while-gated (app restart loses the live promise) ------------

test('answering after a restart resumes the run from persisted gate state', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => {
    if (roleOf(system) !== 'refine') return 'downstream';
    if (prompt.includes('USER ANSWERS')) return '# Brief\n\nFinal.';
    return '# Draft\n\n' + Q([{ id: 'q', text: 'Which one?' }]);
  });
  const runnerA = new FlowRunner(store, testConfig());
  const runId = runnerA.start(refineFlow(), { userInput: 'x' });
  await waitForStage(store, runId, 'awaiting_input');

  // A fresh runner (as after an app restart) has no live promise for this gate.
  const runnerB = new FlowRunner(store, testConfig());
  assert.equal(runnerB.inputGates.has(runId), false);
  runnerB.answerInput(runId, 'the second one');
  await waitFor(() => store.readMeta(runId).stage === 'done', { label: 'done after restart-answer' });

  assert.match(store.readNodeOutput(runId, 'refine'), /Final\./);
  assert.match(store.readNodeOutput(runId, 'refine.answers'), /second one/);
});

test('answerInput rejects a run that is not awaiting input', () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(refineFlow(), { userInput: 'x' });
  // Not gated (or already finished) -> the call is refused.
  assert.throws(() => runner.answerInput(runId, 'hi'), /not waiting for input/);
});
