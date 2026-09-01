// A compact, safe account of what AI work is doing across the app shell.
//
// This is deliberately a renderer projection over the snapshots Flyt already
// emits. It never reads prompt/output text or tool results: those belong in the
// detailed run view, while the persistent chrome only needs identity, phase,
// the allowlisted subject of the latest tool, and freshness.
import { activeStreams } from './runStreams.js';
import { currentNode } from './loopLive.js';
import {
  safeActivityFileSubject, safeActivityLabel, safeActivityToolName
} from './activitySafety.js';

export { safeActivityLabel } from './activitySafety.js';

export const ACTIVITY_STALE_MS = 90_000;
export const ACTIVITY_SETTLED_MS = 15_000;

const PHASE_LABELS = {
  thinking: 'Thinking',
  streaming: 'Responding',
  tool: 'Using a tool',
  'awaiting-approval': 'Needs approval',
  paused: 'Paused',
  pausing: 'Pausing',
  stopping: 'Stopping',
  stalled: 'May be stalled',
  failed: 'Failed',
  cancelled: 'Cancelled',
  complete: 'Complete',
  idle: 'Idle'
};

function latestActivityTool(snapshot) {
  const ordered = Object.entries(snapshot?.meta?.toolActivity ?? {})
    .filter(([, edge]) => edge && typeof edge === 'object')
    .sort(([, a], [, b]) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
  const current = ordered.filter(([, edge]) => edge.active === true).at(-1) ?? ordered.at(-1) ?? null;
  if (!current) return { present: false, label: null };
  const [, edge] = current;
  const name = safeActivityToolName(edge.tool);
  if (!name) return { present: edge.active === true, label: null };
  // The edge owns the exact invocation's already-sanitized subject. Validate
  // it again here; never infer current work from historical same-named calls.
  const subject = safeActivityFileSubject(edge.subject);
  return {
    present: edge.active === true,
    label: safeActivityLabel(`${name}${subject ? ` ${subject}` : ''}`, 76)
  };
}

function workerFor(snapshot, node) {
  const task = (snapshot?.tasks?.tasks ?? []).find(t => t.status === 'running');
  const flowNode = (snapshot?.flow?.nodes ?? []).find(n => n.id === node?.id);
  const retro = snapshot?.retrospectives?.[`executor-${task?.id}`]
    ?? snapshot?.retrospectives?.[node?.id];
  return task?.worker ?? flowNode?.data?.worker ?? retro?.model ?? null;
}

function phaseFor(snapshot, { live, ageMs, staleMs, hasTool, hasStream, node }) {
  const meta = snapshot?.meta ?? {};
  const stage = String(meta.stage ?? '').toLowerCase();
  if (stage === 'failed' || (meta.error && stage !== 'cancelled')) return 'failed';
  if (['cancelled', 'rejected', 'stopped', 'interrupted'].includes(stage) || meta.interrupted) return 'cancelled';
  if (['done', 'complete', 'completed'].includes(stage)) return 'complete';
  if (stage === 'awaiting_approval' || meta.pendingGateKind || meta.pendingToolCall) return 'awaiting-approval';
  if (stage === 'paused' || meta.paused === true) return 'paused';
  if (stage === 'pausing') return 'pausing';
  if (stage === 'stopping') return 'stopping';
  if (live && ageMs >= staleMs) return 'stalled';
  if (live && hasTool) return 'tool';
  if (live && hasStream) return 'streaming';
  if (live) return 'thinking';
  return 'idle';
}

function freshness(ageMs) {
  if (ageMs < 2_000) return 'now';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
}

export function runActivity(record, now = Date.now(), {
  staleMs = ACTIVITY_STALE_MS,
  settledMs = ACTIVITY_SETTLED_MS
} = {}) {
  const snapshot = record?.snapshot ?? null;
  if (!snapshot?.meta) return null;
  const updatedAt = Number(record.updatedAt ?? now);
  const ageMs = Math.max(0, now - updatedAt);
  const live = record.live !== false;
  const node = currentNode(snapshot);
  const latestTool = latestActivityTool(snapshot);
  const tool = latestTool.label;
  const streamPresent = activeStreams(snapshot).some(s => Boolean(s.text));
  const phase = phaseFor(snapshot, {
    live, ageMs, staleMs, hasTool: latestTool.present, hasStream: streamPresent, node
  });
  // A terminal outcome is useful feedback, but it is not ongoing activity.
  // Retain it long enough to be noticed, then let both shell consumers clear.
  if (!live && ['failed', 'cancelled', 'complete'].includes(phase) && ageMs >= settledMs) return null;
  const worker = workerFor(snapshot, node);
  const provider = safeActivityLabel(worker?.provider, 28);
  const model = safeActivityLabel(worker?.model, 56);
  const nodeLabel = safeActivityLabel(node?.label, 52);
  // Commands, questions, searches and URLs can contain prompt text or
  // credentials. latestActivityTool exposes their allowlisted tool name only;
  // file tools may additionally expose one exact structured path field.
  const phaseLabel = PHASE_LABELS[phase];
  const workerLabel = safeActivityLabel([provider, model].filter(Boolean).join('/'), 72);
  const detail = safeActivityLabel(tool ?? nodeLabel ?? model ?? provider, 80);
  const freshnessLabel = freshness(ageMs);
  const ariaLabel = safeActivityLabel([
    `AI activity: ${phaseLabel}.`,
    workerLabel ? `Worker ${workerLabel}.` : '',
    nodeLabel ? `Current work ${nodeLabel}.` : '',
    tool ? `Latest tool ${tool}.` : '',
    `Updated ${freshnessLabel}.`
  ].filter(Boolean).join(' '), 220);

  return {
    runId: snapshot.meta.runId ?? record.runId ?? null,
    phase, phaseLabel, active: live && !['failed', 'cancelled', 'complete', 'idle'].includes(phase),
    provider, model, workerLabel, nodeLabel, tool, detail,
    updatedAt, ageMs, freshness: freshnessLabel, ariaLabel,
    shortLabel: safeActivityLabel(detail ? `${phaseLabel} · ${detail}` : phaseLabel, 72)
  };
}

export function showPersistentActivity(status, liveCount = 0) {
  return Number(liveCount) > 0 || Boolean(status && status.phase !== 'idle');
}

export function projectActivity(records, now = Date.now(), options = {}) {
  const list = [...(records ?? [])]
    .map(r => runActivity(r, now, options))
    .filter(Boolean)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
  if (!list.length) return null;
  const primary = list[0];
  const liveCount = list.filter(x => x.active).length;
  return {
    ...primary,
    liveCount,
    ariaLabel: safeActivityLabel(`${primary.ariaLabel}${liveCount > 1 ? ` ${liveCount} AI runs are active.` : ''}`, 240)
  };
}
