// Unit tests for the strict structured-output parsers (core/planEval.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parsePlanEval, parseStepEvalVerdict, parseStitchDirectives, parseLanePlan } from '../core/planEval.js';

const validNode = {
  id: 'gen-a',
  template: 'code-general-step',
  taskRef: 'task-1',
  category: 'Code general',
  title: 'Do the thing',
  goal: 'Implement the thing exactly as tasks.md describes.'
};
const wrap = obj => 'Some prose first.\n\n```json\n' + JSON.stringify(obj, null, 2) + '\n```\nTrailing prose.';

test('extractJson: fenced json block', () => {
  assert.deepEqual(extractJson('x\n```json\n{"a":1}\n```\ny'), { a: 1 });
});

test('extractJson: raw JSON body', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: outermost braces inside prose', () => {
  assert.deepEqual(extractJson('the answer is {"a": {"b": 2}} thanks'), { a: { b: 2 } });
});

test('extractJson: no JSON -> null', () => {
  assert.equal(extractJson('nothing to see here'), null);
});

test('parsePlanEval: accepts a minimal valid document', () => {
  const r = parsePlanEval(wrap({ nodes: [validNode], summary: 'ok' }));
  assert.equal(r.ok, true);
  assert.equal(r.plan.nodes.length, 1);
  assert.equal(r.plan.nodes[0].id, 'gen-a');
  assert.equal(r.plan.summary, 'ok');
});

test('parsePlanEval: rejects missing nodes array', () => {
  const r = parsePlanEval(wrap({ summary: 'no nodes' }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /nodes: required/);
});

test('parsePlanEval: rejects unknown template', () => {
  const r = parsePlanEval(wrap({ nodes: [{ ...validNode, template: 'nope-step' }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /unknown "nope-step"/);
});

test('parsePlanEval: rejects duplicate ids', () => {
  const r = parsePlanEval(wrap({ nodes: [validNode, { ...validNode, taskRef: 'task-2' }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate id "gen-a"/);
});

test('parsePlanEval: rejects ids with illegal characters', () => {
  const r = parsePlanEval(wrap({ nodes: [{ ...validNode, id: 'bad id!' }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /letters, digits/);
});

test('parsePlanEval: rejects unknown category (node and categories map)', () => {
  const r1 = parsePlanEval(wrap({ nodes: [{ ...validNode, category: 'Wizardry' }] }));
  assert.equal(r1.ok, false);
  const r2 = parsePlanEval(wrap({ nodes: [validNode], categories: { 'task-1': 'Wizardry' } }));
  assert.equal(r2.ok, false);
});

test('parsePlanEval: a vocabulary term in the wrong case is that term, not a violation', () => {
  // The vocabulary is `Code general | Code design | documentation | Test-creation`
  // — three capitalized and one not — so a planner writing "Documentation"
  // beside "Code general" is being consistent with what it was shown. It cost a
  // whole live run: one node's category rejected the entire plan, nothing was
  // materialized, the run "completed" having done nothing, and the loop
  // escalated the task to a bigger model that spells it the same way.
  const r = parsePlanEval(wrap({
    nodes: [{ id: 'n1', template: 'documentation-step', category: 'Documentation', effort: 'Medium', goal: 'g' }],
    categories: { 'task-1': 'Documentation' }
  }));
  assert.equal(r.ok, true, r.errors?.join('\n'));
  // Normalized to the vocabulary's own spelling, so the category→model routing
  // and the template pairing downstream compare one form of the word.
  assert.equal(r.plan.nodes[0].category, 'documentation');
  assert.equal(r.plan.nodes[0].effort, 'medium');
  assert.equal(r.plan.categories['task-1'], 'documentation');

  // Strict is still strict: a word that is not in the vocabulary in any case
  // still rejects the document.
  assert.equal(parsePlanEval(wrap({ nodes: [{ ...validNode, category: 'Wizardry' }] })).ok, false);
});

test('parsePlanEval: rejects malformed contextSpec', () => {
  const r = parsePlanEval(wrap({ nodes: [{ ...validNode, contextSpec: { files: [{ description: 'no path' }] } }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /contextSpec\.files\[0\]\.path/);
});

test('parsePlanEval: whole document rejected on any violation (no partial output)', () => {
  const r = parsePlanEval(wrap({ nodes: [validNode, { id: 'gen-b', template: 'nope' }] }));
  assert.equal(r.ok, false);
});

test('parseStepEvalVerdict: valid verdicts, case-insensitive', () => {
  assert.deepEqual(
    parseStepEvalVerdict(wrap({ verdict: 'Retry', reason: 'r', guidance: 'g' })),
    { verdict: 'retry', reason: 'r', guidance: 'g' });
  assert.equal(parseStepEvalVerdict(wrap({ verdict: 'pass' })).verdict, 'pass');
  assert.equal(parseStepEvalVerdict(wrap({ verdict: 'escalate' })).verdict, 'escalate');
});

test('parseStepEvalVerdict: invalid or missing verdict -> null', () => {
  assert.equal(parseStepEvalVerdict(wrap({ verdict: 'maybe' })), null);
  assert.equal(parseStepEvalVerdict('no json at all'), null);
});

test('parseStitchDirectives: null when no fixTasks key', () => {
  assert.equal(parseStitchDirectives(wrap({ something: 'else' })), null);
});

test('parseStitchDirectives: valid tasks kept, invalid dropped with error', () => {
  const r = parseStitchDirectives(wrap({
    fixTasks: [
      { title: 'Fix A', goal: 'Repair A fully.' },
      { title: 'Missing goal' }
    ]
  }));
  assert.equal(r.fixTasks.length, 1);
  assert.equal(r.fixTasks[0].title, 'Fix A');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /fixTasks\[1\]/);
});

// Category and template are documented 1:1 (BLOCKS.md): the category picks
// the model, the template picks the tools and base type. A live run emitted
// { category: 'Code general', template: 'code-design-step' } for "Implement and
// export tag filtering" — nothing checked, and the node ran with the wrong
// shape for the work it was handed.
test('parsePlanEval rejects a category that contradicts its template', () => {
  const doc = '```json\n' + JSON.stringify({
    nodes: [{ id: 'n1', template: 'code-design-step', category: 'Code general', goal: 'Implement it' }]
  }) + '\n```';
  const r = parsePlanEval(doc);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /does not match template/);
  assert.match(r.errors.join('\n'), /1:1/);
});

test('parsePlanEval accepts a category that matches its template', () => {
  const doc = '```json\n' + JSON.stringify({
    nodes: [{ id: 'n1', template: 'code-general-step', category: 'Code general', goal: 'Implement it' }]
  }) + '\n```';
  assert.equal(parsePlanEval(doc).ok, true);
});

// The category is optional; omitting it is not a contradiction.
test('parsePlanEval still accepts a node with no category', () => {
  const doc = '```json\n' + JSON.stringify({
    nodes: [{ id: 'n1', template: 'code-general-step', goal: 'Implement it' }]
  }) + '\n```';
  assert.equal(parsePlanEval(doc).ok, true);
});

// A user's own template carries no known category, so we can't judge the pairing.
test('parsePlanEval does not police the category of a user-defined template', () => {
  const doc = '```json\n' + JSON.stringify({
    nodes: [{ id: 'n1', template: 'my-own-step', category: 'Code general', goal: 'g' }]
  }) + '\n```';
  assert.equal(parsePlanEval(doc, ['my-own-step']).ok, true);
});

// --- the fan-out lane plan (DECISIONS.md D37) ------------------------------------

const PRESETS = ['standard', 'architecture', 'wildcard', 'adversarial', 'contrarian'];
const lanePlan = (over = {}) => wrap({
  mission: 'explain how this repository recovers from a failed task.',
  subject: 'the repository',
  focus: ['the retry path'],
  ignore: ['code style'],
  lanes: [
    { preset: 'architecture', id: 'arch-control', label: 'Architecture — control flow', intent: 'how retries are wired', reason: 'the brief is structural' },
    { preset: 'adversarial', id: 'attack', label: 'Adversarial', intent: 'where it breaks' }
  ],
  ...over
});

test('parseLanePlan: a well-formed roster survives, focus and ignore included', () => {
  const r = parseLanePlan(lanePlan(), { presetIds: PRESETS });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.plan.mission, 'explain how this repository recovers from a failed task.');
  assert.equal(r.plan.subject, 'the repository');
  assert.deepEqual(r.plan.focus, ['the retry path']);
  assert.deepEqual(r.plan.ignore, ['code style']);
  assert.deepEqual(r.plan.lanes.map(l => l.preset), ['architecture', 'adversarial']);
  assert.equal(r.plan.lanes[0].reason, 'the brief is structural');
});

test('parseLanePlan: repeating a preset is legal — that is how "focus entirely on X" works', () => {
  const r = parseLanePlan(lanePlan({
    lanes: [
      { preset: 'architecture', id: 'a1', label: 'Arch — the data path', intent: 'x' },
      { preset: 'architecture', id: 'a2', label: 'Arch — the control path', intent: 'y' },
      { preset: 'architecture', id: 'a3', label: 'Arch — the boundaries', intent: 'z' }
    ]
  }), { presetIds: PRESETS });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.plan.lanes.length, 3);
});

test('parseLanePlan: an invented preset is rejected, never coerced to a near-match', () => {
  // The enum IS the mitigation for letting a model shape the roster at all: it
  // selects and duplicates presets, it never writes what a lane is.
  const r = parseLanePlan(lanePlan({
    lanes: [{ preset: 'flattering', id: 'nice', label: 'Nice' }, { preset: 'standard', id: 's', label: 'S' }]
  }), { presetIds: PRESETS });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /lanes\[0\]\.preset: required, one of/.test(e)));
});

test('parseLanePlan: the budget is checked on lanes that actually survived', () => {
  const under = parseLanePlan(lanePlan({ lanes: [{ preset: 'standard', id: 'a', label: 'A' }] }),
    { presetIds: PRESETS, minLanes: 2, maxLanes: 6 });
  assert.equal(under.ok, false);
  assert.ok(under.errors.some(e => /declared 1 valid lane\(s\); this fan-out's budget is 2-6/.test(e)));

  const over = parseLanePlan(lanePlan({
    lanes: Array.from({ length: 7 }, (_, i) => ({ preset: 'standard', id: `l${i}`, label: `L${i}` }))
  }), { presetIds: PRESETS, minLanes: 2, maxLanes: 6 });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some(e => /declared 7 valid lane\(s\)/.test(e)));
});

test('parseLanePlan: a missing focus or ignore is an empty array, not an error', () => {
  const r = parseLanePlan(wrap({
    mission: 'read it.', subject: 'the codebase',
    lanes: [{ preset: 'standard', id: 'a', label: 'A' }, { preset: 'wildcard', id: 'b', label: 'B' }]
  }), { presetIds: PRESETS });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.plan.focus, []);
  assert.deepEqual(r.plan.ignore, []);
});

test('parseLanePlan: mission must exist and be one sentence', () => {
  assert.equal(parseLanePlan(lanePlan({ mission: '' }), { presetIds: PRESETS }).ok, false);
  const two = parseLanePlan(lanePlan({ mission: 'Read it. Then judge it.' }), { presetIds: PRESETS });
  assert.equal(two.ok, false);
  assert.ok(two.errors.some(e => /mission: exactly one sentence/.test(e)),
    'the second sentence is invariably the planner starting to write lane instructions');
});

test('parseLanePlan: duplicate ids and over-long emphasis are rejected', () => {
  const dupe = parseLanePlan(lanePlan({
    lanes: [{ preset: 'standard', id: 'same', label: 'A' }, { preset: 'wildcard', id: 'same', label: 'B' }]
  }), { presetIds: PRESETS });
  assert.equal(dupe.ok, false);
  assert.ok(dupe.errors.some(e => /"same" is declared twice/.test(e)));

  const wordy = parseLanePlan(lanePlan({
    lanes: [
      { preset: 'standard', id: 'a', label: 'A', emphasis: 'x'.repeat(300) },
      { preset: 'wildcard', id: 'b', label: 'B' }
    ]
  }), { presetIds: PRESETS });
  assert.equal(wordy.ok, false);
  assert.ok(wordy.errors.some(e => /emphasis: at most 280 characters/.test(e)));
});

test('parseLanePlan is total: prose with no JSON comes back as errors, never a throw', () => {
  const r = parseLanePlan('I think three lanes would be good.', { presetIds: PRESETS });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length);
});
