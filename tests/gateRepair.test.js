// A red gate over real work is a correction, not a failed attempt.
//
// The case this is about, from a live run:
//
//   12:26:15  ▶ t-0037 "Phase 2 — port the canonical set" on moonshotai/kimi-k3 (band xhigh)
//   12:30:50    t-0037 run done, $1.4964 across 40 call(s)
//   12:31:25  ✖ t-0037 gates: The gate `npm test` failed (exit 1). Output:
//
// Forty calls and a dollar fifty, and the loop's answer was to push the task up
// a band so a dearer model could read the same repository and write the same
// thing again. The rung bought nothing: more capability was never the missing
// piece, the failing test's name was.
//
// So the loop now asks whether the work is salvageable before it spends a rung,
// and hands the failures back as feedback when it is. The bound is what makes
// that safe — every path either makes progress or runs out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { git } from '../core/worktree.js';
import {
  readFailures, failureSignature, scopeOf, classify, assessRepair, relativize,
  MAX_REPAIRS, REPAIR_CEILING, BROAD_FAILURES
} from '../core/repair.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-repair-'));

// One TAP failure, with the block `node --test` actually prints under it.
function tapFailure({ n = 2, name = 'a thing works', file = 'tests/thing.test.js', line = 5,
  error = 'true !== false', code = 'ERR_ASSERTION' } = {}) {
  return [
    `not ok ${n} - ${name}`,
    '  ---',
    `  location: '${file}:${line}:1'`,
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    `    ${error}`,
    `  code: '${code}'`,
    '  ...'
  ].join('\n');
}

// The aggregate `node --test` prints for the FILE that contained a failure.
// It is not a second failure, and counting it doubles every number here.
function tapAggregate(file = 'tests/thing.test.js') {
  return [
    'not ok 9 - ' + file,
    '  ---',
    `  location: '${file}:1:1'`,
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    "  code: 'ERR_TEST_FAILURE'",
    '  ...'
  ].join('\n');
}

const suite = (...blocks) => ['TAP version 13', 'ok 1 - something unrelated passed',
  ...blocks, '1..9', '# tests 9', '# fail 1'].join('\n');

const gateFail = (output, over = {}) =>
  ({ command: 'npm test', status: 'fail', code: 1, ms: 9000, output, ...over });

// --- reading a gate's output ----------------------------------------------

test('the failures are read out of the gate output by name and place', () => {
  const found = readFailures(suite(tapFailure(), tapAggregate()));
  assert.equal(found.length, 1, 'the file-level aggregate is not a second failure');
  assert.equal(found[0].name, 'a thing works');
  assert.equal(found[0].file, 'tests/thing.test.js');
  assert.equal(found[0].detail, 'true !== false', 'the assertion is the part somebody acts on');
  assert.equal(classify(found[0]), 'assertion');
});

test('a suite that died before TAP still names what killed it', () => {
  const found = readFailures("SyntaxError: Unexpected token '}'\n    at file:///x/core/thing.js:12");
  assert.equal(found.length, 1);
  assert.equal(classify(found[0]), 'syntax');

  const missing = readFailures("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../core/gone.js'");
  assert.equal(classify(missing[0]), 'missing-module');
});

test('the signature is about which failures, not about how they were printed', () => {
  const a = readFailures(suite(tapFailure({ n: 2 }), tapFailure({ n: 3, name: 'another', line: 9 })));
  // Same two tests, reported in the other order, with different timings.
  const b = readFailures(suite(tapFailure({ n: 7, name: 'another', line: 9 }), tapFailure({ n: 8 })));
  assert.equal(failureSignature(a), failureSignature(b),
    'the same failures in a different order are the same failures');

  const c = readFailures(suite(tapFailure({ name: 'a third thing' })));
  assert.notEqual(failureSignature(a), failureSignature(c));
  assert.equal(failureSignature([]), null, 'nothing failing has no fingerprint');
});

test('scope separates a change breaking itself from a change breaking the repository', () => {
  const found = readFailures(suite(tapFailure()));
  assert.equal(scopeOf(found, ['tests/thing.test.js', 'core/thing.js']), 'local');
  assert.equal(scopeOf(found, ['core/other.js']), 'broad');
  assert.equal(scopeOf(found, ['tests\\thing.test.js']), 'local', 'a windows path is the same path');
  assert.equal(scopeOf(readFailures('SyntaxError: bad'), ['a.js']), 'unknown',
    'an output that never said where is not evidence in either direction');
});

// --- the judgement --------------------------------------------------------

test('a small local failure over real work is corrected, not escalated', () => {
  const verdict = assessRepair({
    failure: gateFail(suite(tapFailure(), tapAggregate())),
    changedFiles: ['tests/thing.test.js', 'core/thing.js'],
    repairs: 0
  });
  assert.equal(verdict.verdict, 'repair');
  assert.equal(verdict.count, 1);
  assert.equal(verdict.scope, 'local');
  assert.equal(verdict.kind, 'assertion');
});

test('a red gate over an empty diff has nothing to correct', () => {
  const verdict = assessRepair({ failure: gateFail(suite(tapFailure())), changedFiles: [], repairs: 0 });
  assert.equal(verdict.verdict, 'escalate');
  assert.match(verdict.reason, /changed no file/);
});

test('corrections run out', () => {
  const failure = gateFail(suite(tapFailure()));
  const files = ['tests/thing.test.js'];
  assert.equal(assessRepair({ failure, changedFiles: files, repairs: MAX_REPAIRS - 1 }).verdict, 'repair');
  const spent = assessRepair({ failure, changedFiles: files, repairs: MAX_REPAIRS });
  assert.equal(spent.verdict, 'escalate');
  assert.match(spent.reason, /did not get/);
});

test('the same failures after a correction end the corrections', () => {
  const failure = gateFail(suite(tapFailure()));
  const signature = failureSignature(readFailures(failure.output));
  const again = assessRepair({
    failure, changedFiles: ['tests/thing.test.js'], repairs: 1, lastSignature: signature
  });
  assert.equal(again.verdict, 'escalate');
  assert.match(again.reason, /the feedback is not landing/);

  // A DIFFERENT failure after a correction is progress, and gets another go.
  const moved = assessRepair({
    failure: gateFail(suite(tapFailure({ name: 'a different thing' }))),
    changedFiles: ['tests/thing.test.js'], repairs: 1, lastSignature: signature
  });
  assert.equal(moved.verdict, 'repair');
});

test('corrections that are working buy more rope, up to a ceiling', () => {
  const failure = gateFail(suite(tapFailure()));
  const files = ['tests/thing.test.js'];
  // One failure left, where there were four. It is converging; cutting it off
  // at MAX_REPAIRS would throw the answer away one attempt before it arrived.
  const progressing = assessRepair({ failure, changedFiles: files, repairs: MAX_REPAIRS, lastCount: 4 });
  assert.equal(progressing.verdict, 'repair');
  assert.equal(progressing.budget, REPAIR_CEILING);
  assert.equal(progressing.progressing, true);

  // But the rope is not unlimited: "fewer than last time" also describes a
  // change slowly deleting the suite.
  assert.equal(
    assessRepair({ failure, changedFiles: files, repairs: REPAIR_CEILING, lastCount: 4 }).verdict,
    'escalate');
});

test('breakage wider than the diff goes to the ladder, not to another correction', () => {
  const many = suite(...Array.from({ length: BROAD_FAILURES + 2 },
    (_, i) => tapFailure({ n: i + 2, name: `case ${i}`, file: `tests/elsewhere${i}.test.js` })));
  const broad = assessRepair({ failure: gateFail(many), changedFiles: ['core/thing.js'], repairs: 0 });
  assert.equal(broad.verdict, 'escalate');
  assert.match(broad.reason, /wider than the diff/);

  // The same number of failures, all inside the change, is a bad afternoon
  // rather than a different event.
  const mine = assessRepair({
    failure: gateFail(many),
    changedFiles: Array.from({ length: BROAD_FAILURES + 2 }, (_, i) => `tests/elsewhere${i}.test.js`),
    repairs: 0
  });
  assert.equal(mine.verdict, 'repair');
});

test('a hang gets one guess and no more', () => {
  const hung = { command: 'npm test', status: 'timeout', code: null, ms: 600_000, output: '' };
  const first = assessRepair({ failure: hung, changedFiles: ['core/thing.js'], repairs: 0 });
  assert.equal(first.verdict, 'repair');
  assert.match(first.feedback, /HUNG/);
  assert.match(first.feedback, /Raising the\s+timeout is not a fix/);
  assert.equal(assessRepair({ failure: hung, changedFiles: ['core/thing.js'], repairs: 1 }).verdict, 'escalate');
});

// --- what the model is actually told ---------------------------------------

test('the feedback names the failures and closes the cheap exits', () => {
  const { feedback } = assessRepair({
    failure: gateFail(suite(tapFailure(), tapAggregate())),
    changedFiles: ['tests/thing.test.js'], repairs: 0
  });
  assert.match(feedback, /YOUR PREVIOUS ATTEMPT IS HERE AND ITS GATES ARE RED/);
  assert.match(feedback, /not being thrown away and you are not starting over/);
  assert.match(feedback, /a thing works/, 'the failing test has to be named');
  assert.match(feedback, /tests\/thing\.test\.js:5/, 'and so does where it is');
  assert.match(feedback, /git show HEAD/, 'it has to say where the work is');
  assert.match(feedback, /Do not delete, skip or weaken a test/,
    'going green by deleting tests is the most convincing way to fail');
  assert.match(feedback, /Run `npm test` yourself/, 'the whole transcript is a command away, not a field away');
  assert.ok(!feedback.includes('something unrelated passed'),
    'the raw transcript must NOT travel: this becomes blockedReason, which the board renders');
  assert.ok(feedback.length < 2500, `the reason a person reads has to stay readable (was ${feedback.length})`);
});

test('the note that climbs the ladder is specific too', () => {
  const { feedback, verdict } = assessRepair({
    failure: gateFail(suite(tapFailure())),
    changedFiles: ['tests/thing.test.js'], repairs: MAX_REPAIRS
  });
  assert.equal(verdict, 'escalate');
  assert.match(feedback, /a thing works/,
    'a dearer model starting from "the gates failed" learns nothing it would not find out itself');
  assert.match(feedback, /correction/);
});

// --- through the real command surface --------------------------------------

// A repository whose gate is a script we control, so a landing can be made to
// fail in a specific, readable way without needing a suite.
async function repoWithGate() {
  const dataRoot = tmp();
  const folder = path.join(dataRoot, 'work');
  fs.mkdirSync(path.join(folder, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# a repository\n');
  // The gate. It fails the same way every time unless FLYT_TEST_GATE says
  // otherwise, which is how the "second attempt, different failures" case is
  // reached without waiting for a model to write anything.
  fs.writeFileSync(path.join(folder, 'gate.js'),
    'const name = process.env.FLYT_TEST_GATE ?? "a thing works";\n'
    + 'process.stdout.write(["TAP version 13", "ok 1 - fine",\n'
    + '  `not ok 2 - ${name}`, "  ---", "  location: \'tests/thing.test.js:5:1\'",\n'
    + '  "  failureType: \'testCodeFailure\'", "  error: |-", "    true !== false",\n'
    + '  "  code: \'ERR_ASSERTION\'", "  ...", "1..2", "# tests 2", "# fail 1"].join("\\n"));\n'
    + 'process.exit(1);\n');
  fs.mkdirSync(path.join(folder, '.flyt'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.flyt', 'config.json'),
    JSON.stringify({ gates: ['node gate.js'] }, null, 2));

  await git(['init', '-b', 'main'], { cwd: folder });
  await git(['config', 'user.email', 'test@example.com'], { cwd: folder });
  await git(['config', 'user.name', 'Test'], { cwd: folder });
  await git(['add', 'README.md', 'gate.js', '.flyt/config.json'], { cwd: folder });
  await git(['commit', '-m', 'first'], { cwd: folder });

  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder });
  return { api, engine, projectId, folder };
}

// The attempt a model would have made: a file written into the worktree.
async function anAttempt(api, projectId, taskId, body = 'the work\n') {
  const wt = await api.invoke('work:start', { projectId, taskId });
  fs.mkdirSync(path.join(wt.dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(wt.dir, 'tests', 'thing.test.js'), body);
  return wt;
}

test('a red gate over real work goes back at the SAME band with the failures attached', async () => {
  const { api, engine, projectId } = await repoWithGate();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'Do a thing', goal: 'g' });
  backlog.update(task.id, { level: 'medium' });

  await anAttempt(api, projectId, task.id);
  const result = await api.invoke('work:land', { projectId, taskId: task.id, dryRun: true });
  assert.equal(result.landed, false);
  assert.equal(result.stage, 'gates');
  assert.equal(result.repair.verdict, 'repair', 'one local failure over a real diff is salvageable');

  const after = backlog.get(task.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.level, 'medium', 'THE POINT: a correctable gate failure does not buy a dearer model');
  assert.equal(after.repairs, 1, 'and the correction is counted, so it is bounded');
  assert.equal(after.attempts, 1, 'the attempt is still an attempt — money was spent');
  assert.equal(after.resumeFrom, result.attemptCommit, 'the work is inherited, not rebuilt');
  assert.equal(after.resumeStage, 'gates');
  assert.ok(after.failureSignature, 'what this correction is aimed at, so a repeat is visible');
  assert.match(after.blockedReason, /a thing works/, 'the next attempt is told what is red');
  assert.match(after.blockedReason, /not starting over/);

  await api.invoke('work:discard', { projectId, taskId: task.id });
});

test('the same failure twice runs out of corrections and climbs', async () => {
  const { api, engine, projectId } = await repoWithGate();
  const backlog = engine.backlogFor(projectId);
  const task = backlog.add({ title: 'Do a thing', goal: 'g' });
  backlog.update(task.id, { level: 'medium' });

  // Correction 1: the same failure would be seen again, so it is the same
  // fingerprint — the check that stops a correction loop being a loop.
  await anAttempt(api, projectId, task.id);
  await api.invoke('work:land', { projectId, taskId: task.id, dryRun: true });
  await api.invoke('work:discard', { projectId, taskId: task.id });
  assert.equal(backlog.get(task.id).level, 'medium');

  await anAttempt(api, projectId, task.id, 'the work, corrected\n');
  const second = await api.invoke('work:land', { projectId, taskId: task.id, dryRun: true });
  assert.equal(second.repair.verdict, 'escalate');

  const after = backlog.get(task.id);
  assert.equal(after.level, 'high', 'a correction that changed nothing spends the rung it saved');
  assert.equal(after.resumeFrom, second.attemptCommit,
    'the work still travels — the dearer model starts where this one stopped, not from nothing');
  assert.match(after.blockedReason, /a thing works/);
  await api.invoke('work:discard', { projectId, taskId: task.id });
});

test('the brief tells a correcting attempt its gates are red, not that they passed', () => {
  // The supervisor builds the brief from the task file. Before `resumeStage`
  // existed, every resumed attempt was told "its gates passed; a reviewer read
  // it" — true after a review, and exactly backwards in front of a red suite.
  const source = fs.readFileSync(path.join(projectRoot, 'core', 'supervisor.js'), 'utf8');
  assert.match(source, /resumeStage === 'gates'/);
  assert.match(source, /the failures above are what is standing between it and landing/);
  assert.match(source, /gates passed; a reviewer read it/, 'the review wording is still there for reviews');
});

// The shape a gate ACTUALLY produces, which is not the shape the unit cases
// above use. A gate runs inside a worktree, so `node --test` reports
// `C:\Users\dev\.flyt\worktrees\myproject-tLWZsb3c\t-0037\tests\x.test.js`
// — absolute, Windows, and doubly-escaped by TAP's own quoting — while the diff
// is a list of repo-relative paths. Compared as strings those never intersect.
//
// Taken from the parked t-0037 in this repository's own backlog: seven
// failures, all reported that way, every one of which looked to `scopeOf` as
// though it were outside the change.
test('a failure reported from inside a worktree still matches the diff that caused it', () => {
  const root = 'C:\\Users\\dev\\.flyt\\worktrees\\myproject-tLWZsb3c\\t-0037';
  const output = suite(
    tapFailure({ n: 999, name: 'five stacks exist and each parses', file: `${root}\\tests\\phase2.test.js`, line: 40 }),
    tapFailure({ n: 733, name: 'a shipped flow can reach the web', file: `${root}\\tests\\library.test.js`, line: 101 })
  );

  const raw = readFailures(output);
  assert.equal(raw.length, 2);
  assert.ok(raw[0].file.includes('worktrees'), 'the runner really does report it absolute');

  const changed = ['tests/phase2.test.js', 'stacks/research.stack.yaml'];
  const placed = relativize(raw, changed);
  assert.equal(placed[0].file, 'tests/phase2.test.js', 'the changed file matches on its tail');
  assert.equal(placed[1].file, 'tests/library.test.js',
    'and the prefix learned from that match relativizes the ones OUTSIDE the diff too');
  assert.ok(!placed[1].file.includes('//'),
    'a doubly-escaped backslash must not normalize into a doubled slash');

  // The whole point of getting the paths right: `scopeOf` is what separates a
  // change breaking its own work from a change breaking the repository, and
  // absolute paths made it answer "broad" to both.
  assert.equal(scopeOf(placed, changed), 'mixed');
  assert.equal(scopeOf(relativize(raw, ['tests/phase2.test.js', 'tests/library.test.js']),
    ['tests/phase2.test.js', 'tests/library.test.js']), 'local');

  const verdict = assessRepair({ failure: gateFail(output), changedFiles: changed, repairs: 0 });
  assert.equal(verdict.verdict, 'repair', 'THE LIVE CASE: this is the task that burned two rungs and parked');
  assert.match(verdict.feedback, /tests\/phase2\.test\.js:40/);
  assert.ok(!verdict.feedback.includes('worktrees'),
    'and no reader is shown a machine name, a project hash and a task id');
});

// The feedback has two readers and one field to reach them both. It becomes the
// task's `blockedReason`: the correcting attempt reads the whole thing in its
// brief, and the board's collapsed card shows the first line as its sentence
// about why the task is not moving.
test('the feedback opens with a sentence a person can read on a card', () => {
  const { feedback } = assessRepair({
    failure: gateFail(suite(tapFailure())),
    changedFiles: ['tests/thing.test.js'], repairs: 0
  });
  const [line, blank] = feedback.split('\n');
  assert.match(line, /^`npm test` failed: 1 failure/, 'a sentence, naming the gate and the damage');
  assert.ok(!/^[A-Z ]+$/.test(line), 'and not an instruction shouted at somebody who is not being instructed');
  assert.equal(blank, '', 'the first line stands alone, so taking it does not take half a paragraph');
  assert.match(feedback, /YOUR PREVIOUS ATTEMPT IS HERE/, 'the model still gets its instruction');

  // A reason that already names the gate must not name it twice.
  const hung = assessRepair({
    failure: { command: 'npm test', status: 'timeout', code: null, ms: 600_000, output: '' },
    changedFiles: ['core/thing.js'], repairs: 0
  });
  assert.match(hung.feedback.split('\n')[0], /^`npm test` hung/);
});

// --- through the supervisor's own loop -------------------------------------

// What `work:land` decided is only half of it. The other half is what the LOOP
// does next: pick the task up again at the band it was already on, start its
// worktree from the work that was kept, and put the failures in front of the
// model. Driven through a fake command surface, because what is under test is
// the decision — the transitions themselves are exercised against real git and
// real files by the two `work:land` cases above.
test('the loop re-picks a corrected task at the same band, with the failures in its brief', async () => {
  const { Supervisor } = await import('../core/supervisor.js');
  const { Backlog } = await import('../core/backlog.js');
  const { correctionFields } = await import('../core/repair.js');

  const backlog = new Backlog(path.join(tmp(), 'backlog'));
  const task = backlog.add({ title: 'Do a thing', goal: 'g' });
  backlog.update(task.id, { level: 'low' });

  const assessment = assessRepair({
    failure: gateFail(suite(tapFailure())),
    changedFiles: ['tests/thing.test.js'], repairs: 0
  });
  assert.equal(assessment.verdict, 'repair');

  const briefs = [];
  let landings = 0;
  let runSeq = 0;
  const invoke = async (name, args) => {
    if (name === 'work:start') return { dir: '/tmp/wt', branch: 'b', attemptId: 'a1' };
    if (name === 'flow:run') { briefs.push(String(args.userInput ?? '')); return `run-${++runSeq}`; }
    if (name === 'work:touch') return { touched: true };
    if (name === 'run:snapshot') {
      return { meta: { stage: 'done', nodeStatus: { 'work-1': 'done' } },
        prompt: '', nodeOutputs: { 'work-1': 'finished' }, retrospectives: {} };
    }
    if (name === 'work:land') {
      landings += 1;
      // First landing: red gates over real work. Second: it was corrected.
      if (landings > 1) {
        backlog.update(args.taskId, { status: 'landed', blockedReason: null });
        return { landed: true, stage: 'landed', mergeSha: 'abc12345' };
      }
      const current = backlog.get(args.taskId);
      backlog.update(args.taskId, correctionFields(current, assessment));
      backlog.update(args.taskId, { resumeFrom: 'd'.repeat(40), resumeStage: 'gates' });
      return {
        landed: false, stage: 'gates', repair: assessment,
        guidance: assessment.feedback, attemptCommit: 'd'.repeat(40)
      };
    }
    if (name === 'work:discard') { backlog.release(args.taskId, { status: args.status ?? null }); return { removed: true }; }
    throw new Error(`unexpected command ${name}`);
  };

  const lines = [];
  const sup = new Supervisor({
    invoke, projectId: 'p', backlog, pollMs: 1, log: line => lines.push(line)
  });
  const status = await sup.run();

  assert.equal(status.landed, 1, 'the correction landed it');
  assert.equal(landings, 2, 'exactly two landings: the red one and the corrected one');
  assert.equal(briefs.length, 2, 'and exactly two attempts — no rung was spent looking for a third');

  // THE POINT. The second attempt ran on the same band as the first.
  const bands = lines.filter(l => l.startsWith('▶')).map(l => /\(band (\w+)\)|at (\w+)/.exec(l)?.[1]
    ?? /at (\w+)$/.exec(l)?.[1]);
  assert.deepEqual(bands, ['low', 'low'], 'a correctable gate failure must not buy a dearer model');

  // And the correcting attempt was actually told what to correct.
  assert.ok(!briefs[0].includes('a thing works'), 'the first attempt had nothing to inherit');
  assert.match(briefs[1], /WHY YOU ARE HERE/);
  assert.match(briefs[1], /a thing works/, 'the failing test is named in the brief');
  assert.match(briefs[1], /THE PREVIOUS ATTEMPT IS ALREADY HERE/);
  assert.match(briefs[1], /fix ONLY what is red/);
  assert.ok(!briefs[1].includes('gates passed; a reviewer read it'),
    'and it is NOT told its gates passed while it stands in front of a red suite');

  // The log says what happened and what was decided about it.
  const said = lines.join('\n');
  assert.match(said, /✖ .* gates: 1 failure/);
  assert.match(said, /tests\/thing\.test\.js:5 — a thing works/);
  assert.match(said, /↻ .* correction 1 of 2 .*\(band low\) — same model, no rung spent — work kept at dddddddd/);
  assert.ok(!/escalated to/.test(said), 'nothing climbed');
});
