// The supervisor (DESIGN-SPEC.md §8).
//
// The outermost loop, which used to be a person pressing Run:
//
//   pick → claim → isolate → run → verify → review → land → record → repeat
//
// It runs until the backlog has nothing ready, a cap trips, or someone stops
// it. There is no clock (§1). What replaces the clock is this file: a poll per
// in-flight task that knows the difference between working and stuck, and the
// authority to nudge, restart, escalate or park (§11.4).
//
// Two rules shape everything here.
//
// A GATE PARKS ITS TASK, IT NEVER BLOCKS THE LOOP (§10). Unattended, one
// approval request would otherwise cost the rest of the day. The question goes
// into the review pile with its context and the supervisor takes the next task.
//
// NOTHING IS DECIDED IN MEMORY. Every transition is a file the next process can
// read — the backlog entry, the ledger line, the run's own artifacts — so a
// supervisor killed at 2pm and restarted at 2:01pm resumes from what is on disk
// rather than from what it remembered.
import fs from 'node:fs';
import path from 'node:path';
import { Heartbeat, detectStall, nextIntervention, DEFAULT_THRESHOLDS } from './heartbeat.js';
import { escalate as escalateLevel, levelFor, workerForLevelMap } from './levels.js';
import { spendFromRun, totalsWithLive } from './ledger.js';
import { captureWorkspaceSignature } from './effect.js';
import { unrunnableGates } from './gates.js';
import { whyNothingReady } from './blockers.js';
import { CONFIG_DIR } from './brand.js';
import { skillPath } from './skills.js';

// Which of a task's declared skills a checkout does not actually contain.
// Deliberately a plain existence check against the worktree rather than a
// resolve through Workspace: the question is "is the file in this checkout",
// and the answer has to survive the directory not being a bound workspace yet.
function missingSkills(dir, names) {
  if (!dir || !names?.length) return [];
  return names.filter(raw => {
    const name = String(raw ?? '').trim();
    if (!name) return false;
    try { return !fs.existsSync(path.join(dir, skillPath(name))); }
    catch { return false; }
  });
}

const POLL_MS = 5000;

// How many polls a deferred restart waits for the walk to unwind before the
// ladder gives up on that rung. The unwind is normally immediate — stop()
// aborts the in-flight calls — but an abort that has to travel to a provider
// can take a few seconds, and a rung is worth more than five seconds of
// patience. It is not worth unbounded patience: a task nothing can restart
// still has to reach a decision.
const RESTART_UNWIND_POLLS = 12;

/**
 * The one thing a task file cannot tell the agent: how this will be judged.
 *
 * Landing means merging a DIFF (§6.2). An answer written as prose — however
 * good, however well cited — leaves the repository unchanged, and an unchanged
 * repository is an empty diff, which cannot land whatever the work was worth.
 *
 * The agent cannot know this from the task text. It reads "produce a cited
 * report" and produces one, as its answer, which is exactly what it was asked
 * for. Observed across five attempts on two models and three tasks: every one
 * read the right files, reasoned well, answered in prose, and changed nothing —
 * so every one was rejected by a reviewer for having no diff, and climbed a
 * band to do the same thing again with a more expensive model.
 *
 * So the supervisor says it, because the supervisor is the part that knows.
 */
const HOW_IT_LANDS = [
  'HOW THIS WILL BE JUDGED (added by the supervisor, not by whoever wrote the task):',
  '',
  'Your work is accepted only if it leaves a CHANGE IN THE FILES of this workspace.',
  'The harness runs the project\'s gates, a reviewer reads your diff, and the result is',
  'merged. A run that changes no file produces an empty diff and cannot be accepted, no',
  'matter how good its answer is — prose in your final message is not a deliverable.',
  '',
  'So: if the task asks for a report, an analysis or an answer, WRITE IT INTO A FILE with',
  'create_file or write_file (`docs/<something>.md` is a reasonable home when the task does',
  'not say). If it asks for code, change the code. Read whatever you need first, but end by',
  'writing.',
  '',
  'If the task cannot be done here at all — it names files this repository does not have, or',
  'asks for something already true — do not invent work to look busy. Change nothing, and begin',
  'your final answer with a line starting `TASK-IMPOSSIBLE:` followed by what you actually found.',
  '',
  // Described, not demonstrated. A worked example here is a line that matches
  // the sentinel, sitting inside the brief the first node of every run echoes
  // as its output — which is how a task about a JSONL session tree parked as
  // "there is no code_quality_manager.py anywhere in this repository". The scan
  // now ignores anything it was asked, and the brief no longer asks it.
  'What follows the colon is your OWN finding, in one line: the thing you looked for, where you',
  'looked, and what was there instead. Naming the file or symbol you could not find is what makes',
  'it readable weeks later.',
  '',
  'That line parks the task for a person instead of retrying it on a more expensive',
  'model, so use it only when more capability could not help; if you simply failed, say that',
  'instead and it will be retried.'
].join('\n');

/**
 * Where a task's file names actually live, when it was learned from elsewhere.
 *
 * A task written by reading someone else's repository describes THAT
 * repository's files, and the agent claiming it is standing in this project,
 * where those paths do not exist. Every such agent then reports the task
 * impossible — correctly, from where it is standing — and a perfectly good
 * backlog parks. Watched exactly that happen: nine tasks naming
 * `code_quality_manager.py` and `agent.py`, while a read-only clone containing
 * both sat in the reference library the whole time, mentioned by nothing.
 *
 * The task carries the reference name (`references:`), so the brief can say
 * where to look and how — which is all that was missing.
 */
/**
 * A duration as a person would say it: "24h", "90min", "45s".
 *
 * Used in the one message where the span matters — a cap the loop hit before
 * it started reads as nonsense unless it says what window the number covers.
 *
 * @param ms — the span.
 * @returns a short human label.
 */
function formatSpan(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'this session';
  if (n >= 3600_000) return `${Math.round(n / 3600_000)}h`;
  if (n >= 60_000) return `${Math.round(n / 60_000)}min`;
  return `${Math.max(1, Math.round(n / 1000))}s`;
}

// How often a task's workspace is actually looked at. The detectors work in
// minutes; sampling faster spends a git process per poll and answers the same
// question.
const WORKSPACE_SAMPLE_MS = 15_000;

/** How a budget park introduces the work reason it is preserving. */
const WORK_REASON_TAIL = ' Its last attempt was rejected on the work, not the money: ';

/** A reason that is about the wallet rather than about the work. */
const BUDGET_REASON = /per-task cap/;

/**
 * Where the work is expected to LAND, when the task said so.
 *
 * `blastRadius` is on every task file and reaches nothing. Watched a worker
 * spend 52 tool calls and four minutes without writing a byte: it read the
 * task, listed the backlog, opened two unrelated tasks, globbed for a tsconfig,
 * tried to cd into a path from another machine, and read four files none of
 * which were the contract it needed — while the task file had named the two
 * files it was supposed to create, in a field nothing put in front of it.
 *
 * A hint about scope, not a fence. Nothing here narrows or widens what the
 * ceiling already allows; it only stops the discovery pass from being the
 * whole attempt.
 */
function whereItLands(task, root = null) {
  const paths = (task.blastRadius ?? []).map(p => String(p).trim()).filter(Boolean);
  if (!paths.length) return '';
  // NEW or EXISTING, because those are different jobs and the agent finds out
  // by reading either way. It also catches the mistake from the other side: a
  // task file that names `tests/library.test.js` for a brand-new v2 library
  // sends the worker into two hundred lines about the v1 node library, and it
  // sent one there for four hundred calls and forty cents.
  const label = p => {
    if (!root) return `\`${p}\``;
    try {
      const full = path.resolve(root, p);
      if (!fs.existsSync(full)) return `\`${p}\` (new)`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) return `\`${p}\` (an existing directory)`;
      const lines = fs.readFileSync(full, 'utf8').split('\n').length;
      return `\`${p}\` (exists, ${lines} lines — read it before you change it)`;
    } catch { return `\`${p}\``; }
  };
  return [
    'WHERE THIS WORK GOES (added by the supervisor):',
    '',
    `Whoever wrote this task expected it to change: ${paths.map(label).join(', ')}.`,
    '',
    'Read those first — the contract you need is almost certainly in them, and a discovery pass',
    'that goes anywhere else is the part of the attempt that produces nothing. It is a hint about',
    'scope rather than a fence: change what the task actually needs. But if you finish having',
    'changed none of them, say why in your final message.'
  ].join('\n');
}

function whereItCameFrom(task) {
  const refs = (task.references ?? []).filter(Boolean);
  if (!refs.length) return '';
  const list = refs.map(r => `\`reference:${r}\``).join(', ');
  return [
    'WHERE THIS TASK CAME FROM (added by the supervisor):',
    '',
    `This task was written by reading ${list} — a read-only clone in the reference`,
    'library, NOT part of this project. Any file, class or function it names that you cannot',
    'find here is almost certainly there, and its absence from this workspace is the point of',
    'the task rather than a reason it cannot be done.',
    '',
    `Search it with \`search_references\` and open a file with \`read_file\` on`,
    `\`reference:${refs[0]}/<path>\`. Look there BEFORE concluding anything is missing.`,
    '',
    'What you write still goes into THIS project. The reference is what you are learning from;',
    'the workspace is what you are changing.'
  ].join('\n');
}

// How an agent says "not here". A sentinel line rather than a judgement about
// its prose: the difference between "I could not do this" and "this cannot be
// done" decides whether the ladder is worth climbing, and it is not a
// difference to infer from wording.
const IMPOSSIBLE = /^\s*TASK-IMPOSSIBLE:\s*(.+)$/m;

/**
 * Is this failure the provider refusing everyone, rather than this task failing?
 *
 * A spent key, a revoked one, an exhausted quota: none of it is about the work,
 * and every task after it will fail the same way in seconds. Left alone the
 * loop treats each as a failed attempt, climbs a band, tries again, exhausts
 * the ladder and parks the task — then does it to the next one. Watched live: a
 * key hit its spending limit and two tasks were driven from their own band to
 * `max` and parked, four attempts and three attempts, in under a minute, with
 * `$0.0000 across 0 call(s)` on each. The backlog was being destroyed at the
 * speed of an HTTP error.
 *
 * 429 is deliberately NOT here. Rate limiting is transient and the adapter
 * already retries it with backoff; stopping the night for one would be its own
 * failure.
 */
/**
 * Is this failure the MODEL being unreachable, rather than the task being hard?
 *
 * The adapter retries 429 with backoff, which is right and is why
 * `providerBlocked` leaves it alone. But a free-tier model sitting behind a
 * shared upstream pool is rate-limited for minutes, not for the thirty seconds
 * a bounded backoff can wait — so the retries run out, the run fails, and the
 * supervisor reads a failed run as a failed attempt.
 *
 * Watched twice in one session:
 *
 *   ▶ t-0070 … on z-ai/glm-5.2:free (band medium)
 *     t-0070 run failed, $0.0000 across 2 call(s)
 *   ↑ retrying at "high"
 *
 * `$0.0000 across 2 call(s)` is the tell: nothing answered, so nothing about
 * this task was tried. Escalating spends a rung of the ladder on a model that
 * never spoke, and the rung is gone whether or not it was used.
 *
 * A bigger model is not the missing piece here; a MOMENT is. So the task goes
 * back at the same band, and the loop tries something else meanwhile.
 *
 * Not `providerBlocked`: a spent key fails every task forever and stops the
 * loop, and a rate-limited model fails one task for a few minutes. Treating
 * them alike would stop a night's work for a shared pool being busy.
 */
export function modelUnavailable(error) {
  const s = String(error ?? '');
  if (!s) return null;
  // A 401/403/quota failure is the other thing, and it wins: it stops the loop.
  if (providerBlocked(s)) return null;
  if (/\b429\b/.test(s) || /\brate[- ]?limit(ed|ing)?\b/i.test(s)) {
    const raw = /"raw"\s*:\s*"([^"]+)"/.exec(s)?.[1];
    return (raw ?? /"message"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? s.slice(0, 160)).trim();
  }
  // "No instances available", "temporarily unavailable", a bare 502/503 — the
  // provider is up and this model is not.
  if (/\b50[23]\b/.test(s) || /\bno (instances|providers?) available\b/i.test(s)
    || /\btemporarily unavailable\b/i.test(s)) {
    return s.slice(0, 160).trim();
  }
  return null;
}

/**
 * How many times one task may be set aside for an unreachable model before the
 * loop stops believing the model will come back.
 *
 * Bounded because "put it back and try later" with no ceiling is a loop that
 * spins on a model that is never coming back, reporting progress it is not
 * making.
 */
export const UNAVAILABLE_RETRIES = 3;
/**
 * How long a task waits after colliding with a live attempt.
 *
 * A worktree lease goes stale after `OWNER_LIVE_MS` (ten minutes) without a
 * heartbeat, so waiting for one is a wait of MINUTES. Releasing the task back
 * to a picker that runs every five seconds is not a wait; it is a spin that
 * spends the whole allowance before the lease could possibly have expired.
 */
export const LEASE_WAIT_MS = 4 * 60 * 1000;

export function providerBlocked(error) {
  const s = String(error ?? '');
  if (!s) return null;
  if (/\b40[13]\b/.test(s) || /\b(unauthorized|forbidden)\b/i.test(s)) {
    const detail = /"message"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? s.slice(0, 200);
    return detail.trim();
  }
  if (/\b(key limit exceeded|insufficient (credit|funds|balance)|quota exceeded|billing)\b/i.test(s)) {
    return s.slice(0, 200).trim();
  }
  return null;
}

export class Supervisor {
  /**
   * @param {object} deps
   * @param {(name: string, args: object) => Promise<any>} deps.invoke  the command surface
   * @param {string} deps.projectId
   */
  constructor({
    invoke, projectId, backlog, ledger, store = null, config = {},
    parallelism = 1, only = null, pollMs = POLL_MS, log = () => {}, now = () => Date.now(),
    // Where the status goes so that something OTHER than this process can read
    // it (§11.1: the record is owned by the supervisor and kept outside the
    // worktree). Without it the loop is only observable from the terminal that
    // started it: `flyt loop status` in a second window, `flyt report`, and the
    // desktop app's Loop view all answered "no loop running" while one was
    // working — which is a strange thing for a system whose entire premise is
    // running while nobody is watching.
    writeStatus = () => {},
    // Asked to stop by someone who is not in this process. Checked once per
    // tick, so a stop takes effect within a poll and still winds down cleanly —
    // in-flight work finishes rather than being abandoned half-landed.
    stopRequested = () => null
  }) {
    this.invoke = invoke;
    this.projectId = projectId;
    // The run store, for reading what a finished run spent out of its own
    // artifacts (core/ledger.js) rather than threading a hook through every
    // call site.
    this.store = store;
    this.backlog = backlog;
    this.ledger = ledger;
    this.config = config;
    this.parallelism = Math.max(1, parallelism);
    // The task ids this session may claim, or null for the whole backlog.
    this.only = Array.isArray(only) && only.length ? only.map(String) : null;
    this.pollMs = pollMs;
    this.log = log;
    this.now = now;
    this.writeStatus = writeStatus;
    this.stopRequested = stopRequested;

    this.running = false;
    this.stopping = null;      // why we are winding down, if we are
    this.inFlight = new Map(); // taskId -> Heartbeat
    this.attempts = new Map(); // taskId -> attemptId (WR-02 ownership)
    this.history = [];         // finished attempts, for the report
    this.durations = [];       // how long each finished attempt took, for the outlier detector
    this.parked = [];          // things waiting on a person
    this.unavailable = new Map(); // taskId → times its model did not answer at all
    this.deferred = new Map();    // taskId → the earliest moment it is worth trying again
    this.noEscalate = false;   // set when the soft cap trips
    // The last green canary's output — the base branch's own test count, handed
    // to the next task as its "before" (§7.3).
    this.lastCanaryOutput = null;
  }

  status() {
    return {
      running: this.running,
      stopping: this.stopping,
      // What this loop is actually running on, which is not necessarily what
      // the settings say right now: a pick made after the loop started belongs
      // to the next one, and a panel that showed the setting instead of the
      // session would be reporting an intention as a fact.
      model: this.config.loop?.worker?.model ?? null,
      // The band→model map this session is working to, when it has one. A
      // single `model` cannot describe it: the whole point is that the answer
      // differs per attempt.
      models: this.config.loop?.models ?? {},
      inFlight: [...this.inFlight.values()].map(h => h.toJSON()),
      parked: this.parked.slice(-20),
      completed: this.history.length,
      landed: this.history.filter(h => h.landed).length,
      // Recorded spend PLUS what the runs in flight have already cost. A panel
      // that shows only settled spend reads $0 through the whole stretch the
      // money is being spent, which is the one stretch somebody is watching it
      // for. `live` is broken out so a reader can tell the two apart.
      spend: this.#spendNow(),
      noEscalate: this.noEscalate
    };
  }

  /**
   * Publish the status where another process can read it.
   *
   * Called on every transition and every poll, so a reader never sees a state
   * the loop left minutes ago. `pid` and `at` ride along because the reader's
   * hard question is not "what does this say" but "is whoever wrote it still
   * alive" — a status file outlives the process that wrote it, and a crashed
   * loop that still claims to be running is worse than no file at all.
   */
  #publish() {
    try {
      this.writeStatus({ ...this.status(), pid: process.pid, at: new Date(this.now()).toISOString() });
    } catch { /* an unwritable status file must never take the loop down */ }
  }

  #windowMs() { return this.config.loop?.windowMs ?? 24 * 60 * 60 * 1000; }
  #caps() { return this.config.loop?.caps ?? {}; }

  /**
   * Run until there is nothing ready, a cap trips, or stop() is called.
   *
   * `maxTasks` is for tests and for a deliberately bounded session; the normal
   * mode is unbounded, because the loop is bounded by the backlog and the
   * budget rather than by a count someone guessed.
   */
  async run({ maxTasks = Infinity } = {}) {
    this.running = true;
    this.stopping = null;
    this.startedAtMs = Date.now();
    let started = 0;
    this.#publish();

    try {
      while (this.running && started < maxTasks) {
        // The hard cap is checked before anything new begins: finishing the
        // in-flight work and stopping cleanly is the promise (§9).
        const budget = this.#checkBudget();
        if (budget.action === 'stop') {
          // A cap that was already tripped when the loop started is different
          // news from one this loop's own work reached: nothing was attempted,
          // and saying only "hard cap reached" sends the reader looking for
          // work that never happened.
          this.stopping = started === 0 && budget.scope !== 'session'
            ? `hard cap reached before any task started: $${budget.window.usd.toFixed(2)} already spent`
              + ` in the last ${formatSpan(this.#windowMs())}, cap $${Number(budget.caps.hardUsd).toFixed(2)}`
              + ' — nothing was attempted'
            : `hard cap reached ($${budget.window.usd.toFixed(2)})`;
          this.log(this.stopping);
          break;
        }
        if (budget.action === 'no-escalate' && !this.noEscalate) {
          this.noEscalate = true;
          this.log(`soft cap reached ($${budget.window.usd.toFixed(2)}) — no further escalation`);
        }

        if (this.inFlight.size >= this.parallelism) { await this.#tick(); continue; }

        const task = this.backlog.take('supervisor', { only: this.only });
        // A task set aside a moment ago is not ready yet, whatever the picker
        // thinks. Put it back and take a tick: the picker scores what is
        // QUEUED, and a task waiting for someone else's lease to expire is
        // queued and not startable, which are different things.
        if (task && (this.deferred.get(task.id) ?? 0) > this.now()) {
          this.backlog.release(task.id, { status: 'queued' });
          await this.#tick();
          continue;
        }
        if (task) this.deferred.delete(task.id);
        if (!task) {
          // Nothing ready. If work is in flight it may unblock something, so
          // keep polling; otherwise the loop is genuinely done.
          //
          // "Done" and "stuck" look identical from here and are not the same
          // news. A backlog of four where the first task parks and the other
          // three depend on it has nothing READY, and reporting that as
          // "backlog empty" tells the person who comes back in the morning that
          // the night went fine — the loop stopped after one task, three good
          // tasks sat behind a parked one, and the status said empty. Say which
          // it is, and what is in the way.
          if (!this.inFlight.size) { this.stopping = this.#whyNothingReady(); break; }
          await this.#tick();
          continue;
        }
        if (task.stolen) this.log(`reclaimed an expired lease on ${task.id} from ${task.claimedBy}`, { taskId: task.id });
        started += 1;
        await this.#begin(task);
      }

      // Wind down: let what is in flight finish rather than abandoning it
      // half-landed.
      while (this.inFlight.size) await this.#tick();
    } finally {
      this.running = false;
      // The last thing written says it stopped, so a reader does not inherit a
      // file claiming work is in flight after the process is gone.
      this.#publish();
    }
    return this.status();
  }

  stop(reason = 'stopped by request') {
    this.stopping = reason;
    this.running = false;
  }

  /** Caps named on THIS start call, as opposed to the project's standing ones. */
  #sessionCaps() { return this.config.loop?.sessionCaps ?? {}; }

  /**
   * What the budget says right now.
   *
   * Two kinds of cap, measured over two different spans, because they answer
   * two different questions:
   *
   * - a cap in the project's config is a standing guard on a rolling window —
   *   "this project may spend $20 a day, whoever starts a loop";
   * - a cap named on `loop start` is this session's ceiling — "the next few
   *   hours may cost $2".
   *
   * Measuring the second one over the first one's window is why `--cap-usd 2`
   * on a project that already spent $7 today refused to start a single task
   * and reported a cap the caller had not reached. A session cap counts what
   * THIS loop spent, from the moment it started.
   */
  #checkBudget(taskId = null) {
    if (!this.ledger) return { ok: true, action: null, window: { usd: 0 } };
    const session = this.#sessionCaps();
    const caps = this.#caps();
    const standing = Object.fromEntries(Object.entries(caps).filter(([k]) => !(k in session)));

    // What the runs currently in flight have already spent. Recorded spend
    // arrives only when a run ends, so without this the window ceiling reads
    // zero for exactly as long as the money is being spent.
    const live = this.#liveSpend();
    const byWindow = this.ledger.check({ caps: standing, taskId, windowMs: this.#windowMs(), extraUsd: live });
    if (!Object.keys(session).length) return byWindow;

    // Since the loop started, floored at a millisecond so a check on the first
    // tick still reads the ledger rather than dividing by nothing.
    const sinceStart = Math.max(1, Date.now() - (this.startedAtMs ?? Date.now()));
    const bySession = this.ledger.check({ caps: session, taskId, windowMs: sinceStart, extraUsd: live });

    const hits = [...new Set([...byWindow.hits, ...bySession.hits])];
    const strongest = bySession.hits.length ? bySession : byWindow;
    return {
      ...strongest,
      ok: !hits.length,
      hits,
      action: hits.includes('hard') ? 'stop' : hits.includes('task') ? 'park' : hits.includes('soft') ? 'no-escalate' : null,
      // Which span the reported number covers, so the message can say it.
      scope: bySession.hits.length ? 'session' : 'window',
      caps
    };
  }

  async #begin(task) {
    // Can this task afford another attempt at all?
    //
    // Watched live: attempt one spent $0.97 of a $1.20 cap and produced no
    // workspace change, so the ladder escalated to a MORE expensive band,
    // spent $0.25 more, and hit the cap mid-run. The task parked having spent
    // its whole allowance and landed nothing. An attempt that will be killed
    // partway is the worst of the three outcomes — it costs the money and
    // produces neither work nor an answer — so a task with no room for one is
    // parked before it starts, with the numbers that decided it.
    const shortfall = this.#cannotAfford(task);
    if (shortfall) { this.#park(task.id, this.#keepingWorkReason(task, shortfall)); return; }

    const level = levelFor(task, this.config);
    // Which model this attempt runs on. Three shapes, most specific first:
    //
    //   models  — a model PER BAND. Escalation then buys a bigger model again,
    //             by name instead of by price tier, which is how a backlog gets
    //             worked by something cheap while only the tasks that fail
    //             reach the expensive one.
    //   worker  — one model for everything. The rungs still count attempts and
    //             still end in parking (that is what stops a task retrying
    //             forever); what escalation no longer buys is a bigger model.
    //   neither — a band, and OpenRouter's Auto Router picks inside it.
    //
    // Said out loud in the log either way, because "escalated to high" should
    // not imply a change of model that did not happen.
    // A gate this machine cannot run makes the task unlandable however good the
    // work is, and nothing would say so until the work was finished and paid
    // for. Nine of this project's thirteen tasks arrived asking for `pytest` in
    // a repository with no Python. Parking costs nothing; finding out afterwards
    // costs a run.
    const badGates = unrunnableGates(task.gates ?? []);
    if (badGates.length) {
      this.#park(task.id, `Declares a gate that cannot run here: ${
        badGates.map(g => g.problem).join('; ')}. Fix the task's gates, or run it somewhere that has them.`);
      return;
    }

    const worker = this.#workerFor(level);
    this.log(`▶ ${task.id} "${task.title}" ${worker ? `on ${worker.model} (band ${level})` : `at ${level}`}`, { taskId: task.id });
    // startedAt, so "how long did this take" survives the process that knew.
    // The first attempt sets it and a retry does not, because the question the
    // benchmark asks is how long the TASK took, not the last try at it.
    this.backlog.update(task.id, {
      status: 'running', level,
      startedAt: task.startedAt ?? new Date(this.now()).toISOString()
    });

    try {
      const wt = await this.invoke('work:start', { projectId: this.projectId, taskId: task.id });
      // The attempt this supervisor owns. Every destructive call it makes later
      // names it, so a cleanup that arrives after the task was restarted cannot
      // delete the newer attempt's worktree (WR-02).
      this.attempts.set(task.id, wt.attemptId ?? null);
      // A worktree is a CHECKOUT, so a skill file that is untracked — or merely
      // .gitignored, which is how the skills directory started out — is simply
      // not there. The task attached the expertise, the run logged
      // `skill_missing` into log.jsonl, and nobody looked. Missing expertise
      // must not park a task (a worker without it still works, just worse), but
      // it must be said out loud in the place a person is actually watching.
      for (const name of missingSkills(wt.dir, task.skills)) {
        this.log(
          `  ${task.id} declares skill "${name}" and the worktree has no ${CONFIG_DIR}/skills/${name}.md`
          + ' — untracked, ignored, or misspelled. The worker runs without it.',
          { taskId: task.id });
      }
      const runId = await this.invoke('flow:run', {
        projectId: this.projectId,
        flowId: this.config.loop?.flowId ?? 'default-pipeline',
        userInput: this.#briefFor(task),
        // THE WORKTREE, not the main checkout. Without this the isolation is
        // built and then bypassed: every task would edit the repo the loop is
        // merging into, and two parallel tasks would edit each other's work.
        workspaceDir: wt.dir,
        // Unattended: tool calls run through. Node gates still park the task
        // rather than blocking the loop — see #tick.
        approvalMode: 'always',
        // `loop.levels: false` runs on whatever workers are configured, for a
        // project whose keys are not OpenRouter's.
        level: this.config.loop?.levels === false ? null : level,
        worker,
        // This run belongs to a task, and its spend is recorded against that
        // task when the task ends. Saying so is what keeps the runner from
        // recording the same calls a second time as an unattributed run.
        loopTaskId: task.id,
        // What this task said its worker needs to know (core/backlog.js
        // `skills`). Unattended work is exactly where rediscovering a
        // convention by trial and error is most expensive: nobody is watching
        // to say "we do it this way here", so the task has to.
        skills: task.skills ?? null
      });
      const hb = new Heartbeat({ taskId: task.id, runId, level, now: this.now(), model: worker?.model ?? null });
      // Where the work is supposed to appear. The heartbeat reads it to tell
      // accomplishment from talking (workSignature).
      hb.dir = wt.dir;
      this.inFlight.set(task.id, hb);
      this.backlog.update(task.id, { runIds: [...(task.runIds ?? []), runId] });
      // Say so at once rather than at the next tick: a task appearing in flight
      // is the most interesting single event a watcher sees.
      this.#publish();
    } catch (err) {
      // A previous attempt's tree is still held, and its holder is still alive
      // as far as the pool can tell. That is a WAIT, not a decision for a
      // person: an owner whose process died releases the slot when its
      // heartbeat goes stale, and the next pass picks the task up.
      //
      // Watched it park a task for this: a loop was stopped mid-attempt, the
      // next session found the lease and parked the work permanently, which is
      // the one outcome nothing recovers from on its own.
      if (err?.code === 'attempt_live') {
        const seen = (this.unavailable.get(task.id) ?? 0) + 1;
        this.unavailable.set(task.id, seen);
        if (seen <= UNAVAILABLE_RETRIES) {
          // DEFERRED, not just released. The lease goes stale after
          // `OWNER_LIVE_MS` without a heartbeat, so "wait for it" is a wait of
          // minutes — and releasing it back to a picker that runs every five
          // seconds is not a wait, it is a spin. Watched it burn all three
          // tries in under a minute and park the task:
          //
          //   ↻ t-0071 set aside: already has a live attempt … Waiting.
          //   ↻ t-0071 set aside: already has a live attempt … Waiting.
          //   ⏸ t-0071 parked: Could not start …
          this.deferred.set(task.id, this.now() + LEASE_WAIT_MS);
          this.backlog.release(task.id, { status: 'queued' });
          this.log(`↻ ${task.id} set aside for ${Math.round(LEASE_WAIT_MS / 60000)} min:`
            + ` ${err.message} Waiting for that lease to go stale.`, { taskId: task.id });
          this.#publish();
          return;
        }
      }
      // A task that cannot even be started is not a task that should be retried
      // at a bigger model: the failure is in the harness, not the capability.
      this.log(`✖ ${task.id} could not start: ${err.message}`, { taskId: task.id });
      this.#park(task.id, `Could not start: ${String(err.message ?? err)}`);
    }
  }

  // What the run is told. The task file is already written for a reader who has
  // not seen this run (§5.1), so the brief is the task, not a summary of it —
  // plus the one thing the task file cannot know, which is how it will be
  // judged.
  #briefFor(task) {
    return [
      task.title,
      task.body,
      whereItLands(task, this.projectId),
      whereItCameFrom(task),
      HOW_IT_LANDS,
      task.blockedReason ? `\nA PREVIOUS ATTEMPT FAILED:\n${task.blockedReason}` : '',
      // When the last attempt was rejected at REVIEW, its work is already in
      // this worktree — gates green, one specific objection. Saying so is what
      // turns "rebuild it" into "fix that". Without this line the worker opens
      // a checkout it does not recognise as its own and writes the whole thing
      // again, which is both the expensive answer and the one that loses the
      // parts nobody objected to.
      task.resumeFrom
        ? 'THE PREVIOUS ATTEMPT IS ALREADY HERE. Its commit is checked out in this worktree and its'
          + ' gates passed; a reviewer read it and asked for the change above. Read the diff'
          + ' (`git show HEAD`, `git diff HEAD~1`) and CORRECT it. Do not start over — the parts'
          + ' nobody objected to are the parts you would be throwing away.'
        : ''
    ].filter(Boolean).join('\n\n');
  }

  /** One poll across everything in flight. */
  async #tick() {
    await new Promise(r => setTimeout(r, this.pollMs));
    // A stop asked for from somewhere else — the app's button, a second
    // terminal. It reaches the same `stop()` a local caller uses, so it winds
    // down the same way: what is in flight finishes, nothing is abandoned
    // half-landed.
    const asked = this.stopRequested();
    if (asked && this.running) {
      this.log(`stop requested: ${asked}`);
      this.stop(asked);
    }
    this.#publish();
    for (const [taskId, hb] of [...this.inFlight]) {
      try {
        // Say "still mine" before doing anything else with this task. A long
        // reasoning call is not an abandoned attempt, and the ownership record
        // is what the next `work:start` reads to tell the two apart (WR-02).
        const attemptId = this.attempts.get(taskId);
        if (attemptId) {
          await this.invoke('work:touch', { projectId: this.projectId, taskId, attemptId })
            .catch(() => { /* a missed beat is not a reason to stop polling */ });
        }
        await this.#pollTask(taskId, hb);
        hb.pollErrors = 0;
      } catch (err) {
        // A poll that keeps failing is not a task that keeps running: something
        // about this task cannot be observed, and observing it is the only way
        // the loop can ever finish it. Without a ceiling here the loop spins on
        // it forever, doing nothing, which is worse than either succeeding or
        // giving up.
        hb.pollErrors = (hb.pollErrors ?? 0) + 1;
        this.log(`poll ${taskId}: ${err.message}`, { taskId });
        if (hb.pollErrors >= (this.config.loop?.maxPollErrors ?? 5)) {
          await this.#discard(taskId);
          this.#park(taskId, `Could not be observed: ${err.message}`);
        }
      }
    }
  }

  async #pollTask(taskId, hb) {
    const snapshot = await this.invoke('run:snapshot', { projectId: this.projectId, runId: hb.runId });
    const stage = snapshot.meta?.stage;

    // A restart the ladder asked for and could not take yet (see #intervene).
    // First, because the run is stopped: its bytes are frozen, so observing it
    // would read as "byte-identical work" and trip the detector that put it
    // here, and its stage is terminal, so every branch below would treat a run
    // that is about to relaunch as one that ended.
    if (hb.pendingRestart) {
      const { nodeId, guidance, rung, stall } = hb.pendingRestart;
      try {
        await this.invoke('run:restartNode', {
          projectId: this.projectId, runId: hb.runId, nodeId, guidance
        });
      } catch (err) {
        // Still unwinding. A bound, because a restart that never lands must not
        // hold a task in flight forever: give up on the rung and take the next
        // one, which is what the ladder does with any rung it cannot use.
        hb.restartWaits = (hb.restartWaits ?? 0) + 1;
        if (hb.restartWaits < RESTART_UNWIND_POLLS) return;
        hb.pendingRestart = null;
        this.log(`  ${taskId} could not ${rung} ${nodeId}: ${err.message}`, { taskId });
        if (!hb.interventions.includes('restart')) hb.interventions.push('restart');
        await this.#intervene(taskId, hb, stall);
        return;
      }
      hb.pendingRestart = null;
      hb.restartWaits = 0;
      // A restart is a fresh attempt: EVERY counter that measures "since the
      // work last changed" starts over, or the next poll trips the same
      // detector and burns the next rung. This reset used to name the spin
      // counters only, and the burn counter went on accumulating — so a task
      // whose burn threshold was $0.15 took nudge, restart and escalate inside
      // a few polls, at $0.15, $0.22 and $0.23.
      hb.restarted(this.now());
      this.log(`  ${taskId} ${rung}: restarted ${nodeId} with guidance`, { taskId });
      return;
    }

    // What this task has cost SO FAR — previous attempts from the ledger, plus
    // the run currently in flight read from its own artifacts. The ledger is
    // written when a run ends, so reading only the ledger meant an in-flight
    // task always reported $0 and the per-task cap below could never fire: the
    // one ceiling whose job is to stop a single runaway task was decorative.
    const taskSpend = this.#spentOn(taskId, hb);
    // What this poll cost, as a DELTA. The burn detector exists to catch a
    // polite infinite loop — busy, expensive, producing the same thing every
    // time — and it was handed a hard-coded zero on every poll, so its counter
    // could never reach any threshold. A detector that cannot fire is not a
    // safety net, it is a comment.
    const usage = this.#liveUsageOf(hb);
    const usd = Math.max(0, usage.usd - (hb.seenUsd ?? 0));
    const tokens = Math.max(0, usage.tokens - (hb.seenTokens ?? 0));
    hb.seenUsd = usage.usd;
    hb.seenTokens = usage.tokens;
    hb.observe(snapshot, { now: this.now(), usd, tokens, workspace: this.#workspaceOf(hb) });
    // Which node the ladder's nudge and restart rungs would act on. Without
    // this they silently fall through to escalate, which spends money to solve
    // a problem the cheapest rung might have fixed.
    hb.currentNode = currentNodeOf(snapshot);

    // A gate. Which KIND decides whether the loop may answer it (§10).
    //
    //   'pre'        — a node's requiresApproval: "does this plan look right?".
    //                  In loop mode the real check is the landing sequence —
    //                  harness-run gates, a reviewer on the diff, a canary on
    //                  the merge — all of which happen after this and judge the
    //                  actual change rather than the intention. Auto-approving
    //                  is defensible precisely because something stricter comes
    //                  later. The shipped default pipeline has one of these, so
    //                  without this the loop parks every task and achieves
    //                  nothing.
    //   'escalation' — step-eval concluded a human must decide. That is the
    //                  case this loop exists to defer, not to answer.
    //   'tool'       — a call that wanted more than approvalMode: 'always'
    //                  allows. Fail-closed: park it.
    if (stage === 'awaiting_approval') {
      const kind = snapshot.meta?.pendingGateKind ?? 'pre';
      const mayAnswer = (this.config.loop?.autoApprove ?? ['pre']).includes(kind);
      if (mayAnswer) {
        this.log(`  ${taskId} approving ${kind} gate (the landing sequence is the real check)`, { taskId });
        await this.invoke('run:approve', { projectId: this.projectId, runId: hb.runId });
        hb.lastProgressAt = this.now(); // answering a gate IS headway
        return;
      }
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      await this.#discard(taskId);
      this.#park(taskId, `A ${kind} gate asked for a decision this loop is not allowed to make.`);
      return;
    }

    if (stage === 'done' || stage === 'failed') {
      await this.#complete(taskId, hb, stage, snapshot.meta?.error ?? null);
      return;
    }

    // Per-task cap: this one has had its allowance, whatever it is doing.
    const caps = this.#caps();
    if (caps.taskUsd != null && taskSpend.usd >= caps.taskUsd) {
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      // Record before discarding: the money was spent whether or not the work
      // was any good, and this is the path where the most of it goes.
      this.#recordSpend(taskId, hb, 'stopped at its cap');
      await this.#discard(taskId);
      // Say that it is a LIFETIME total, and name the way out. This counts
      // every attempt the task has ever made, which is the safe reading — but
      // it also means a task that once cost $3 can never be given a cheap
      // one-line correction under a $1 cap, and the message read as though the
      // correction itself had been expensive.
      this.#park(taskId, this.#keepingWorkReason(this.backlog.get(taskId),
        `Spent $${taskSpend.usd.toFixed(2)} across ${
          (this.backlog.get(taskId)?.attempts ?? 0) + 1} attempt(s) against a $${caps.taskUsd} per-task cap.`
        + ' That cap covers the whole history of this task, not this attempt alone — raise --task-usd to work it again.'));
      return;
    }

    // A quarter of this task's whole allowance, spent without the work
    // changing, is a burn. The threshold belongs here rather than in the
    // detector because only the supervisor knows what this task was allowed.
    const taskUsd = Number(this.#caps().taskUsd);
    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(Number.isFinite(taskUsd) && taskUsd > 0 ? { burnUsd: taskUsd / 4 } : {}),
      ...(this.config.loop?.thresholds ?? {})
    };
    const stall = detectStall(hb, { thresholds, medianMs: this.#medianAttemptMs() });
    if (stall) await this.#intervene(taskId, hb, stall);
  }

  /** The ladder (§11.4). Each rung once, in order, per task. */
  async #intervene(taskId, hb, stall) {
    let rung = nextIntervention(hb);
    hb.interventions.push(rung);
    this.log(`… ${taskId} ${stall.detector}: ${stall.detail} → ${rung}`, { taskId });

    const guidance = `SUPERVISOR: ${stall.detail} Change your approach rather than repeating it.`;
    const currentNode = hb.currentNode;

    if (rung === 'nudge' || rung === 'restart') {
      if (currentNode) {
        // `restartNode` refuses a run that is still walking, and a stall is BY
        // DEFINITION a live run — so the two cheap rungs were asking the runner
        // for the one thing it will not do in exactly the state that summons
        // them. Watched live: nudge threw "run is live — stop or pause it
        // first", restart threw it five seconds later, and the task reached
        // escalate having actually tried neither. Worse, the throw skipped the
        // counter reset below, so the very next poll tripped the same detector
        // and burned the next rung: three rungs in eleven seconds.
        //
        // So the run is stopped first and the restart is taken on a later poll.
        // The refusal is transient — the walk unwinds a moment after stop() —
        // and a rung deferred is a rung tried, which is what this ladder is
        // for.
        hb.pendingRestart = { nodeId: currentNode, guidance, rung, stall };
        hb.restartWaits = 0;
        await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
        this.log(`  ${taskId} stopping to ${rung} ${currentNode}`, { taskId });
        return;
      }
      // Nothing identifiable to restart. Both node-level rungs are unusable, so
      // mark them tried and TAKE THE NEXT ONE — the escalate branch below tests
      // `rung`, and leaving it as 'nudge' fell all the way through to parking.
      // The intent ("fall through to the next rung") was in the comment and not
      // in the code, so a task the supervisor could have escalated was parked on
      // its first stall instead.
      if (!hb.interventions.includes('restart')) hb.interventions.push('restart');
      rung = nextIntervention(hb);
      hb.interventions.push(rung);
      this.log(`  ${taskId} nothing to restart → ${rung}`, { taskId });
    }

    if (rung === 'escalate' && !this.noEscalate) {
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      this.inFlight.delete(taskId);
      this.#recordSpend(taskId, hb);
      const result = this.backlog.escalate(taskId, { reason: 'stalled', note: stall.detail, workerAt: this.#workerAt });
      await this.#discard(taskId);
      this.log(`↑ ${taskId} ${result.escalation.reason}`, { taskId });
      if (!result.escalation.escalated) this.parked.push({ taskId, reason: result.escalation.reason });
      this.history.push({ taskId, landed: false, stage: 'stalled', detector: stall.detector });
      return;
    }

    await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
    this.#recordSpend(taskId, hb);
    await this.#discard(taskId);
    this.#park(taskId, `${stall.detail} The supervisor exhausted what it can try.`);
  }

  /**
   * What a run cost, into the ledger.
   *
   * Called on every ending, not just the tidy one. Only `#complete` used to do
   * this, so a task the supervisor interrupted — the expensive kind, the one
   * that ground for an hour and produced nothing — contributed NOTHING to the
   * burn-down. The caps are rolling totals of real money, and a total that
   * silently omits the failures is worse than no total: it is lowest exactly
   * when the night is going worst.
   */
  /**
   * Did this run declare the task impossible here? The reason, or null.
   *
   * Read from what the run WROTE, not from the model's mood: the sentinel is a
   * line the brief asks for by name, so "I could not do this" and "this cannot
   * be done" stay distinguishable — the first is worth another band, the second
   * is worth a person.
   */
  /**
   * Nothing is ready — is that because there is nothing, or because everything
   * left is waiting on something that will never happen?
   *
   * core/blockers.js knows, and it is the SAME module the board reads — so the
   * line a person gets at breakfast and the sentence on the stuck card cannot
   * drift into two different accounts of one fact. It also knows the difference
   * D44 recorded getting wrong: an empty backlog and a backlog where everything
   * left is parked are not the same report.
   */
  #whyNothingReady() {
    // `--only` narrows what the loop may take, so it must narrow the
    // EXPLANATION too. Without this the answer came from the whole backlog: a
    // run over two named tasks that had both parked reported "nothing ready — 1
    // task blocked: t-0008 (waiting on t-0006, which does not exist)", naming a
    // task nobody had asked it to work. Three restarts went looking at t-0008.
    const tasks = (this.backlog.list() ?? [])
      .filter(t => !this.only || this.only.includes(t.id));
    if (this.only && !tasks.length) {
      return `no task matched --only ${this.only.join(', ')}`;
    }
    if (this.only) {
      const stuck = tasks.filter(t => t.status !== 'queued');
      if (stuck.length === tasks.length) {
        return `none of --only ${this.only.join(', ')} is claimable: ${
          stuck.map(t => `${t.id} is ${t.status}${t.blockedReason ? ` (${String(t.blockedReason).slice(0, 120)})` : ''}`).join('; ')}`;
      }
    }
    try {
      return whyNothingReady({
        tasks,
        problems: this.backlog.problems ?? [],
        config: this.config,
        // The loop is running by definition when this is asked, so a
        // `loop-stopped` blocker can never be the answer here.
        // No cwd: the gate check falls back to process.cwd(), which is what
        // `#begin`'s own unrunnableGates() call already does — one answer, not
        // two that disagree about which machine we are on.
        status: { running: true, inFlight: [...this.inFlight.values()] }
      });
    } catch { return 'backlog empty'; }
  }

  async #saidImpossible(runId) {
    let snapshot;
    try { snapshot = await this.invoke('run:snapshot', { projectId: this.projectId, runId }); }
    catch { return null; }
    // What the run was ASKED, so a sentinel that came from the question is not
    // mistaken for an answer.
    //
    // This cost a night. The brief carries a worked example of the sentinel
    // line; the first node of a task run echoes the brief verbatim as its
    // output; the scan reads node outputs — so every task declared itself
    // impossible with the example's words, and t-0001 parked as "there is no
    // code_quality_manager.py anywhere in this repository" while working on a
    // JSONL session tree. Three dependent tasks blocked behind it and the
    // finished worktree was deleted. The same trap catches a task whose own
    // goal quotes the sentinel — a task to fix THIS function would park itself.
    //
    // The rule that holds in all three cases: a line that is already in the
    // question cannot be this run's answer.
    const asked = String(snapshot?.prompt ?? '');
    const texts = [
      ...Object.values(snapshot?.nodeOutputs ?? {}),
      ...Object.values(snapshot?.taskOutputs ?? {})
    ];
    for (const text of texts) {
      const hit = IMPOSSIBLE.exec(String(text ?? ''));
      if (!hit) continue;
      // The whole matched line, not just its reason: an agent quoting the
      // example while genuinely refusing is vanishingly rare next to a node
      // that echoed the brief, and the brief is where this line comes from.
      if (asked && asked.includes(hit[0].trim())) continue;
      const why = hit[1].trim().slice(0, 300);
      // A model that echoed the example instead of writing its finding has
      // still declared the task impossible, so it still parks — but a
      // fill-in-the-blank must not reach the pile a person reads. Seen on the
      // first real use: the parked reason was literally
      // "<one line saying what is missing or already true>".
      return !why || /^<.*>$/.test(why)
        ? 'no reason given — the agent declared it impossible but echoed the example instead of its finding'
        : why;
    }
    return null;
  }

  /** The worker for an attempt at this band — the map first, then the pin. */
  #workerFor(level) {
    const mapped = workerForLevelMap(level, this.config.loop?.models);
    if (mapped) return { provider: mapped.provider, model: mapped.model };
    return this.config.loop?.worker ?? null;
  }

  /**
   * Which model a band actually resolves to, for the ladder to compare.
   *
   * An arrow function so it can be handed to the backlog without carrying
   * `this` with it. Null means nothing is named at any band, which is the Auto
   * Router path — there the band IS the model, so a rung is always a real one.
   */
  #workerAt = level => this.#workerFor(level)?.model ?? null;

  /**
   * What every run currently in flight has spent but not yet recorded.
   *
   * The per-task ceiling has counted live spend since the night it watched a
   * task spend $23 under a $2 cap; the window and session ceilings did not,
   * and had the same hole for the same reason.
   */
  /**
   * Why this task cannot pay for another attempt, or null if it can.
   *
   * The estimate is this task's own history: what its previous attempts cost
   * on average is the best available guess at what the next one costs, and
   * escalation only ever makes that bigger. Half of one attempt is the floor —
   * below that there is not enough left to reach a gate, let alone pass one.
   */
  #cannotAfford(task) {
    const cap = Number(this.#caps().taskUsd);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    const spent = this.ledger?.totals({ taskId: task.id })?.usd ?? 0;
    const remaining = cap - spent;
    if (remaining <= 0) {
      return `Spent $${spent.toFixed(2)} of its $${cap} per-task cap over ${task.attempts ?? 0} attempt(s),`
        + ' with nothing left for another — raise --task-usd to work it again.';
    }
    const attempts = Number(task.attempts ?? 0);
    if (attempts < 1) return null;
    const perAttempt = spent / attempts;
    if (perAttempt <= 0 || remaining >= perAttempt / 2) return null;
    return `Spent $${spent.toFixed(2)} of its $${cap} per-task cap over ${attempts} attempt(s)`
      + ` — $${remaining.toFixed(2)} left, against $${perAttempt.toFixed(2)} an attempt.`
      + ' Starting one that gets killed partway costs the money and produces nothing;'
      + ' raise --task-usd to work it again.';
  }

  /** The window total as it stands right now, in-flight runs included. */
  #spendNow() {
    if (!this.ledger) return null;
    return totalsWithLive(this.ledger, { sinceMs: this.#windowMs() },
      { store: this.store, runIds: [...this.inFlight.values()].map(hb => hb.runId) });
  }

  /**
   * A park that is about the wallet must not erase what was wrong with the work.
   *
   * `blockedReason` is read twice: by a person looking at the parked pile, and
   * by the NEXT attempt, whose brief quotes it under "A PREVIOUS ATTEMPT
   * FAILED". Overwriting a review rejection with a budget message loses the
   * first reader's answer and lies to the second — it tells the next worker its
   * predecessor ran out of money when what actually happened is that the
   * reviewer objected to something specific.
   */
  #keepingWorkReason(task, budgetMessage) {
    let prior = String(task?.blockedReason ?? '').trim();
    const at = prior.indexOf(WORK_REASON_TAIL);
    if (at >= 0) prior = prior.slice(at + WORK_REASON_TAIL.length);   // do not nest them
    if (!prior || BUDGET_REASON.test(prior)) return budgetMessage;
    return budgetMessage + WORK_REASON_TAIL + prior;
  }

  /**
   * What the task's workspace looks like, sampled rather than polled.
   *
   * The detectors work in minutes, so asking git every five seconds buys
   * nothing and spends a process each time. Between samples the last answer
   * stands, which is correct: an unchanged fingerprint is exactly what "no
   * progress" means, and a stale one only ever delays an intervention by a
   * sample.
   *
   * Null — never a throw — when there is no worktree to look at; the signature
   * falls back to completed tool calls in that case.
   */
  #workspaceOf(hb) {
    if (!hb?.dir) return null;
    const now = this.now();
    if (hb.workspaceAt && now - hb.workspaceAt < WORKSPACE_SAMPLE_MS) return hb.workspace ?? null;
    hb.workspaceAt = now;
    try { hb.workspace = captureWorkspaceSignature(hb.dir); }
    catch { hb.workspace = null; }
    return hb.workspace;
  }

  /**
   * How long this session's attempts have been taking.
   *
   * The outlier detector compares an attempt against the usual for its kind,
   * and `detectStall` was never given a median — so that branch could not fire
   * either. Three samples before it means anything: two attempts do not have a
   * usual.
   */
  #medianAttemptMs() {
    if (this.durations.length < 3) return null;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  #liveSpend() {
    let live = 0;
    for (const hb of this.inFlight.values()) live += this.#liveSpendOf(hb);
    return live;
  }

  /** What one in-flight run has spent so far, from its call trace. */
  #liveSpendOf(hb) { return this.#liveUsageOf(hb).usd; }

  /** The same read, with the token count the burn detector counts in. */
  #liveUsageOf(hb) {
    if (!this.ledger || !this.store || !hb?.runId) return { usd: 0, tokens: 0 };
    let usd = 0;
    let tokens = 0;
    try {
      for (const e of spendFromRun(this.store, hb.runId, { prices: this.ledger.prices ?? {} })) {
        usd += e.usd ?? 0;
        tokens += Number(e.usage?.prompt_tokens ?? 0) + Number(e.usage?.completion_tokens ?? 0);
      }
    } catch { /* a run with nothing readable yet has cost nothing yet */ }
    return { usd, tokens };
  }

  /** Recorded spend for this task, plus what the in-flight run has cost. */
  #spentOn(taskId, hb) {
    const recorded = this.ledger?.totals({ taskId }) ?? { usd: 0 };
    if (!this.ledger || !this.store || !hb?.runId) return recorded;
    let live = 0;
    try {
      // The LEDGER's price table, not `config.loop.prices` directly. That map is
      // a hand-written override and it ships empty, so every in-flight call
      // priced to null and `live` stayed 0 no matter what the run was spending
      // — which made the per-task and rolling ceilings inert in exactly the
      // situation they exist for. Watched a task spend $23 across three
      // attempts under `--task-usd 2 --cap-usd 4`, with the caps reading zero
      // the whole way. The ledger builds its table from the model catalog
      // (pricesFromCatalog) and still honours the override where it speaks.
      for (const e of spendFromRun(this.store, hb.runId, { prices: this.ledger.prices ?? {} })) {
        live += e.usd ?? 0;
      }
    } catch { /* a run with nothing readable yet has cost nothing yet */ }
    return { ...recorded, usd: recorded.usd + live };
  }

  #recordSpend(taskId, hb, note = '') {
    if (!this.ledger || !this.store) return null;
    const entries = this.ledger.recordRun(this.store, { runId: hb.runId, taskId, level: hb.level });
    const usd = entries.reduce((n, e) => n + (e.usd ?? 0), 0);
    this.log(`  ${taskId} ${note || 'run ended'}, $${usd.toFixed(4)} across ${entries.length} call(s)`, { taskId });
    return { usd, calls: entries.length };
  }

  /** A finished run: record the spend, then verify, review and land it. */
  async #complete(taskId, hb, stage, error = null) {
    this.inFlight.delete(taskId);
    // What an attempt usually costs in wall time, which is the only thing the
    // outlier detector can compare against — and only from attempts where a
    // model ANSWERED.
    //
    // An attempt that died in twenty seconds because a free model was
    // rate-limited says nothing about how long this work takes; it says how
    // fast that failure is. Counting those made the median a median of how
    // quickly things break, and the outlier detector then killed every real
    // attempt at four times that. The floor in heartbeat.js catches the worst
    // of it; this stops the number being wrong in the first place.
    //
    // When there is no way to SEE whether a model answered — no ledger, no
    // store — nothing is recorded and the median stays null, which leaves the
    // outlier detector quiet. That is the safe direction: the other four
    // detectors still work, and a detector with no baseline guessing at one is
    // how this went wrong to begin with.
    const spent = this.#liveUsageOf(hb);
    if ((spent?.tokens ?? 0) > 0) this.durations.push(Math.max(0, this.now() - hb.startedAt));
    this.#recordSpend(taskId, hb, `run ${stage}`);
    // Landing takes minutes — gates, a reviewer, a merge, a canary — and it all
    // happens inside one tick, so without this the published status keeps
    // saying whatever it said before the run finished. A watcher then shows a
    // task "executing" for the two minutes it is actually being landed, which
    // is the one stretch where somebody watching most wants to know.
    this.#publish();

    if (stage === 'failed') {
      // The provider refusing everyone is not this task failing. A spent key or
      // an exhausted quota will do the same to every task after it, in seconds,
      // and the ladder would turn that into a parked backlog: the task goes up
      // a band, fails identically, goes up again, runs out of ladder, parks —
      // and the loop moves on to do it to the next one. Watched live: two tasks
      // driven to `max` and parked inside a minute, `$0.0000 across 0 call(s)`
      // on every attempt, because a key hit its spending limit.
      //
      // So the task goes back UNTOUCHED — same band, no attempt spent, nothing
      // in its blockedReason blaming work that never ran — and the loop stops
      // and says why. This is the same judgement `loop:start`'s pre-flight
      // makes before the first task; nothing was checking for it afterwards.
      const blocked = providerBlocked(error);
      if (blocked) {
        await this.#discard(taskId);
        this.backlog.release(taskId, { status: 'queued' });
        this.stopping = `the provider refused the call: ${blocked}`;
        this.running = false;
        this.log(`✖ ${taskId} ${this.stopping} — stopping, because every task would fail the same way`, { taskId });
        this.#publish();
        return;
      }
      // The model never answered. Not this task failing — this task not having
      // been tried. A rung spent here is a rung spent on silence.
      const unreachable = modelUnavailable(error);
      if (unreachable) {
        const seen = (this.unavailable.get(taskId) ?? 0) + 1;
        this.unavailable.set(taskId, seen);
        if (seen <= UNAVAILABLE_RETRIES) {
          await this.#discard(taskId);
          this.backlog.release(taskId, { status: 'queued' });
          this.log(`↻ ${taskId} set aside: ${hb.worker?.model ?? 'the model'} did not answer`
            + ` (${unreachable}). Same band, no attempt spent — ${UNAVAILABLE_RETRIES - seen} more before it parks.`,
          { taskId });
          this.#publish();
          return;
        }
        // Out of patience. Fall through and let the ladder have it, with the
        // reason recorded as what it was rather than as failed work.
      }
      await this.#discard(taskId);
      const result = this.backlog.escalate(taskId, {
        reason: 'failed',
        note: unreachable
          ? `The model did not answer, ${UNAVAILABLE_RETRIES + 1} times: ${unreachable}`
          : 'The run itself failed.',
        workerAt: this.#workerAt
      });
      this.history.push({ taskId, landed: false, stage: 'run-failed' });
      if (!result.escalation.escalated) this.parked.push({ taskId, reason: result.escalation.reason });
      return;
    }

    // The agent declared the task impossible here (§the brief). Park it BEFORE
    // the landing sequence: gates, a reviewer and a canary on a task nobody can
    // do is a bill for confirming what the agent already said, and `work:land`
    // escalates the backlog itself on failure — so checking afterwards would
    // park a task that had already been pushed up a band.
    //
    // The brief promises this outcome, and a loop that escalated instead would
    // be punishing an agent for following instructions. Seen live: a task naming
    // a Python file this repository does not contain, correctly reported as
    // impossible, climbing a band to be told the same thing by a dearer model.
    // Parking is not letting it off — it is handing the judgement to a person,
    // which is the one thing an agent cannot award itself.
    const impossible = await this.#saidImpossible(hb.runId);
    if (impossible) {
      await this.#discard(taskId);
      this.#park(taskId, `The agent reports this cannot be done in this repository: ${impossible}`);
      return;
    }

    // Gates → checks → review → merge → canary. work:land already updates the
    // backlog (landed, or escalated one rung with the guidance attached).
    //
    // The previous landing's canary output goes in as the baseline: it is the
    // last time the suite ran green on the base branch, which is exactly the
    // "before" the test-count check needs (§7.3). Without it that check never
    // fires unattended, and deleting tests to go green is the cheapest exit
    // there is.
    const landed = await this.invoke('work:land', {
      projectId: this.projectId, taskId, baselineOutput: this.lastCanaryOutput ?? null,
      // Which attempt is being landed: a slow landing must not clean up after a
      // restart that has already begun (WR-02).
      attemptId: this.attempts.get(taskId) ?? null,
      // The dry-run posture (§6.4): gates and a reviewer run, nothing merges.
      // This was decided in `loop:start` and then never travelled — `work:land`
      // defaults it to false, so a loop started with --dry-run merged anyway.
      // The one flag whose whole job is "do not touch the base branch" has to
      // reach the code that touches the base branch.
      dryRun: this.config.loop?.dryRun === true,
      // Who reviews this session's work, when the caller named someone. The key
      // stays behind: `work:land` re-stamps it from the provider map.
      reviewer: this.config.workers?.reviewer
        ? { provider: this.config.workers.reviewer.provider, model: this.config.workers.reviewer.model }
        : null
    });
    if (landed.canaryOutput) this.lastCanaryOutput = landed.canaryOutput;
    this.history.push({ taskId, landed: landed.landed, stage: landed.stage, guidance: landed.guidance ?? null });
    this.log(landed.landed
      ? `✔ ${taskId} landed ${landed.mergeSha?.slice(0, 8)}`
      : `✖ ${taskId} ${landed.stage}: ${String(landed.guidance ?? '').slice(0, 160)}`, { taskId });

    if (!landed.landed) {
      await this.#discard(taskId);
      const after = this.backlog.get(taskId);
      if (after?.status === 'parked') this.parked.push({ taskId, reason: after.blockedReason });
    }
  }

  // A worktree outlives only a LANDED task (work:land removes that one). Every
  // other ending throws it away, or the next attempt cannot even start — which
  // is how a task wedges permanently and an overnight run quietly stops working.
  //
  // `status: null` because the status has ALREADY been decided by whoever is
  // discarding — escalate() put the task back in the queue a rung up, #park put
  // it in the parked pile. This used to pass 'parked', which meant every
  // escalation was immediately undone by the cleanup that followed it and the
  // ladder never climbed after a failed landing.
  async #discard(taskId) {
    const attemptId = this.attempts.get(taskId) ?? null;
    try {
      const r = await this.invoke('work:discard', { projectId: this.projectId, taskId, status: null, attemptId });
      // A refusal is a fact worth saying out loud. Swallowing every error here
      // is what let a stale cleanup look identical to a successful one, and
      // "owner-mismatch" specifically means this supervisor just tried to clean
      // up a worktree that now belongs to a newer attempt (WR-02).
      if (r?.outcome === 'owner-mismatch') {
        this.log(`· ${taskId} cleanup skipped: worktree now belongs to attempt ${r.owner}`, { taskId });
      } else if (r?.outcome === 'live-owner') {
        this.log(`· ${taskId} cleanup skipped: attempt ${r.owner} is still live`, { taskId });
      }
    } catch (err) {
      this.log(`· ${taskId} cleanup failed: ${String(err?.message ?? err).slice(0, 160)}`, { taskId });
    } finally {
      this.attempts.delete(taskId);
    }
  }

  #park(taskId, reason) {
    // A park that interrupted a RUN is an attempt: a run started, money was
    // spent, and nothing landed — which is what `attempts` means everywhere
    // else. Only escalate() and work:land counted, so every task that died at
    // its cap, at a gate nobody could answer, or at the bottom of the ladder
    // recorded its spend and no attempt. Watched live: t-0011 reported
    // "Spent $0.77 of its $0.5 per-task cap over 0 attempt(s)", which is not a
    // sentence about anything that can happen.
    //
    // Being in flight is the signal, and it is exact: the pre-run refusals
    // above — an unaffordable task, an unrunnable gate, a run that would not
    // start — park a task that never began, and those are not attempts.
    const attempted = this.inFlight.has(taskId);
    this.inFlight.delete(taskId);
    const attempts = attempted ? { attempts: (this.backlog.get(taskId)?.attempts ?? 0) + 1 } : {};
    this.backlog.update(taskId,
      { status: 'parked', blockedReason: reason, claimedBy: null, claimedAt: null, ...attempts });
    try { this.backlog.release(taskId, { status: 'parked' }); } catch { /* no lock */ }
    this.parked.push({ taskId, reason });
    this.history.push({ taskId, landed: false, stage: 'parked' });
    this.log(`⏸ ${taskId} parked: ${reason}`, { taskId });
    this.#publish();
  }
}

// The node a run is currently working on: the first one still going. Null when
// nothing is (between waves, or parked), which the ladder reads as "there is
// nothing to nudge" and moves down a rung.
//
// `active` is the status the runner actually writes for a node it is executing
// (`FlowRunner.setNodeStatus(runId, node.id, 'active')`); nothing anywhere
// writes 'running'. Looking for the wrong word meant this ALWAYS returned null,
// so the two cheapest rungs of the interruption ladder — nudge and restart —
// could never fire on any run, and every stall went straight to the bottom.
const RUNNING = new Set(['active', 'running']);

function currentNodeOf(snapshot) {
  const statuses = snapshot?.meta?.nodeStatus ?? {};
  return Object.entries(statuses).find(([, s]) => RUNNING.has(s))?.[0] ?? null;
}

/**
 * The morning report (§10): what landed, what reverted, what is waiting on you,
 * and what it cost. One page, because a report nobody finishes reading is a
 * report that does not exist.
 */
export function renderReport({ status, backlog, ledger, loopLog = null, store = null, windowMs = 24 * 60 * 60 * 1000 }) {
  const tasks = backlog.list();
  const by = s => tasks.filter(t => t.status === s);
  // Including what the runs named in the status are spending right now: a
  // morning report that says $0 about a loop that has been working since
  // midnight is the same lie as a status that says "stopped".
  const spend = ledger
    ? totalsWithLive(ledger, { sinceMs: windowMs },
      { store, runIds: (status?.inFlight ?? []).map(h => h?.runId).filter(Boolean) })
    : null;
  const lines = [`# Loop report — ${new Date().toISOString()}`, ''];

  if (spend) {
    lines.push(`**Spend:** $${spend.usd.toFixed(2)} across ${spend.calls} call(s)`
      + (spend.live ? ` (of which $${spend.live.toFixed(2)} is still in flight)` : '')
      + (spend.unknown ? ` — ${spend.unknown} call(s) with no cost reported` : ''), '');
  }
  lines.push(`**Loop:** ${status.running ? 'running' : `stopped (${status.stopping ?? 'idle'})`}`
    + `, ${status.landed}/${status.completed} attempt(s) landed`
    // Where this came from. A report assembled from a status file written by
    // another process is still true, and saying so is how a reader knows why
    // the numbers can move without them doing anything.
    + (status.observed ? ` _(observed: pid ${status.pid ?? '?'}, as of ${status.at ?? 'unknown'})_` : ''), '');

  const section = (title, list, render) => {
    lines.push(`## ${title} (${list.length})`, '');
    if (!list.length) lines.push('_none_', '');
    for (const t of list) lines.push(render(t));
    if (list.length) lines.push('');
  };

  section('Landed', by('landed'), t => `- **${t.id}** ${t.title}`);
  // The pile that needs a person is deliberately above the queue: it is the
  // only part of this document that is asking you for something.
  section('Waiting on you', by('parked'), t => `- **${t.id}** ${t.title}\n  - ${t.blockedReason ?? 'no reason recorded'}`);
  section('Queued', by('queued'), t => `- ${t.id} ${t.title} _(${t.level ?? 'default'}${t.attempts ? `, ${t.attempts} attempt(s)` : ''})_`);
  section('In flight', status.inFlight, h => `- ${h.taskId} — ${h.stage ?? h.phase}, ${Math.round(h.ageMs / 60000)}min`);

  // What the loop actually said, from its own file. A report that describes
  // the state without the account of how it got there sends the reader back to
  // the run folders, which is the trip this file exists to prevent.
  const said = loopLog?.read({ tail: 15 }) ?? [];
  if (said.length) {
    lines.push('## What the loop said', '');
    for (const e of said) lines.push(`- \`${String(e.at).slice(11, 19)}\` ${e.line}`);
    lines.push('');
  }

  const blocked = backlog.blocked();
  if (blocked.length) {
    lines.push('## Blocked', '');
    for (const b of blocked) lines.push(`- ${b.id} ${b.title} — ${b.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
