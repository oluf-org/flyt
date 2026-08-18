// DECISIONS.md D27 — comparison logic (T11/T12), pure over run snapshots so
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

// --- "What differed" header (DECISIONS.md D27) ------------------------------
//
// Both runs carry their fully RESOLVED flow.json snapshot, so what actually
// differed between two runs is computable after the fact — for any pair,
// weeks later, even if the flow and its modes have been edited twenty times
// since. diffResolvedFlows diffs those two snapshots (never the live flows)
// over the config-relevant fields and condenses the result into a one-line
// header summary. Pure, like the rest of this module.
//
// Returns { identical, entries, summary }:
//   entries — [{ nodeId, node, field, kind, a, b, text }] per difference
//   summary — e.g. "Model: fable vs gpt-5 · work.effort: medium vs high ·
//             refine.system: differs", or the sampling line when identical.
const FLOW_DIFF_FIELDS = [
  'worker', 'effort', 'category', 'evalType', 'language', 'minNodes', 'maxNodes',
  'system', 'instructions', 'tools', 'requiresApproval', 'approveToolCalls'
];

export function diffResolvedFlows(flowA, flowB) {
  const entries = [];
  const byIdA = new Map((flowA?.nodes ?? []).map(n => [n.id, n]));
  const byIdB = new Map((flowB?.nodes ?? []).map(n => [n.id, n]));
  const allIds = [...new Set([...byIdA.keys(), ...byIdB.keys()])];
  for (const id of allIds) {
    const a = byIdA.get(id);
    const b = byIdB.get(id);
    if (!a || !b) {
      entries.push({
        nodeId: id, node: id, field: null, kind: 'node-missing',
        a: Boolean(a), b: Boolean(b),
        text: `${id}: only in run ${a ? 'A' : 'B'}`
      });
      continue;
    }
    const da = a.data ?? {};
    const db = b.data ?? {};
    const title = da.title ?? db.title ?? id;
    for (const field of FLOW_DIFF_FIELDS) {
      const va = da[field];
      const vb = db[field];
      if (field === 'worker') {
        const ma = va?.model ?? 'default';
        const mb = vb?.model ?? 'default';
        if (ma !== mb) entries.push({ nodeId: id, node: title, field, kind: 'worker', a: ma, b: mb, text: `${id}.model: ${ma} vs ${mb}` });
      } else if (field === 'system' || field === 'instructions') {
        // Long prompts are compared, never printed — the header says "differs".
        if ((va ?? '') !== (vb ?? '')) {
          entries.push({ nodeId: id, node: title, field, kind: 'text', a: va ?? null, b: vb ?? null, text: `${id}.${field}: differs` });
        }
      } else if (field === 'tools') {
        if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) {
          entries.push({ nodeId: id, node: title, field, kind: 'scalar', a: va ?? null, b: vb ?? null, text: `${id}.tools: differ` });
        }
      } else if (field === 'requiresApproval' || field === 'approveToolCalls') {
        // Absent and false are the same gate; compare the effective boolean.
        if (Boolean(va) !== Boolean(vb)) {
          entries.push({ nodeId: id, node: title, field, kind: 'scalar', a: Boolean(va), b: Boolean(vb), text: `${id}.${field}: ${Boolean(va)} vs ${Boolean(vb)}` });
        }
      } else if (va !== vb && (va !== undefined || vb !== undefined)) {
        entries.push({ nodeId: id, node: title, field, kind: 'scalar', a: va ?? 'default', b: vb ?? 'default', text: `${id}.${field}: ${va ?? 'default'} vs ${vb ?? 'default'}` });
      }
    }
  }

  // Condensed summary: a uniform worker swap across nodes collapses into one
  // "Model: a vs b" token (the headline case — same flow, two brains).
  const workers = entries.filter(e => e.kind === 'worker');
  const rest = entries.filter(e => e.kind !== 'worker');
  const parts = [];
  if (workers.length) {
    const uniform = workers.every(e => e.a === workers[0].a && e.b === workers[0].b);
    parts.push(...(uniform ? [`Model: ${workers[0].a} vs ${workers[0].b}`] : workers.map(e => e.text)));
  }
  parts.push(...rest.map(e => e.text));
  const identical = entries.length === 0;
  return {
    identical,
    entries,
    summary: identical
      ? 'same configuration — outputs differ only by sampling'
      : parts.join(' · ')
  };
}
