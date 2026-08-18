// The supervisor (LOOP-PLAN §4.3, §10, §11).
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
import { Heartbeat, detectStall, nextIntervention, DEFAULT_THRESHOLDS } from './heartbeat.js';
import { escalate as escalateLevel, levelFor, workerForLevelMap } from './levels.js';
import { spendFromRun } from './ledger.js';
import { unrunnableGates } from './gates.js';
import { whyNothingReady } from './blockers.js';

const POLL_MS = 5000;

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
    parallelism = 1, pollMs = POLL_MS, log = () => {}, now = () => Date.now(),
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
    this.pollMs = pollMs;
    this.log = log;
    this.now = now;
    this.writeStatus = writeStatus;
    this.stopRequested = stopRequested;

    this.running = false;
    this.stopping = null;      // why we are winding down, if we are
    this.inFlight = new Map(); // taskId -> Heartbeat
    this.history = [];         // finished attempts, for the report
    this.parked = [];          // things waiting on a person
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
      spend: this.ledger?.totals({ sinceMs: this.#windowMs() }) ?? null,
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
    let started = 0;
    this.#publish();

    try {
      while (this.running && started < maxTasks) {
        // The hard cap is checked before anything new begins: finishing the
        // in-flight work and stopping cleanly is the promise (§9).
        const budget = this.#checkBudget();
        if (budget.action === 'stop') {
          this.stopping = `hard cap reached ($${budget.window.usd.toFixed(2)})`;
          this.log(this.stopping);
          break;
        }
        if (budget.action === 'no-escalate' && !this.noEscalate) {
          this.noEscalate = true;
          this.log(`soft cap reached ($${budget.window.usd.toFixed(2)}) — no further escalation`);
        }

        if (this.inFlight.size >= this.parallelism) { await this.#tick(); continue; }

        const task = this.backlog.take('supervisor');
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
        if (task.stolen) this.log(`reclaimed an expired lease on ${task.id} from ${task.claimedBy}`);
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

  #checkBudget(taskId = null) {
    if (!this.ledger) return { ok: true, action: null, window: { usd: 0 } };
    return this.ledger.check({ caps: this.#caps(), taskId, windowMs: this.#windowMs() });
  }

  async #begin(task) {
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
    this.log(`▶ ${task.id} "${task.title}" ${worker ? `on ${worker.model} (band ${level})` : `at ${level}`}`);
    // startedAt, so "how long did this take" survives the process that knew.
    // The first attempt sets it and a retry does not, because the question the
    // benchmark asks is how long the TASK took, not the last try at it.
    this.backlog.update(task.id, {
      status: 'running', level,
      startedAt: task.startedAt ?? new Date(this.now()).toISOString()
    });

    try {
      const wt = await this.invoke('work:start', { projectId: this.projectId, taskId: task.id });
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
        loopTaskId: task.id
      });
      this.inFlight.set(task.id, new Heartbeat({ taskId: task.id, runId, level, now: this.now(), model: worker?.model ?? null }));
      this.backlog.update(task.id, { runIds: [...(task.runIds ?? []), runId] });
      // Say so at once rather than at the next tick: a task appearing in flight
      // is the most interesting single event a watcher sees.
      this.#publish();
    } catch (err) {
      // A task that cannot even be started is not a task that should be retried
      // at a bigger model: the failure is in the harness, not the capability.
      this.log(`✖ ${task.id} could not start: ${err.message}`);
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
      whereItCameFrom(task),
      HOW_IT_LANDS,
      task.blockedReason ? `\nA PREVIOUS ATTEMPT FAILED:\n${task.blockedReason}` : ''
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
        await this.#pollTask(taskId, hb);
        hb.pollErrors = 0;
      } catch (err) {
        // A poll that keeps failing is not a task that keeps running: something
        // about this task cannot be observed, and observing it is the only way
        // the loop can ever finish it. Without a ceiling here the loop spins on
        // it forever, doing nothing, which is worse than either succeeding or
        // giving up.
        hb.pollErrors = (hb.pollErrors ?? 0) + 1;
        this.log(`poll ${taskId}: ${err.message}`);
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

    // What this task has cost SO FAR — previous attempts from the ledger, plus
    // the run currently in flight read from its own artifacts. The ledger is
    // written when a run ends, so reading only the ledger meant an in-flight
    // task always reported $0 and the per-task cap below could never fire: the
    // one ceiling whose job is to stop a single runaway task was decorative.
    const taskSpend = this.#spentOn(taskId, hb);
    hb.observe(snapshot, { now: this.now(), usd: 0 });
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
        this.log(`  ${taskId} approving ${kind} gate (the landing sequence is the real check)`);
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
      this.#park(taskId, `Spent $${taskSpend.usd.toFixed(2)} against a $${caps.taskUsd} per-task cap.`);
      return;
    }

    const stall = detectStall(hb, { thresholds: this.config.loop?.thresholds ?? DEFAULT_THRESHOLDS });
    if (stall) await this.#intervene(taskId, hb, stall);
  }

  /** The ladder (§11.4). Each rung once, in order, per task. */
  async #intervene(taskId, hb, stall) {
    let rung = nextIntervention(hb);
    hb.interventions.push(rung);
    this.log(`… ${taskId} ${stall.detector}: ${stall.detail} → ${rung}`);

    const guidance = `SUPERVISOR: ${stall.detail} Change your approach rather than repeating it.`;
    const currentNode = hb.currentNode;

    if (rung === 'nudge' || rung === 'restart') {
      if (currentNode) {
        await this.invoke('run:restartNode', {
          projectId: this.projectId, runId: hb.runId, nodeId: currentNode, guidance
        });
        // A restart is a fresh attempt: the spin counters start over, or the
        // next poll would trip the same detector instantly and burn the ladder.
        hb.repeats = 0;
        hb.gateFailures = [];
        hb.lastProgressAt = this.now();
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
      this.log(`  ${taskId} nothing to restart → ${rung}`);
    }

    if (rung === 'escalate' && !this.noEscalate) {
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      this.inFlight.delete(taskId);
      this.#recordSpend(taskId, hb);
      const result = this.backlog.escalate(taskId, { reason: 'stalled', note: stall.detail });
      await this.#discard(taskId);
      this.log(`↑ ${taskId} ${result.escalation.reason}`);
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
    try {
      return whyNothingReady({
        tasks: this.backlog.list() ?? [],
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

  /** Recorded spend for this task, plus what the in-flight run has cost. */
  #spentOn(taskId, hb) {
    const recorded = this.ledger?.totals({ taskId }) ?? { usd: 0 };
    if (!this.ledger || !this.store || !hb?.runId) return recorded;
    let live = 0;
    try {
      for (const e of spendFromRun(this.store, hb.runId, { prices: this.config.loop?.prices ?? {} })) {
        live += e.usd ?? 0;
      }
    } catch { /* a run with nothing readable yet has cost nothing yet */ }
    return { ...recorded, usd: recorded.usd + live };
  }

  #recordSpend(taskId, hb, note = '') {
    if (!this.ledger || !this.store) return null;
    const entries = this.ledger.recordRun(this.store, { runId: hb.runId, taskId, level: hb.level });
    const usd = entries.reduce((n, e) => n + (e.usd ?? 0), 0);
    this.log(`  ${taskId} ${note || 'run ended'}, $${usd.toFixed(4)} across ${entries.length} call(s)`);
    return { usd, calls: entries.length };
  }

  /** A finished run: record the spend, then verify, review and land it. */
  async #complete(taskId, hb, stage, error = null) {
    this.inFlight.delete(taskId);
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
        this.log(`✖ ${taskId} ${this.stopping} — stopping, because every task would fail the same way`);
        this.#publish();
        return;
      }
      await this.#discard(taskId);
      const result = this.backlog.escalate(taskId, { reason: 'failed', note: 'The run itself failed.' });
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
      : `✖ ${taskId} ${landed.stage}: ${String(landed.guidance ?? '').slice(0, 160)}`);

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
    try { await this.invoke('work:discard', { projectId: this.projectId, taskId, status: null }); }
    catch { /* nothing to discard */ }
  }

  #park(taskId, reason) {
    this.inFlight.delete(taskId);
    this.backlog.update(taskId, { status: 'parked', blockedReason: reason, claimedBy: null, claimedAt: null });
    try { this.backlog.release(taskId, { status: 'parked' }); } catch { /* no lock */ }
    this.parked.push({ taskId, reason });
    this.history.push({ taskId, landed: false, stage: 'parked' });
    this.log(`⏸ ${taskId} parked: ${reason}`);
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
export function renderReport({ status, backlog, ledger, windowMs = 24 * 60 * 60 * 1000 }) {
  const tasks = backlog.list();
  const by = s => tasks.filter(t => t.status === s);
  const spend = ledger?.totals({ sinceMs: windowMs }) ?? null;
  const lines = [`# Loop report — ${new Date().toISOString()}`, ''];

  if (spend) {
    lines.push(`**Spend:** $${spend.usd.toFixed(2)} across ${spend.calls} call(s)`
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

  const blocked = backlog.blocked();
  if (blocked.length) {
    lines.push('## Blocked', '');
    for (const b of blocked) lines.push(`- ${b.id} ${b.title} — ${b.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
