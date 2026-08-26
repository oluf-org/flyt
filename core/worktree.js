// Isolation and landing (DESIGN-SPEC.md §8).
//
// One git worktree per in-flight task, on its own branch, OUTSIDE the repo root
// — a nested checkout inside the working tree confuses grep, test runners and
// the agent's own file tools, and from outside, each worktree is simply the
// run's workspace root, so `core/tools/fileHost.js` confinement works unchanged
// and an agent physically cannot reach another task's tree.
//
// A failed task is thrown away by deleting a directory. That property is what
// makes an unattended loop tolerable at all.
//
// The landing sequence and why it has a canary (§6.2):
//
//   gates green in the worktree
//     → reviewer approves the diff
//     → merge --no-ff into main, push
//     → CANARY: the full suite on main AFTER the merge
//         green → landed
//         red   → revert the merge commit, push, re-file the task with evidence
//
// The canary is the part most such systems omit. Two branches that each pass in
// isolation can fail together, and with two or three tasks landing per hour that
// will happen. The merge is never squashed precisely so reverting it is one
// clean operation.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_TIMEOUT_MS = 2 * 60 * 1000;

// --- Attempt identity (WR-02) ------------------------------------------------
//
// Worktree paths and cleanup calls used to be keyed by `taskId` alone. That is
// a cross-attempt destructive race: `work:start` removed any existing tree for
// the task and `work:discard` later removed "the tree for that id", so if
// attempt A was cancelled, attempt B started, and A's asynchronous cleanup
// finished late, A deleted B's ACTIVE worktree and erased valid in-progress
// work.
//
// The fix is ownership. Every claim/run mints an `attemptId`; the pool records
// who owns a path; and every destructive operation is compare-and-delete —
// it states which attempt it believes it is cleaning up, and refuses to touch
// a path whose current owner is somebody else.
//
// Owner records live in `<baseDir>/.owners/`, beside the worktrees and outside
// every repository and every worktree — the same rule the backlog follows. The
// leading dot keeps the directory out of the taskId namespace.
const OWNERS_DIR = '.owners';

// How long an unreleased owner record stays "live" without a heartbeat. The
// supervisor touches its in-flight attempts each tick; anything older than this
// with no release is a crashed process's leftover, and a new attempt may clear
// it. Generous, because the cost of being wrong is deleting real work.
export const OWNER_LIVE_MS = 10 * 60 * 1000;

// Collision-resistant and roughly sortable: the timestamp makes `ls` readable
// and orders attempts, the random suffix makes two attempts minted in the same
// millisecond distinct.
export function newAttemptId(taskId = 'task', { now = Date.now() } = {}) {
  return `${taskId}-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// The outcomes of a destructive worktree operation. Named rather than boolean
// because "I did not delete it" has four very different meanings, and the one
// that matters most — somebody else owns this now — must never be silent.
export const CLEANUP_OUTCOMES = ['removed', 'already-removed', 'owner-mismatch', 'live-owner'];

export class GitError extends Error {
  constructor(message, { code = 1, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Run git with an argv array and no shell.
 *
 * No shell anywhere in this module: branch names and commit messages carry task
 * titles, which are model-authored text. Through a shell that is an injection
 * point; as argv it is just a string.
 */
export function git(args, { cwd, timeoutMs = GIT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT from execFile means "could not start", and on Windows a
          // missing `cwd` produces the identical error to a missing git — so a
          // worktree that was removed under a poll reported "spawn git ENOENT",
          // which reads as "git is not installed" and sends the reader looking
          // in entirely the wrong place. Say which of the two it was.
          const cwdGone = err.code === 'ENOENT' && cwd && !fs.existsSync(cwd);
          const detail = cwdGone
            ? `its working directory is gone (${cwd})`
            : String(stderr || err.message).slice(0, 500);
          return reject(new GitError(
            `git ${args.slice(0, 3).join(' ')} failed: ${detail}`,
            { code: typeof err.code === 'number' ? err.code : 1, stderr: String(stderr ?? '') }));
        }
        resolve(String(stdout ?? '').trim());
      });
  });
}

// A branch/directory-safe slug of a task title. Git refuses plenty of
// characters in a ref name and a model will eventually produce all of them.
export function slugify(text, max = 40) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'task';
}

export const branchFor = (taskId, title) => `flyt/${taskId}-${slugify(title)}`;

/**
 * Where a repo's worktrees live: outside every repository, always.
 *
 * Not under the app's data root, which in development IS the checkout — that
 * would put worktrees of the repo inside the repo, the exact thing §6.1
 * forbids, and it is how the first real run of this code went wrong. The home
 * directory is outside every project on every platform and needs no
 * permissions the user does not already have.
 */
export function defaultWorktreeRoot(repoRoot, { home = os.homedir() } = {}) {
  const resolved = path.resolve(repoRoot);
  const root = path.join(home, '.flyt', 'worktrees');
  // The basename is for a human reading `ls`; the digest keeps two checkouts of
  // the same name apart.
  //
  // This used to be `base64url(path).slice(-8)`, which is not a digest of the
  // path — it is the ENCODING OF THE LAST SIX BYTES of it. Every checkout whose
  // path ended the same way therefore got the identical key, so two unrelated
  // projects both called `api` shared one worktree root and their attempts
  // collided on `<baseDir>/<taskId>`: a cross-project version of exactly the
  // race attempt ownership exists to prevent. A real hash of the whole path
  // does what the old comment claimed.
  const key = `${path.basename(resolved)}-${crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 10)}`;
  // Migration: a checkout that already has worktrees under the old key keeps
  // using them. Relocating silently would orphan every in-flight attempt and
  // leave its git registrations pointing at a directory nothing looks in.
  const legacy = path.join(root, `${path.basename(resolved)}-${Buffer.from(resolved).toString('base64url').slice(-8)}`);
  try { if (fs.existsSync(legacy)) return legacy; } catch { /* unreadable home */ }
  return path.join(root, key);
}

// Is `dir` inside `root`? Used to enforce the invariant rather than describe it.
export function isInside(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class WorktreePool {
  /**
   * @param {string} repoRoot  The main checkout — the only place that merges.
   * @param {string} baseDir   Where worktrees live; outside repoRoot by design.
   */
  constructor(repoRoot, baseDir = null) {
    this.repoRoot = path.resolve(repoRoot);
    this.baseDir = path.resolve(baseDir ?? defaultWorktreeRoot(repoRoot));
    // Enforced, not merely documented. A worktree inside the repo confuses
    // grep, test runners and the agent's own file tools, and for a loop working
    // on its own repository it means a checkout of the project inside the
    // project. Failing loudly here beats discovering it in a diff.
    if (isInside(this.repoRoot, this.baseDir)) {
      throw new GitError(`Worktrees must live outside the repository: ${this.baseDir} is inside ${this.repoRoot}.`);
    }
  }

  dirFor(taskId) { return path.join(this.baseDir, String(taskId)); }

  // --- Attempt ownership (WR-02) -------------------------------------------

  #ownerPath(taskId) {
    return path.join(this.baseDir, OWNERS_DIR, `${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  /** The current owner record for a task's worktree path, or null. */
  owner(taskId) {
    try { return JSON.parse(fs.readFileSync(this.#ownerPath(taskId), 'utf8')); }
    catch { return null; }
  }

  #writeOwner(taskId, record, { exclusive = false } = {}) {
    const file = this.#ownerPath(taskId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), exclusive ? { flag: 'wx' } : undefined);
    return record;
  }

  #clearOwner(taskId) {
    try { fs.rmSync(this.#ownerPath(taskId), { force: true }); } catch { /* already gone */ }
  }

  /**
   * Is this owner record a live attempt, or a crashed process's leftover?
   *
   * Released records are never live. An unreleased one is live only while its
   * heartbeat is recent — a supervisor touches its in-flight attempts each
   * tick, so a record that has gone quiet for OWNER_LIVE_MS belonged to
   * something that is no longer running.
   */
  isLive(record, { now = Date.now() } = {}) {
    if (!record || record.releasedAt) return false;
    const beat = Date.parse(record.heartbeatAt ?? record.createdAt ?? '');
    if (!Number.isFinite(beat)) return false;
    return now - beat < OWNER_LIVE_MS;
  }

  /** Keep a live attempt's record fresh. Called from the supervisor's tick. */
  touchAttempt(taskId, attemptId, { now = Date.now() } = {}) {
    const record = this.owner(taskId);
    if (!record || record.attemptId !== attemptId || record.releasedAt) return false;
    this.#writeOwner(taskId, { ...record, heartbeatAt: new Date(now).toISOString() });
    return true;
  }

  /**
   * Mark an attempt finished WITHOUT deleting anything.
   *
   * Releasing and cleaning up are separate on purpose: a parked attempt keeps
   * its tree for forensics but must not block the next attempt, and a cleanup
   * that arrives later still has to prove it owns what it deletes.
   */
  releaseAttempt(taskId, attemptId, { now = Date.now() } = {}) {
    const record = this.owner(taskId);
    if (!record || record.attemptId !== attemptId) return false;
    this.#writeOwner(taskId, { ...record, releasedAt: new Date(now).toISOString() });
    return true;
  }

  async defaultBranch() {
    // Whatever this repo calls it. Assuming "main" breaks on every repo that
    // never renamed, and silently — onto a branch that does not exist.
    try { return await git(['symbolic-ref', '--short', 'HEAD'], { cwd: this.repoRoot }); }
    catch { return 'main'; }
  }

  async list() {
    const out = await git(['worktree', 'list', '--porcelain'], { cwd: this.repoRoot });
    return out.split('\n\n').filter(Boolean).map(block => {
      const dir = (/^worktree (.+)$/m.exec(block) ?? [])[1] ?? null;
      const branch = (/^branch refs\/heads\/(.+)$/m.exec(block) ?? [])[1] ?? null;
      return { dir, branch };
    }).filter(w => w.dir);
  }

  /**
   * A worktree for one task, branched from the CURRENT base.
   *
   * Branching from the live base rather than a cached one matters: by the time
   * a task is picked, other tasks have landed, and starting from a stale commit
   * guarantees a conflict at merge time for no reason.
   */
  async create(taskId, title, { base = null, attemptId = null, projectId = null, runId = null, now = Date.now() } = {}) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const dir = this.dirFor(taskId);
    const branch = branchFor(taskId, title);
    const from = base ?? await this.defaultBranch();
    if (fs.existsSync(dir)) throw new GitError(`A worktree for ${taskId} already exists at ${dir}.`);
    const attempt = attemptId ?? newAttemptId(taskId, { now });
    // The owner record is written BEFORE the checkout, so two concurrent
    // creates cannot both believe they own this path: the second one's
    // exclusive write fails and it never runs `git worktree add`. If the
    // checkout then fails, the reservation is rolled back rather than left
    // behind to block the next attempt.
    const record = {
      projectId, taskId: String(taskId), attemptId: attempt, runId,
      path: dir, branch, base: from,
      createdAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      releasedAt: null
    };
    try {
      this.#writeOwner(taskId, record, { exclusive: true });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const held = this.owner(taskId);
      throw new GitError(
        `A worktree for ${taskId} is already owned by attempt ${held?.attemptId ?? 'unknown'}`
        + `${held?.runId ? ` (run ${held.runId})` : ''}. Discard that attempt before starting another.`);
    }
    try {
      // `-B`, not `-b`: point the task's branch at `from`, whether or not it
      // already exists.
      //
      // A leftover branch from a previous attempt is now the NORMAL case, not
      // an anomaly — resuming a reviewed commit starts from that attempt's own
      // branch (api.js work:start). With `-b`, git refused, and on Windows it
      // refused with "cannot change to <dir>: No such file or directory" after
      // cleaning up the directory it had half-created, which reads as a
      // filesystem problem and is not one. Three loop starts died on that.
      //
      // Resetting is what the old delete-then-create did anyway, and the base
      // is chosen by the caller: the default branch for a fresh attempt, the
      // reviewed commit for a correction. Neither loses work — the reviewed
      // commit IS the branch tip in the resume case, and a fresh attempt is
      // meant to start from the base.
      await git(['worktree', 'add', '-B', branch, dir, from], { cwd: this.repoRoot });
    } catch (err) {
      this.#clearOwner(taskId);
      throw err;
    }
    this.#linkDependencies(dir);
    return { taskId, dir, branch, base: from, attemptId: attempt };
  }

  /**
   * Point the worktree's `node_modules` at the checkout's.
   *
   * A git worktree is a checkout, and `node_modules` is not in the checkout —
   * so a gate that needs an installed dependency fails there for a reason that
   * has nothing to do with the work being judged. This project's suite ran
   * without dependencies for a long time, which hid it; the moment `npm test`
   * gained a build step, every gate in every worktree failed in two seconds
   * and the loop escalated tasks whose code was fine.
   *
   * A junction on Windows and a symlink elsewhere, both of which work without
   * privileges. Failure is not fatal: a worktree without it is exactly what we
   * had before, and the gate will say so in its own output.
   *
   * @param dir — the worktree.
   */
  #linkDependencies(dir) {
    const target = path.join(this.repoRoot, 'node_modules');
    const link = path.join(dir, 'node_modules');
    try {
      if (!fs.existsSync(target) || fs.existsSync(link)) return;
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch { /* no link: the gate reports what it could not find */ }
  }

  /**
   * Cut the dependency link, leaving what it pointed at alone.
   *
   * Only ever removes the LINK: if `node_modules` in the worktree is a real
   * directory, somebody installed it there on purpose and it is not ours to
   * delete. Windows reports a junction as a symlink to `lstat` but refuses
   * `unlink` on it, hence the second attempt.
   *
   * @param dir — the worktree.
   */
  #unlinkDependencies(dir) {
    const link = path.join(dir, 'node_modules');
    let stat;
    try { stat = fs.lstatSync(link); } catch { return; }
    if (!stat.isSymbolicLink()) return;
    try { fs.unlinkSync(link); }
    catch { try { fs.rmdirSync(link); } catch { /* leave it; the caller reports what it could not remove */ } }
  }

  /**
   * Throw away ONE attempt's worktree.
   *
   * Force, because the whole point is that a failed task is thrown away — an
   * agent that left the tree dirty must not be able to keep it alive.
   *
   * Compare-and-delete: the caller states which attempt it believes it is
   * cleaning up, and this refuses to touch a path owned by a different one.
   * That is the whole fix for the cross-attempt race — a cancelled attempt's
   * cleanup arriving after the next attempt has started is now a recorded
   * `owner-mismatch` that mutates nothing, instead of a silent rm -rf of live
   * work.
   *
   * `attemptId: null` is the unscoped call: a hand-driven `flyt work discard`,
   * or a tree that predates ownership. It proceeds — "no attempt id" is a
   * caller asserting deliberate intent, and a person who typed `discard` means
   * it. `guardLive` is how the automated paths ask for the other behavior; see
   * `reclaim`, which is the one that must never disturb live work.
   *
   * @returns {{outcome, taskId, attemptId?, owner?, dir, branch?}} never throws
   *          on a mismatch; the outcome IS the answer.
   */
  async remove(taskId, { deleteBranch = false, attemptId = null, guardLive = false, now = Date.now() } = {}) {
    const dir = this.dirFor(taskId);
    const record = this.owner(taskId);

    // A WRONG attempt id is the actual bug: something believes it owns a path
    // that has since been handed to a newer attempt. Refuse, always.
    if (attemptId && record && record.attemptId !== attemptId) {
      return { outcome: 'owner-mismatch', taskId: String(taskId), attemptId, owner: record.attemptId, dir };
    }
    if (guardLive && !attemptId && this.isLive(record, { now })) {
      return { outcome: 'live-owner', taskId: String(taskId), owner: record.attemptId, runId: record.runId ?? null, dir };
    }
    if (!fs.existsSync(dir)) {
      // Idempotent: cleaning up the same completed attempt twice is a no-op,
      // not an error. Clear any record so the path is free for the next start.
      if (record && (!attemptId || record.attemptId === attemptId)) this.#clearOwner(taskId);
      return { outcome: 'already-removed', taskId: String(taskId), attemptId: attemptId ?? record?.attemptId ?? null, dir };
    }

    // Before anything deletes anything: take the dependency link out.
    //
    // `git worktree remove --force` recurses, and on Windows it walked THROUGH
    // the junction and deleted the checkout's own node_modules — 117 packages,
    // from a command whose entire job is to delete a scratch directory. A link
    // out of a directory that is about to be destroyed has to be cut first.
    this.#unlinkDependencies(dir);

    let branch = null;
    if (deleteBranch) {
      try { branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }); }
      catch {
        // Unreadable — a half-removed worktree has no .git to ask. The owner
        // record wrote the branch down when the attempt started, which is
        // exactly what it is for; without this fallback the branch survives a
        // cleanup that reported success, and the next `create` fails with
        // "a branch named ... already exists".
        branch = record?.branch ?? null;
      }
    }
    try {
      await git(['worktree', 'remove', '--force', dir], { cwd: this.repoRoot });
    } catch (err) {
      // A DIRECTORY git no longer calls a worktree — `git worktree prune` ran,
      // or the metadata was removed by hand — is still this attempt's leftover
      // and still has to be cleaned up. Throwing here left the owner record in
      // place, and the next `work:start` refused the task with "already has a
      // live attempt" for a tree git had already forgotten. Idempotent cleanup
      // that fails on the second half of an interrupted cleanup is not
      // idempotent.
      //
      // Narrow on purpose: any other git failure is a real one and must
      // surface. Ownership was already checked above, and the path is inside
      // the pool's own base directory, so removing it here is the same
      // authority the git call was being asked for.
      if (!/is not a working tree|No such file or directory|does not exist/i.test(String(err?.message ?? err))) throw err;
      fs.rmSync(dir, { recursive: true, force: true });
      try { await git(['worktree', 'prune'], { cwd: this.repoRoot }); } catch { /* nothing to prune */ }
    }
    if (branch) { try { await git(['branch', '-D', branch], { cwd: this.repoRoot }); } catch { /* already gone */ } }
    if (record && (!attemptId || record.attemptId === attemptId)) this.#clearOwner(taskId);
    return { outcome: 'removed', taskId: String(taskId), attemptId: attemptId ?? record?.attemptId ?? null, dir, branch };
  }

  /**
   * Clear a path a new attempt wants, refusing to disturb a live owner.
   *
   * What `work:start` needs and `remove` deliberately does not give it: "this
   * task's slot must be free, and if somebody is genuinely still working in it,
   * tell me who instead of deleting their tree."
   */
  async reclaim(taskId, { now = Date.now() } = {}) {
    const record = this.owner(taskId);
    if (this.isLive(record, { now })) {
      return { outcome: 'live-owner', taskId: String(taskId), owner: record.attemptId, runId: record.runId ?? null, dir: this.dirFor(taskId) };
    }
    // Abandoned or released: the old attempt's id is the one we are cleaning
    // up. `guardLive` too, so a record that goes live between the check above
    // and the delete below is still refused rather than raced.
    return this.remove(taskId, { deleteBranch: true, attemptId: record?.attemptId ?? null, guardLive: true, now });
  }

  /**
   * Owner records and git worktrees that no longer belong together (WR-02).
   *
   * Run at startup: a process that died mid-attempt leaves one of three
   * things — a record with no directory, a directory with no record, or a
   * git worktree registration pointing at neither. Reported rather than
   * cleaned automatically, because "delete this directory" is exactly the
   * decision that must not be guessed at.
   */
  reconcile({ now = Date.now() } = {}) {
    const orphans = [];
    let records = [];
    try {
      records = fs.readdirSync(path.join(this.baseDir, OWNERS_DIR))
        .filter(f => f.endsWith('.json'))
        .map(f => { try { return JSON.parse(fs.readFileSync(path.join(this.baseDir, OWNERS_DIR, f), 'utf8')); } catch { return null; } })
        .filter(Boolean);
    } catch { /* no owners directory yet */ }

    const owned = new Set(records.map(r => r.path));
    for (const r of records) {
      if (!fs.existsSync(r.path)) {
        orphans.push({ kind: 'record-without-worktree', taskId: r.taskId, attemptId: r.attemptId, path: r.path });
      } else if (!this.isLive(r, { now })) {
        orphans.push({
          kind: r.releasedAt ? 'released-worktree' : 'abandoned-worktree',
          taskId: r.taskId, attemptId: r.attemptId, path: r.path, runId: r.runId ?? null
        });
      }
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== OWNERS_DIR)
        .map(d => path.join(this.baseDir, d.name));
    } catch { /* nothing created yet */ }
    for (const dir of dirs) {
      if (!owned.has(dir)) orphans.push({ kind: 'worktree-without-record', taskId: path.basename(dir), path: dir });
    }
    return orphans;
  }

  // Which files the task actually touched, committed or not. This is what the
  // protected-path check reads (§7.3).
  async changedFiles(taskId, { base }) {
    const dir = this.dirFor(taskId);
    const [tracked, untracked] = await Promise.all([
      git(['diff', '--name-only', `${base}...HEAD`], { cwd: dir }).catch(() => ''),
      git(['status', '--porcelain'], { cwd: dir }).catch(() => '')
    ]);
    const files = new Set(tracked.split('\n').map(s => s.trim()).filter(Boolean));
    for (const line of untracked.split('\n')) {
      const name = line.slice(3).trim();
      if (name) files.add(name);
    }
    return [...files].sort();
  }

  // Which files the task DELETED. Asked separately because `changedFiles`
  // returns names with no status, so a removal and an edit look identical
  // there — and the difference is the whole of whether a declared fall in the
  // test count was earned (core/gates.js testCountRegression).
  async deletedFiles(taskId, { base }) {
    const out = await git(['diff', '--diff-filter=D', '--name-only', `${base}...HEAD`],
      { cwd: this.dirFor(taskId) }).catch(() => '');
    return out.split('\n').map(s => s.trim()).filter(Boolean).sort();
  }

  /**
   * Files the task wrote that git is ignoring.
   *
   * Only asked for on the failure path, where "nothing changed" needs to
   * distinguish a task that produced nothing from a task that produced
   * something into a path `.gitignore` covers. The second is invisible to
   * `changedFiles` — `git status --porcelain` omits ignored files — so the
   * next attempt is told to write a file that is already sitting there.
   *
   * @param taskId — whose worktree to look in.
   * @returns paths, sorted; empty when there are none or git cannot say.
   */
  async ignoredFiles(taskId) {
    const dir = this.dirFor(taskId);
    const out = await git(['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd: dir })
      .catch(() => '');
    return out.split('\n').map(s => s.trim()).filter(Boolean).sort();
  }

  async hasChanges(taskId) {
    const dir = this.dirFor(taskId);
    const status = await git(['status', '--porcelain'], { cwd: dir });
    return status.trim().length > 0;
  }

  /**
   * Commit everything in the worktree.
   *
   * `--no-verify` on purpose: the project's own hooks may be interactive or may
   * run the very suite the gate runner has already run. Verification here is the
   * harness's job (§7.1), deliberately and visibly, not a hook's.
   */
  async commit(taskId, message, { author = 'Flyt <flyt@localhost>' } = {}) {
    const dir = this.dirFor(taskId);
    if (!await this.hasChanges(taskId)) return null;
    await git(['add', '-A'], { cwd: dir });
    await git(['-c', `user.name=${author.split('<')[0].trim()}`,
      '-c', `user.email=${(/<(.+)>/.exec(author) ?? [])[1] ?? 'flyt@localhost'}`,
      'commit', '--no-verify', '-m', message], { cwd: dir });
    return git(['rev-parse', 'HEAD'], { cwd: dir });
  }

  /**
   * What this attempt has done to the workspace, so far.
   *
   * Two things were wrong with the obvious version, and both made it useless at
   * exactly the moment somebody types it.
   *
   * The default base was the string `'HEAD'`, so it ran `git diff HEAD...HEAD`
   * — a diff of a commit against itself, which is empty for every attempt that
   * has ever existed. The base an attempt started from is on its owner record,
   * where `create()` wrote it.
   *
   * And `a...b` compares two COMMITS. An attempt that is still running has
   * written files and committed nothing, which is the state a supervisor most
   * wants to look at: watched a worktree with 285 new lines in it report no
   * diff at all. Diffing against the merge base, with no second revision,
   * covers the commits and the working tree together.
   *
   * Untracked files are listed rather than inlined: `git diff` cannot see them
   * and a new file is the most common shape of a first attempt, so "no diff"
   * would again be the answer for work that is plainly there.
   */
  async diff(taskId, { base = null, maxChars = 60_000 } = {}) {
    const dir = this.dirFor(taskId);
    // A task with no worktree has no diff, and that is an ANSWER. Letting git
    // fail in a directory that is not there sends a stack trace to somebody who
    // asked a simple question about a task that finished an hour ago.
    if (!fs.existsSync(dir)) return `No worktree for "${taskId}" — nothing is checked out for it right now.`;
    const from = base ?? this.owner(taskId)?.base ?? await this.defaultBranch();
    let anchor = from;
    try { anchor = await git(['merge-base', from, 'HEAD'], { cwd: dir }); }
    catch { /* an unborn or unrelated base: diff against it directly */ }

    const changed = await git(['diff', anchor], { cwd: dir });
    let untracked = '';
    try {
      const listed = await git(['ls-files', '--others', '--exclude-standard'], { cwd: dir });
      const files = listed.split('\n').map(s => s.trim()).filter(Boolean);
      if (files.length) untracked = `\n\n${files.length} untracked file(s):\n${files.map(f => `  ${f}`).join('\n')}`;
    } catch { /* nothing to add */ }

    const out = changed + untracked;
    return out.length > maxChars
      ? `${out.slice(0, maxChars)}\n…[diff truncated at ${maxChars} characters]`
      : out;
  }
}

/**
 * Push the base branch and the task branch, when a remote exists.
 *
 * Returns what it did rather than throwing on "no remote": a repo with no
 * origin is a perfectly good local loop, and refusing to land into it would be
 * wrong. A push that FAILS is a different matter and is reported to the caller.
 */
export async function pushRefs({ repoRoot, base, branch = null, remote = 'origin', log = () => {} }) {
  const remotes = await git(['remote'], { cwd: repoRoot }).catch(() => '');
  if (!remotes.split('\n').map(s => s.trim()).includes(remote)) {
    log(`no "${remote}" remote — nothing pushed`);
    return { pushed: false, reason: 'no-remote' };
  }
  const refs = [base, branch].filter(Boolean);
  for (const ref of refs) await git(['push', remote, ref], { cwd: repoRoot });
  log(`pushed ${refs.join(', ')} to ${remote}`);
  return { pushed: true, refs };
}

/**
 * Merge a task branch into the base, then verify the RESULT.
 *
 * `verify` runs the gates against the main checkout after the merge — the
 * canary. It is passed in rather than imported so the caller decides what
 * "green" means and so this stays testable without a suite.
 *
 * On a red canary the merge commit is reverted and the failure is returned; the
 * caller re-files the task with the evidence. Nothing is left half-landed.
 */
export async function land({
  repoRoot, branch, base, message, verify = null, push = null, log = () => {}
}) {
  const before = await git(['rev-parse', 'HEAD'], { cwd: repoRoot });
  await git(['checkout', base], { cwd: repoRoot });

  try {
    await git(['-c', 'user.name=Flyt', '-c', 'user.email=flyt@localhost',
      'merge', '--no-ff', '--no-verify', '-m', message, branch], { cwd: repoRoot });
  } catch (err) {
    // A conflicting merge leaves the tree mid-merge; abort so the checkout is
    // usable rather than wedged for every task after this one.
    await git(['merge', '--abort'], { cwd: repoRoot }).catch(() => {});
    return { landed: false, reason: 'conflict', error: String(err.message ?? err), before };
  }

  const mergeSha = await git(['rev-parse', 'HEAD'], { cwd: repoRoot });
  log(`merged ${branch} as ${mergeSha.slice(0, 8)}`);

  let canary = null;
  if (verify) {
    canary = await verify({ repoRoot, mergeSha });
    if (!canary.ok) {
      // Revert rather than reset: the merge may already have been pushed, and
      // rewriting published history is a worse problem than an extra commit.
      // -m 1 keeps the base's side, which is what "undo this merge" means.
      await git(['-c', 'user.name=Flyt', '-c', 'user.email=flyt@localhost',
        'revert', '--no-edit', '-m', '1', mergeSha], { cwd: repoRoot });
      const revertSha = await git(['rev-parse', 'HEAD'], { cwd: repoRoot });
      log(`canary failed — reverted ${mergeSha.slice(0, 8)} as ${revertSha.slice(0, 8)}`);
      if (push) await push({ repoRoot, base }).catch(e => log(`push after revert failed: ${e.message}`));
      return { landed: false, reason: 'canary', mergeSha, revertSha, canary };
    }
  }

  if (push) {
    try { await push({ repoRoot, base, branch, mergeSha }); }
    catch (err) {
      // The merge is real and verified locally; a failed push is a delivery
      // problem, reported as such rather than by undoing good work.
      log(`push failed: ${err.message}`);
      return { landed: true, pushed: false, mergeSha, canary, pushError: String(err.message ?? err) };
    }
  }
  // The canary rides along on success too. A green suite on the merged base is
  // the only trustworthy "before" for the next task's test-count check (§7.3),
  // and it has just been run — asking for it again would be a second full suite
  // for a number we already have.
  return { landed: true, pushed: Boolean(push), mergeSha, canary };
}
