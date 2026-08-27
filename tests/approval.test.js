// One flag, five decisions, and a test that they agree (t-0106).
//
// `approvalMode: 'always'` was read in five places in core/stackRunner.js and
// settled five unrelated things. That overloading is the direct cause of
// t-0083: three readers of one flag, two honouring the documented contract and
// one not, and nothing noticed the third for months because there was nothing
// to notice it WITH — no name for the concept, no single place it was decided,
// and no test that the readers agreed. t-0084 then walked into it from the
// other side, where the obvious implementation silently undid t-0083.
//
// This is the check that did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVAL_MODES, APPROVAL_POLICY, APPROVAL_DECISIONS, TOOL_GATING, normalizeApprovalMode,
  editsProject, toolGating, screensToolCalls, skipsNodePreGate, assumesItsOwnAnswers
} from '../core/approval.js';

const readers = {
  editsProject, toolGating, screensToolCalls, skipsNodePreGate, assumesItsOwnAnswers
};

test('every mode answers every decision, and the vocabulary is closed', () => {
  // A sixth reader cannot silently disagree with the other five, because there
  // is nothing for it to read that is not named here — and this enumerates the
  // whole table rather than sampling it.
  assert.deepEqual(APPROVAL_DECISIONS, Object.keys(readers),
    'a named decision with no reader, or a reader with no name, is the gap this closes');
  assert.deepEqual(Object.keys(APPROVAL_POLICY).sort(), [...APPROVAL_MODES].sort());

  for (const mode of APPROVAL_MODES) {
    const row = APPROVAL_POLICY[mode];
    assert.deepEqual(Object.keys(row).sort(), [...APPROVAL_DECISIONS].sort(), `mode "${mode}"`);
    for (const decision of APPROVAL_DECISIONS) {
      assert.equal(readers[decision](mode), row[decision],
        `${decision}("${mode}") must be what the table says`);
    }
  }
});

test('the table is exactly the behaviour that shipped before it existed', () => {
  // A refactor's test is that nothing moved. These five columns are read off
  // the five call sites as they stood in core/stackRunner.js.
  //
  //   context file    writeContextFile   `=== 'always'` skips the project edit
  //   tool gating     runTasks isGated   'always' none, ask/smart all, node per-node
  //   screening       toolGate           `=== 'smart'` screens before pausing
  //   pre-gate        gate()             `=== 'always'` passes it (t-0083)
  //   answers         isAttended         `!== 'always'` is the FALLBACK (t-0084)
  assert.deepEqual(APPROVAL_POLICY, {
    ask: {
      editsProject: true, toolGating: 'every', screensToolCalls: false,
      skipsNodePreGate: false, assumesItsOwnAnswers: false
    },
    smart: {
      editsProject: true, toolGating: 'every', screensToolCalls: true,
      skipsNodePreGate: false, assumesItsOwnAnswers: false
    },
    node: {
      editsProject: true, toolGating: 'per-node', screensToolCalls: false,
      skipsNodePreGate: false, assumesItsOwnAnswers: false
    },
    always: {
      editsProject: false, toolGating: 'none', screensToolCalls: false,
      skipsNodePreGate: true, assumesItsOwnAnswers: true
    }
  });
});

test('"always" is the only mode that departs, and it departs four times', () => {
  // The argument for having written the table down: one word, four unrelated
  // consequences. "Nobody is here to approve a gate", "nobody is here to answer
  // a question" and "do not touch the project outside the worktree" are three
  // different facts that happen to be true together for the loop and are not
  // true together for a person at a terminal — which is what `flyt run
  // --approval always` is, and is exactly how t-0083 and t-0084 happened.
  const differs = APPROVAL_DECISIONS.filter(d => APPROVAL_POLICY.always[d] !== APPROVAL_POLICY.ask[d]);
  assert.deepEqual(differs,
    ['editsProject', 'toolGating', 'skipsNodePreGate', 'assumesItsOwnAnswers']);

  // 'smart' departs from 'ask' on exactly one axis, and 'node' on exactly one.
  assert.deepEqual(
    APPROVAL_DECISIONS.filter(d => APPROVAL_POLICY.smart[d] !== APPROVAL_POLICY.ask[d]),
    ['screensToolCalls']);
  assert.deepEqual(
    APPROVAL_DECISIONS.filter(d => APPROVAL_POLICY.node[d] !== APPROVAL_POLICY.ask[d]),
    ['toolGating']);
});

test('tool gating has three answers, because a node deciding for itself is one of them', () => {
  // The axis that cannot be a boolean, and the reason the table is a table.
  assert.deepEqual(TOOL_GATING, ['none', 'every', 'per-node']);
  for (const mode of APPROVAL_MODES) assert.ok(TOOL_GATING.includes(toolGating(mode)), mode);
});

test('an unrecognised mode is "ask" and an absent one is "node", at every reader', () => {
  // Fail-closed is the house rule, and it has to hold through the named
  // predicates too — a corrupted settings file must not become "approve
  // everything" by taking a different route in.
  for (const junk of ['ALWAYS', 'yes', '', 'always ', 42, {}]) {
    assert.equal(normalizeApprovalMode(junk), 'ask', String(junk));
    for (const decision of APPROVAL_DECISIONS) {
      assert.equal(readers[decision](junk), APPROVAL_POLICY.ask[decision], `${decision}(${String(junk)})`);
    }
  }
  for (const absent of [null, undefined]) {
    assert.equal(normalizeApprovalMode(absent), 'node');
    for (const decision of APPROVAL_DECISIONS) {
      assert.equal(readers[decision](absent), APPROVAL_POLICY.node[decision], `${decision}(${String(absent)})`);
    }
  }
});

test('nothing in stackRunner reads the mode by comparing it to a literal any more', () => {
  // The check with teeth. Five readers agreeing in a table is worth nothing if
  // a sixth goes back to `approvalMode(runId) === 'always'` — which is the
  // exact line t-0083 was, and it would pass every test above.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'stackRunner.js'), 'utf8');
  const offenders = source.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /approvalMode\([^)]*\)\s*[!=]==\s*'/.test(line))
    .map(([n, line]) => `stackRunner.js:${n}: ${line.trim()}`);
  assert.deepEqual(offenders, [],
    'ask core/approval.js for a named decision instead of comparing the mode here');
});
