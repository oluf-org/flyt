// Attempt-scoped worktree ownership (WR-02).
//
// The production failure: worktree paths and cleanup calls were keyed by
// `taskId` alone. `work:start` removed any existing tree for the task and
// `work:discard` later removed "the tree for that id" — so when attempt A was
// cancelled, attempt B started, and A's asynchronous cleanup finished late, A
// deleted B's ACTIVE worktree and erased valid in-progress work.
//
// The race test below is the whole point of this file: it interleaves those
// operations deterministically, in the order that used to destroy work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreePool, git, newAttemptId, OWNER_LIVE_MS, defaultWorktreeRoot } from '../core/worktree.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-attempt-'));

async function makeRepo() {
  const root = path.join(tmp(), 'repo');
  fs.mkdirSync(root, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'test@localhost'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# repo\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'init', '--no-verify'], { cwd: root });
  return root;
}

const poolFor = async () => {
  const root = await makeRepo();
  return new WorktreePool(root, path.join(tmp(), 'worktrees'));
};

test('a worktree gets the dependencies its checkout has, or the gates judge the wrong thing', async () => {
  const root = await makeRepo();
  // What an installed checkout looks like, and what a checkout does NOT carry.
  fs.mkdirSync(path.join(root, 'node_modules', 'typescript'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}');

  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  const { dir } = await pool.create('t-1', 'a task');

  const linked = path.join(dir, 'node_modules', 'typescript', 'package.json');
  assert.ok(fs.existsSync(linked), 'a gate that needs an installed dependency can find it');
  assert.equal(JSON.parse(fs.readFileSync(linked, 'utf8')).name, 'typescript');
});

test('a checkout with nothing installed still gets a worktree', async () => {
  const root = await makeRepo();      // no node_modules at all
  const pool = new WorktreePool(root, path.join(tmp(), 'worktrees'));
  const { dir } = await pool.create('t-1', 'a task');
  assert.ok(fs.existsSync(dir), 'linking is a convenience, not a precondition');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('attempt ids are unique even when minted in the same millisecond', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newAttemptId('t-1', { now: 1_700_000_000_000 })));
  assert.equal(ids.size, 200);
});

test('THE RACE: a cancelled attempt\'s late cleanup cannot delete the next attempt\'s worktree', async () => {
  const pool = await poolFor();

  // Attempt A starts and does some work.
  const a = await pool.create('t-0001', 'First try');
  fs.writeFileSync(path.join(a.dir, 'a-work.js'), 'export const from = "A";\n');
  assert.ok(a.attemptId);

  // A is cancelled. Its cleanup is SCHEDULED but has not run yet — the app is
  // shutting the run down, the git call is still in flight, the promise is
  // pending. This is the window the bug lived in.
  pool.releaseAttempt('t-0001', a.attemptId);
  const aCleanup = () => pool.remove('t-0001', { deleteBranch: true, attemptId: a.attemptId });

  // Attempt B starts in that window and gets the slot.
  const cleared = await pool.reclaim('t-0001');
  assert.equal(cleared.outcome, 'removed');
  const b = await pool.create('t-0001', 'Second try');
  assert.notEqual(b.attemptId, a.attemptId);
  fs.writeFileSync(path.join(b.dir, 'b-work.js'), 'export const from = "B";\n');

  // …and only NOW does A's cleanup finally land.
  const result = await aCleanup();

  assert.equal(result.outcome, 'owner-mismatch');
  assert.equal(result.owner, b.attemptId);
  // B survives, entirely: directory, branch and files.
  assert.ok(fs.existsSync(b.dir), "B's worktree still exists");
  assert.ok(fs.existsSync(path.join(b.dir, 'b-work.js')), "B's work still exists");
  assert.equal(pool.owner('t-0001').attemptId, b.attemptId);
  const branches = await git(['branch', '--list'], { cwd: pool.repoRoot });
  assert.match(branches, new RegExp(b.branch.replace(/[/\\]/g, '.')));
});

test('cleanup with a stale attempt id mutates nothing at all', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0002', 'Work');
  fs.writeFileSync(path.join(a.dir, 'keep.js'), 'keep\n');
  const before = fs.readdirSync(a.dir).sort();

  const result = await pool.remove('t-0002', { deleteBranch: true, attemptId: 'attempt-that-never-existed' });

  assert.equal(result.outcome, 'owner-mismatch');
  assert.equal(result.owner, a.attemptId);
  assert.deepEqual(fs.readdirSync(a.dir).sort(), before);
  const branches = await git(['branch', '--list'], { cwd: pool.repoRoot });
  assert.match(branches, new RegExp(a.branch.replace(/[/\\]/g, '.')));
});

test('cleanup with the current attempt id removes that attempt and its branch', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0003', 'Work');
  const result = await pool.remove('t-0003', { deleteBranch: true, attemptId: a.attemptId });

  assert.equal(result.outcome, 'removed');
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(pool.owner('t-0003'), null);
  const branches = await git(['branch', '--list'], { cwd: pool.repoRoot });
  assert.doesNotMatch(branches, new RegExp(a.branch.replace(/[/\\]/g, '.')));
});

test('cleaning up the same completed attempt twice is a successful no-op', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0004', 'Work');
  assert.equal((await pool.remove('t-0004', { attemptId: a.attemptId })).outcome, 'removed');
  const second = await pool.remove('t-0004', { attemptId: a.attemptId });
  assert.equal(second.outcome, 'already-removed');
});

test('starting a new attempt never disturbs a live one — it names the holder instead', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0005', 'Long task');
  fs.writeFileSync(path.join(a.dir, 'wip.js'), 'in progress\n');

  // The "make room for a new attempt" path is the automated one, and it must
  // report who holds the slot rather than deleting their work.
  const reclaimed = await pool.reclaim('t-0005');
  assert.equal(reclaimed.outcome, 'live-owner');
  assert.equal(reclaimed.owner, a.attemptId);
  assert.ok(fs.existsSync(path.join(a.dir, 'wip.js')));
});

test('an explicit unscoped discard still works — a person who typed it meant it', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0005b', 'Abandon this');
  // No attempt id: `flyt work discard <task>`, or a tree predating ownership.
  // Deliberate intent, so it proceeds; only a WRONG attempt id is refused.
  const result = await pool.remove('t-0005b', { deleteBranch: true });
  assert.equal(result.outcome, 'removed');
  assert.equal(fs.existsSync(a.dir), false);
});

test('an attempt whose process died is reclaimable once its heartbeat goes stale', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0006', 'Crashed', { now: 1_000_000 });
  assert.equal(pool.isLive(pool.owner('t-0006'), { now: 1_000_000 }), true);

  const later = 1_000_000 + OWNER_LIVE_MS + 1;
  assert.equal(pool.isLive(pool.owner('t-0006'), { now: later }), false);
  const reclaimed = await pool.reclaim('t-0006', { now: later });
  assert.equal(reclaimed.outcome, 'removed');
  assert.equal(fs.existsSync(a.dir), false);
});

test('a heartbeat keeps a long attempt alive, and only its owner may beat', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0007', 'Slow', { now: 1_000_000 });
  const midway = 1_000_000 + OWNER_LIVE_MS - 1;
  assert.equal(pool.touchAttempt('t-0007', a.attemptId, { now: midway }), true);
  // Still live well past the original window, because it kept saying so.
  assert.equal(pool.isLive(pool.owner('t-0007'), { now: midway + OWNER_LIVE_MS - 1 }), true);
  // A different attempt cannot refresh somebody else's record.
  assert.equal(pool.touchAttempt('t-0007', 'someone-else', { now: midway }), false);
});

test('two concurrent creates cannot both own one path', async () => {
  const pool = await poolFor();
  await pool.create('t-0008', 'First');
  await assert.rejects(() => pool.create('t-0008', 'Second'), /already owned by attempt|already exists/);
});

test('a released attempt keeps its tree for forensics but no longer blocks the next one', async () => {
  const pool = await poolFor();
  const a = await pool.create('t-0009', 'Parked');
  fs.writeFileSync(path.join(a.dir, 'evidence.js'), 'why it failed\n');
  pool.releaseAttempt('t-0009', a.attemptId);

  // Still on disk to look at…
  assert.ok(fs.existsSync(path.join(a.dir, 'evidence.js')));
  assert.equal(pool.isLive(pool.owner('t-0009')), false);
  // …but the slot is free for the next attempt.
  assert.equal((await pool.reclaim('t-0009')).outcome, 'removed');
  const b = await pool.create('t-0009', 'Next');
  assert.notEqual(b.attemptId, a.attemptId);
});

test('reconciliation names orphans without deleting anything', async () => {
  const pool = await poolFor();
  const live = await pool.create('t-0010', 'Live');
  const dead = await pool.create('t-0011', 'Dead', { now: 1_000 });
  // A worktree nobody has a record for: a process that died between the git
  // checkout and writing its ownership.
  const stray = path.join(pool.baseDir, 't-0012');
  fs.mkdirSync(stray, { recursive: true });

  const orphans = pool.reconcile();
  const kinds = Object.fromEntries(orphans.map(o => [o.taskId, o.kind]));
  assert.equal(kinds['t-0011'], 'abandoned-worktree');
  assert.equal(kinds['t-0012'], 'worktree-without-record');
  assert.ok(!('t-0010' in kinds), 'a live attempt is not an orphan');

  // Reporting only: everything is still exactly where it was.
  assert.ok(fs.existsSync(live.dir));
  assert.ok(fs.existsSync(dead.dir));
  assert.ok(fs.existsSync(stray));
});

test('two projects with the same folder name do not share one worktree root', () => {
  // `defaultWorktreeRoot` used to key on the last six BYTES of the path rather
  // than a digest of it, so every checkout ending in the same characters got
  // one root — and their attempts then collided on <baseDir>/<taskId>, which is
  // the cross-project form of the race attempt ownership exists to prevent.
  const home = tmp();
  const a = defaultWorktreeRoot(path.join(tmp(), 'workspace-one', 'api'), { home });
  const b = defaultWorktreeRoot(path.join(tmp(), 'workspace-two', 'api'), { home });
  assert.notEqual(a, b);
  // Still readable in `ls`: the basename leads.
  assert.match(path.basename(a), /^api-/);
});

test('a checkout that already has worktrees under the old key keeps using them', () => {
  // Relocating silently would orphan in-flight attempts and leave their git
  // registrations pointing at a directory nothing looks in.
  const home = tmp();
  const repo = path.join(tmp(), 'legacy-repo');
  const legacy = path.join(home, '.flyt', 'worktrees',
    `${path.basename(repo)}-${Buffer.from(path.resolve(repo)).toString('base64url').slice(-8)}`);
  fs.mkdirSync(legacy, { recursive: true });
  assert.equal(defaultWorktreeRoot(repo, { home }), legacy);
});

// Idempotent cleanup that fails on the second half of an interrupted cleanup is
// not idempotent. `git worktree prune` — or a hand-removed `.git` file — leaves
// a DIRECTORY git no longer calls a worktree: `worktree remove` then fails, the
// owner record survives, and the next `work:start` refuses the task with
// "already has a live attempt" for a tree git has already forgotten.
test('a directory git no longer calls a worktree is still cleaned up, record and all', async () => {
  const pool = await poolFor();
  const wt = await pool.create('t-0001', 'A task');
  assert.ok(fs.existsSync(wt.dir));
  assert.ok(pool.owner('t-0001'));

  // Exactly what an interrupted cleanup leaves: the files, without git's idea
  // of them.
  fs.rmSync(path.join(wt.dir, '.git'), { force: true });
  await git(['worktree', 'prune'], { cwd: pool.repoRoot });

  // deleteBranch, exactly as `reclaim` asks for it — the path `work:start`
  // actually takes when it clears a slot.
  const result = await pool.remove('t-0001', { attemptId: wt.attemptId, deleteBranch: true });
  assert.equal(result.outcome, 'removed');
  assert.equal(fs.existsSync(wt.dir), false, 'the leftover directory has to go');
  assert.equal(pool.owner('t-0001'), null, 'and so does the record that blocks the next attempt');

  // And the slot is genuinely free again, which is the whole point.
  const next = await pool.create('t-0001', 'A task');
  assert.ok(fs.existsSync(next.dir));
});

test('a git failure that is not "already gone" still surfaces', async () => {
  const pool = await poolFor();
  const wt = await pool.create('t-0002', 'A task');
  // A repo root that is not a repository fails for a real reason, and a real
  // reason must not be swallowed by the leftover path.
  pool.repoRoot = path.join(pool.repoRoot, 'nope-not-a-repo');
  await assert.rejects(() => pool.remove('t-0002', { attemptId: wt.attemptId }));
  assert.ok(fs.existsSync(wt.dir), 'nothing is deleted on an error nobody understood');
});

// A leftover branch from a previous attempt is the NORMAL case once a review
// rejection resumes from that attempt's commit. `git worktree add -b` refuses
// it, and on Windows it refuses with "cannot change to <dir>: No such file or
// directory" after cleaning up the directory it half-created — which reads as a
// filesystem problem and is not one. Three loop starts died on that.
test('a task branch left over from a previous attempt does not stop the next one', async () => {
  const pool = await poolFor();
  const first = await pool.create('t-0001', 'A task');
  fs.writeFileSync(path.join(first.dir, 'work.js'), 'export const from = "first";\n');
  await pool.commit('t-0001', 'the first attempt');
  const reviewed = await git(['rev-parse', 'HEAD'], { cwd: first.dir });

  // The tree goes; the branch deliberately stays, which is what carries the
  // reviewed commit into the next attempt.
  await pool.remove('t-0001', { attemptId: first.attemptId, deleteBranch: false });

  const second = await pool.create('t-0001', 'A task', { base: reviewed.trim() });
  assert.ok(fs.existsSync(path.join(second.dir, 'work.js')), 'the reviewed work has to be there to correct');
  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: second.dir })).trim(), reviewed.trim());
});
