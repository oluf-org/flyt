// MODES-COMPARE Phase 5 — comparison logic (T11/T12), pure over run snapshots so
// it tests without a DOM (same split as nodeFeedData.js / runProgress.js).
//
// A comparison is two ORDINARY runs launched from one prompt and shown side by
// side. No new runner semantics: each pane is a normal run with its own gates,
// follow-ups and stage. This module owns the small amount of shared reasoning —
// what state a pane is in, whether the composer can send, and where a broadcast
// reaches — so CompareRun.jsx stays a thin view.
import { isTerminal } from './runProgress.js';
import { finalAnswer } from './nodeFeedData.js';

// The pair record carried on a compare tab (`{ compare: [a, b] }` in the plan).
// Normalize the several shapes it can arrive in (a bare array, the wrapped
// object, or junk from a stale bundle) to a validated [a, b] or null.
export function comparePair(value) {
  if (!value) return null;
  const ids = Array.isArray(value) ? value : value.compare;
  if (!Array.isArray(ids) || ids.length !== 2) return null;
  if (ids.some(x => !x || typeof x !== 'string')) return null;
  if (ids[0] === ids[1]) return null; // two panes must be two distinct runs
  return [ids[0], ids[1]];
}

// The A/B label for a pane index (0 -> "A", 1 -> "B", …).
export function paneLabel(index) {
  return String.fromCharCode(65 + index);
}

// Per-pane derivation shared by CompareRun and its tests: given the snapshot we
// hold for a pane (or null before it lands) and the runId that pane expects,
// what state is the pane in? Mirrors ChatRun's single-run derivation so the two
// surfaces read a run the same way.
export function paneStatus(snapshot, runId) {
  const loaded = Boolean(snapshot?.meta?.runId && snapshot.meta.runId === runId);
  const meta = loaded ? snapshot.meta : null;
  const stage = meta?.stage ?? null;
  const live = Boolean(loaded && !isTerminal(stage));
  const gated = stage === 'awaiting_approval';
  const awaitingInput = stage === 'awaiting_input';
  return {
    loaded,
    stage,
    live,
    gated,
    awaitingInput,
    parked: gated || awaitingInput,
    settled: Boolean(loaded && isTerminal(stage))
  };
}

// The channel a typed message would use for this pane right now, or null when
// the pane can't take one. A run parked at the refiner's input gate WANTS the
// composer (answering is how it proceeds); a settled run takes a follow-up;
// everything else (working, approval-gated) takes nothing.
export function paneChannel(status) {
  if (!status?.loaded) return null;
  if (status.awaitingInput) return 'answer';
  if (status.settled) return 'followup';
  return null;
}

// A broadcast reaches every pane that can take a FOLLOW-UP (settled, ungated).
// Input-gated panes are steered individually — a broadcast never answers a
// clarifying question aimed at one side — so they are excluded here.
export function broadcastTargets(statuses) {
  return statuses
    .map((s, i) => (paneChannel(s) === 'followup' ? i : -1))
    .filter(i => i >= 0);
}

export function canBroadcast(statuses) {
  return broadcastTargets(statuses).length > 0;
}

// Resolve a composer send against the chosen target ('both' | pane index) into
// the concrete [{ index, channel }] deliveries. 'both' fans out to the
// broadcast set; a single pane sends on whatever channel it currently accepts
// (so selecting an input-gated pane answers it). Empty = nothing to send, the
// composer should be disabled.
export function sendPlan(statuses, target) {
  if (target === 'both') {
    return broadcastTargets(statuses).map(index => ({ index, channel: 'followup' }));
  }
  const status = statuses[target];
  const channel = paneChannel(status);
  return channel ? [{ index: target, channel }] : [];
}

// T13 judge prep: the compare role runs over the two panes' final answers.
// Build the alternatives payload (label + text) from the snapshots; null when
// either side hasn't produced an answer yet (nothing to compare).
export function judgeAlternatives(snapshots) {
  const alts = snapshots.map((s, i) => ({ label: `Run ${paneLabel(i)}`, text: finalAnswer(s) }));
  return alts.some(a => !a.text) ? null : alts;
}
