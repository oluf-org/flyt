// Status, headway and stalls (DESIGN-SPEC.md §8).
//
// With no clock bounding the day, this is what replaces it. A task may
// legitimately run for hours; the supervisor's job is to know the difference
// between WORKING and STUCK, and to act without waiting for a person.
//
// The hard part is defining headway, and the two obvious candidates are both
// wrong. Elapsed time says nothing — a long task is the design target. Token
// spend says nothing either: a model can burn an hour producing confident
// nothing, and that is precisely the failure this is meant to catch.
//
// So headway is CHANGE IN THE WORK: a node completing, a file whose content
// actually differs from what was there before, a gate whose failure signature
// moved. A different error is progress. The identical error three times is a
// spin. Everything else is elapsed time.
import crypto from 'node:crypto';

export const DEFAULT_THRESHOLDS = {
  silentMs: 10 * 60 * 1000,   // no event of any kind
  spinRepeats: 2,             // identical work signature, back to back
  // ...and it must also have been identical for this LONG. A repeat count is a
  // property of the observer, not of the work: the supervisor polls every five
  // seconds, so "2 repeats" alone meant fifteen seconds, and a node thinking
  // its way through a single call on a reasoning model was declared a spin and
  // parked. Seen live — a task with 12 model calls and 10 tool calls behind it,
  // killed 15 seconds in.
  //
  // The floor is not a guess: a model call that goes `timeout.idleMs`
  // (config.json, 5 min) without producing anything is already killed by its
  // own deadline and retried. So anything the supervisor kills sooner is work
  // the adapter would have rescued, and this sits just above that line.
  spinMs: 6 * 60 * 1000,
  groundhogRepeats: 3,        // identical gate failure
  outlierFactor: 4,           // times the median for this class of task
  // Money spent since the work last changed. Dollars rather than tokens
  // because dollars are what the provider reports and what the caps are
  // written in; `burnTokens` still works for a caller that prefers it.
  //
  // No default: the honest threshold is a fraction of what THIS task was
  // allowed to spend, which the supervisor knows and this module does not.
  burnUsd: null,
  burnTokens: null
};

const hash = value => crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 16);

/**
 * A fingerprint of what has been ACCOMPLISHED, not of what is being said.
 *
 * This is the definition the whole stall ladder rests on, and it was wrong.
 * The old signature hashed every node and task output, and `streamInto()`
 * rewrites `tasks/<id>.md` every 250ms while a model is talking — so every
 * poll looked like new work. `repeats` reset to 0, `lastProgressAt` reset, and
 * `idleMs` stayed at 0 for as long as the model kept producing tokens. Three
 * of the five detectors could therefore never fire. Watched live: an
 * eleven-minute attempt, 40 model calls, 66 tool calls, no workspace change,
 * reporting `idleMs: 0, repeats: 0` on every single poll until it hit its cap.
 *
 * So progress means the durable record changed:
 *
 * - a node or task **status** changed;
 * - a **finished** output changed — a node or task whose status says it is
 *   done, never a buffer that is still being streamed into;
 * - the **workspace** changed, when the caller can see one.
 *
 * Talking is not progress. Reading is not progress either, which is the case
 * that cost real money: the attempt above made 66 tool calls and every one of
 * them was a read. A signature that counted tool calls would have called that
 * progress too, so the workspace — what the task actually promised to change —
 * is the measure wherever there is one to look at.
 *
 * @param snapshot — the run snapshot.
 * @param options.workspace — a fingerprint of the bound workspace, when the
 *        caller has one. Absent (a run with no worktree) falls back to the
 *        completed tool-call count, which at least only moves when a node ends.
 * @returns a hash that changes only when something was accomplished.
 */
export function workSignature(snapshot = {}, { workspace = null } = {}) {
  const nodeStatus = snapshot.meta?.nodeStatus ?? {};
  const statuses = Object.entries(nodeStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => `${id}:${s}`)
    .join(',');

  // Which tasks have finished, so their output can be trusted to be final.
  const taskStatus = Object.fromEntries(
    (snapshot.tasks?.tasks ?? []).map(t => [t.id, t.status ?? 'pending']));
  const settled = new Set(['done', 'failed', 'skipped', 'rejected']);
  const finished = ([id, text], status) => settled.has(status) ? `${id}:${hash(text)}` : null;

  const outputs = [
    ...Object.entries(snapshot.nodeOutputs ?? {}).map(e => finished(e, nodeStatus[e[0]] ?? 'pending')),
    ...Object.entries(snapshot.taskOutputs ?? {}).map(e => finished(e, taskStatus[e[0]] ?? 'pending'))
  ]
    .filter(Boolean)
    .sort()
    // Hash the content, not its length: a rewrite of the same size is not
    // progress, and a model asked to try again often produces exactly that.
    .join(',');

  // With a workspace to look at, that is the answer. Without one, the count of
  // tool calls RECORDED BY FINISHED NODES — which moves when a node ends, not
  // while one talks.
  const acted = workspace === null
    ? String(Object.values(snapshot.retrospectives ?? {})
      .reduce((n, r) => n + (r?.toolCalls?.length ?? 0), 0))
    : hash(JSON.stringify(workspace));

  return hash(`${statuses}|${outputs}|${acted}`);
}

/**
 * One in-flight task's heartbeat.
 *
 * Owned by the supervisor and kept OUTSIDE the worktree, so a wedged run cannot
 * report on its own health (§11.1).
 */
export class Heartbeat {
  constructor({ taskId, runId, level = null, model = null, now = Date.now() }) {
    this.taskId = taskId;
    this.runId = runId;
    this.level = level;
    // The model this attempt is running on, when one was named rather than
    // asked for by band. Recorded per attempt because it is a property of the
    // attempt: the next one may be pinned to something else.
    this.model = model;
    this.startedAt = now;
    this.lastProgressAt = now;
    this.lastPollAt = now;
    this.signature = null;
    this.repeats = 0;            // consecutive polls with no change in the work
    this.gateFailures = [];      // consecutive identical gate failure signatures
    this.tokensSinceProgress = 0;
    this.usdSinceProgress = 0;
    this.phase = 'running';
    this.stage = null;
    this.interventions = [];     // what the supervisor has already tried (§11.4)
  }

  /**
   * Fold in a poll. Returns true when this poll showed headway.
   *
   * @param snapshot — the run snapshot.
   * @param options.workspace — the workspace fingerprint, when the caller has
   *        one; see {@link workSignature} for why it is the measure.
   * @param options.tokens — tokens spent since the last poll.
   * @param options.usd — money spent since the last poll.
   */
  observe(snapshot, { now = Date.now(), tokens = 0, usd = 0, workspace = null } = {}) {
    this.lastPollAt = now;
    this.stage = snapshot?.meta?.stage ?? this.stage;
    const signature = workSignature(snapshot, { workspace });
    const moved = this.signature !== null && signature !== this.signature;
    const first = this.signature === null;
    this.signature = signature;

    if (moved || first) {
      this.lastProgressAt = now;
      this.repeats = 0;
      this.tokensSinceProgress = 0;
      this.usdSinceProgress = 0;
      return true;
    }
    this.repeats += 1;
    // The counter that catches a polite infinite loop: busy, expensive, and
    // producing the same thing every time.
    this.tokensSinceProgress += tokens;
    this.usdSinceProgress += usd;
    return false;
  }

  /** A gate result, for the groundhog detector. */
  observeGate(failure) {
    if (!failure) { this.gateFailures = []; return; }
    const sig = hash(`${failure.command}|${failure.status}|${failure.code}|${failure.output?.slice(0, 2000)}`);
    // A DIFFERENT error is progress — it means the last attempt changed
    // something real, even if it is still red.
    if (this.gateFailures[0] !== sig) this.gateFailures = [sig];
    else this.gateFailures.push(sig);
  }

  get idleMs() { return this.lastPollAt - this.lastProgressAt; }
  get ageMs() { return this.lastPollAt - this.startedAt; }

  toJSON() {
    return {
      taskId: this.taskId, runId: this.runId, level: this.level, model: this.model,
      phase: this.phase, stage: this.stage,
      startedAt: new Date(this.startedAt).toISOString(),
      ageMs: this.ageMs, idleMs: this.idleMs,
      repeats: this.repeats,
      tokensSinceProgress: this.tokensSinceProgress,
      usdSinceProgress: Number(this.usdSinceProgress.toFixed(6)),
      interventions: this.interventions
    };
  }
}

/**
 * Has this task stopped making headway, and how do we know?
 *
 * Every trip carries the evidence that tripped it — a silent detector is as bad
 * as no detector, and the evidence is what the next attempt is told (§11.4).
 * Returns null when the task is fine.
 */
export function detectStall(heartbeat, { thresholds = DEFAULT_THRESHOLDS, medianMs = null } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  if (heartbeat.gateFailures.length >= t.groundhogRepeats) {
    return {
      detector: 'groundhog',
      detail: `The same gate failure ${heartbeat.gateFailures.length} times running. The last ${heartbeat.gateFailures.length} attempts changed nothing the gate can see.`
    };
  }
  // Both halves, deliberately: enough polls to be sure it is not one unlucky
  // sample, and enough time that a model legitimately working cannot trip it.
  if (heartbeat.repeats >= t.spinRepeats && heartbeat.idleMs >= (t.spinMs ?? 0)) {
    return {
      detector: 'spin',
      detail: `${heartbeat.repeats} consecutive polls over ${Math.round(heartbeat.idleMs / 60000)} minutes with byte-identical work. Whatever it is doing, it is producing the same thing each time.`
    };
  }
  if (heartbeat.idleMs >= t.silentMs) {
    return {
      detector: 'silent',
      detail: `No file, tool or node event for ${Math.round(heartbeat.idleMs / 1000)}s.`
    };
  }
  if (t.burnUsd && heartbeat.usdSinceProgress >= t.burnUsd) {
    return {
      detector: 'burn',
      detail: `$${heartbeat.usdSinceProgress.toFixed(2)} spent since anything last changed.`
    };
  }
  if (t.burnTokens && heartbeat.tokensSinceProgress >= t.burnTokens) {
    return {
      detector: 'burn',
      detail: `${heartbeat.tokensSinceProgress} tokens since anything last changed.`
    };
  }
  if (medianMs && heartbeat.ageMs >= medianMs * t.outlierFactor) {
    return {
      detector: 'outlier',
      detail: `Running ${Math.round(heartbeat.ageMs / 60000)} minutes; ${t.outlierFactor}× the usual for this kind of task.`
    };
  }
  return null;
}

/**
 * What to do about it — the interruption ladder (§11.4).
 *
 * Detection without authority is a dashboard. Each rung is tried once, in
 * order, and the ladder is per-task: a task that has already been nudged and
 * restarted escalates next rather than being nudged forever.
 *
 *   nudge    — inject the evidence as guidance and let the node continue.
 *   restart  — re-run the node with the accumulated guidance.
 *   escalate — one effort band up (§8), on the theory the model is the
 *              bottleneck.
 *   park     — stop the run, keep the worktree for forensics, take the next task.
 */
export const LADDER = ['nudge', 'restart', 'escalate', 'park'];

export function nextIntervention(heartbeat) {
  for (const rung of LADDER) {
    if (!heartbeat.interventions.includes(rung)) return rung;
  }
  return 'park'; // the bottom rung repeats: there is nothing below it
}
