// DECISIONS.md D46 — the interrogation node. The refiner's opposite number:
// where `refine` resolves ambiguity itself and asks only when it must, this
// node asks first, over several bounded rounds, and writes the specification
// its answers settled. The gate it parks at is the same one (D27's
// awaiting_input); what changed is that the number of rounds belongs to the
// node instead of being hard-coded at one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner, countAnsweredRounds, renderQuestions, renderOpenItems } from '../core/flowRunner.js';
import { parseInterrogation, MAX_INTERROGATION_QUESTIONS } from '../core/planEval.js';
import { answered, describeEmptyTurn } from '../core/agent.js';
import {
  SEED_NODE_TEMPLATES, questionRoundsFor, normalizeRounds, nodePorts,
  MAX_QUESTION_ROUNDS, DEFAULT_QUESTION_ROUNDS, resolveInstance
} from '../src/flowTypes.js';
import { inferEffectMode } from '../core/effect.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, waitFor, makeFlow, node, edge } from './helpers.js';

const block = obj => '```json\n' + JSON.stringify(obj) + '\n```';
const asking = qs => block({ status: 'asking', confidence: 'low', questions: qs });
const settled = (extra = {}) => block({ status: 'settled', confidence: 'high', questions: [], ...extra });

// A run parks once per round, so waiting for the STAGE is ambiguous between
// rounds: the answer that releases round one and the park of round two are
// both `awaiting_input`. Wait for the question instead.
const waitForRound = (store, runId, text) => waitFor(
  () => store.readMeta(runId).pendingQuestions?.[0]?.text === text,
  { label: `parked asking "${text}"` });
// Same idea where every round asks the same thing: count the parks.
const waitForRounds = (store, runId, n) => waitFor(
  () => store.readLog(runId).filter(e => e.event === 'input_gate').length >= n
    && store.readMeta(runId).stage === 'awaiting_input',
  { label: `parked ${n} time(s)` });

function interrogateFlow(data = {}) {
  return makeFlow(
    [node('input', 'input', { text: 'a thing that does the thing' }),
     node('ask', 'aiStep', { role: 'interrogate', title: 'Interrogate', ...data }),
     node('output', 'output')],
    [edge('input', 'ask'), edge('ask', 'output')]);
}

// --- the contract ------------------------------------------------------------

test('parseInterrogation requires a status, and "asking" requires a question', () => {
  assert.equal(parseInterrogation('spec, no fence').ok, false);
  assert.equal(parseInterrogation('spec\n' + block({ questions: [] })).ok, false,
    'a missing status is not a settled interrogation');
  assert.equal(parseInterrogation('spec\n' + block({ status: 'maybe' })).ok, false);
  // "asking" with nothing to ask is the dangerous one: it would park the run
  // on an empty gate, so it is rejected rather than coerced.
  assert.equal(parseInterrogation('spec\n' + asking([])).ok, false);

  const ok = parseInterrogation('spec\n' + settled({ assumptions: ['a'], unknowns: ['u'] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.interrogation.status, 'settled');
  assert.equal(ok.interrogation.confidence, 'high');
  assert.deepEqual(ok.interrogation.assumptions, ['a']);
  assert.deepEqual(ok.interrogation.unknowns, ['u']);
});

test('an interrogation may ask more per round than a refiner, but not unboundedly', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, text: `question ${i}` }));
  const r = parseInterrogation('spec\n' + asking(many));
  assert.equal(r.interrogation.questions.length, MAX_INTERROGATION_QUESTIONS);
  assert.equal(MAX_INTERROGATION_QUESTIONS, 6);
});

test('candidate answers survive parsing, which is what makes a reply a click', () => {
  const r = parseInterrogation('spec\n' + asking([
    { id: 'shape', text: 'Node or flow?', why: 'changes everything', options: ['node', 'flow', 'both', '', 1] }
  ]));
  assert.deepEqual(r.interrogation.questions[0].options, ['node', 'flow', 'both']);
  assert.match(renderQuestions(r.interrogation.questions), /options: node · flow · both/);
});

// --- the round budget --------------------------------------------------------

test('rounds belong to the node: one for the roles where a question is an exception', () => {
  assert.equal(questionRoundsFor({ data: { role: 'refine' } }), 1);
  assert.equal(questionRoundsFor({ data: { role: 'orient' } }), 1);
  assert.equal(questionRoundsFor({ data: { role: 'interrogate' } }), DEFAULT_QUESTION_ROUNDS);
  assert.equal(questionRoundsFor({ data: { role: 'interrogate', maxRounds: 2 } }), 2);
  // A flow asking for more than the ceiling gets the ceiling, not an error:
  // the bound exists to protect the person answering, not to fail the run.
  assert.equal(questionRoundsFor({ data: { role: 'interrogate', maxRounds: 99 } }), MAX_QUESTION_ROUNDS);
  assert.equal(normalizeRounds(0), null);
  assert.equal(normalizeRounds('3'), 3);
});

test('answeredInputs is counted, not tested for membership', () => {
  assert.equal(countAnsweredRounds({ answeredInputs: [] }, 'ask'), 0);
  assert.equal(countAnsweredRounds({ answeredInputs: ['ask', 'other', 'ask'] }, 'ask'), 2);
  assert.equal(countAnsweredRounds(null, 'ask'), 0);
});

// --- the node in a run -------------------------------------------------------

test('an interrogation runs several rounds and each round sees the ones before it', async () => {
  const seen = [];
  setScript(({ system, prompt }) => {
    if (roleOf(system) !== 'interrogate') return 'downstream';
    seen.push(prompt);
    const round = seen.length;
    if (round === 1) return '# Specification\n\n## Goal\nTBD\n' + asking([{ id: 'a', text: 'What is it for?' }]);
    if (round === 2) return '# Specification\n\n## Goal\nDrafting\n' + asking([{ id: 'b', text: 'Who consumes it?' }]);
    return '# Specification\n\n## Goal\nBuild the interrogation node.\n' + settled({ assumptions: ['none needed'] });
  });
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow(), { userInput: 'a thing' });

  await waitForRound(store, runId, 'What is it for?');
  runner.answerInput(runId, 'For specifying ideas.');

  await waitForRound(store, runId, 'Who consumes it?');
  runner.answerInput(runId, 'A planner node downstream.');

  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');

  // Two rounds recorded, and the second prompt carried the first round's answer
  // — an interrogation that forgets what it was told is a questionnaire.
  assert.equal(countAnsweredRounds(store.readMeta(runId), 'ask'), 2);
  assert.match(seen[1], /For specifying ideas\./);
  assert.match(seen[2], /For specifying ideas\./, 'round three still remembers round one');
  assert.match(seen[2], /A planner node downstream\./);

  // The transcript keeps every round, in order, with the question that produced it.
  const transcript = store.readNodeOutput(runId, 'ask.transcript');
  assert.match(transcript, /Round 1/);
  assert.match(transcript, /What is it for\?/);
  assert.match(transcript, /Round 2/);
  assert.match(transcript, /A planner node downstream\./);

  // The spec is the primary port, with the contract block stripped off it.
  const spec = store.readNodeOutput(runId, 'ask');
  assert.match(spec, /Build the interrogation node\./);
  assert.ok(!spec.includes('"status"'), 'the machine half is not the deliverable');
});

test('the round budget is a hard stop: the last round settles instead of asking again', async () => {
  setScript(({ system }) => {
    // A model that would ask forever. The node, not the model, has to stop it.
    if (roleOf(system) !== 'interrogate') return 'downstream';
    return '# Specification\n\n## Goal\nTBD\n' + asking([{ id: 'more', text: 'And what else?' }]);
  });
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow({ maxRounds: 2 }), { userInput: 'x' });

  await waitForRounds(store, runId, 1);
  runner.answerInput(runId, 'first answer');
  await waitForRounds(store, runId, 2);
  runner.answerInput(runId, 'second answer');
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done', 'did not park a third time');
  const log = store.readLog(runId);
  const assumed = log.find(e => e.event === 'interrogation_assumed');
  assert.ok(assumed, 'the fork it wanted to ask about is recorded, not dropped');
  assert.match(assumed.reason, /budget spent/);
  // And it is visible in the artifact, not only in the log.
  assert.match(store.readNodeOutput(runId, 'ask.open'), /ASSUMED: And what else\?/);
});

test('the last round is announced, so the model can settle rather than be cut off', async () => {
  const prompts = [];
  setScript(({ system, prompt }) => {
    if (roleOf(system) !== 'interrogate') return 'downstream';
    prompts.push(prompt);
    return prompts.length === 1
      ? '# Spec\n' + asking([{ id: 'a', text: 'Which one?' }])
      : '# Spec\n' + settled();
  });
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow({ maxRounds: 2 }), { userInput: 'x' });
  await waitForStage(store, runId, 'awaiting_input');
  runner.answerInput(runId, 'this one');
  await waitForStage(store, runId, ['done', 'failed']);

  assert.match(prompts[0], /round 1 of at most 2/);
  assert.match(prompts[1], /LAST round/);
});

test('unattended, an interrogation never parks — it records the forks it took blind', async () => {
  setScript(({ system }) => (roleOf(system) !== 'interrogate' ? 'downstream'
    : '# Specification\n\n## Goal\nTBD\n' + asking([{ id: 'a', text: 'Web or CLI?' }])));
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow(), { userInput: 'x', approvalMode: 'always' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  const assumed = store.readLog(runId).find(e => e.event === 'interrogation_assumed');
  assert.equal(assumed.reason, 'unattended run');
  assert.match(store.readNodeOutput(runId, 'ask.open'), /nobody was asked/);
});

test('an unparseable contract settles on the spec as written rather than failing the run', async () => {
  setScript(({ system }) => (roleOf(system) !== 'interrogate'
    ? 'downstream'
    : '# Specification\n\n## Goal\nA thing.\n\nno fence at all'));
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow(), { userInput: 'x' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(store.readNodeOutput(runId, 'ask'), /A thing\./);
  assert.ok(store.readLog(runId).some(e => e.event === 'interrogation_failed'));
  assert.match(store.readNodeOutput(runId, 'ask.open'), /could not be parsed/);
});

test('an interrogation that is never asked anything still says so in its transcript', async () => {
  setScript(({ system }) => (roleOf(system) !== 'interrogate'
    ? 'downstream' : '# Specification\n\n## Goal\nClear already.\n' + settled()));
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(interrogateFlow(), { userInput: 'x' });
  await waitForStage(store, runId, ['done', 'failed']);

  assert.equal(store.readMeta(runId).stage, 'done');
  assert.match(store.readNodeOutput(runId, 'ask.transcript'), /no round of questions was answered/);
  assert.equal(store.readLog(runId).filter(e => e.event === 'input_gate').length, 0);
});

// --- the library shape -------------------------------------------------------

test('the shipped template declares its ports, its rounds, and owes an artifact', () => {
  const tpl = SEED_NODE_TEMPLATES.find(t => t.id === 'interrogate');
  assert.ok(tpl, 'the interrogation node ships in the seed library');
  assert.equal(tpl.role, 'interrogate');
  assert.equal(tpl.baseType, 'aiStep');
  assert.equal(tpl.maxRounds, DEFAULT_QUESTION_ROUNDS);

  const ports = nodePorts({ type: 'aiStep', data: { role: 'interrogate' } }).map(p => p.id);
  assert.deepEqual(ports, ['spec', 'transcript', 'open', 'questions']);

  // It writes a document, never the repository — so it can never be "done"
  // on the strength of a workspace change it did not make.
  assert.equal(inferEffectMode({ type: 'aiStep', role: 'interrogate' }), 'artifact');
});

test('a flow may narrow the rounds on its instance', () => {
  const resolved = resolveInstance(
    { id: 'ask', templateId: 'interrogate', overrides: { maxRounds: 1 } },
    SEED_NODE_TEMPLATES.find(t => t.id === 'interrogate'));
  assert.equal(resolved.data.maxRounds, 1);
  assert.equal(questionRoundsFor(resolved), 1);
});

// --- the answer-only round (found by running it) -----------------------------
//
// The interrogation is the first aiStep to hold tools AND owe a contract, which
// is how it surfaced this: on its last round the loop withdraws the tools so the
// model will write, and a model that asks for them anyway used to count as an
// answered turn — returning empty text and failing the node as "the provider
// returned no content", with the provider and the model id both fine.

test('a tool call is an answer while tools remain, and not on the answer-only round', () => {
  const toolTurn = { text: '', message: { tool_calls: [{ id: '1' }] } };
  assert.equal(answered(toolTurn), true, 'mid-loop, a tool call is the loop continuing');
  assert.equal(answered(toolTurn, { requireText: true }), false,
    'with the tools withdrawn, a tool call has produced nothing');
  assert.equal(answered({ text: 'the spec' }, { requireText: true }), true);
});

test('the empty-turn diagnostic names the round budget, not the provider', () => {
  const msg = describeEmptyTurn(
    { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' },
    { emptyTurn: { finishReason: 'tool_calls', discardedToolCalls: 4, maxTokens: 12288, retriedWith: 24576 } });
  assert.match(msg, /final answer-only round requesting 4 more tool call/);
  assert.match(msg, /maxToolIterations/);
  assert.ok(!/Check the provider status/.test(msg),
    'the provider was not the problem and must not be named as one');
});

test('renderOpenItems says "none" rather than leaving a reader to infer it', () => {
  const text = renderOpenItems({ confidence: 'medium' });
  assert.match(text, /Confidence: medium/);
  assert.match(text, /## Assumptions taken\n- \(none\)/);
  assert.match(text, /## Still unknown\n- \(none\)/);
});
