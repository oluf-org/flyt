// The benchmark (LOOP-PLAN §12.1).
//
// What is under test is whether the SCORE can be trusted, which is a different
// question from whether the loop works. Three properties carry that:
//
//   a case with no probe is refused, so nothing is scored by its own say-so;
//   `landed` and `verified` are separate numbers, so a merge is not evidence;
//   two cards from different suites refuse to produce a headline delta.
//
// The clone half runs against REAL git repositories in a temp dir, for the
// reason `landing.test.js` does: a mocked clone proves nothing about whether
// the committed state is what got measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { git } from '../core/worktree.js';
import {
  parseCase, loadSuite, prepareClone, applySetup, baselineGates, seedBacklog,
  probeCase, scoreCase, scoreSuite, renderScorecard, compareCards, renderComparison,
  defaultCloneRoot, saveCard, listCards, readCard, recentCards, runBenchmark,
  DEFAULT_SUITE_DIR
} from '../core/benchmark.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-bench-'));
// Unquoted on purpose: a `probe:` value is a plain YAML scalar, exactly as a
// real case file writes it. Quoting it would test a shape nobody uses.
const NODE = process.execPath;

const CASE = ({ id = 'demo', probe = `${NODE} -e "process.exit(0)"`, setup = null, extra = '' } = {}) => [
  '---',
  `title: A demo case`,
  'level: low',
  `probe: ${probe}`,
  ...(setup ? [`setup: ${setup}`] : []),
  extra,
  '---',
  '',
  '## Goal',
  '',
  'Do the thing.'
].filter(Boolean).join('\n');

function suiteDir(cases) {
  const dir = path.join(tmp(), 'benchmark');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of Object.entries(cases)) fs.writeFileSync(path.join(dir, `${id}.bench.md`), text);
  return dir;
}

// A small repo with a passing suite, so a benchmark clone has something real to
// gate on without depending on a test runner.
async function makeRepo({ green = true } = {}) {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'test@localhost'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'suite.js'), green ? 'console.log("# tests 2");\n' : 'process.exit(1);\n');
  fs.mkdirSync(path.join(root, '.flyt'), { recursive: true });
  fs.writeFileSync(path.join(root, '.flyt', 'config.json'),
    JSON.stringify({ gates: [`${JSON.stringify(NODE)} suite.js`], gateTimeoutMs: 30000 }));
  // .flyt is committed here on purpose: the clone needs the gate config, and a
  // real repo that wants gates in its benchmark has to commit them too.
  await git(['add', '-A', '-f'], { cwd: root });
  await git(['commit', '-m', 'initial'], { cwd: root });
  return root;
}

// --- cases -----------------------------------------------------------------

test('a case scored by nothing is refused at load', () => {
  assert.throws(() => parseCase('---\ntitle: no probe\n---\nbody', 'x'), /needs a `probe`/);
  assert.throws(() => parseCase('---\nprobe: echo\n---\nbody', 'x'), /needs a title/);
  assert.throws(() => parseCase('no frontmatter', 'x'), /frontmatter/);

  const ok = parseCase(CASE(), 'demo');
  assert.equal(ok.id, 'demo');
  assert.equal(ok.weight, 1);
  assert.match(ok.body, /Do the thing/);
});

test('one bad case file is reported, not thrown past — and the report rides along', () => {
  const dir = suiteDir({ good: CASE(), bad: '---\ntitle: unprobed\n---\n' });
  const suite = loadSuite(dir);
  assert.deepEqual(suite.cases.map(c => c.id), ['good']);
  assert.equal(suite.problems.length, 1);
  assert.match(suite.problems[0].error, /probe/);

  // A suite that shrank without anyone noticing is a score that went up for no
  // reason, so the problems end up on the card.
  const card = scoreSuite({ cases: [], problems: suite.problems });
  assert.match(renderScorecard(card), /not loaded/);

  assert.deepEqual(loadSuite(dir, { only: ['good'] }).cases.map(c => c.id), ['good']);
  assert.deepEqual(loadSuite(dir, { only: ['nope'] }).cases, []);
  assert.match(loadSuite(path.join(dir, 'missing')).problems[0].error, /No suite directory/);
});

// --- the clone -------------------------------------------------------------

test('the clone is a commit, and it lives outside the repository', async () => {
  const root = await makeRepo();
  assert.ok(!defaultCloneRoot(root, { home: '/home/x' }).startsWith(root));
  await assert.rejects(
    prepareClone({ repoRoot: root, dest: path.join(root, 'inside') }),
    /must live outside the repository/);

  // A dirty working tree must not travel: a score of an uncommitted change is a
  // score nobody else can reproduce.
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'not committed');
  const clone = await prepareClone({ repoRoot: root, dest: path.join(tmp(), 'clone') });
  assert.ok(!fs.existsSync(path.join(clone.dir, 'scratch.txt')));
  assert.equal(clone.revision, await git(['rev-parse', 'HEAD'], { cwd: root }));
  // On a branch, not detached: the loop needs something to merge into.
  assert.equal(await git(['symbolic-ref', '--short', 'HEAD'], { cwd: clone.dir }), 'benchmark-base');
});

test('setup seeds a failure into the baseline, and the baseline is measured', async () => {
  const root = await makeRepo();
  const clone = await prepareClone({ repoRoot: root, dest: path.join(tmp(), 'clone') });
  const cases = [parseCase(CASE({ setup: `${NODE} -e "require('fs').writeFileSync('seeded.txt','x')"` }), 'demo')];

  const applied = await applySetup(cases, { cwd: clone.dir });
  assert.deepEqual(applied, [{ id: 'demo', ok: true }]);
  assert.ok(fs.existsSync(path.join(clone.dir, 'seeded.txt')));
  // Committed, not left dirty: every worktree branches from the base commit, so
  // an uncommitted seed is a seed the task never sees.
  assert.equal((await git(['status', '--porcelain'], { cwd: clone.dir })).trim(), '');

  const green = await baselineGates(clone.dir, cases);
  assert.equal(green.ok, true);
  assert.match(green.output, /# tests 2/);

  // The contamination case: cases share one clone, so a setup that reddens the
  // suite fails every OTHER case for reasons that have nothing to do with them.
  // It is measured rather than assumed away.
  fs.writeFileSync(path.join(clone.dir, 'suite.js'), 'process.exit(1);\n');
  const red = await baselineGates(clone.dir, cases);
  assert.equal(red.ok, false);
  assert.ok(red.failure.command.includes('suite.js'));
  assert.match(renderScorecard(scoreSuite({ cases: [], baseline: red })), /baseline was RED/);
});

test('a failing setup is reported rather than scored as a bad night for the loop', async () => {
  const root = await makeRepo();
  const clone = await prepareClone({ repoRoot: root, dest: path.join(tmp(), 'clone') });
  const applied = await applySetup([parseCase(CASE({ setup: `${NODE} -e "process.exit(2)"` }), 'demo')],
    { cwd: clone.dir });
  assert.equal(applied[0].ok, false);
});

test('the case id is the task id, so every number traces back to a file', async () => {
  const root = await makeRepo();
  const clone = await prepareClone({ repoRoot: root, dest: path.join(tmp(), 'clone') });
  const cases = [parseCase(CASE(), 'pure-function'), parseCase(CASE(), 'cli-flag')];
  const { backlog, seeded } = seedBacklog(clone.dir, cases);
  assert.deepEqual(seeded.map(t => t.id), ['pure-function', 'cli-flag']);
  assert.equal(backlog.get('pure-function').status, 'queued');
  assert.match(backlog.get('pure-function').body, /Do the thing/);
  // The same id twice is an error rather than an overwrite: a queue that
  // silently loses an entry is worse than one that refuses to take it.
  assert.throws(() => seedBacklog(clone.dir, cases), /already exists/);
});

// --- scoring ---------------------------------------------------------------

test('landing is not evidence: verified needs the probe to agree', async () => {
  const bench = parseCase(CASE(), 'demo');
  const landedTask = { status: 'landed', attempts: 1, level: 'low', startedAt: '2026-08-13T10:00:00.000Z', updatedAt: '2026-08-13T10:05:00.000Z' };

  const good = scoreCase({ bench, task: landedTask, probe: { status: 'pass', command: 'p', code: 0, ms: 1, output: '' }, spend: { usd: 0.5, calls: 3, unknown: 0 } });
  assert.equal(good.verified, true);
  assert.equal(good.ms, 5 * 60 * 1000);
  assert.equal(good.usd, 0.5);

  // The number worth staring at: the loop's gates and reviewer said done, and
  // an independent command disagreed.
  const lied = scoreCase({ bench, task: landedTask, probe: { status: 'fail', command: 'p', code: 1, ms: 1, output: 'boom' } });
  assert.equal(lied.landed, true);
  assert.equal(lied.verified, false);

  const parked = scoreCase({ bench, task: { status: 'parked', attempts: 3, blockedReason: 'stuck' }, probe: { status: 'fail', command: 'p', code: 1, ms: 1, output: '' } });
  assert.equal(parked.verified, false);
  assert.equal(parked.escalations, 2);
  assert.equal(parked.reason, 'stuck');

  // A task the loop never even created still scores, as a miss rather than a crash.
  const missing = scoreCase({ bench, task: null, probe: null });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.probe.status, 'skipped');

  // Never a silent zero: "$0" must only ever mean free (§9).
  assert.equal(scoreCase({ bench, task: landedTask, spend: { usd: 0, calls: 0, unknown: 0 } }).usd, null);
});

test('a suite total says what it does not know', () => {
  const bench = parseCase(CASE(), 'demo');
  const card = scoreSuite({
    suite: 'demo',
    cases: [
      scoreCase({ bench: { ...bench, id: 'a', weight: 1 }, task: { status: 'landed', attempts: 1 }, probe: { status: 'pass' }, spend: { usd: 1, calls: 2, unknown: 0 } }),
      scoreCase({ bench: { ...bench, id: 'b', weight: 3 }, task: { status: 'landed', attempts: 2 }, probe: { status: 'fail' } })
    ]
  });
  assert.equal(card.totals.landed, 2);
  assert.equal(card.totals.verified, 1);
  assert.equal(card.totals.unverifiedLandings, 1);
  assert.equal(card.totals.unpricedCases, 1);
  assert.equal(card.score, 0.25); // weighted: 1 of 4
  const text = renderScorecard(card);
  assert.match(text, /landed but failed their probe/);
  assert.match(text, /dollar total is partial/);
});

// --- the gradient ----------------------------------------------------------

test('two different suites refuse to produce a delta', () => {
  const mk = (ids, extra = {}) => scoreSuite({
    cases: ids.map(id => ({ id, title: id, weight: 1, verified: true, landed: true, usd: 1, ms: 1000, attempts: 1, escalations: 0, probe: { status: 'pass' }, ...extra }))
  });
  const cmp = compareCards(mk(['a', 'b']), mk(['a', 'c']));
  assert.equal(cmp.comparable, false);
  assert.equal(cmp.verdict, 'incomparable');
  assert.deepEqual(cmp.added, ['c']);
  assert.deepEqual(cmp.removed, ['b']);
  assert.match(renderComparison(cmp), /suite changed/);
});

test('better, worse, and cheaper are three different answers', () => {
  const card = (cases) => scoreSuite({ cases });
  const c = (id, { verified = true, usd = 1, attempts = 1 } = {}) =>
    ({ id, title: id, weight: 1, verified, landed: verified, usd, ms: 1000, attempts, escalations: attempts - 1, probe: { status: verified ? 'pass' : 'fail' } });

  const before = card([c('a'), c('b', { verified: false })]);
  const after = card([c('a'), c('b')]);
  const better = compareCards(before, after);
  assert.equal(better.verdict, 'better');
  assert.equal(better.cases.find(x => x.id === 'b').change, 'fixed');

  const worse = compareCards(after, before);
  assert.equal(worse.verdict, 'worse');
  assert.deepEqual(worse.regressions, ['b']);

  // Same score, less money and fewer attempts — the plan's definition of
  // progress when the pass rate is already at the ceiling.
  const cheap = compareCards(after, card([c('a', { usd: 0.4 }), c('b', { usd: 0.4 })]));
  assert.equal(cheap.verdict, 'cheaper');
  assert.equal(cheap.totals.usd.delta, -1.2);

  assert.equal(compareCards(after, after).verdict, 'same');
  assert.match(renderComparison(better), /score: 50% → 100%/);
});

test('cards are stored per suite so a comparison has two of the same thing', () => {
  const dir = path.join(tmp(), 'scores');
  const card = (suite, at) => scoreSuite({ suite, at, cases: [] });
  saveCard(dir, card('default', '2026-08-11T00:00:00.000Z'));
  saveCard(dir, card('default', '2026-08-12T00:00:00.000Z'));
  saveCard(dir, card('nightly', '2026-08-13T00:00:00.000Z'));
  assert.equal(listCards(dir).length, 3);

  const recent = recentCards(dir, { suite: 'default' });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].card.at, '2026-08-12T00:00:00.000Z'); // newest first
  assert.equal(readCard(dir, recent[0].name).suite, 'default');
  assert.equal(readCard(dir, 'nope.json'), null);
});

// --- end to end ------------------------------------------------------------

test('a benchmark run clones, works, probes, scores and cleans up after itself', async () => {
  const root = await makeRepo();
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot: repoRoot, dataRoot, userDataDir: dataRoot });

  // Two cases: one whose probe will pass because the drive "landed" it, and one
  // that nobody did anything about.
  const dir = suiteDir({
    lands: CASE({ probe: `${NODE} -e "process.exit(require('fs').existsSync('done.txt') ? 0 : 1)"` }),
    misses: CASE({ probe: `${NODE} -e "process.exit(1)"` })
  });

  // The seam. A real run hands this to the supervisor; here it stands in for
  // "the loop landed one of them", which is all the scoring needs to be true.
  const drive = async ({ projectId, clone }) => {
    fs.writeFileSync(path.join(clone.dir, 'done.txt'), 'landed');
    await git(['add', '-A'], { cwd: clone.dir });
    await git(['-c', 'user.email=t@localhost', '-c', 'user.name=T', 'commit', '-m', 'land'], { cwd: clone.dir });
    engine.backlogFor(projectId).update('lands', { status: 'landed', attempts: 1 });
    engine.ledgerFor(projectId).record({ taskId: 'lands', usd: 0.25, estimated: false });
  };

  const card = await runBenchmark({
    engine, api: { invoke: async () => {} }, repoRoot: root, suiteDir: dir,
    suite: 'e2e', cloneRoot: path.join(tmp(), 'clones'), drive
  });

  assert.equal(card.suite, 'e2e');
  assert.equal(card.baseline.ok, true);
  assert.equal(card.totals.cases, 2);
  assert.equal(card.totals.verified, 1);
  assert.equal(card.score, 0.5);

  const lands = card.cases.find(c => c.id === 'lands');
  assert.equal(lands.verified, true);
  assert.equal(lands.usd, 0.25);
  const misses = card.cases.find(c => c.id === 'misses');
  assert.equal(misses.verified, false);
  assert.equal(misses.status, 'queued');
  assert.equal(misses.probe.status, 'fail');

  // Thrown away: the whole value of a throwaway is that it leaves nothing
  // behind, including a project tab in the user's session.
  assert.equal(card.clone, null);
  assert.equal(engine.registry.listOpen().length, 0);
  assert.throws(() => engine.registry.get(path.resolve(root)), /Unknown project/);
});

test('a benchmark with no cases refuses rather than scoring 0/0 as success', async () => {
  const root = await makeRepo();
  await assert.rejects(
    runBenchmark({ engine: {}, api: {}, repoRoot: root, suiteDir: path.join(tmp(), 'empty') }),
    /No benchmark cases/);
});

// --- the shipped suite -----------------------------------------------------

test('the suite this repo ships is loadable, probed, and its scripts exist', () => {
  const { cases, problems } = loadSuite(path.join(repoRoot, DEFAULT_SUITE_DIR));
  assert.deepEqual(problems, []);
  assert.ok(cases.length >= 3, 'a suite of one case is an anecdote');
  for (const c of cases) {
    // Every probe and setup names a real file, or the first benchmark run
    // discovers it at the end of a working day.
    for (const command of [c.probe, c.setup].filter(Boolean)) {
      const script = command.split(/\s+/).find(part => part.endsWith('.mjs'));
      assert.ok(script, `${c.id}: ${command} does not name a script`);
      assert.ok(fs.existsSync(path.join(repoRoot, script)), `${c.id}: ${script} does not exist`);
    }
    assert.ok(c.body.includes('## Done when'), `${c.id}: needs a "Done when" — the probe grades against it`);
  }
});
