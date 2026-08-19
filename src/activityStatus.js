// A compact, safe account of what AI work is doing across the app shell.
//
// This is deliberately a renderer projection over the snapshots Flyt already
// emits. It never reads prompt/output text or tool results: those belong in the
// detailed run view, while the persistent chrome only needs identity, phase,
// the allowlisted subject of the latest tool, and freshness.
import { activeStreams } from './runStreams.js';
import { currentNode, toolCalls } from './loopLive.js';

export const ACTIVITY_STALE_MS = 90_000;

const PHASE_LABELS = {
  thinking: 'Thinking',
  streaming: 'Responding',
  tool: 'Using a tool',
  'awaiting-approval': 'Needs approval',
  paused: 'Paused',
  stalled: 'May be stalled',
  failed: 'Failed',
  cancelled: 'Cancelled',
  complete: 'Complete',
  idle: 'Idle'
};

const SECRET = /(bearer\s+\S+|\b(?:sk|pk)-[a-z0-9_-]{8,}|\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+)/gi;
const SAFE_TOOL_SUBJECTS = new Set(['read_file', 'write_file', 'create_file', 'edit_file', 'glob']);

export function safeActivityLabel(value, max = 64) {
  if (value == null) return null;
  const clean = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(SECRET, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
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

export function runActivity(record, now = Date.now(), { staleMs = ACTIVITY_STALE_MS } = {}) {
  const snapshot = record?.snapshot ?? null;
  if (!snapshot?.meta) return null;
  const updatedAt = Number(record.updatedAt ?? now);
  const ageMs = Math.max(0, now - updatedAt);
  const live = record.live !== false;
  const node = currentNode(snapshot);
  const call = toolCalls(snapshot, 1)[0] ?? null;
  const streamPresent = activeStreams(snapshot).some(s => Boolean(s.text));
  const phase = phaseFor(snapshot, {
    live, ageMs, staleMs, hasTool: Boolean(call), hasStream: streamPresent, node
  });
  const worker = workerFor(snapshot, node);
  const provider = safeActivityLabel(worker?.provider, 28);
  const model = safeActivityLabel(worker?.model, 56);
  const nodeLabel = safeActivityLabel(node?.label, 52);
  const toolName = safeActivityLabel(call?.name, 28);
  // Commands, questions, searches and URLs can contain prompt text or
  // credentials. Persistent chrome shows their tool name only; a small
  // allowlist of local file operations may also show the path/pattern.
  const toolSubject = SAFE_TOOL_SUBJECTS.has(call?.name)
    ? safeActivityLabel(call?.argsPreview, 60)
    : null;
  const tool = toolName ? safeActivityLabel(`${toolName}${toolSubject ? ` ${toolSubject}` : ''}`, 76) : null;
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
