// Unit tests for the strict structured-output parsers (core/planEval.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parsePlanEval, parseStepEvalVerdict, parseStitchDirectives } from '../core/planEval.js';

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
