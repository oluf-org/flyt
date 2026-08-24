// Amending a task from what its attempts hit (core/brief.js).
//
// Escalation used to mean a dearer model and the same brief, which spends money
// on the assumption that the work was too hard. Often it was not: the brief was
// not specific enough, and a bigger model read the same ambiguity and made a
// bigger, more confident mistake.
//
// Everything asserted here is a count or a set difference the run already
// recorded. Nothing in this module asks a model anything, which is why it can
// run on every escalation without costing a penny.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptFindings, repeatedFailure, amendBrief, briefNotes,
  BRIEF_MARK_START, BRIEF_MARK_END, KEEP_ATTEMPTS,
} from '../core/brief.js';

// --- what one attempt says about its brief ---------------------------------

test('writing nothing is a fact about the brief, not about the model', () => {
  const { findings } = attemptFindings({ wroteNothing: true });
  assert.match(findings.join(' '), /did not read as an instruction to change a file/);
});

test('writing outside the declared paths names both sides and refuses to guess', () => {
  const { findings } = attemptFindings({
    wrote: ['core/a.js', 'tests/a.test.js'],
    blastRadius: ['core/a.js'],
  });
  const said = findings.join(' ');
  assert.match(said, /tests\/a\.test\.js/, 'what it changed');
  assert.match(said, /core\/a\.js/, 'and what the task declared');
  assert.match(said, /Either the radius is wrong or the change is/,
    'the loop does not get to decide which');
});

test('a path inside a declared directory is not outside it', () => {
  const { findings } = attemptFindings({
    wrote: ['core/tools/edit_file.js'],
    blastRadius: ['core/tools/'],
  });
  assert.ok(!findings.some(f => /blast radius/.test(f)), findings.join(' '));
});

test('a directory prefix does not match a sibling that merely starts the same way', () => {
  const { findings } = attemptFindings({
    wrote: ['core/toolsmith.js'],
    blastRadius: ['core/tools'],
  });
  assert.ok(findings.some(f => /blast radius/.test(f)),
    'core/toolsmith.js is not inside core/tools');
});

test('reading half the repository before writing is the brief not saying where the code is', () => {
  const { findings } = attemptFindings({ readsBeforeWrite: 28 });
  assert.match(findings.join(' '), /Read 28 files before changing anything/);
  assert.match(findings.join(' '), /name the files/);
});

test('a handful of reads is just doing the work', () => {
  const { findings } = attemptFindings({ readsBeforeWrite: 4 });
  assert.ok(!findings.some(f => /before changing anything/.test(f)));
});

test('the headline says which attempt, at what price, and where it stopped', () => {
  const { headline } = attemptFindings({
    attempt: 2, level: 'high', model: 'deepseek-v4-pro', stage: 'gates', at: '2026-08-24T19:00:00Z',
  });
  assert.match(headline, /Attempt 2/);
  assert.match(headline, /at high/);
  assert.match(headline, /on deepseek-v4-pro/);
  assert.match(headline, /stopped at gates/);
  assert.match(headline, /2026-08-24/);
});

test('a reviewer objection is quoted, and kept to one line', () => {
  const { findings } = attemptFindings({ reviewerSaid: 'the tests\nwere\ndeleted rather than fixed' });
  const said = findings.find(f => /reviewer objected/.test(f));
  assert.ok(said);
  assert.ok(!said.includes('\n'), 'a brief is not the place for somebody else\'s formatting');
  assert.match(said, /deleted rather than fixed/);
});

// --- the same thing, repeatedly, which is nobody's model problem ------------

test('the same gate failing twice is addressed to a human, not to a bigger model', () => {
  const said = repeatedFailure([
    { gateFailures: ['npm test: tests/a.test.js'] },
    { gateFailures: ['npm test: tests/a.test.js'] },
  ]);
  assert.match(said, /2 attempts failed on the same thing/);
  assert.match(said, /A dearer model has already been tried/);
  assert.match(said, /decision for a human, not a rung/);
});

test('different failures each time are the work, and say nothing about the task', () => {
  assert.equal(repeatedFailure([
    { gateFailures: ['npm test: a'] },
    { gateFailures: ['npm test: b'] },
  ]), null);
});

test('one attempt is not a pattern', () => {
  assert.equal(repeatedFailure([{ gateFailures: ['npm test: a'] }]), null);
});

// --- the managed section ---------------------------------------------------

const BODY = '## Goal\n\nDo the thing.\n\n## Done when\n\n- it is done\n';

test('the author\'s prose is untouched, and the section is added below it', () => {
  const out = amendBrief(BODY, [{ attempt: 1, wroteNothing: true }]);
  assert.ok(out.startsWith('## Goal'), 'the task still opens with the task');
  assert.match(out, /Do the thing\./);
  assert.match(out, /- it is done/);
  assert.match(out, /## What previous attempts hit/);
  assert.ok(out.includes(BRIEF_MARK_START) && out.includes(BRIEF_MARK_END));
});

test('amending twice replaces the section rather than growing a second one', () => {
  const once = amendBrief(BODY, [{ attempt: 1, wroteNothing: true }]);
  const twice = amendBrief(once, [{ attempt: 1, wroteNothing: true }, { attempt: 2, readsBeforeWrite: 30 }]);

  assert.equal(twice.split(BRIEF_MARK_START).length - 1, 1, 'one section');
  assert.equal(twice.split('## What previous attempts hit').length - 1, 1, 'one heading');
  assert.match(twice, /Attempt 2/);
  assert.ok(twice.startsWith('## Goal'));
});

test('the section is bounded: the oldest attempt drops off', () => {
  const notes = [1, 2, 3, 4, 5].map(n => ({ attempt: n, wroteNothing: true }));
  const out = amendBrief(BODY, notes);
  assert.ok(!out.includes('Attempt 1'), 'a brief nobody finishes reading is not a brief');
  assert.ok(!out.includes('Attempt 2'));
  assert.match(out, /Attempt 5/);
  assert.equal(briefNotes(out).length, KEEP_ATTEMPTS);
});

test('the evidence round-trips, so the next amendment adds rather than re-derives', () => {
  const notes = [{ attempt: 1, level: 'low', gateFailures: ['npm test: a'] }];
  const out = amendBrief(BODY, notes);
  assert.deepEqual(briefNotes(out), notes);
});

test('a body with no evidence to add comes back unchanged', () => {
  assert.equal(amendBrief(BODY, []), BODY);
});

test('a body whose section is removed by hand can be amended again', () => {
  const once = amendBrief(BODY, [{ attempt: 1, wroteNothing: true }]);
  const stripped = once.slice(0, once.indexOf(BRIEF_MARK_START)).trim() + '\n';
  const again = amendBrief(stripped, [{ attempt: 2, wroteNothing: true }]);
  assert.match(again, /Attempt 2/);
  assert.equal(again.split(BRIEF_MARK_START).length - 1, 1);
});

test('the section tells a human where to edit, since the loop rewrites this one', () => {
  const out = amendBrief(BODY, [{ attempt: 1, wroteNothing: true }]);
  assert.match(out, /Edit the task above it/);
});
