// Isolation, gates and landing (DESIGN-SPEC.md §8).
//
// These run against REAL git repositories in a temp dir, because the thing
// being tested is whether a commit ends up on the base branch or not, and a
// mocked git proves nothing about that.
//
// The three failures that matter most, in order: a green suite that deleted the
// tests, a change that passes alone and breaks the base once merged, and a
// reviewer that cannot be reached being treated as approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorktreePool, git, slugify, branchFor, land, defaultWorktreeRoot, isInside } from '../core/worktree.js';
import { runGate, runGates, gatesFor, protectedViolations, testCountFrom, testCountRegression, testCountStagnation, testCountUncheckable, scratchArtefacts, scratchArtefactProblem, weakenedAssertions, weakenedAssertionProblem, suiteExpectation, suiteExpectationProblem, suiteExpectationMismatch, SUITE_EXPECTATIONS, gateProblem, unrunnableGates } from '../core/gates.js';
import { parseReview, buildReviewPrompt, packageReviewDiff, reviewDiff, reviewWorker } from '../core/diffReview.js';
import { landTask, mechanicalChecks, syncChangedDependencies, advancePin, readPin } from '../core/landing.js';
import { setScript } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-land-'));
const NODE = JSON.stringify(process.execPath);

// A repo with a passing "suite" that is just a script, so a test can make it
// red on demand without depending on a real test runner.
async function makeRepo({ tests = 2 } = {}) {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'test@localhost'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'suite.js'),
    `const n = ${tests};\nif (process.env.BREAK === '1') { console.log('# tests ' + n); process.exit(1); }\nconsole.log('# tests ' + n);\n`);
  fs.writeFileSync(path.join(root, 'src.js'), 'export const version = 1;\n');
  // The project's own gate configuration (§7.1). Without it the default is
  // `npm test`, which is correct and is what a repo with no config gets.
  fs.mkdirSync(path.join(root, '.flyt'), { recursive: true });
  fs.writeFileSync(path.join(root, '.flyt', 'config.json'),
    JSON.stringify({ gates: [SUITE], gateTimeoutMs: 30000 }, null, 2));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'initial'], { cwd: root });
  return root;
}

const SUITE = `${NODE} suite.js`;

// --- gates -----------------------------------------------------------------

test('a gate reports pass, fail and timeout as three different things', async () => {
  const dir = tmp();
  const pass = await runGate(`${NODE} -e "console.log('ok')"`, { cwd: dir });
  assert.equal(pass.status, 'pass');
  assert.equal(pass.code, 0);

  const fail = await runGate(`${NODE} -e "console.error('boom'); process.exit(3)"`, { cwd: dir });
  assert.equal(fail.status, 'fail');
  assert.equal(fail.code, 3);
  assert.match(fail.output, /boom/);

  // A hang and a red suite call for different responses; a supervisor that
  // cannot tell them apart will retry a hang forever.
  const hang = await runGate(`${NODE} -e "setTimeout(()=>{}, 60000)"`, { cwd: dir, timeoutMs: 300 });
  assert.equal(hang.status, 'timeout');
  assert.equal(hang.code, null);
});

test('gates stop at the first failure', async () => {
  const dir = tmp();
  const ran = [];
  const out = await runGates(
    [`${NODE} -e "process.exit(1)"`, `${NODE} -e "console.log('never')"`],
    { cwd: dir, onResult: r => ran.push(r.command) });
  assert.equal(out.ok, false);
  assert.equal(ran.length, 1, 'a ten-minute suite after a failed lint buys nothing');
  assert.equal(out.failure.status, 'fail');
});

test('a task may add gates and may never remove them', () => {
  const gates = gatesFor({
    projectConfig: { gates: ['npm test', 'npm run lint'] },
    task: { gates: ['npm run typecheck', 'npm test'] }
  });
  assert.deepEqual(gates, ['npm test', 'npm run lint', 'npm run typecheck']);
  // An agent that can delete the check that judges it is not being checked.
  assert.ok(gatesFor({ projectConfig: { gates: ['npm test'] }, task: { gates: [] } }).includes('npm test'));
});

test('deleting tests to go green is caught, and an unknowable count is not "fine"', () => {
  assert.equal(testCountFrom('# tests 621'), 621);
  assert.equal(testCountFrom('Tests: 3 failed, 40 passed'), 40);
  assert.equal(testCountFrom('all good'), null);

  const fell = (baselineOutput, currentOutput, rest = {}) =>
    testCountRegression({ baselineOutput, currentOutput, ...rest });
  assert.match(fell('# tests 621', '# tests 604'), /fell from 621 to 604/);
  assert.equal(fell('# tests 621', '# tests 640'), null);
  // Unknowable must not silently pass as "no decrease" — that is the hole.
  assert.equal(fell('no counts here', '# tests 5'), null);
});

test('the count standing still while source moved is the finding', () => {
  // t-0079 through t-0082: 271 lines across four tasks, count identical either
  // side, gates green, two defects behind them. That shape is what this exists
  // to catch, and it is the fixture worth naming.
  const said = testCountStagnation({
    changedFiles: ['core/backlog.js', 'core/archive.js', 'core/api.js'],
    baselineOutput: '# tests 1721', currentOutput: '# tests 1721',
  });
  assert.match(said, /did not move \(1721\)/);
  assert.match(said, /3 source file\(s\)/);
  assert.match(said, /same suite, not because this change is covered/);
});

test('a definition file is behaviour, whatever its extension', () => {
  // A tool definition carries a schema, its effects and its risk; a node
  // template carries a role and a ceiling. Exempting every .json would have let
  // the most safety-relevant edits in the repository through unchecked.
  for (const file of ['tools/glob.json', 'nodes/backlog-plan.json', 'flows/x.flow.yaml', 'stacks/y.stack.yaml']) {
    assert.ok(testCountStagnation({
      changedFiles: [file], baselineOutput: '# tests 10', currentOutput: '# tests 10',
    }), file);
  }
});

test('prose and ordinary configuration are exempt', () => {
  for (const files of [['README.md'], ['DESIGN-SPEC.md', 'notes.txt'], ['package.json'], ['tsconfig.json']]) {
    assert.equal(testCountStagnation({
      changedFiles: files, baselineOutput: '# tests 10', currentOutput: '# tests 10',
    }), null, files.join(','));
  }
});

test('touching tests at all satisfies it, whatever the count did', () => {
  assert.equal(testCountStagnation({
    changedFiles: ['core/a.js', 'tests/a.test.js'],
    baselineOutput: '# tests 10', currentOutput: '# tests 10',
  }), null);
});

test('a count that FELL is left to testCountRegression, which says it better', () => {
  // Two sentences about one number in the same blockedReason is one too many.
  assert.equal(testCountStagnation({
    changedFiles: ['core/a.js'], baselineOutput: '# tests 10', currentOutput: '# tests 8',
  }), null);
  assert.match(testCountRegression({ baselineOutput: '# tests 10', currentOutput: '# tests 8' }), /fell from 10 to 8/);
});

test('a growing suite says nothing', () => {
  assert.equal(testCountStagnation({
    changedFiles: ['core/a.js'], baselineOutput: '# tests 10', currentOutput: '# tests 11',
  }), null);
});

test('the message is bounded: a blockedReason is read on a board', () => {
  const many = Array.from({ length: 30 }, (_, i) => `core/file${i}.js`);
  const said = testCountStagnation({
    changedFiles: many, baselineOutput: '# tests 10', currentOutput: '# tests 10',
  });
  assert.match(said, /and 26 more/);
  assert.ok(said.length < 400, `${said.length} characters is not a board notice`);
});

// --- an assertion that stopped asking (t-0108) -------------------------------
//
// t-0103's attempt ran the suite as a tool, saw ONE failing assertion, and
// edited the TEST to accept both values, then declared itself done without
// re-running the gate. The landing gate passed, because the assertion now
// accepted the wrong answer, and the reviewer approved it — REVIEW_SYSTEM says
// in as many words that "Deleted, skipped, or weakened assertions are a
// REJECT", and this was one, and it was one line in a diff.
//
// testCountStagnation cannot help: a test file WAS touched, which is what
// exempts a change from it. So the diff has to be read.

const hunk = (file, minus, plus) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,3 +1,3 @@',
  '   const x = 1;',
  ...[].concat(minus).map(l => `-${l}`),
  ...[].concat(plus).map(l => `+${l}`),
  '   done();'
].join('\n');

test('the t-0103 shape: an exact match widened to accept the old wrong answer', () => {
  const found = weakenedAssertions(hunk('tests/doctorAffordability.test.js',
    '  assert.match(findings, /can only afford 1411/);',
    '  assert.match(findings, /can only afford 14(10|11)/);'));

  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].file, 'tests/doctorAffordability.test.js');
  assert.match(found[0].why, /widened to accept more/);

  const said = weakenedAssertionProblem(found);
  assert.match(said, /made weaker rather than made to pass/);
  assert.match(said, /14\(10\|11\)/, 'quoting what it became');
  assert.match(said, /Fix the behaviour, or say in the task why the expectation itself was wrong/);
});

test('an expectation that merely CHANGED is not weaker', () => {
  // The common, legitimate edit: a test updated because the behaviour it pins
  // moved. Treating that as vandalism would make this unusable.
  assert.deepEqual(weakenedAssertions(hunk('tests/x.test.js',
    "  assert.match(out, /affords 1411/);",
    "  assert.match(out, /affords 2500/);")), []);
  assert.deepEqual(weakenedAssertions(hunk('tests/x.test.js',
    '  assert.equal(count, 10);',
    '  assert.equal(count, 12);')), []);
  // And one that got STRICTER is certainly not.
  assert.deepEqual(weakenedAssertions(hunk('tests/x.test.js',
    '  assert.match(out, /affords \\d+/);',
    '  assert.match(out, /affords 1411/);')), []);
});

test('an equality check that became a looser one is named for what it is', () => {
  const equalToOk = weakenedAssertions(hunk('tests/x.test.js',
    '  assert.equal(report.verdict, "approve");',
    '  assert.ok(report.verdict);'));
  assert.equal(equalToOk.length, 1);
  assert.match(equalToOk[0].why, /equality check became a looser one/);

  const matchToOk = weakenedAssertions(hunk('tests/x.test.js',
    '  assert.match(said, /exactly this/);',
    '  assert.ok(said);'));
  assert.equal(matchToOk.length, 1);
  assert.match(matchToOk[0].why, /pattern check became a truthiness check/);
});

test('only test files, and only assertions', () => {
  // A widened regex in application code is somebody's parser getting more
  // permissive, which is not this check's business.
  assert.deepEqual(weakenedAssertions(hunk('core/gates.js',
    '  const re = /tests 10/;',
    '  const re = /tests (10|11)/;')), []);
  // And a line with no assertion on either side is not one.
  assert.deepEqual(weakenedAssertions(hunk('tests/x.test.js',
    '  const re = /tests 10/;',
    '  const re = /tests (10|11)/;')), []);
  assert.deepEqual(weakenedAssertions(''), []);
  assert.equal(weakenedAssertionProblem([]), null);
});

test('mechanicalChecks refuses a landing whose assertion stopped asking', () => {
  const mech = mechanicalChecks({
    changedFiles: ['core/diagnostics.js', 'tests/doctorAffordability.test.js'],
    diff: hunk('tests/doctorAffordability.test.js',
      '  assert.match(findings, /can only afford 1411/);',
      '  assert.match(findings, /can only afford 14(10|11)/);'),
    task: { blastRadius: ['core/', 'tests'] },
    baselineOutput: '# tests 10', currentOutput: '# tests 12'
  });
  assert.equal(mech.ok, false);
  assert.ok(mech.problems.some(p => /made weaker rather than made to pass/.test(p)),
    mech.problems.join(' | '));
});

test('a gate the attempt ran itself and left red reaches the report', () => {
  // The landing re-runs the gates and sees only its OWN result, so an attempt
  // that ran the suite, watched it fail, and stopped is invisible from here.
  // It is a note rather than a refusal: the harness's own gate is the verdict,
  // and this says what the attempt knew before it handed the work over.
  const green = mechanicalChecks({
    changedFiles: ['core/a.js'], baselineOutput: '# tests 10', currentOutput: '# tests 12',
    workerGate: { command: 'npm test', status: 'pass', code: 0 }
  });
  assert.ok(!green.notes.some(n => /left it FAILING/.test(n)));

  const red = mechanicalChecks({
    changedFiles: ['core/a.js'], baselineOutput: '# tests 10', currentOutput: '# tests 12',
    workerGate: { command: 'npm test', status: 'fail', code: 1 }
  });
  assert.ok(red.notes.some(n => /ran "npm test" itself and left it FAILING/.test(n)),
    red.notes.join(' | '));
  assert.equal(red.ok, true, 'a note, not a refusal — the harness gate is the verdict');
});

// --- scratch scripts are not deliverables (t-0100) --------------------------
//
// Eleven artefacts across six attempts. A reviewer caught one set and parked
// the task; nothing caught the others, so the pattern was one landing away from
// main three times.

test('the eleven that actually happened are caught, and the deliverable beside them is not', () => {
  // t-0092's real worktree, verbatim: five artefacts and one genuine new test
  // file, written by the same attempt in the same minutes.
  const found = scratchArtefacts({
    addedFiles: ['516', '_dump.js', '_dump2.js', '_extract_revive.py', '_revive.txt',
      'tests/backlogRevive.test.js'],
    blastRadius: ['core/backlog.js', 'core/archive.js', 'tests']
  });
  assert.deepEqual(found, ['516', '_dump.js', '_dump2.js', '_extract_revive.py', '_revive.txt']);

  // And the other two attempts, whose artefacts share no extension with these.
  assert.deepEqual(scratchArtefacts({
    addedFiles: ['scratch_edit.py', 'scratch_edit2.py', 'scratch_edit3.py'],
    blastRadius: ['kernel/src/blocks/types.ts', 'tests']
  }).length, 3);
  assert.deepEqual(scratchArtefacts({
    addedFiles: ['fix.cjs', 'patch-parse.mjs', 'patch-parse2.mjs', '3925', '1035'],
    blastRadius: ['kernel/src/stack/parse.ts', 'tests']
  }).length, 5, 'a zero-byte file named for a number is a redirect, not a script');
});

test('a new file the task DECLARED is a deliverable, wherever it sits', () => {
  // STACK_LANG.md arrived exactly this way and must keep being able to.
  assert.deepEqual(scratchArtefacts({
    addedFiles: ['STACK_LANG.md'], blastRadius: ['core/flowlang/', 'STACK_LANG.md']
  }), []);
  // A directory in the radius covers what is under it, and only what is under it.
  assert.deepEqual(scratchArtefacts({ addedFiles: ['docs/x.md'], blastRadius: ['docs/'] }), []);
  assert.deepEqual(scratchArtefacts({ addedFiles: ['docs/x.md'], blastRadius: ['docs'] }), []);
  assert.deepEqual(scratchArtefacts({ addedFiles: ['docsy.md'], blastRadius: ['docs'] }), ['docsy.md'],
    'a prefix is not a directory');
});

test('a task that declared no blast radius has nothing to be outside of', () => {
  // The rule is "outside what the task said it would touch". With no
  // declaration there is no outside, and every one of the eleven came from a
  // task that did declare one — so this costs nothing real. An undeclared task
  // is judged by the reviewer, exactly as it already was.
  assert.deepEqual(scratchArtefacts({ addedFiles: ['_dump.js', '516'], blastRadius: [] }), []);
});

test('a legitimately new script under scripts/ is not the thing being refused', () => {
  // The other half of the rule, and the one that keeps it usable: this is about
  // files at the ROOT that nobody asked for, not about new scripts.
  assert.deepEqual(scratchArtefacts({
    addedFiles: ['scripts/release.mjs', 'scripts/bench.py'], blastRadius: ['core/']
  }), []);
});

test('a root file that was MODIFIED is ordinary, and only additions are judged', () => {
  // package.json, config.json and the living docs are edited constantly. Only
  // git-added paths reach this check, so nothing else has to be excluded by name.
  assert.deepEqual(scratchArtefacts({ addedFiles: [], blastRadius: [] }), []);
});

test('the refusal names the files, is bounded, and says what to do instead', () => {
  assert.equal(scratchArtefactProblem([]), null);
  const said = scratchArtefactProblem(['516', '_dump.js', '_dump2.js', '_extract_revive.py', '_revive.txt']);
  assert.match(said, /Created 5 new file\(s\) at the repository root/);
  assert.match(said, /and 1 more/, 'a blockedReason is read on a board');
  assert.match(said, /name it in the task's blastRadius/);
  assert.ok(said.length < 500, `${said.length} characters is not a board notice`);
});

test('mechanicalChecks refuses the landing, as a named problem and not a generic failure', () => {
  const mech = mechanicalChecks({
    changedFiles: ['core/archive.js', '_dump.js'],
    addedFiles: ['_dump.js'],
    task: { blastRadius: ['core/archive.js', 'tests'] },
    baselineOutput: '# tests 10', currentOutput: '# tests 11'
  });
  assert.equal(mech.ok, false);
  assert.ok(mech.problems.some(p => /_dump\.js/.test(p) && /not deliverables/.test(p)),
    mech.problems.join(' | '));

  // And the same change without the artefact lands.
  assert.equal(mechanicalChecks({
    changedFiles: ['core/archive.js'], addedFiles: ['tests/archive.test.js'],
    task: { blastRadius: ['core/archive.js', 'tests'] },
    baselineOutput: '# tests 10', currentOutput: '# tests 11'
  }).ok, true);
});

// --- what a task may declare the suite will do (t-0107) ---------------------
//
// Both count checks were right about the common case and wrong about three
// real ones: a pure refactor needs no new test, a deletion should take its
// tests with it, and four near-identical tests consolidated into one is an
// improvement that reads as vandalism. t-0040 is the case that forced it —
// "flip the flag, delete the old surfaces" removes the v1 DSL and the files
// that cover it, and as things stood it could not land.

test('the vocabulary is closed, and a value outside it is a mistake, not a default', () => {
  // The failure a declaration must not have: a typo that silently restores
  // strict checking, so the author believes they declared something and the
  // gate believes they declared nothing.
  assert.deepEqual(SUITE_EXPECTATIONS, ['grows', 'unchanged', 'shrinks']);
  for (const v of SUITE_EXPECTATIONS) assert.equal(suiteExpectation({ suiteExpectation: v }), v);
  assert.equal(suiteExpectation({ suiteExpectation: 'SHRINKS' }), 'shrinks', 'case is not the point');
  assert.equal(suiteExpectation({}), null, 'declaring nothing is the strict default');

  assert.equal(suiteExpectationProblem({}), null);
  assert.equal(suiteExpectationProblem({ suiteExpectation: 'grows' }), null);
  assert.match(suiteExpectationProblem({ suiteExpectation: 'fewer' }), /"fewer".*not one of grows, unchanged, shrinks/s);
});

test('a task that declares nothing is checked exactly as it was before', () => {
  // Forgetting to declare must never silently disable a check.
  assert.match(testCountRegression({ baselineOutput: '# tests 10', currentOutput: '# tests 8' }),
    /green because there is less of it/);
  assert.match(testCountStagnation({
    changedFiles: ['core/a.js'], baselineOutput: '# tests 10', currentOutput: '# tests 10'
  }), /did not move/);
});

test('a declared fall is earned by deleting test FILES, not by removing assertions', () => {
  // The blank cheque this must not be. Tests taken out of a file that still
  // exists is precisely how the gate would be gamed, and the count cannot tell
  // that apart from a feature leaving — but git can.
  const task = { suiteExpectation: 'shrinks' };
  const io = { baselineOutput: '# tests 1936', currentOutput: '# tests 1919' };

  assert.equal(testCountRegression({ ...io, task, deletedFiles: ['tests/flowlang.test.js'] }), null,
    'the v1 DSL leaving takes its tests with it');

  const gamed = testCountRegression({ ...io, task, deletedFiles: [] });
  assert.match(gamed, /no file under tests\/ was deleted/);
  assert.match(gamed, /removing the tests with the feature, not by removing assertions/);

  // A deletion somewhere else does not account for it either.
  assert.match(testCountRegression({ ...io, task, deletedFiles: ['src/FlowCanvas.jsx'] }),
    /no file under tests\/ was deleted/);
});

test('a declared "unchanged" is what a refactor needs, and only that', () => {
  const io = { changedFiles: ['core/flowRunner.js', 'core/gates.js'] };
  assert.equal(testCountStagnation({
    ...io, task: { suiteExpectation: 'unchanged' },
    baselineOutput: '# tests 10', currentOutput: '# tests 10'
  }), null);

  // It buys the count standing still, not the count falling: that is the other
  // check's business and it has its own declaration.
  assert.match(testCountRegression({
    task: { suiteExpectation: 'unchanged' }, deletedFiles: ['tests/a.test.js'],
    baselineOutput: '# tests 10', currentOutput: '# tests 8'
  }), /green because there is less of it/);
});

test('a prediction that was wrong is reported, and does not block the landing', () => {
  // Refusing a landing because the suite grew MORE than predicted would punish
  // the better outcome. It must not pass unremarked either — a prediction
  // nobody checks is not a prediction.
  const wrong = suiteExpectationMismatch({
    task: { suiteExpectation: 'shrinks' }, changedFiles: ['core/a.js'],
    baselineOutput: '# tests 10', currentOutput: '# tests 14'
  });
  assert.match(wrong, /declared the suite would be "shrinks" and it grew \(10 → 14\)/);
  assert.match(wrong, /the landing stands/);

  assert.match(suiteExpectationMismatch({
    task: { suiteExpectation: 'grows' }, changedFiles: ['core/a.js'],
    baselineOutput: '# tests 10', currentOutput: '# tests 10'
  }), /would be "grows" and it did not move/);

  // Right, or undeclared, or unreadable: nothing to say.
  assert.equal(suiteExpectationMismatch({
    task: { suiteExpectation: 'shrinks' }, baselineOutput: '# tests 10', currentOutput: '# tests 8'
  }), null);
  assert.equal(suiteExpectationMismatch({ task: {}, baselineOutput: '# tests 10', currentOutput: '# tests 8' }), null);
  assert.equal(suiteExpectationMismatch({
    task: { suiteExpectation: 'grows' }, baselineOutput: null, currentOutput: '# tests 8'
  }), null);
  // A docs-only change predicted to grow is not a wrong prediction about the
  // suite; it is a change that was only prose.
  assert.equal(suiteExpectationMismatch({
    task: { suiteExpectation: 'grows' }, changedFiles: ['README.md'],
    baselineOutput: '# tests 10', currentOutput: '# tests 10'
  }), null);
});

test('t-0040 is the worked example: it declares a fall and it lands', () => {
  // The task that forced this to exist, run through the checks it was blocked by.
  //
  // Read as DATA, not from .flyt/backlog/t-0040.task.md — and that is the point
  // rather than a shortcut. The backlog lives outside every worktree, which is
  // what stops a worker declaring its own escape hatch mid-attempt; a test that
  // reads it therefore passes on main and fails in every worktree the loop
  // creates. This one did, and the loop found it on the next task: ENOENT on a
  // path that is deliberately not in the checkout.
  const t0040 = { suiteExpectation: 'shrinks', blastRadius: ['src/', 'core/'] };
  const cutover = {
    // Deleting the v1 DSL takes flowlang's files with it — 17 tests in flowlang
    // alone, out of 143 files.
    deletedFiles: ['tests/flowlang.test.js', 'tests/flowlangLint.test.js', 'src/FlowCanvas.jsx'],
    baselineOutput: '# tests 1956', currentOutput: '# tests 1921'
  };
  assert.equal(testCountRegression({ task: t0040, ...cutover }), null, 'and so it can land');
  assert.equal(suiteExpectationMismatch({
    task: t0040, changedFiles: ['core/flowstore.js'],
    baselineOutput: cutover.baselineOutput, currentOutput: cutover.currentOutput
  }), null, 'and the prediction was right');

  // Without the declaration it is refused, which is where t-0040 stood before.
  assert.match(testCountRegression({ task: {}, ...cutover }), /green because there is less of it/);
});

test('mechanicalChecks reads one declaration for both checks, and reports a bad one', () => {
  const strict = mechanicalChecks({
    changedFiles: ['core/a.js'], deletedFiles: ['tests/a.test.js'], task: {},
    baselineOutput: '# tests 10', currentOutput: '# tests 8'
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.problems.some(p => /green because there is less of it/.test(p)));

  const declared = mechanicalChecks({
    changedFiles: ['core/a.js'], deletedFiles: ['tests/a.test.js'],
    task: { suiteExpectation: 'shrinks' },
    baselineOutput: '# tests 10', currentOutput: '# tests 8'
  });
  assert.equal(declared.ok, true, declared.problems.join(' '));

  const typo = mechanicalChecks({
    changedFiles: ['core/a.js'], deletedFiles: ['tests/a.test.js'],
    task: { suiteExpectation: 'shrink' },
    baselineOutput: '# tests 10', currentOutput: '# tests 8'
  });
  assert.equal(typo.ok, false);
  assert.ok(typo.problems.some(p => /not one of grows, unchanged, shrinks/.test(p)),
    'the typo is the finding, not silent strictness');
});

test('a check that could not run says so, rather than nothing', () => {
  // Both count checks return null for "cannot tell", which is indistinguishable
  // from "looked and it was fine". The first task of a session has no baseline
  // at all — it comes from the previous task's canary output.
  assert.match(testCountUncheckable(null, '# tests 10'), /no baseline/);
  assert.match(testCountUncheckable('nothing parseable', '# tests 10'), /no test count could be read/);
  assert.equal(testCountUncheckable('# tests 10', '# tests 10'), null);
});


test('protected paths are the reflexive-modification hole, and are closed by rule', () => {
  const files = ['core/gates.js', '.flyt/config.json', '.flyt/backlog/t-0001.task.md', 'src/app.js'];
  assert.deepEqual(protectedViolations(files), ['.flyt/config.json', '.flyt/backlog/t-0001.task.md']);
  // ...unless the task is explicitly about them, which lands with a human.
  assert.deepEqual(protectedViolations(files, { allow: ['.flyt/config.json'] }), ['.flyt/backlog/t-0001.task.md']);

  // The benchmark is the exam (§12.1). A task that can edit the suite or the
  // scores it is measured by is not being measured.
  assert.deepEqual(
    protectedViolations(['benchmark/pure-function.bench.md', '.flyt/scores/x.json', '.flyt/archive/2026-08-13/day.json']),
    ['benchmark/pure-function.bench.md', '.flyt/scores/x.json', '.flyt/archive/2026-08-13/day.json']);
  // A task whose whole job IS adding a case says so up front and lands with a
  // human's approval, exactly like one that widens the gates.
  assert.deepEqual(protectedViolations(['benchmark/new-case.bench.md'], { allow: ['benchmark/'] }), []);
});

// --- worktrees -------------------------------------------------------------

test('a branch name survives whatever a model calls a task', () => {
  assert.equal(slugify('Add `grep`: search/replace!! (finally)'), 'add-grep-search-replace-finally');
  assert.equal(slugify(''), 'task');
  assert.match(branchFor('t-0001', 'Fix the thing'), /^flyt\/t-0001-fix-the-thing$/);
});

test('each task gets its own worktree, outside the repo, and throwing it away is a delete', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));

  const wt = await pool.create('t-0001', 'Add a thing');
  assert.ok(fs.existsSync(wt.dir));
  assert.ok(!wt.dir.startsWith(root), 'outside the repo: a nested checkout confuses every tool');
  assert.equal(wt.branch, 'flyt/t-0001-add-a-thing');

  fs.writeFileSync(path.join(wt.dir, 'new.js'), 'export const x = 1;\n');
  assert.equal(await pool.hasChanges('t-0001'), true);
  assert.deepEqual(await pool.changedFiles('t-0001', { base: 'main' }), ['new.js']);
  const sha = await pool.commit('t-0001', 'add new.js');
  assert.match(sha, /^[0-9a-f]{40}$/);

  // The base branch is untouched until something merges.
  assert.ok(!fs.existsSync(path.join(root, 'new.js')));
  assert.match(await pool.diff('t-0001', { base: 'main' }), /\+export const x = 1;/);

  // Cleanup reports a named outcome now, not a boolean: "I did not delete it"
  // has four meanings and the one that matters — somebody else owns this — must
  // never be silent (WR-02).
  assert.equal((await pool.remove('t-0001', { deleteBranch: true })).outcome, 'removed');
  assert.ok(!fs.existsSync(wt.dir), 'a failed task is thrown away by deleting a directory');
});

// --- the reviewer ----------------------------------------------------------

test('an unusable review is never an approval', () => {
  assert.equal(parseReview('```json\n{"verdict":"approve","reason":"fine"}\n```').verdict, 'approve');
  // Fail-closed: this is the gate that decides what reaches main.
  assert.equal(parseReview('```json\n{"verdict":"lgtm!"}\n```').verdict, 'request-changes');
  assert.equal(parseReview('I like it'), null);
});

test('a reviewer that cannot be reached blocks the landing', async () => {
  // Unconfigured, unreachable and unparseable must all mean "do not land",
  // never "land unreviewed".
  assert.equal(reviewWorker({}), null);
  const none = await reviewDiff({ worker: null, task: {}, diff: 'x' });
  assert.equal(none.verdict, 'request-changes');
  assert.equal(none.unavailable, true);

  setScript(() => { throw new Error('provider down'); });
  const down = await reviewDiff({
    worker: { provider: 'script', model: 'm' }, task: {}, diff: 'x', retry: { attempts: 1, baseMs: 1 }
  });
  assert.equal(down.verdict, 'request-changes');
  assert.match(down.reason, /could not be completed/);
});

test('a gate this machine cannot run is caught before the work, not after it', () => {
  // A task may ADD gates and may never remove them, which is right and has a
  // sharp edge: a task declaring a gate the project cannot run is unlandable
  // however good the work is, and nothing said so until the work was finished
  // and paid for. Nine of this project's thirteen backlog tasks arrived asking
  // for `pytest` in a repository with no Python; three more declared the
  // literal command `none`.
  assert.equal(gateProblem('npm test'), null);
  assert.match(gateProblem('pytest -q'), /`pytest` is not an executable command/);
  assert.match(gateProblem('none'), /`none` is not an executable/);
  assert.match(gateProblem('   '), /empty gate command/);

  // Only the interpreter, and only for existence: whether the suite passes is
  // the gate's own business, and running it to find out is what it is for.
  assert.equal(gateProblem('npm run lint -- --fix'), null);
  // A shell line is the caller's business — we do not try to parse one.
  assert.equal(gateProblem('npm test | tee out.txt'), null);
  assert.equal(gateProblem('npm test && npm run lint'), null);

  assert.deepEqual(unrunnableGates(['npm test', 'pytest']).map(g => g.command), ['pytest']);
  assert.deepEqual(unrunnableGates([]), []);
});

test('a configured reviewer keeps the key it was stamped with', async () => {
  // The worker the main process builds carries its provider's key. reviewDiff
  // used to spread `apiKey` unconditionally over it, so every caller that had
  // no separate key to pass — which is all of them — blanked it, the call
  // failed on a missing key, and the failure surfaced only as "the review could
  // not be completed". Nothing could land unattended, for a reason that looked
  // like the reviewer's opinion.
  let seen = null;
  setScript(({ apiKey }) => { seen = apiKey; return '```json\n{"verdict":"approve","reason":"fine"}\n```'; });
  const ok = await reviewDiff({
    worker: { provider: 'script', model: 'm', apiKey: 'sk-stamped' }, task: {}, diff: 'x'
  });
  assert.equal(ok.verdict, 'approve');
  assert.equal(seen, 'sk-stamped');

  // An explicitly passed key still wins.
  await reviewDiff({ worker: { provider: 'script', model: 'm', apiKey: 'sk-stamped' }, apiKey: 'sk-explicit', task: {}, diff: 'x' });
  assert.equal(seen, 'sk-explicit');
});

test('the reviewer is told the test delta, and told when it is unknown', () => {
  // A reviewer reading a diff cannot run the suite, so "green" and "green
  // because it is the same suite" look identical from where it sits. The count
  // standing still is the whole tell, and it has to be a fact in front of it
  // rather than something it is expected to infer.
  const stood = buildReviewPrompt({
    task: { title: 'Add retirement' }, diff: 'diff --git a/core/backlog.js',
    testDelta: { before: 1721, after: 1721 }
  });
  assert.match(stood, /TEST COUNT: 1721 before this change, 1721 after — UNCHANGED/);
  assert.match(stood, /judge whether this change is actually covered/);

  const grew = buildReviewPrompt({
    task: {}, diff: 'x', testDelta: { before: 1721, after: 1730 }
  });
  assert.match(grew, /TEST COUNT: 1721 before this change, 1730 after$/m);
  assert.ok(!/UNCHANGED/.test(grew));

  // Unknown is said out loud. Saying nothing would read as "checked, fine".
  for (const delta of [null, { before: null, after: 10 }, { before: 10, after: null }]) {
    assert.match(buildReviewPrompt({ task: {}, diff: 'x', testDelta: delta }),
      /TEST COUNT: not known for this change/);
  }
});

test('a roll-up review sees the landed contracts that are already in its base', () => {
  const prompt = buildReviewPrompt({
    task: {
      title: 'Phase 4',
      body: 'Bring the decomposed pieces together.',
      dependsOn: ['t-trust', 't-skill'],
    },
    dependencyEvidence: [
      { id: 't-trust', title: 'Classify plugin tools', status: 'landed', body: '## Done when\n\n- unknown effects resolve upward' },
      { id: 't-skill', title: 'Bound skill requests', status: 'landed', body: '## Done when\n\n- unattended grants are refused' },
    ],
    diff: 'diff --git a/src/integration.js b/src/integration.js',
  });
  assert.match(prompt, /LANDED DEPENDENCY EVIDENCE/);
  assert.match(prompt, /t-trust: Classify plugin tools \[landed\]/);
  assert.match(prompt, /unknown effects resolve upward/);
  assert.match(prompt, /t-skill: Bound skill requests \[landed\]/);
  assert.match(prompt, /unattended grants are refused/);
  assert.match(prompt, /DIFF:\ndiff --git a\/src\/integration\.js/);
});

test('a substantial cross-cutting diff reaches the reviewer whole', () => {
  const tail = 'THE-FINAL-TEST-AND-FILE';
  const diff = `${'x'.repeat(90_000)}${tail}`;
  const prompt = buildReviewPrompt({ task: { title: 'Large task' }, diff });
  assert.match(prompt, new RegExp(tail));
  assert.ok(!prompt.includes('diff truncated'), 'the old 60k blind spot must stay closed');
});

test('dependency setup runs only when an npm manifest changed', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const calls = [];
  const run = async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    return { command, status: 'pass', code: 0, output: '', ms: 1 };
  };
  assert.equal((await syncChangedDependencies({ dir: root, changedFiles: ['src.js'], run })).skipped, true);
  const synced = await syncChangedDependencies({ dir: root, changedFiles: ['package.json'], run });
  assert.equal(synced.ok, true);
  assert.equal(synced.skipped, undefined);
  assert.deepEqual(calls, [{
    command: 'npm install --ignore-scripts --no-audit --no-fund',
    cwd: root,
  }]);
});

test('a bulk added provider snapshot is manifested without hiding integration or tests', () => {
  const added = (file, body) => [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
  const changed = (file, marker) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old',
    `+${marker}`,
    '',
  ].join('\n');
  const payload = [
    added('.flyt/skills/impeccable/SKILL.md', 'provider entrypoint'),
    ...Array.from({ length: 30 }, (_, i) => added(
      `.flyt/skills/impeccable/reference/generated-${i}.md`,
      `${i}-${'vendor payload '.repeat(500)}`,
    )),
    changed('core/skills.js', 'INTEGRATION-TAIL'),
    added('tests/impeccablePlugin.test.js', 'TEST-TAIL'),
  ].join('');

  const evidence = packageReviewDiff(payload);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.summarized, true);
  assert.match(evidence.text, /BULK ADDED SNAPSHOT: \.flyt\/skills\/impeccable\//);
  assert.match(evidence.text, /generated-29\.md .* sha256:[a-f0-9]{16}/);
  assert.match(evidence.text, /provider entrypoint/);
  assert.match(evidence.text, /INTEGRATION-TAIL/);
  assert.match(evidence.text, /TEST-TAIL/);
  assert.ok(!evidence.text.includes('diff truncated'));
  assert.ok(evidence.text.length <= 120_000);
});

test('an oversized patch with no identifiable package snapshot fails closed', () => {
  const evidence = packageReviewDiff('x'.repeat(120_001));
  assert.equal(evidence.complete, false);
  assert.match(evidence.text, /REVIEW EVIDENCE INCOMPLETE/);
  assert.match(evidence.text, /do not approve/i);
});

test('a deletion-heavy cutover manifests source deletions but keeps deleted tests and integration inline', () => {
  const deleted = (file, marker, lines = 8000) => [
    `diff --git a/${file} b/${file}`,
    'deleted file mode 100644',
    `--- a/${file}`,
    '+++ /dev/null',
    `@@ -1,${lines} +0,0 @@`,
    ...Array.from({ length: lines }, (_, i) => `-${marker}-${i}`),
    '',
  ].join('\n');
  const changed = (file, marker) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old',
    `+${marker}`,
    '',
  ].join('\n');
  const payload = [
    deleted('src/OldApp.jsx', 'OLD-UI'),
    deleted('src/OldCanvas.jsx', 'OLD-CANVAS'),
    deleted('tests/oldApp.test.js', 'DELETED-ASSERTION', 20),
    changed('src/Root.jsx', 'CUTOVER-INTEGRATION'),
  ].join('');

  const evidence = packageReviewDiff(payload);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.summarized, true);
  assert.deepEqual(evidence.deleted, ['src/OldApp.jsx', 'src/OldCanvas.jsx']);
  assert.match(evidence.text, /BULK DELETION MANIFEST/);
  assert.match(evidence.text, /src\/OldApp\.jsx .* sha256:[a-f0-9]{16}/);
  assert.ok(!evidence.text.includes('OLD-UI-1499'), 'deleted source bodies are represented by the manifest');
  assert.match(evidence.text, /DELETED-ASSERTION-19/, 'deleted test bodies remain reviewable');
  assert.match(evidence.text, /CUTOVER-INTEGRATION/);
  assert.ok(evidence.text.length <= 120_000);
});

test('the reviewer is told which files left the declared blast radius', () => {
  const prompt = buildReviewPrompt({
    task: { title: 'Add tag filtering' },
    diff: 'diff --git a/src.js',
    gates: [{ command: 'npm test', status: 'pass', code: 0 }],
    blastRadius: ['src/'],
    changedFiles: ['src/store.js', 'package.json']
  });
  assert.match(prompt, /FILES CHANGED OUTSIDE THAT RADIUS:\n- package\.json/);
  assert.match(prompt, /npm test: pass/);
});

// --- the full sequence -----------------------------------------------------

const approving = () => setScript(({ system }) => {
  if (/ROLE: diff-review/.test(system)) return '```json\n{"verdict":"approve","reason":"Does what the task asked."}\n```';
  return 'ok';
});

test('a task that changed nothing is a failure, and does not cost a review to notice', async () => {
  // An empty diff is not a diff to review, it is the absence of one. Asking a
  // model buys a paragraph explaining that the diff is empty — which is free to
  // know, and which every failed attempt would pay for again. Seen live: a task
  // whose target file does not exist in this repository produced no change on
  // three consecutive attempts.
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0001', 'Change nothing');
  let reviewed = false;
  setScript(({ system }) => {
    if (/ROLE: diff-review/.test(system)) reviewed = true;
    return '```json\n{"verdict":"approve","reason":"fine"}\n```';
  });

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0001', base: 'main',
    task: { title: 'Change nothing' },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    verify: async () => runGates([SUITE], { cwd: root })
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'no-changes');
  assert.equal(reviewed, false, 'no reviewer was asked about an empty diff');
  // The two ways to get here need different answers from the next attempt.
  assert.match(result.guidance, /write it into the workspace/);
  assert.match(result.guidance, /needs a person to close it/);
  // And nothing was merged: an empty merge commit would attest on the base
  // branch to work that did not happen.
  assert.equal((await git(['rev-list', '--count', 'main'], { cwd: root })).trim(), '1');
});

test('a deliverable git is ignoring is not "no change", and says so', async () => {
  // The third way to reach an empty diff, and the one that reads as the first.
  // `git status --porcelain` omits ignored files, so a task whose deliverable
  // lands in a gitignored directory produces work that is invisible to every
  // check above — and the old guidance told the next attempt to write the file
  // into the workspace, which is exactly what it had just done. Every attempt
  // would do it again, and every one would cost.
  const root = await makeRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), 'notes/\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'ignore notes'], { cwd: root });

  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0001', 'Write the note');
  const dir = pool.dirFor('t-0001');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), '# the deliverable\n');

  let reviewed = false;
  setScript(({ system }) => {
    if (/ROLE: diff-review/.test(system)) reviewed = true;
    return '```json\n{"verdict":"approve","reason":"fine"}\n```';
  });

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0001', base: 'main',
    task: { title: 'Write the note' },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    verify: async () => runGates([SUITE], { cwd: root })
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'no-changes');
  assert.equal(reviewed, false);
  assert.deepEqual(result.ignored, ['notes/plan.md'], 'the file is named, not merely counted');
  assert.match(result.guidance, /git is ignoring/);
  assert.match(result.guidance, /notes\/plan\.md/);
  assert.match(result.guidance, /Writing it again will not help/,
    'the one thing the old guidance told it to do');
  assert.ok(!/write it into the workspace/.test(result.guidance));
});

test('a task lands on main by itself when the gates and the reviewer agree', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0001', 'Add a feature');
  fs.writeFileSync(path.join(pool.dirFor('t-0001'), 'feature.js'), 'export const feature = true;\n');
  await pool.commit('t-0001', 'add feature');
  approving();

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0001', base: 'main',
    task: { title: 'Add a feature', blastRadius: ['feature.js'] },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    verify: async () => runGates([SUITE], { cwd: root })
  });

  assert.equal(result.landed, true, JSON.stringify(result.steps));
  assert.equal(result.review.verdict, 'approve');
  // It is really on main, as a merge commit that can be reverted in one move.
  assert.ok(fs.existsSync(path.join(root, 'feature.js')));
  const log = await git(['log', '--oneline', '-1', 'main'], { cwd: root });
  assert.match(log, /Add a feature/);
  assert.equal((await git(['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: root })).split(' ').length, 3, 'a real merge commit');
  // The green canary comes back with the landing. It is the only trustworthy
  // "before" for the NEXT task's test-count check (§7.3), and it has just been
  // run — asking for it again would be a second full suite for a number we
  // already have.
  assert.match(result.canaryOutput, /# tests 2/);
});

test('a dependency-changing task syncs its worktree and merged canary environment', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0001', 'Add a dependency');
  const dir = pool.dirFor('t-0001');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"local":"file:plugins/local"}}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  await pool.commit('t-0001', 'add dependency');
  approving();
  const synced = [];

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0001', base: 'main',
    task: { title: 'Add a dependency', blastRadius: ['package.json', 'package-lock.json'] },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    syncDependencies: async ({ dir: target }) => {
      synced.push(target);
      return { ok: true, command: 'fake install', status: 'pass' };
    },
    verify: async () => runGates([SUITE], { cwd: root })
  });

  assert.equal(result.landed, true, JSON.stringify(result.steps));
  assert.deepEqual(synced, [dir, root]);
  assert.ok(result.steps.some(step => step.step === 'dependencies'));
});

test('a reverted dependency change restores the base dependency tree', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0001', 'Add a bad dependency');
  const dir = pool.dirFor('t-0001');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  await pool.commit('t-0001', 'add dependency');
  approving();
  const synced = [];

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0001', base: 'main',
    task: { title: 'Add a bad dependency', blastRadius: ['package.json', 'package-lock.json'] },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    syncDependencies: async ({ dir: target }) => {
      synced.push(target);
      return { ok: true, command: 'fake install', status: 'pass' };
    },
    verify: async () => ({
      ok: false,
      results: [{ command: SUITE, status: 'fail', code: 1, output: 'dependency broke main' }],
      failure: { command: SUITE, status: 'fail', code: 1, output: 'dependency broke main' },
    })
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'canary');
  assert.deepEqual(synced, [dir, root, root]);
});

test('a change that passes alone but breaks main is reverted, not left behind', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0002', 'Innocent change');
  fs.writeFileSync(path.join(pool.dirFor('t-0002'), 'innocent.js'), 'export const ok = 1;\n');
  await pool.commit('t-0002', 'innocent');
  approving();

  const before = await git(['rev-parse', 'main'], { cwd: root });
  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0002', base: 'main',
    task: { title: 'Innocent change' },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    // The canary: green in the worktree, red once merged. Two branches that
    // each pass in isolation can fail together, and with tasks landing hourly
    // that will happen.
    verify: async () => runGates([SUITE], { cwd: root, env: { ...process.env, BREAK: '1' } })
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'canary');
  assert.match(result.guidance, /broke main once merged/);
  // Reverted, not reset: the merge may already be pushed, and rewriting
  // published history is a worse problem than an extra commit.
  const head = await git(['log', '--oneline', '-1'], { cwd: root });
  assert.match(head, /Revert/);
  assert.notEqual(await git(['rev-parse', 'main'], { cwd: root }), before);
  assert.ok(!fs.existsSync(path.join(root, 'innocent.js')), 'main is back to working');
});

test('a red suite never reaches the reviewer, and the failure comes back as guidance', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0003', 'Broken work');
  await pool.commit('t-0003', 'nothing yet');
  let reviewed = false;
  setScript(({ system }) => { if (/diff-review/.test(system)) reviewed = true; return 'ok'; });

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0003', base: 'main',
    task: { title: 'Broken work', gates: [`${NODE} -e "console.error('2 tests failed'); process.exit(1)"`] },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } }
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'gates');
  assert.equal(reviewed, false, 'no point paying a reviewer to look at a red suite');
  assert.match(result.guidance, /2 tests failed/, 'the exact error is the useful part');
});

test('a rejected review stops the landing and says what to change', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0004', 'Scope creep');
  fs.writeFileSync(path.join(pool.dirFor('t-0004'), 'extra.js'), 'export const extra = 1;\n');
  await pool.commit('t-0004', 'extra');
  setScript(({ system }) => (/diff-review/.test(system)
    ? '```json\n{"verdict":"request-changes","reason":"Refactors unrelated code.","changes":["Drop the rename in extra.js"]}\n```'
    : 'ok'));

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0004', base: 'main',
    task: { title: 'Scope creep' },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
    verify: async () => ({ ok: true, results: [] })
  });
  assert.equal(result.landed, false);
  assert.equal(result.stage, 'review');
  assert.match(result.guidance, /Drop the rename/);
  assert.ok(!fs.existsSync(path.join(root, 'extra.js')));
});

// The suite runs inside a worktree on every loop task, and `.flyt/` is not in
// one — the backlog, the ledger and the incidents live beside the repository,
// not in it, which is what stops a worker editing the queue that ranks it. So a
// test that reads `.flyt/` passes on main and fails on every task the loop
// runs, and it fails as an ENOENT naming a path the reader has no reason to
// expect. One did: t-0107's worked example read the real t-0040 task file, and
// the next loop task found it.
test('no test reads .flyt/ out of the checkout, because a worktree has none', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const problems = [];
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of source.split('\n')) {
      // A literal '.flyt' joined onto cwd or a repo root. Temp-directory
      // fixtures build their own `.flyt` and are the normal, correct thing —
      // those never start from process.cwd().
      if (/process\.cwd\(\)[^;\n]*['"]\.flyt['"]|['"]\.flyt['"][^;\n]*process\.cwd\(\)/.test(line)) {
        problems.push(`${name}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(problems, [], 'these pass on main and fail in every worktree');
});

test('a task cannot edit the queue that ranks it or the gates that judge it', () => {
  const mech = mechanicalChecks({
    changedFiles: ['core/thing.js', '.flyt/backlog/t-0001.task.md'],
    task: { title: 'Sneaky' }
  });
  assert.equal(mech.ok, false);
  assert.match(mech.problems[0], /protected path/);

  // And green-with-fewer-tests is caught before a reviewer is even asked.
  const fewer = mechanicalChecks({
    changedFiles: ['src/x.js'], task: {},
    baselineOutput: '# tests 621', currentOutput: '# tests 600'
  });
  assert.equal(fewer.ok, false);
  assert.match(fewer.problems[0], /less of it/);
});

test('a failed mechanical check preserves the exact attempt commit for correction', async () => {
  const root = await makeRepo({ tests: 2 });
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0006', 'Keep failed check work');
  fs.appendFileSync(path.join(pool.dirFor('t-0006'), 'src.js'), 'export const changed = true;\n');
  const head = await pool.commit('t-0006', 'useful work before check failure');

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0006', base: 'main',
    task: { title: 'Keep failed check work' },
    baselineOutput: '# tests 3',
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } },
  });

  assert.equal(result.landed, false);
  assert.equal(result.stage, 'checks');
  assert.equal(result.attemptCommit, head.trim());
  assert.match(result.guidance, /fell from 3 to 2/);
});

test('dry run approves without merging — the posture for the first nights', async () => {
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  await pool.create('t-0005', 'Careful');
  fs.writeFileSync(path.join(pool.dirFor('t-0005'), 'careful.js'), 'export const c = 1;\n');
  await pool.commit('t-0005', 'careful');
  approving();

  const result = await landTask({
    pool, repoRoot: root, taskId: 't-0005', base: 'main', dryRun: true,
    task: { title: 'Careful' },
    config: { workers: { reviewer: { provider: 'script', model: 'm' } }, retry: { attempts: 1, baseMs: 1 } }
  });
  assert.equal(result.landed, false);
  assert.equal(result.stage, 'dry-run');
  assert.equal(result.approved, true);
  assert.ok(!fs.existsSync(path.join(root, 'careful.js')), 'nothing merged itself');
});

// --- the pin ---------------------------------------------------------------

test('the pin only advances to a revision that proved itself, and refusing is not an error', async () => {
  const pinDir = tmp();
  const ok = name => async () => ({ ok: true, name });
  const bad = name => async () => ({ ok: false, name, detail: 'the suite is red' });

  const first = await advancePin({ pinDir, revision: 'aaa1111', checks: [ok('suite'), ok('self-test')] });
  assert.equal(first.advanced, true);
  assert.equal(readPin(pinDir).revision, 'aaa1111');

  // A merge that breaks the gate runner breaks the thing that would revert it.
  // The supervisor keeps running the old pin, and says why.
  const refused = await advancePin({ pinDir, revision: 'bbb2222', checks: [ok('suite'), bad('self-test')] });
  assert.equal(refused.advanced, false);
  assert.match(refused.reason, /self-test failed/);
  assert.equal(readPin(pinDir).revision, 'aaa1111', 'improvements reach the harness one verified step behind');

  // A failing check short-circuits the rest.
  const short = await advancePin({ pinDir, revision: 'ccc3333', checks: [bad('suite'), ok('never-run')] });
  assert.equal(short.results.length, 1);
});

test('a worktree root inside the repository is refused, loudly', async () => {
  const root = await makeRepo();
  // The first real run of this code put worktrees under the app's data root,
  // which in development IS the checkout — a worktree of the repo inside the
  // repo, which is precisely what the isolation rule forbids.
  assert.throws(() => new WorktreePool(root, path.join(root, 'worktrees')), /must live outside the repository/);
  assert.throws(() => new WorktreePool(root, root), /must live outside the repository/);

  // The default is outside every project, on every platform.
  const home = tmp();
  const base = defaultWorktreeRoot(root, { home });
  assert.ok(base.startsWith(home));
  assert.equal(isInside(root, base), false);
  // Two checkouts that share a basename do not share a worktree directory.
  assert.notEqual(defaultWorktreeRoot('/a/repo', { home }), defaultWorktreeRoot('/b/repo', { home }));
});

test('the diff of a live attempt shows what it has written, committed or not', async () => {
  // `flyt work diff <task>` is what a supervisor types to see what an attempt
  // is doing, and it answered nothing for every attempt that ever ran.
  //
  // The default base was the string 'HEAD', so it ran `git diff HEAD...HEAD` —
  // a commit against itself. And `a...b` compares two COMMITS, so even with a
  // real base it could not see an attempt that had written files and committed
  // nothing, which is the state you are looking at while one is still running.
  const root = await makeRepo();
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  const wt = await pool.create('t-0001', 'Write something');

  // Uncommitted, in a file that already existed: `git diff` sees this.
  fs.appendFileSync(path.join(wt.dir, 'src.js'), 'export const added = 1;\n');
  // Untracked: `git diff` cannot see it at all, and a new file is the most
  // common shape of a first attempt.
  fs.writeFileSync(path.join(wt.dir, 'brand-new.js'), 'export const y = 2;\n');

  // No base given — the one the attempt started from is on its owner record.
  const live = await pool.diff('t-0001');
  assert.match(live, /\+export const added = 1;/, 'work in flight is work');
  assert.match(live, /1 untracked file\(s\)/);
  assert.match(live, /brand-new\.js/, 'a file git is not tracking yet is still the attempt');

  // And once committed it is still there, rather than disappearing because the
  // comparison moved.
  await pool.commit('t-0001', 'the work');
  const settled = await pool.diff('t-0001');
  assert.match(settled, /\+export const added = 1;/);

  await pool.remove('t-0001', { deleteBranch: true });
});

test('a review cut off at its token budget says so, and one that rambled says that', async () => {
  // The loop reported "the reviewer returned no usable verdict block" twice in
  // one session and the two causes call for different things: a truncated
  // review wants a bigger budget or a smaller diff, a rambling one wants a
  // different reviewer. Saying the same sentence for both is what you say when
  // you have not looked.
  const { reviewDiff } = await import('../core/diffReview.js');
  const worker = { provider: 'script', model: 'reviewer' };

  setScript(() => '{"verdict":"approve","reason":"It does what the task asked.');  // cut mid-JSON
  const cut = await reviewDiff({ worker, task: { title: 't' }, diff: 'x', finishReason: 'length' });
  // The fake reports `stop`, so this is the prose branch — which is the point:
  // the distinction is made from what the ADAPTER said, not guessed from the text.
  assert.equal(cut.unavailable, true);
  assert.equal(cut.verdict, 'request-changes', 'an unreadable review is never an approval');
  assert.match(cut.reason, /without a verdict block/);

  setScript(() => '```json\n{"verdict":"approve","reason":"Fine."}\n```\nSome notes after it.');
  const fine = await reviewDiff({ worker, task: { title: 't' }, diff: 'x' });
  assert.equal(fine.verdict, 'approve');
  assert.equal(fine.unavailable, undefined, 'a block followed by prose is still a verdict');
});

test('the reviewer is asked for its verdict FIRST, so a cut answer still has one', async () => {
  const { REVIEW_SYSTEM } = await import('../core/diffReview.js');
  assert.match(REVIEW_SYSTEM, /START your reply with ONE ```json block/);
  assert.doesNotMatch(REVIEW_SYSTEM, /End with ONE ```json block/,
    'whatever is last is what a token budget cuts, and the verdict is the part that must survive');
});
