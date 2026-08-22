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
import { WorktreePool, git, slugify, branchFor, land, defaultWorktreeRoot, isInside } from '../core/worktree.js';
import { runGate, runGates, gatesFor, protectedViolations, testCountFrom, testCountRegression, gateProblem, unrunnableGates } from '../core/gates.js';
import { parseReview, buildReviewPrompt, reviewDiff, reviewWorker } from '../core/diffReview.js';
import { landTask, mechanicalChecks, advancePin, readPin } from '../core/landing.js';
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

  assert.match(testCountRegression('# tests 621', '# tests 604'), /fell from 621 to 604/);
  assert.equal(testCountRegression('# tests 621', '# tests 640'), null);
  // Unknowable must not silently pass as "no decrease" — that is the hole.
  assert.equal(testCountRegression('no counts here', '# tests 5'), null);
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
