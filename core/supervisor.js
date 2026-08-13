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
import { escalate as escalateLevel, levelFor } from './levels.js';

const POLL_MS = 5000;

export class Supervisor {
  /**
   * @param {object} deps
   * @param {(name: string, args: object) => Promise<any>} deps.invoke  the command surface
   * @param {string} deps.projectId
   */
  constructor({
    invoke, projectId, backlog, ledger, store = null, config = {},
    parallelism = 1, pollMs = POLL_MS, log = () => {}, now = () => Date.now()
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

    this.running = false;
    this.stopping = null;      // why we are winding down, if we are
    this.inFlight = new Map(); // taskId -> Heartbeat
    this.history = [];         // finished attempts, for the report
    this.parked = [];          // things waiting on a person
    this.noEscalate = false;   // set when the soft cap trips
  }

  status() {
    return {
      running: this.running,
      stopping: this.stopping,
      inFlight: [...this.inFlight.values()].map(h => h.toJSON()),
      parked: this.parked.slice(-20),
      completed: this.history.length,
      landed: this.history.filter(h => h.landed).length,
      spend: this.ledger?.totals({ sinceMs: this.#windowMs() }) ?? null,
      noEscalate: this.noEscalate
    };
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
          if (!this.inFlight.size) { this.stopping = 'backlog empty'; break; }
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
    this.log(`▶ ${task.id} "${task.title}" at ${level}`);
    this.backlog.update(task.id, { status: 'running', level });

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
        level: this.config.loop?.levels === false ? null : level
      });
      this.inFlight.set(task.id, new Heartbeat({ taskId: task.id, runId, level, now: this.now() }));
      this.backlog.update(task.id, { runIds: [...(task.runIds ?? []), runId] });
    } catch (err) {
      // A task that cannot even be started is not a task that should be retried
      // at a bigger model: the failure is in the harness, not the capability.
      this.log(`✖ ${task.id} could not start: ${err.message}`);
      this.#park(task.id, `Could not start: ${String(err.message ?? err)}`);
    }
  }

  // What the run is told. The task file is already written for a reader who has
  // not seen this run (§5.1), so the brief is the task, not a summary of it.
  #briefFor(task) {
    return [
      task.title,
      task.body,
      task.blockedReason ? `\nA PREVIOUS ATTEMPT FAILED:\n${task.blockedReason}` : ''
    ].filter(Boolean).join('\n\n');
  }

  /** One poll across everything in flight. */
  async #tick() {
    await new Promise(r => setTimeout(r, this.pollMs));
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

    const taskSpend = this.ledger?.totals({ taskId }) ?? { usd: 0 };
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
      await this.#complete(taskId, hb, stage);
      return;
    }

    // Per-task cap: this one has had its allowance, whatever it is doing.
    const caps = this.#caps();
    if (caps.taskUsd != null && taskSpend.usd >= caps.taskUsd) {
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      await this.#discard(taskId);
      this.#park(taskId, `Spent $${taskSpend.usd.toFixed(2)} against a $${caps.taskUsd} per-task cap.`);
      return;
    }

    const stall = detectStall(hb, { thresholds: this.config.loop?.thresholds ?? DEFAULT_THRESHOLDS });
    if (stall) await this.#intervene(taskId, hb, stall);
  }

  /** The ladder (§11.4). Each rung once, in order, per task. */
  async #intervene(taskId, hb, stall) {
    const rung = nextIntervention(hb);
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
      // Nothing identifiable to restart — fall through to the next rung rather
      // than marking a rung "tried" that did nothing.
      hb.interventions.push('restart');
    }

    if (rung === 'escalate' && !this.noEscalate) {
      await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
      this.inFlight.delete(taskId);
      const result = this.backlog.escalate(taskId, { reason: 'stalled', note: stall.detail });
      await this.#discard(taskId);
      this.log(`↑ ${taskId} ${result.escalation.reason}`);
      if (!result.escalation.escalated) this.parked.push({ taskId, reason: result.escalation.reason });
      this.history.push({ taskId, landed: false, stage: 'stalled', detector: stall.detector });
      return;
    }

    await this.invoke('run:stop', { projectId: this.projectId, runId: hb.runId });
    await this.#discard(taskId);
    this.#park(taskId, `${stall.detail} The supervisor exhausted what it can try.`);
  }

  /** A finished run: record the spend, then verify, review and land it. */
  async #complete(taskId, hb, stage) {
    this.inFlight.delete(taskId);
    if (this.ledger && this.store) {
      const entries = this.ledger.recordRun(this.store, { runId: hb.runId, taskId, level: hb.level });
      const usd = entries.reduce((n, e) => n + (e.usd ?? 0), 0);
      this.log(`  ${taskId} run ${stage}, $${usd.toFixed(4)} across ${entries.length} call(s)`);
    }

    if (stage === 'failed') {
      await this.#discard(taskId);
      const result = this.backlog.escalate(taskId, { reason: 'failed', note: 'The run itself failed.' });
      this.history.push({ taskId, landed: false, stage: 'run-failed' });
      if (!result.escalation.escalated) this.parked.push({ taskId, reason: result.escalation.reason });
      return;
    }

    // Gates → checks → review → merge → canary. work:land already updates the
    // backlog (landed, or escalated one rung with the guidance attached).
    const landed = await this.invoke('work:land', { projectId: this.projectId, taskId });
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
  async #discard(taskId) {
    try { await this.invoke('work:discard', { projectId: this.projectId, taskId, status: 'parked' }); }
    catch { /* nothing to discard */ }
  }

  #park(taskId, reason) {
    this.inFlight.delete(taskId);
    this.backlog.update(taskId, { status: 'parked', blockedReason: reason, claimedBy: null, claimedAt: null });
    try { this.backlog.release(taskId, { status: 'parked' }); } catch { /* no lock */ }
    this.parked.push({ taskId, reason });
    this.history.push({ taskId, landed: false, stage: 'parked' });
    this.log(`⏸ ${taskId} parked: ${reason}`);
  }
}

// The node a run is currently working on: the first one still running. Null
// when nothing is (between waves, or parked), which the ladder reads as "there
// is nothing to nudge" and moves down a rung.
function currentNodeOf(snapshot) {
  const statuses = snapshot?.meta?.nodeStatus ?? {};
  return Object.entries(statuses).find(([, s]) => s === 'running')?.[0] ?? null;
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
    + `, ${status.landed}/${status.completed} attempt(s) landed`, '');

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
