// The archive (DESIGN-SPEC.md §8).
//
// The property that makes an archive an archive is that it COPIES. Every source
// it reads from keeps moving — the ledger appends, the backlog is rewritten in
// place, git grows — so a record that points at them is not a record of
// Tuesday, it is a second name for today. Most of this file is that one claim,
// checked from several directions.
//
// The rest is the trend, whose only job is to refuse to overclaim: one scored
// day is a measurement, and a direction needs two.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeArchive, listArchive, readArchive, trend, renderTrend, commitsOn, dateStamp, archiveDir } from '../core/archive.js';
import { Backlog } from '../core/backlog.js';
import { Ledger } from '../core/ledger.js';
import { scoreSuite } from '../core/benchmark.js';
import { git } from '../core/worktree.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-archive-'));
const TODAY = dateStamp();

function seeded() {
  const root = tmp();
  const backlog = new Backlog(path.join(root, 'backlog'));
  const ledger = new Ledger(path.join(root, 'ledger'));
  const landed = backlog.add({ title: 'landed thing', goal: 'x' });
  backlog.update(landed.id, { status: 'landed' });
  const stuck = backlog.add({ title: 'stuck thing', goal: 'y' });
  backlog.update(stuck.id, { status: 'parked', blockedReason: 'a gate asked something' });
  backlog.add({ title: 'queued thing', goal: 'z' });
  ledger.record({ taskId: landed.id, usd: 1.5, estimated: false });
  ledger.record({ taskId: stuck.id, usd: null, estimated: true });
  return { root, backlog, ledger, archive: path.join(root, 'archive') };
}

const card = (over = {}) => scoreSuite({
  suite: 'default', at: `${TODAY}T12:00:00.000Z`, revision: 'abc1234',
  cases: [{ id: 'a', title: 'a', weight: 1, verified: true, landed: true, usd: 1, ms: 60000, attempts: 1, escalations: 0, probe: { status: 'pass' } }],
  ...over
});

test('a date is validated before it becomes a directory name', () => {
  assert.throws(() => archiveDir('/tmp/x', '../../etc'), /Invalid archive date/);
  assert.throws(() => archiveDir('/tmp/x', '2026-8-1'), /Invalid archive date/);
  assert.equal(path.basename(archiveDir('/tmp/x', '2026-08-13')), '2026-08-13');
});

test('the archive copies, so editing the sources afterwards changes nothing', async () => {
  const { backlog, ledger, archive } = seeded();
  const written = await writeArchive({ root: archive, backlog, ledger, card: card() });

  assert.equal(written.date, TODAY);
  assert.ok(written.files.includes('day.json'));
  assert.ok(written.files.includes('ledger.jsonl'));

  const before = readArchive(archive, TODAY);
  assert.equal(before.day.spend.usd, 1.5);
  assert.equal(before.day.tasks.landed, 1);
  assert.equal(before.parked.length, 1);
  assert.equal(before.parked[0].reason, 'a gate asked something');
  assert.equal(before.day.benchmark.score, 1);
  assert.equal(before.benchmark.revision, 'abc1234');

  // Everything the archive read from keeps moving. It must not.
  ledger.record({ taskId: 'later', usd: 99, estimated: false });
  for (const t of backlog.list()) backlog.update(t.id, { status: 'queued', blockedReason: null });

  const after = readArchive(archive, TODAY);
  assert.equal(after.day.spend.usd, 1.5);
  assert.equal(after.parked.length, 1);
  assert.equal(fs.readFileSync(path.join(archive, TODAY, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('the pile that needs a person is written even when it is empty', async () => {
  const root = tmp();
  const written = await writeArchive({ root: path.join(root, 'archive'), backlog: new Backlog(path.join(root, 'backlog')) });
  // An absence is an answer; having to infer it from a missing file is not.
  assert.ok(written.files.includes('parked.json'));
  assert.deepEqual(readArchive(path.join(root, 'archive'), TODAY).parked, []);
  assert.equal(written.day.spend, null);
});

test('a benchmark from another day is not filed as this one', async () => {
  const { backlog, ledger, archive } = seeded();
  // writeArchive takes whatever card it is handed; the API layer is what scopes
  // it to the day. What this pins is that the day summary reports what it got.
  const written = await writeArchive({ root: archive, backlog, ledger, card: null });
  assert.equal(written.day.benchmark, null);
  assert.ok(!fs.existsSync(path.join(archive, TODAY, 'benchmark.json')));
});

test('what landed comes from git, first-parent, and reverts are part of the day', async () => {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 't@localhost'], { cwd: root });
  await git(['config', 'user.name', 'T'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'initial'], { cwd: root });

  // A task branch merged --no-ff, which is exactly how the loop lands (§6.2):
  // first-parent history is the list of things that landed and nothing else.
  await git(['checkout', '-b', 'flyt/t-0001'], { cwd: root });
  fs.writeFileSync(path.join(root, 'b.txt'), '2');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'work on the branch'], { cwd: root });
  await git(['checkout', 'main'], { cwd: root });
  await git(['merge', '--no-ff', '-m', 'a landed task', 'flyt/t-0001'], { cwd: root });
  await git(['revert', '--no-edit', '-m', '1', 'HEAD'], { cwd: root });

  const commits = await commitsOn({ repoRoot: root, base: 'main', date: TODAY });
  const subjects = commits.map(c => c.subject);
  assert.ok(subjects.includes('a landed task'));
  assert.ok(!subjects.includes('work on the branch'), 'branch commits are not landings');
  assert.equal(commits.filter(c => c.revert).length, 1);

  const archive = path.join(tmp(), 'archive');
  const written = await writeArchive({ root: archive, repoRoot: root, base: 'main', date: TODAY });
  assert.equal(written.day.reverts, 1);
  // A day with no repository is not an error, it is a project without git.
  const bare = await writeArchive({ root: path.join(tmp(), 'a2'), repoRoot: null });
  assert.equal(bare.day.landed, 0);
});

test('a direction needs two scored days, and an unscored day keeps its slot', async () => {
  const archive = path.join(tmp(), 'archive');
  const day = (date, score) => writeArchive({
    root: archive, date,
    card: score == null ? null : scoreSuite({
      suite: 'default', at: `${date}T12:00:00.000Z`,
      cases: [{ id: 'a', title: 'a', weight: 1, verified: score > 0, landed: true, usd: 1, ms: 1000, attempts: 1, escalations: 0, probe: { status: 'pass' } }]
    })
  });

  await day('2026-08-10', 0);
  assert.equal(trend(archive).direction, null, 'one point is a measurement, not a direction');

  await day('2026-08-11', null);
  await day('2026-08-12', 1);
  const series = trend(archive);
  assert.deepEqual(series.points.map(p => p.date), ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.equal(series.points[1].score, null, 'a day nobody scored keeps its slot');
  assert.equal(series.scored, 2);
  assert.equal(series.direction, 'improving');
  assert.equal(series.latest.date, '2026-08-12');
  assert.match(renderTrend(series), /improving/);

  // A half-written directory is a gap in the record, and a gap must be visible.
  fs.mkdirSync(path.join(archive, '2026-08-13'), { recursive: true });
  const withGap = listArchive(archive);
  assert.equal(withGap.at(-1).incomplete, true);
  assert.equal(trend(archive).points.at(-1).incomplete, true);

  assert.equal(readArchive(archive, '2026-01-01'), null);
  assert.equal(renderTrend(trend(path.join(tmp(), 'none'))), 'No archived days yet.');
});

test('writing the same day twice replaces it rather than growing a second one', async () => {
  const { backlog, ledger, archive } = seeded();
  await writeArchive({ root: archive, backlog, ledger });
  const extra = backlog.add({ title: 'appeared later', goal: 'x' });
  backlog.update(extra.id, { status: 'parked', blockedReason: 'later' });
  await writeArchive({ root: archive, backlog, ledger });

  assert.equal(listArchive(archive).length, 1);
  assert.equal(readArchive(archive, TODAY).parked.length, 2);
});
