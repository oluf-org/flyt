// The backlog: work that survives a run (DESIGN-SPEC.md §8).
//
// `create_task` already lets an agent spawn follow-up work, but that work lives
// in `runs/<id>/tasks.json` and dies with the run. The loop needs the other
// thing: a queue that outlives any run, that a human can add to from a phone at
// 07:00, that an agent can add to mid-run when it notices something worth
// doing, and that a supervisor can pick from tomorrow.
//
// A task is a file, for the same reason a tool is (DESIGN-SPEC.md §5) and a flow
// is (FLOW_LANG.md): markdown with YAML frontmatter, because a human writes
// these and an agent writes these and both have to read them. Zero dependencies
// (D24) — the frontmatter goes through core/flowlang/yaml.js.
//
// WHERE IT LIVES, and why it matters more than it looks (§5.2). The backlog is
// owned by the SUPERVISOR and lives in the main checkout's `.flyt/backlog/`,
// never inside a worktree. A queue kept inside the thing being edited is a
// queue that fights itself: every parallel task's diff would carry bookkeeping
// churn, and any two tasks in flight would conflict on the same files. Agents
// therefore never write these files directly — they call `enqueue_task`, which
// resolves the canonical directory from outside every worktree.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, formatInline } from './flowlang/yaml.js';
import { normalizeLevel, escalate as escalateLevel, DEFAULT_LEVEL } from './levels.js';

export const TASK_STATUSES = [
  'queued',     // ready to be picked
  'claimed',    // a worker holds the lease, not yet running
  'running',    // a run is executing it
  'verifying',  // gates are running (§7)
  'review',     // gates green, waiting on the reviewer model
  'landed',     // merged
  'failed',     // gates or review rejected it, and it is out of attempts
  'parked'      // needs a human — a gate, a question, an exhausted budget
];

const TERMINAL = new Set(['landed', 'failed']);
const DEFAULT_LEASE_MS = 60 * 60 * 1000; // an hour: long tasks are the point (§1)

// Frontmatter fields, with their defaults. Anything not listed here is still
// preserved on write — a field a later phase adds must not be erased by an
// older reader, and a human's own note in the frontmatter is theirs to keep.
const DEFAULTS = () => ({
  title: '',
  status: 'queued',
  value: 3,          // 1-5, what it is worth
  effort: 3,         // 1-5, what it costs
  level: null,       // effort band (§8): low|medium|high|xhigh|max. null = the project default
  dependsOn: [],
  gates: [],         // extra gate commands beyond the project defaults
  blastRadius: [],   // paths this task expects to touch
  // Reference repositories this task was LEARNED FROM (§16), by name. A task
  // written from reading someone else's code names that code's files, and the
  // agent that claims it is standing somewhere those paths do not exist —
  // without this it can only report the task impossible, however good the task
  // is. With it, `reference:<name>/<path>` opens the file.
  references: [],
  // Expertise this task's worker needs, by name, resolved from the bound
  // project's .flyt/skills/<name>.md exactly as a template's `skills` list is
  // (core/skills.js). A skill on a TEMPLATE says "work of this kind is always
  // done this way"; a skill on a TASK says "this particular job needs this
  // knowledge" — which is the more common case and had nowhere to live. Without
  // it, teaching one unattended task a convention meant attaching the skill to
  // every task the loop runs, so nobody did, and the worker rediscovered the
  // same API by traceback every time. Instructions only: a skill never widens a
  // tool grant, here as everywhere else.
  skills: [],
  budgetUsd: null,
  attempts: 0,
  createdBy: 'human',
  createdAt: null,
  updatedAt: null,
  // When a supervisor actually began work, as distinct from when the task was
  // written. Wall clock per task is a scored axis of the benchmark (§12.1), and
  // the only honest place to read it from is the file the supervisor wrote —
  // process memory does not survive the night.
  startedAt: null,
  claimedBy: null,
  claimedAt: null,
  blockedReason: null,
  // The commit a reviewer read and rejected, when the last landing failed at
  // review. The next attempt starts from it instead of from the base branch, so
  // a specific objection is a correction rather than a rebuild. Null on every
  // other outcome — a gate failure or an empty diff is not work worth
  // inheriting.
  resumeFrom: null,
  runIds: []
});

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- serialization ---------------------------------------------------------

export function serializeTask(task) {
  const { body = '', ...fields } = task;
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${formatInline(v)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body.trim()}\n`;
}

export function parseTask(text, id) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${id}: no YAML frontmatter`);
  const fields = parseYaml(m[1]);
  if (!isPlainObject(fields)) throw new Error(`${id}: frontmatter is not a mapping`);
  return { ...DEFAULTS(), ...fields, id, body: (m[2] ?? '').trim() };
}

// The body a new task gets: the goal, and the acceptance if one was given.
// Prose lives in the body rather than the frontmatter because that is the half
// a model needs to read in full and a human needs to skim.
function buildBody({ goal = '', doneWhen = [], notes = '', evidence = [] }) {
  const parts = [];
  if (goal) parts.push(`## Goal\n\n${String(goal).trim()}`);
  if (doneWhen?.length) parts.push(`## Done when\n\n${doneWhen.map(d => `- ${d}`).join('\n')}`);
  if (notes) parts.push(`## Notes\n\n${String(notes).trim()}`);
  if (evidence?.length) {
    parts.push('## Reference evidence\n\n' + evidence.map(item => [
      `- **${String(item.claim).trim()}**`,
      `  - Source: \`${item.ref}:${item.line}\`${item.commit ? ` at \`${String(item.commit).slice(0, 12)}\`` : ''}`,
      `  - Excerpt: \`${String(item.excerpt).trim().replace(/`/g, '\\`')}\``
    ].join('\n')).join('\n'));
  }
  return parts.join('\n\n');
}

export class Backlog {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  #ensure() { fs.mkdirSync(this.rootDir, { recursive: true }); return this.rootDir; }
  #file(id) { return path.join(this.rootDir, `${id}.task.md`); }
  #lock(id) { return path.join(this.rootDir, `${id}.lock`); }
  #counter() { return path.join(this.rootDir, 'next-id.json'); }

  /**
   * The highest task number ever handed out, not the highest one still on disk.
   *
   * Ids used to be `max(existing) + 1`, which quietly REUSES an id the moment
   * its file is removed — and the ledger, the archive and the run log all key
   * spend and history by task id, so the new t-0004 inherits the old t-0004's
   * money and its runs. That was survivable while nothing removed a task; now
   * that removing one is a button, it is a way to corrupt the history by
   * tidying up.
   *
   * The counter file is the memory of what is gone. It is a floor rather than
   * the answer: the existing files are still consulted and the larger wins, so
   * a backlog written before this file existed keeps working, a counter that
   * gets deleted degrades to exactly the old behaviour instead of colliding,
   * and a counter that somehow runs behind the directory cannot hand out an id
   * that is already taken.
   */
  #highWater() {
    const onDisk = this.ids().reduce((m, id) => Math.max(m, idNumber(id)), 0);
    return Math.max(onDisk, this.#recorded());
  }

  #recorded() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.#counter(), 'utf8'));
      return Number.isFinite(saved?.last) ? Number(saved.last) : 0;
    } catch { return 0; } // no counter yet, or unreadable: the directory is the floor
  }

  // Remember a number as spent. Compared against the FILE, not the high-water
  // mark: by the time this is called the task exists on disk, so a mark that
  // included the directory would always already cover it and nothing would ever
  // be written down. Only ever climbs — two workers enqueue at once, and the
  // one that got there second must not walk the mark back onto an id the first
  // just used.
  #recordId(id) {
    const n = idNumber(id);
    if (!n || n <= this.#recorded()) return;
    try { fs.writeFileSync(this.#counter(), `${JSON.stringify({ last: n }, null, 2)}\n`); }
    catch { /* an unwritable counter must not fail the add: the id is taken on disk regardless */ }
  }

  // An id is only ever the stem of a file this class wrote. Callers pass ids in
  // from a CLI, an HTTP body and a model's tool call, so a traversal attempt
  // must fail here rather than resolve to somewhere interesting.
  #assertId(id) {
    const s = String(id ?? '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s)) throw new Error(`Invalid task id "${s}".`);
    return s;
  }

  ids() {
    try {
      return fs.readdirSync(this.rootDir)
        .filter(f => f.endsWith('.task.md'))
        .map(f => f.slice(0, -'.task.md'.length))
        .sort();
    } catch { return []; }
  }

  get(id) {
    const safe = this.#assertId(id);
    try { return parseTask(fs.readFileSync(this.#file(safe), 'utf8'), safe); }
    catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Malformed files are reported, never thrown past: one bad task must not
  // stop the loop from working the other forty (the same rule the ToolStore
  // follows for a bad definition).
  list({ status = null } = {}) {
    const out = [];
    this.problems = [];
    for (const id of this.ids()) {
      try {
        const t = this.get(id);
        if (t && (!status || t.status === status)) out.push(t);
      } catch (err) {
        this.problems.push({ id, error: String(err.message ?? err) });
      }
    }
    return out;
  }

  add(input = {}) {
    this.#ensure();
    const now = new Date().toISOString();
    const fields = {
      ...DEFAULTS(),
      ...Object.fromEntries(Object.entries(input).filter(([k, v]) =>
        v !== undefined && !['id', 'goal', 'doneWhen', 'notes', 'evidence', 'body'].includes(k))),
      createdAt: now,
      updatedAt: now
    };
    fields.status = TASK_STATUSES.includes(fields.status) ? fields.status : 'queued';
    // `tier` was this field's name for one commit; read it so a file written
    // then still means what it said.
    if (fields.level == null && input.tier) fields.level = input.tier;
    if (fields.level != null) fields.level = normalizeLevel(fields.level);
    fields.title = String(fields.title || input.goal || 'untitled').trim().slice(0, 120);
    const body = input.body ?? buildBody(input);

    // A caller that owns its own naming may supply the id — the benchmark does,
    // so every number on a scorecard traces back to a case file a person can
    // read. A collision is still an error rather than an overwrite: the queue
    // silently losing an entry is the one outcome worse than refusing to add.
    if (input.id) {
      const id = this.#assertId(input.id);
      const task = { id, ...fields, body };
      try {
        fs.writeFileSync(this.#file(id), serializeTask(stripId(task)), { flag: 'wx' });
        // A caller naming `t-0050` itself still spends that number, or the
        // generated ids would walk straight into it later.
        this.#recordId(id);
        return task;
      } catch (err) {
        if (err?.code === 'EEXIST') throw new Error(`Task "${id}" already exists.`);
        throw err;
      }
    }

    // Exclusive create, retried on collision: two agents enqueueing at the same
    // instant must not land on the same id, and 'wx' is the only way to find
    // out atomically that someone else took it.
    let n = this.#highWater();
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = `t-${String(++n).padStart(4, '0')}`;
      const task = { id, ...fields, body };
      try {
        fs.writeFileSync(this.#file(id), serializeTask(stripId(task)), { flag: 'wx' });
        this.#recordId(id);
        return task;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('Could not allocate a task id.');
  }

  update(id, patch = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task "${id}".`);
    const next = { ...task, ...patch, id: task.id, updatedAt: new Date().toISOString() };
    if (patch.status && !TASK_STATUSES.includes(patch.status)) {
      throw new Error(`Unknown status "${patch.status}".`);
    }
    fs.writeFileSync(this.#file(task.id), serializeTask(stripId(next)));
    return next;
  }

  /**
   * Take a task out of the queue for good.
   *
   * The queue could be added to and never emptied: `release` and `escalate`
   * move a task between states, and nothing removed one. So a backlog written
   * against the wrong repository — or by an experiment, or a duplicate — could
   * only be hidden by parking it, where it sits in the pile a person reads
   * every morning, forever.
   *
   * A task that is CLAIMED is refused rather than deleted: something holds a
   * lease and probably a worktree, and removing the file it is working from is
   * how a worker ends up writing into a directory the supervisor has forgotten.
   * Release it first, deliberately.
   *
   * A file that does not PARSE is removed anyway. `list` already tolerates one
   * (it reports it in `problems` so forty good tasks still run), but a reader
   * that tolerates a bad file and a remover that throws on it together mean the
   * one entry nobody can act on is also the one entry nobody can delete — the
   * queue's only permanent resident. Deleting is the whole point of this method,
   * so unreadable is a reason to proceed, not to refuse; the returned task
   * carries `unreadable` so the caller reports it honestly rather than printing
   * a title it never read.
   *
   * Returns the task that was removed, so a caller can report or undo it.
   */
  remove(id, { force = false } = {}) {
    const safe = this.#assertId(id);
    let task = null;
    try {
      task = this.get(safe);
      if (!task) return null;
    } catch (err) {
      if (!fs.existsSync(this.#file(safe))) return null;
      task = { id: safe, title: '(unreadable)', status: 'unknown', unreadable: String(err.message ?? err) };
    }
    if (!force && fs.existsSync(this.#lock(safe))) {
      throw new Error(`Task "${safe}" is claimed by ${task.claimedBy ?? 'someone'}. Release it before removing it.`);
    }
    fs.rmSync(this.#file(safe));
    try { fs.rmSync(this.#lock(safe)); } catch { /* no lock, or already gone */ }
    // Spend the number on the way out. `add` already records what it hands out,
    // so this only matters for a file a human wrote by hand and then removed —
    // but that is the whole point of the counter: the directory has just
    // forgotten this id, and the ledger has not.
    this.#recordId(safe);
    return task;
  }

  // --- claiming ------------------------------------------------------------
  //
  // Exclusive-create of a sibling lock file. `wx` fails with EEXIST if another
  // worker got there first, which is the atomic primitive both Windows and
  // POSIX actually give you — a rename would also be atomic, but it moves the
  // task's own path around and then status lives in two places at once.
  //
  // The lock carries its holder and the moment it was taken, so a worker that
  // died mid-task leaves something readable rather than a permanently poisoned
  // entry. Reclaiming an expired lease is allowed, and returns `stolen` so the
  // caller can log it — a silent steal is how two workers end up in one
  // worktree.
  claim(id, by = 'supervisor', { leaseMs = DEFAULT_LEASE_MS, now = Date.now() } = {}) {
    const task = this.get(id);
    if (!task) return null;
    if (task.status !== 'queued') return null;
    const lockPath = this.#lock(task.id);
    const payload = JSON.stringify({ by, at: new Date(now).toISOString() });
    let stolen = false;
    try {
      fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const age = now - (statMtime(lockPath) ?? now);
      if (age < leaseMs) return null; // someone else holds it, legitimately
      fs.writeFileSync(lockPath, payload); // lease expired: take it over
      stolen = true;
    }
    const claimed = this.update(task.id, { status: 'claimed', claimedBy: by, claimedAt: new Date(now).toISOString() });
    return { ...claimed, stolen };
  }

  /**
   * Drop the lease.
   *
   * `status: null` keeps whatever status the task already has, and that is not
   * a nicety: the caller has often just decided the status — escalated the task
   * back into the queue a rung up, or parked it — and a release that insists on
   * writing one of its own silently undoes that decision. Seen for real: every
   * failed landing escalated correctly and was then parked by the worktree
   * cleanup that followed it, so the ladder never climbed after a bad review.
   */
  release(id, { status = 'queued' } = {}) {
    const safe = this.#assertId(id);
    try { fs.unlinkSync(this.#lock(safe)); } catch { /* no lock to drop */ }
    const task = this.get(safe);
    if (!task) return null;
    return this.update(safe, { status: status ?? task.status, claimedBy: null, claimedAt: null });
  }

  /**
   * Move a task up a rung and hand it back to the queue (§8.2).
   *
   * The supervisor calls this when an attempt fails or a task stops making
   * headway. At the top of the ladder there is nothing left to escalate TO, so
   * the task parks for a human rather than re-running `max` forever at the most
   * expensive band there is — "escalate means a bigger model, then a person",
   * and this is where the "then a person" happens.
   */
  escalate(id, { reason = 'failed', note = '' } = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task "${id}".`);
    const attempts = (task.attempts ?? 0) + 1;
    const result = escalateLevel({ level: task.level ?? DEFAULT_LEVEL, reason, attempts });
    const blockedReason = [result.reason, note].filter(Boolean).join(' ');
    if (!result.escalated) {
      return { ...this.update(id, { status: 'parked', attempts, blockedReason }), escalation: result };
    }
    // The lease goes with it: an escalated task is queued again, and a task
    // that is queued while still holding a lock can never be picked up.
    try { fs.unlinkSync(this.#lock(task.id)); } catch { /* no lock held */ }
    return {
      ...this.update(id, {
        status: 'queued', attempts, level: result.level, blockedReason,
        claimedBy: null, claimedAt: null
      }),
      escalation: result
    };
  }

  // --- picking (§5.3) ------------------------------------------------------
  //
  // Deterministic and free. An LLM tiebreak belongs on top of this, not instead
  // of it: paying for a model call to rank forty obvious tasks is the mistake
  // D12 already named for routing, and the same tiering safetyCheck.js uses.
  //
  //   score = value / effort, bonus for unblocking others, zero if not ready.
  //
  // "Ready" means queued with every dependency landed. A task whose dependency
  // FAILED is not ready and never becomes ready on its own — it surfaces in
  // `blocked` so a human sees why the queue stopped moving, instead of the
  // picker silently skipping it forever.
  score(task, all = this.list()) {
    if (task.status !== 'queued') return 0;
    const byId = new Map(all.map(t => [t.id, t]));
    const deps = (task.dependsOn ?? []).map(d => byId.get(d));
    if (deps.some(d => !d || d.status !== 'landed')) return 0;
    const unblocks = all.filter(t =>
      t.status === 'queued' && (t.dependsOn ?? []).includes(task.id)).length;
    const value = clamp(task.value, 1, 5);
    const effort = clamp(task.effort, 1, 5);
    return (value * (1 + 0.25 * unblocks)) / effort;
  }

  // Everything ready, best first. Ties break toward the oldest task, so a
  // long-ignored item eventually wins rather than starving behind a stream of
  // equally-scored newcomers.
  ready() {
    const all = this.list();
    return all
      .map(t => ({ task: t, score: this.score(t, all) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score || String(a.task.createdAt).localeCompare(String(b.task.createdAt)))
      .map(e => ({ ...e.task, score: Number(e.score.toFixed(4)) }));
  }

  // Queued but not ready, with the reason — the answer to "why is nothing
  // being picked up", which is otherwise invisible.
  blocked() {
    const all = this.list();
    const byId = new Map(all.map(t => [t.id, t]));
    return all.filter(t => t.status === 'queued' && this.score(t, all) === 0).map(t => {
      const missing = (t.dependsOn ?? []).filter(d => byId.get(d)?.status !== 'landed');
      return {
        ...t,
        reason: missing.length
          ? `waiting on ${missing.map(d => `${d} (${byId.get(d)?.status ?? 'missing'})`).join(', ')}`
          : 'not ready'
      };
    });
  }

  // Pick and claim in one step, walking down the ready list so a task another
  // worker just took doesn't end the attempt.
  // `only` narrows what may be claimed to a named set of task ids, WITHOUT
  // changing the order the picker would otherwise take them in. It is a filter
  // over `ready()`, so every rule still applies — a task in the set that is
  // blocked, parked or already claimed is still not taken.
  //
  // The gap it closes: the loop could only ever be pointed at "the backlog".
  // Trying it on one task first — the obvious way to decide whether you trust
  // it — meant reordering or parking everything else, which is editing the
  // queue to work around the tool.
  take(by = 'supervisor', opts = {}) {
    const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
    for (const candidate of this.ready()) {
      if (only && !only.has(candidate.id)) continue;
      const claimed = this.claim(candidate.id, by, opts);
      if (claimed) return claimed;
    }
    return null;
  }

  stats() {
    const all = this.list();
    const counts = Object.fromEntries(TASK_STATUSES.map(s => [s, 0]));
    for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return {
      total: all.length,
      counts,
      ready: this.ready().length,
      blocked: this.blocked().length,
      open: all.filter(t => !TERMINAL.has(t.status)).length
    };
  }
}

function stripId({ id, ...rest }) { return rest; }
function idNumber(id) { return Number((/^t-(\d+)$/.exec(String(id)) ?? [])[1] ?? 0); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n) || lo)); }
function statMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }
