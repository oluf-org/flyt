// The deliverable/effect contract (WR-01).
//
// The defect this exists to close: `runExecutorTask` treated a non-empty
// textual deliverable as sufficient to mark a task `done`. For an analysis or
// documentation-output task that is correct. For a task whose whole point is to
// modify the bound repository it is not — and several model-owned nodes in real
// runs produced confident prose, called no write tool, changed nothing, and
// appeared green. Loop eventually rejected the empty diff at landing, but by
// then downstream tasks had run on fictional results and the budget was spent.
//
// So the contract is explicit and inspectable rather than "every task must
// change a file":
//
//   artifact         success needs a non-empty run artifact; no repo change.
//   workspace-change success needs a non-empty workspace change inside scope.
//   either           success needs one or the other.
//   none             structural/control nodes that claim no deliverable.
//
// Model output is evidence, not proof that the requested effect happened. When
// a required effect is absent the text is kept as partial evidence and the task
// fails retryably — it is never presented as a completion.
//
// Pure except for the two signature functions, which only READ (never stage,
// never mutate): capturing a baseline must not itself be a workspace change.
import { execFileSync } from 'node:child_process';
import { scrubbedParentEnv } from '#kernel';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './tools/glob.js';
// The modes and their normalization are shared with the renderer, which cannot
// import this module (it reaches for node:fs and node:child_process below).
import { EFFECT_MODES, normalizeEffect, normalizeEffectScope } from '../src/flowTypes.js';

export { EFFECT_MODES };

// The conservative default for anything we cannot classify: prose is a
// deliverable, and demanding a diff from a node that was never meant to produce
// one would fail honest work.
export const DEFAULT_EFFECT_MODE = 'artifact';

export const normalizeEffectMode = normalizeEffect;

// --- Inference --------------------------------------------------------------

// Categories whose whole purpose is editing the repository.
const CODE_CATEGORIES = new Set(['Code general', 'Code design', 'Test-creation']);

// Roles that produce a document and nothing else. `documentation` is NOT here:
// a docs task writes files in the repo, which is a workspace change.
const ARTIFACT_ROLES = new Set([
  'plan', 'plan-start', 'split', 'plan-eval', 'step-eval', 'final-eval',
  'feedback-review', 'verify', 'stitch', 'combine', 'compare', 'evaluation',
  'analyze', 'translate', 'summarize', 'orient', 'triage',
  // D46: an interrogation owes a specification, never a repository change.
  'interrogate'
]);

// Tools that write the RUN or the queue rather than the project's source. They
// carry `effects: ['write']` and workspace scope like a real file write does,
// so without this list a task granted only `enqueue_task` would be inferred to
// owe a source diff.
const NON_SOURCE_WRITERS = new Set(['create_task', 'enqueue_task', 'update_task', 'ask_human']);

// Can this tool change files in the bound project? Read off the record's
// declared effects/scope, the same way `isDestructive` does, so an imported
// tool is classified by what it does rather than by being remembered here.
//
// `shell` deliberately does NOT count. A shell can obviously write files, but
// granting bash is how a task is told to run a build, a suite or a probe — the
// canonical VERIFICATION grant. Treating it as a promise to produce a diff
// fails honest work: a task asked to run the tests and report what happened
// owes a report, not a change.
export function writesWorkspace(tool) {
  const name = typeof tool === 'string' ? tool : tool?.name ?? tool?.id;
  if (NON_SOURCE_WRITERS.has(name)) return false;
  if (typeof tool === 'string') return null; // unknown without the record
  const effects = tool?.effects ?? [];
  const scope = tool?.scope ?? 'workspace';
  return scope !== 'run' && effects.includes('write');
}

/**
 * The effect mode a node/task owes when nobody declared one.
 *
 * @param {object} spec  { type, role, category, tools, toolsAuthored } — tools
 *                       are RESOLVED tool records (so effects/scope can be
 *                       read). `toolsAuthored` says whether that grant was
 *                       CHOSEN for this node or is just the default full
 *                       registry; see below for why the difference decides.
 */
export function inferEffectMode(spec = {}) {
  const { type, role, category, tools, toolsAuthored = true } = spec;
  // Structural nodes claim nothing.
  if (type === 'input' || type === 'output' || type === 'note') return 'none';
  // A declared analysis/evaluation/planning role owes a document. Checked
  // before the tool signal: a plan-eval node holding read tools is still a
  // planning node, and a `verify` step that runs a gate is still reporting.
  if (role && ARTIFACT_ROLES.has(role)) return 'artifact';
  if (category && CODE_CATEGORIES.has(category)) return 'workspace-change';
  if (type === 'agentTask') {
    // No declared category: fall back to what it was DELIBERATELY given.
    //
    // "Deliberately" is the whole of it. An agentTask with no `tools` grant
    // gets the full registry, which of course contains create_file — so
    // inferring from the effective grant would demand a diff from every
    // unrestricted node in every flow ever authored, and quietly change what
    // those flows mean. An authored grant naming a file writer is a statement
    // of intent; the default grant is not a statement of anything.
    const records = toolsAuthored && Array.isArray(tools)
      ? tools.filter(t => t && typeof t === 'object') : [];
    if (records.some(t => writesWorkspace(t))) return 'workspace-change';
    // An agentTask with an unresolved tool list (names only), the default
    // grant, or no tools at all cannot be held to a diff nobody asked it for.
    return 'artifact';
  }
  return DEFAULT_EFFECT_MODE;
}

/**
 * Normalize a node/task's authored contract into the one internal shape.
 *
 * `scope` is an optional list of globs the change must land inside, so a task
 * cannot satisfy "change the application" by writing an unrelated note.
 */
export function effectContractFor(spec = {}) {
  const declared = normalizeEffectMode(spec.effect ?? spec.effectMode ?? spec.deliverable);
  const mode = declared ?? inferEffectMode(spec);
  const scope = normalizeEffectScope(spec.effectScope ?? spec.scope ?? null);
  return {
    mode,
    scope,
    // Which of the two it was matters for diagnostics: an inferred contract
    // that turns out wrong is an authoring prompt, not a model failure.
    inferred: !declared
  };
}

export const requiresWorkspaceChange = mode => mode === 'workspace-change' || mode === 'either';
export const requiresArtifact = mode => mode === 'artifact' || mode === 'either';

// --- Workspace signatures ---------------------------------------------------

// Directories that are never the point of a task and would dominate a scan.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor'
]);

// Bounds for the non-git scan. A signature is taken twice per task, so it has
// to stay cheap on a repository nobody told us to expect.
const MAX_SCAN_FILES = 5000;
const MAX_HASH_BYTES = 2 * 1024 * 1024;

const GIT_TIMEOUT_MS = 30_000;

// `trim: false` matters for --porcelain: its first column is a SPACE for a
// file modified but not staged (" M src.js"), so trimming the whole output
// shifts the first entry's path by one character and every path read off it is
// silently wrong.
function gitOut(args, cwd, { trim = true } = {}) {
  // `--no-optional-locks`: this is a POLLED read, and a plain `git status`
  // takes .git/index.lock to refresh the index. A killed refresh — a timeout,
  // an app quitting — leaves a zero-byte lock behind, and every later git
  // write in that repository fails, including the person's own commits. A
  // reader has no business taking a write lock.
  const out = String(execFileSync('git', ['--no-optional-locks', ...args], {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: scrubbedParentEnv(),
  }) ?? '');
  return trim ? out.trim() : out;
}

const isGitRepo = root => {
  try {
    // A project can be bound below an enclosing repository, including inside
    // an ignored directory. Parent-relative Git paths cannot describe effects
    // in that bound project; use its bounded file scan instead.
    const top = gitOut(['rev-parse', '--show-toplevel'], root);
    return fs.realpathSync(top) === fs.realpathSync(root);
  } catch { return false; }
};

// Porcelain v1 entries, as { path, code }. `--porcelain` already excludes
// gitignored files and already INCLUDES untracked ones, which is exactly the
// rule the contract wants: an untracked source file is an effect, a build
// artifact the repo ignores is not.
function porcelainEntries(root) {
  const out = gitOut(['status', '--porcelain', '--untracked-files=all'], root, { trim: false });
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // "XY path": exactly two status characters, one separator, then the path.
    const m = /^(..)\s(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const code = m[1];
    let rel = m[2].trim();
    // Renames read "old -> new"; the new path is the one that exists now.
    const arrow = rel.indexOf(' -> ');
    if (arrow !== -1) rel = rel.slice(arrow + 4);
    // Paths with odd characters come back quoted.
    if (rel.startsWith('"') && rel.endsWith('"')) {
      try { rel = JSON.parse(rel); } catch { rel = rel.slice(1, -1); }
    }
    entries.push({ path: rel.replace(/\\/g, '/'), code });
  }
  return entries;
}

function scanFiles(root) {
  const files = new Map();
  let budget = MAX_SCAN_FILES;
  const walk = (dir, prefix) => {
    if (budget <= 0) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (budget <= 0) return;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        walk(path.join(dir, item.name), prefix ? `${prefix}/${item.name}` : item.name);
      } else if (item.isFile()) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        const full = path.join(dir, item.name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        budget--;
        // Content hash, not mtime: a write followed by a complete revert must
        // not read as a change, and a tool that rewrites a file byte-identical
        // has not changed the workspace.
        let sig;
        if (stat.size > MAX_HASH_BYTES) sig = `size:${stat.size}`;
        else {
          try { sig = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'); }
          catch { sig = `unreadable:${stat.size}`; }
        }
        files.set(rel, sig);
      }
    }
  };
  walk(root, '');
  return files;
}

/**
 * A cheap, read-only fingerprint of a workspace.
 *
 * Prefers git, which answers the question exactly and cheaply: HEAD plus the
 * porcelain status covers committed work, uncommitted work and untracked files
 * while honoring .gitignore. Falls back to a bounded content-hash scan for a
 * workspace that is not a repository.
 *
 * Never stages, never writes, never runs a hook.
 */
export function captureWorkspaceSignature(root) {
  if (!root) return { kind: 'none', reason: 'no workspace bound' };
  let resolved;
  try {
    resolved = path.resolve(root);
    if (!fs.statSync(resolved).isDirectory()) return { kind: 'none', reason: 'workspace is not a directory' };
  } catch {
    return { kind: 'none', reason: 'workspace is unreadable' };
  }
  if (isGitRepo(resolved)) {
    try {
      // A repo with no commits yet has no HEAD; that is not an error here.
      let head = null;
      try { head = gitOut(['rev-parse', 'HEAD'], resolved); } catch { head = null; }
      const entries = porcelainEntries(resolved);
      return {
        kind: 'git', root: resolved, head,
        status: Object.fromEntries(entries.map(e => [e.path, e.code]))
      };
    } catch (err) {
      return { kind: 'none', reason: `git status failed: ${String(err?.message ?? err).slice(0, 200)}` };
    }
  }
  try {
    return { kind: 'scan', root: resolved, files: Object.fromEntries(scanFiles(resolved)) };
  } catch (err) {
    return { kind: 'none', reason: `workspace scan failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}

// Paths that differ between two same-kind signatures.
function changedPaths(before, after) {
  if (!before || !after || before.kind !== after.kind) return null;
  if (before.kind === 'none') return null;
  const out = new Set();
  if (before.kind === 'git') {
    const a = before.status ?? {};
    const b = after.status ?? {};
    for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[p] !== b[p]) out.add(p);
    }
    // Work the agent committed inside the worktree moves HEAD and leaves the
    // status clean, so the porcelain diff alone would miss it entirely.
    if (before.head && after.head && before.head !== after.head) {
      try {
        const names = gitOut(['diff', '--name-only', `${before.head}..${after.head}`], after.root);
        for (const n of names.split('\n').map(s => s.trim()).filter(Boolean)) out.add(n.replace(/\\/g, '/'));
      } catch { out.add('(committed changes)'); }
    } else if (!before.head && after.head) {
      out.add('(initial commit)');
    }
    return [...out].sort();
  }
  const a = before.files ?? {};
  const b = after.files ?? {};
  for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[p] !== b[p]) out.add(p);
  }
  return [...out].sort();
}

// Which of the changed paths the contract's scope actually accepts.
export function applyScope(paths, scope) {
  if (!scope?.length) return paths;
  const res = scope.map(globToRegExp);
  return paths.filter(p => res.some(re => re.test(p)));
}

/**
 * Did this task produce the effect it owes?
 *
 * Returns a plain result — never throws, never mutates — so the caller can put
 * it in a log line, a retrospective and a UI state without re-deriving it.
 *
 * @returns {{ok, required, observed, reason, changedPaths, outOfScopePaths, detectable}}
 */
export function evaluateTaskEffect({ contract, artifactText, before, after } = {}) {
  const mode = normalizeEffectMode(contract?.mode) ?? DEFAULT_EFFECT_MODE;
  const scope = contract?.scope ?? null;
  const hasArtifact = Boolean(String(artifactText ?? '').trim());

  const all = changedPaths(before, after);
  // "Could not tell" is not "did not happen". A workspace we cannot fingerprint
  // (no bound folder, unreadable, git unavailable) must not manufacture a
  // failure — landing's empty-diff rejection remains the backstop there.
  const detectable = all !== null;
  const inScope = detectable ? applyScope(all, scope) : [];
  const outOfScope = detectable && scope?.length ? all.filter(p => !inScope.includes(p)) : [];
  const hasChange = inScope.length > 0;

  const observed = {
    artifact: hasArtifact,
    workspaceChange: detectable ? hasChange : null,
    changedPaths: inScope.slice(0, 50),
    ...(outOfScope.length ? { outOfScopePaths: outOfScope.slice(0, 50) } : {}),
    ...(detectable ? {} : { undetectable: before?.reason ?? after?.reason ?? 'workspace effect could not be measured' })
  };
  const base = { required: mode, observed, changedPaths: inScope, outOfScopePaths: outOfScope, detectable };

  if (mode === 'none') return { ok: true, reason: null, ...base };

  if (mode === 'artifact') {
    return hasArtifact
      ? { ok: true, reason: null, ...base }
      : { ok: false, reason: 'required artifact was not produced', ...base };
  }

  if (mode === 'workspace-change') {
    if (!detectable) {
      // Undetectable: fall back to the artifact so an unmeasurable workspace
      // cannot fail every task in it, and say plainly that it was not verified.
      return hasArtifact
        ? { ok: true, reason: null, unverified: true, ...base }
        : { ok: false, reason: 'required workspace change was not produced', ...base };
    }
    if (hasChange) return { ok: true, reason: null, ...base };
    return {
      ok: false,
      reason: outOfScope.length
        ? `required workspace change was not produced (${outOfScope.length} file(s) changed outside this task's scope)`
        : 'required workspace change was not produced',
      ...base
    };
  }

  // 'either'
  if (hasChange || hasArtifact) return { ok: true, reason: null, ...base };
  return { ok: false, reason: 'neither an artifact nor a workspace change was produced', ...base };
}

/**
 * A task that produced no required effect.
 *
 * Thrown so the executor keeps ONE failure path — a missing effect is a task
 * failure like any other — while staying distinguishable from a model error, a
 * rejected tool call or a stop. The result rides along for the retrospective.
 */
export class EffectMissingError extends Error {
  constructor(result) {
    super(result?.reason ?? 'required effect was not produced');
    this.name = 'EffectMissingError';
    this.effectMissing = true;
    this.effect = result;
  }
}

// A short, bounded, secret-free summary for logs and retrospectives.
export function describeEffect(result) {
  if (!result) return null;
  const parts = [`required ${result.required}`];
  if (result.observed?.artifact) parts.push('artifact present');
  else parts.push('no artifact');
  if (result.observed?.workspaceChange === true) {
    const n = result.changedPaths?.length ?? 0;
    parts.push(`${n} file(s) changed`);
  } else if (result.observed?.workspaceChange === false) parts.push('no file changed');
  else parts.push('workspace effect not measurable');
  return parts.join('; ');
}
