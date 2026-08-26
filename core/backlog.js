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
import { retiredDir, relocateRetiredRuns, readRetirement, markRevived } from './archive.js';

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
// How long a lock whose task file says "queued, unclaimed" is believed. Only
// covers the window between writing the lock and recording the claim, which is
// one local file write.
const ORPHAN_LOCK_MS = 15 * 1000;
// list()'s file-read cache (§5.2, and the §16 page seller). The Loop polls
// `task:list` every three seconds and the read per file is what grows with the
// backlog; the blocker pass over the result is in-memory and cheap. But mtime
// has one-second granularity on some filesystems, so a file written twice
// within the same second can present the SAME mtime (and the same size) with
// changed content. A same-mtime+same-size entry is therefore trusted as a
// cache hit only once the mtime is at least a second old — by then any write
// that could have landed in that rounded second has had its moment, and the
// cached parse is provably current.
const CACHE_HIT_FRESH_MS = 1000;

// The frontmatter fields that hold a number. `budgetUsd` is here even though
// its default is null: "no budget" is a real state, and a string is still not
// a number.
const NUMERIC_FIELDS = ['value', 'effort', 'attempts', 'budgetUsd', 'repairs', 'failureCount'];

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
  // What the SUITE should do when this lands: 'grows' | 'unchanged' |
  // 'shrinks'. null is the strict default, checked exactly as before.
  //
  // Declared by whoever wrote the task, before the attempt, which is the
  // whole of it: a prediction that can be wrong, not an excuse invented
  // afterwards (GOALS principle 8). A worker mid-attempt cannot set it —
  // the backlog lives outside every worktree and is not writable from one —
  // and that is the property that stops the hatch becoming a way for a
  // model to excuse itself. Keep it true.
  suiteExpectation: null,
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
  // The commit the last attempt was judged on, when what it was judged on was
  // worth keeping — a reviewer's objection, or a red gate over real work. The
  // next attempt starts from it instead of from the base branch, so a specific
  // objection is a correction rather than a rebuild. Null when there is nothing
  // worth inheriting, so a stale sha can never be resumed from.
  resumeFrom: null,
  // WHICH judgement produced `resumeFrom`: 'review' or 'gates'. The two need
  // different things said to the next attempt — "a person read this and asked
  // for one change" against "this is red and here is what is red" — and the
  // brief was telling every resumed attempt its gates had passed, which after a
  // gate failure is the one thing that is definitely untrue.
  resumeStage: null,
  // The level this task had before anything escalated it, recorded on the FIRST
  // escalation and never overwritten after.
  //
  // Without it, undoing an escalation is guesswork. A task found at `xhigh`
  // after six attempts might have been authored there, or might have started at
  // `medium` and been walked up by a provider that was refusing every call —
  // which is what happened to five tasks on 2026-08-24, and what had to be
  // repaired by hand afterwards from memory. The ladder is cheap to climb and
  // expensive to be wrong about, so it says where it started.
  baseLevel: null,
  // Corrections spent on THIS body of work: attempts that kept the diff and
  // went back at the same band to fix what the gates named (core/repair.js).
  // Deliberately not reset when the ladder escalates — the budget is the task's,
  // not the band's, or a five-rung ladder would buy fifteen attempts.
  repairs: 0,
  // What the gates said last time, so a correction that changed nothing is
  // visible: same fingerprint means the feedback did not land, and a third copy
  // of it will not either.
  failureSignature: null,
  failureCount: null,
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
    // Parsed-task cache keyed by file path (the Loop polls `task:list` every
    // three seconds and the per-file read is what grows with the backlog).
    // list() consults it and re-reads only when the file's mtime or size moved;
    // see CACHE_HIT_FRESH_MS above for why freshness gates a hit. Isolated to
    // this instance — each of the four callers (CLI, HTTP server, supervisor,
    // renderer) owns its own Backlog and so shares no cache state.
    this._cache = new Map();
  }

  /** Read a task file through the mtime/size cache: the parsed task, or null
   * if the file is missing, re-reading whenever the file changed. */
  #readCached(safe) {
    const file = this.#file(safe);
    let st;
    try { st = fs.statSync(file); }
    catch { this._cache.delete(file); return null; }
    const hit = this._cache.get(file);
    const fresh = Date.now() - st.mtimeMs < CACHE_HIT_FRESH_MS;
    const same = hit && hit.mtime === st.mtimeMs && hit.size === st.size;
    if (same && !fresh) return hit.task; // older than the rounding window, provably unchanged
    try {
      const task = parseTask(fs.readFileSync(file, 'utf8'), safe);
      this._cache.set(file, { mtime: st.mtimeMs, size: st.size, task });
      return task;
    } catch (err) {
      if (err?.code === 'ENOENT') { this._cache.delete(file); return null; }
      throw err;
    }
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

  /**
   * Reserve the next task id without writing a file.
   * Used by enqueue_task in propose mode: the chat proposes, the human commits,
   * so the id must not be reused before they press Queue it.
   */
  reserveId() {
    this.#ensure();
    let n = this.#highWater();
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = `t-${String(++n).padStart(4, '0')}`;
      const file = this.#file(id);
      if (!fs.existsSync(file)) {
        this.#recordId(id);
        return id;
      }
    }
    throw new Error('Could not allocate a task id.');
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
    return this.#readCached(safe);
  }

  // Malformed files are reported, never thrown past: one bad task must not
  // stop the loop from working the other forty (the same rule the ToolStore
  // follows for a bad definition).
  list({ status = null } = {}) {
    const out = [];
    this.problems = [];
    for (const id of this.ids()) {
      try {
        const t = this.#readCached(id);
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
    // A list field given a scalar is refused rather than written.
    //
    // `flyt call task:update --arg dependsOn=` stored an empty STRING in a
    // field every reader treats as an array, and from then on `task:list`
    // threw for every task in the backlog — one bad field, the whole queue
    // unreadable, including the picker's. A store that will write anything
    // hands its callers' typos to everybody who reads afterwards.
    for (const [field, fallback] of Object.entries(DEFAULTS())) {
      if (!Array.isArray(fallback) || !(field in patch)) continue;
      if (Array.isArray(next[field])) continue;
      // An empty scalar is the honest way to say "none", so it clears the list.
      if (next[field] === '' || next[field] === null || next[field] === undefined) { next[field] = []; continue; }
      throw new Error(`"${field}" is a list, and was given ${JSON.stringify(next[field])}.`);
    }
    // A number field given a STRING is the same hole one type over, and every
    // argument that arrives through `flyt call --arg` is a string. Written
    // through, `attempts: "0"` made `attempts + 1` concatenate: a task reported
    // being parked "across 01 attempt(s)", and nothing else complained, because
    // a numeric string survives every comparison and fails only at arithmetic.
    // Coerced where it is honestly a number, refused where it is not.
    for (const field of NUMERIC_FIELDS) {
      if (!(field in patch) || typeof next[field] === 'number') continue;
      if (next[field] === '' || next[field] === null || next[field] === undefined) {
        next[field] = DEFAULTS()[field] ?? null;
        continue;
      }
      const n = Number(next[field]);
      if (!Number.isFinite(n)) {
        throw new Error(`"${field}" is a number, and was given ${JSON.stringify(next[field])}.`);
      }
      next[field] = n;
    }
    fs.writeFileSync(this.#file(task.id), serializeTask(stripId(next)));
    // A task that reached a terminal status has no lease to keep: nothing holds
    // it, nothing is executing it, and the lock left behind misreports who does
    // and blocks `remove()` without --force. Done in the one method every status
    // change goes through, so no caller has to remember it.
    //
    // AFTER the write, deliberately. Every validation above throws, and a lock
    // dropped before one of them leaves a task that is still `running` with
    // nothing guarding it — free for a second worker to claim while the first is
    // mid-attempt. The lease is the thing protecting the work, so it is released
    // only once the status that makes it unnecessary is actually on disk.
    if (TERMINAL.has(next.status)) {
      try { fs.rmSync(this.#lock(task.id)); } catch { /* no lock to drop */ }
    }
    this._cache.delete(this.#file(task.id));
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
    // Who this leaves stranded.
    //
    // A task whose dependency does not exist scores zero forever: `score()`
    // requires every dependency to be LANDED, and a task that is gone can never
    // land. So removing one task can quietly make another unclaimable for the
    // rest of the backlog's life, and nothing said so at the moment it
    // happened. Watched it: t-0006 was removed after spending $2.29, t-0008
    // depended on it, and the loop reported "nothing ready" for weeks with a
    // queued task sitting in the backlog that no picker would ever take.
    //
    // Reported rather than refused. `--all` removes parents and children in one
    // pass and would otherwise trip over its own feet, and a person deleting a
    // task usually means it — what they cannot do is notice the consequence,
    // because it is in a different file. `blockers.js` already offers the
    // remedy (`dep-missing` → drop the dependency); this is what tells anyone
    // to go and look.
    const stranded = this.list()
      .filter(t => t.id !== safe
        && !TERMINAL.has(t.status)
        && (t.dependsOn ?? []).includes(safe))
      .map(t => ({ id: t.id, title: t.title, status: t.status }));
    fs.rmSync(this.#file(safe));
    this._cache.delete(this.#file(safe));
    try { fs.rmSync(this.#lock(safe)); } catch { /* no lock, or already gone */ }
    // Spend the number on the way out. `add` already records what it hands out,
    // so this only matters for a file a human wrote by hand and then removed —
    // but that is the whole point of the counter: the directory has just
    // forgotten this id, and the ledger has not.
    this.#recordId(safe);
    return { ...task, stranded };
  }

/**
   * Retire a task: move it out of the live queue into .flyt/archive/retired/.
   *
   * Unlike remove(), retirement keeps the evidence: the task frontmatter
   * (verbatim), the retirement record, and the run folders named by runIds
   * all move into a self-contained per-id directory. A retired task is gone
   * from the queue but can be brought back by revive() under the same id.
   */
  retire(id, { reason = null, by = null, force = false } = {}) {
    if (String(reason ?? '').trim() === '') {
      throw new Error('A retirement needs a reason.');
    }
    const safe = this.#assertId(id);
    let task = null;
    try {
      task = this.get(safe);
      if (!task) return null;
    } catch (err) {
      if (!fs.existsSync(this.#file(safe))) return null;
      task = { id: safe, title: '(unreadable)', status: 'unknown', unreadable: String(err.message ?? err) };
    }
    if (task.status === 'landed') {
      throw new Error('Task "' + safe + '" is landed; archive it rather than retiring it.');
    }
    if (!force && fs.existsSync(this.#lock(safe))) {
      throw new Error('Task "' + safe + '" is claimed by ' + (task.claimedBy ?? 'someone') + '. Release it before removing it.');
    }
    const stranded = this.list()
      .filter(t => t.id !== safe
        && !TERMINAL.has(t.status)
        && (t.dependsOn ?? []).includes(safe))
      .map(t => ({ id: t.id, title: t.title, status: t.status }));

    const retiredAt = new Date().toISOString();
    // The state root is the backlog's parent (`.flyt/`), and the two things
    // retirement touches sit at different depths under it: runs are `.flyt/runs`,
    // but the archive is `.flyt/archive` — `retiredDir()` joins `retired/<id>`
    // onto the ARCHIVE root, the same root `archive:write`, `archive:list` and
    // `trend` are handed. Passing the state root instead put every retirement in
    // `.flyt/retired/`, beside the archive rather than inside it, where nothing
    // that reads the archive would ever find it.
    const stateRoot = path.dirname(this.rootDir);
    const root = path.join(stateRoot, 'archive');
    const runsDir = path.join(stateRoot, 'runs');
    const dir = retiredDir(root, safe);
    const raw = fs.readFileSync(this.#file(safe), 'utf8');
    relocateRetiredRuns({
      root,
      runsDir,
      taskId: safe,
      runIds: Array.isArray(task.runIds) ? task.runIds : [],
      reason: String(reason ?? '').trim() || null,
      retiredBy: by ?? task.claimedBy ?? null,
      retiredAt,
      resumeFrom: task.resumeFrom ?? null
    });
    fs.writeFileSync(path.join(dir, safe + '.task.md'), raw);
    this.#recordId(safe);
    fs.rmSync(this.#file(safe));
    try { fs.rmSync(this.#lock(safe)); } catch { /* no lock, or already gone */ }
    this._cache.delete(this.#file(safe));
    return { ...task, retired: { dir, record: readRetirement(root, safe) }, stranded };
  }

  /**
   * Bring a retired task back into the queue, same id and attempts, queued.
   * The retirement record stays put: a revival is a second life, not an erasure.
   */
  revive(id) {
    const safe = this.#assertId(id);
    // The archive root, exactly as retire() resolves it — the two must agree or
    // a revival looks for the record in a place no retirement ever wrote to.
    const root = path.join(path.dirname(this.rootDir), 'archive');
    const dir = retiredDir(root, safe);
    const record = readRetirement(root, safe);
    if (!record) return null;
    if (fs.existsSync(this.#file(safe))) {
      throw new Error('Task "' + safe + '" is already in the backlog.');
    }
    let archived = null;
    const file = path.join(dir, safe + '.task.md');
    if (fs.existsSync(file)) {
      try { archived = parseTask(fs.readFileSync(file, 'utf8'), safe); } catch { archived = null; }
    }
    const patch = {
      title: archived?.title ?? null,
      status: 'queued',
      attempts: archived?.attempts ?? 0,
      dependsOn: archived?.dependsOn ?? [],
      gates: archived?.gates ?? [],
      blastRadius: archived?.blastRadius ?? [],
      references: archived?.references ?? [],
      skills: archived?.skills ?? [],
      budgetUsd: archived?.budgetUsd,
      value: archived?.value ?? 3,
      effort: archived?.effort ?? 3,
      level: archived?.level,
      createdBy: archived?.createdBy ?? 'human',
      createdAt: archived?.createdAt ?? record.retiredAt,
      resumeFrom: null,
      resumeStage: null,
      body: archived?.body ?? ''
    };
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null));
    const revived = this.add({ id: safe, ...fields });
    // The record and the runs are amended AFTER the task file exists, so a
    // failure to write the task never leaves stubs claiming a revival that did
    // not happen. The runs stay where they are (core/archive.js markRevived);
    // what changes is that they stop describing a retirement that is over.
    try { markRevived({ root, runsDir: path.join(path.dirname(this.rootDir), 'runs'), taskId: safe }); }
    catch { /* the task is back; an un-amended stub is a smaller loss */ }
    return revived;
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
      // An ORPHANED lock: the task file says queued and unclaimed, so whoever
      // wrote this lock never got as far as recording the claim, or died
      // between the two. The task file is the source of truth for whether a
      // task is held; the lock is only the atomicity primitive.
      //
      // Without this, a supervisor killed mid-claim leaves a task that looks
      // ready in `flyt task ready`, is skipped in silence by the picker, and
      // stays that way for a full hour — while the loop reports "nothing
      // ready" and blames some other task's missing dependency. Two of them
      // did exactly that after a stop.
      //
      // The grace period is what keeps this safe against the real race: claim()
      // writes the lock and then updates the file, so for a moment a live claim
      // also looks orphaned. Seconds are plenty for a local file write, and far
      // short of the lease.
      const orphaned = task.status === 'queued' && !task.claimedBy && age >= ORPHAN_LOCK_MS;
      if (age < leaseMs && !orphaned) return null; // someone else holds it, legitimately
      fs.writeFileSync(lockPath, payload); // lease expired, or the lock was left behind
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
  escalate(id, { reason = 'failed', note = '', workerAt = null } = {}) {
    const task = this.get(id);
    if (!task) throw new Error(`No task "${id}".`);
    const attempts = (task.attempts ?? 0) + 1;
    // `workerAt` comes from whoever knows which model a band resolves to — the
    // supervisor — because the backlog has no business reading loop config.
    // Without it the ladder cannot tell a rung from a repeat.
    const result = escalateLevel({ level: task.level ?? DEFAULT_LEVEL, reason, attempts, workerAt });
    const blockedReason = [result.reason, note].filter(Boolean).join(' ');
    // Where the ladder started, remembered once. Set here rather than at `add`
    // so a task that is never escalated carries nothing, and never overwritten
    // so the second rung does not record the first rung as the ground.
    const baseLevel = task.baseLevel ?? task.level ?? DEFAULT_LEVEL;
    if (!result.escalated) {
      return { ...this.update(id, { status: 'parked', attempts, blockedReason, baseLevel }), escalation: result };
    }
    // The lease goes with it: an escalated task is queued again, and a task
    // that is queued while still holding a lock can never be picked up.
    try { fs.unlinkSync(this.#lock(task.id)); } catch { /* no lock held */ }
    return {
      ...this.update(id, {
        status: 'queued', attempts, level: result.level, blockedReason, baseLevel,
        claimedBy: null, claimedAt: null
      }),
      escalation: result
    };
  }

  /**
   * Put a task back the way it was before something that was not its fault.
   *
   * The counterpart to `escalate`. A provider that refuses every call, a tool
   * that cannot edit a file, a loop whose process died — none of these are the
   * work being inadequate, but all of them used to arrive at the task as spent
   * attempts, a climbed effort ladder and a `blockedReason` describing work
   * that had never run. Five tasks needed this on 2026-08-24 and it did not
   * exist, so it was done by hand, from memory, at midnight.
   *
   * What comes back: the level it started at (from `baseLevel`, which the first
   * escalation recorded), no attempts, no block reason, no lease, and queued.
   * What does NOT come back is `repairs` — corrections spent on a body of work
   * that still exists are still spent, and the resumeFrom they belong to is
   * cleared here only because a task starting over must never resume from a
   * commit judged under different conditions.
   */
  reset(id, { reason = null, keepWork = false } = {}) {
    const safe = this.#assertId(id);
    const task = this.get(safe);
    if (!task) return null;
    if (task.status === 'landed') {
      throw new Error(`Task "${safe}" has landed; there is nothing to put back.`);
    }
    const level = task.baseLevel ?? task.level ?? null;
    const before = {
      status: task.status, attempts: task.attempts ?? 0,
      level: task.level ?? null, blockedReason: task.blockedReason ?? null,
    };
    // The lease goes, or a queued task nobody holds can never be picked up.
    try { fs.rmSync(this.#lock(safe)); } catch { /* no lock held */ }
    const next = this.update(safe, {
      status: 'queued',
      attempts: 0,
      level,
      baseLevel: null,
      blockedReason: reason ? `Reset: ${reason}` : null,
      // `keepWork` is for the case where the work is FINISHED and nothing
      // judged it — a reviewer that could not be reached, a provider that
      // refused after the commit. Throwing the commit away there would make the
      // next attempt rebuild a diff that was already good, which is the
      // expensive end of an infrastructure failure.
      //
      // `resumeStage` goes either way. It says which judgement produced the
      // commit — 'review' means a person read this and asked for one change —
      // and after a refusal no judgement happened at all, so keeping it would
      // tell the next attempt something untrue about work nobody looked at.
      resumeFrom: keepWork ? (task.resumeFrom ?? null) : null,
      resumeStage: null,
      failureSignature: null,
      failureCount: null,
      claimedBy: null,
      claimedAt: null,
    });
    return { ...next, before };
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
