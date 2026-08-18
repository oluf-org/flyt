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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_TIMEOUT_MS = 2 * 60 * 1000;

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
          return reject(new GitError(
            `git ${args.slice(0, 3).join(' ')} failed: ${String(stderr || err.message).slice(0, 500)}`,
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
  // The basename is for a human reading `ls`; the hash keeps two checkouts of
  // the same name apart.
  const key = `${path.basename(resolved)}-${Buffer.from(resolved).toString('base64url').slice(-8)}`;
  return path.join(home, '.flyt', 'worktrees', key);
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
  async create(taskId, title, { base = null } = {}) {
    fs.mkdirSync(this.baseDir, { recursive: true });
    const dir = this.dirFor(taskId);
    const branch = branchFor(taskId, title);
    const from = base ?? await this.defaultBranch();
    if (fs.existsSync(dir)) throw new GitError(`A worktree for ${taskId} already exists at ${dir}.`);
    await git(['worktree', 'add', '-b', branch, dir, from], { cwd: this.repoRoot });
    return { taskId, dir, branch, base: from };
  }

  // Force, because the whole point is that a failed task is thrown away — an
  // agent that left the tree dirty must not be able to keep it alive.
  async remove(taskId, { deleteBranch = false } = {}) {
    const dir = this.dirFor(taskId);
    if (!fs.existsSync(dir)) return false;
    let branch = null;
    if (deleteBranch) {
      try { branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }); } catch { /* unreadable */ }
    }
    await git(['worktree', 'remove', '--force', dir], { cwd: this.repoRoot });
    if (branch) { try { await git(['branch', '-D', branch], { cwd: this.repoRoot }); } catch { /* already gone */ } }
    return true;
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

  async diff(taskId, { base, maxChars = 60_000 }) {
    const dir = this.dirFor(taskId);
    const out = await git(['diff', `${base}...HEAD`], { cwd: dir });
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
