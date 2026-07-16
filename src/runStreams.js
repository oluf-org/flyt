// Which units of work in a run are producing output right now, and what each
// has produced so far. The data behind the live output panel (LiveStream.jsx,
// V1 task 8, D10), kept as a pure function over a run snapshot so it is
// testable without a DOM — the same split as flowTypes.js / flowLayout.js.
//
// This needs no channel of its own: the runner streams partial model text into
// the very files a finished node writes (core/flowRunner.js streamInto), so a
// snapshot already carries the live text, and a streaming flush ships only the
// one changed entry (core/snapshotDiff.js).
import { TYPE_META, nodeLabel } from './flowTypes.js';
import { outputKey } from './runGraph.js';

// Returns [{ key, label, sub, icon, text }] — two kinds, keyed differently on
// purpose:
//   - tasks, because an agentTask node's work IS its task (listing both would
//     double it), and a task spawned by create_task has no node at all — the
//     task is the only handle on it.
//   - aiStep/orchestrator nodes, which stream into their own nodes/<id>.md.
// A task stays listed through a tool gate (its status is still 'running'), so
// the block it is asking approval for shows up beside the reply that asked.
export function activeStreams(snapshot) {
  if (!snapshot) return [];
  const { meta, flow, tasks, taskOutputs, nodeOutputs } = snapshot;
  const streams = [];
  for (const t of tasks?.tasks ?? []) {
    if (t.status !== 'running') continue;
    streams.push({
      key: `task:${t.id}`,
      label: t.title || t.id,
      sub: t.worker ? `${t.worker.provider}/${t.worker.model}` : t.id,
      icon: TYPE_META.agentTask.icon,
      text: taskOutputs?.[t.id] ?? ''
    });
  }
  for (const n of flow?.nodes ?? []) {
    if (meta?.nodeStatus?.[n.id] !== 'active') continue;
    // Only the node types that make a model call of their own. agentTask is
    // covered by its task above; input/output go active briefly but never
    // call a model.
    if (n.type !== 'aiStep' && n.type !== 'orchestrator') continue;
    // An orchestrator's own call is its planning turn; the children it creates
    // stream as nodes in their own right once they start.
    const id = n.type === 'orchestrator' ? `${n.id}.plan` : n.id;
    streams.push({
      key: `node:${n.id}`,
      label: nodeLabel(n),
      sub: n.type === 'orchestrator' ? 'planning' : (n.data?.role ?? 'custom'),
      icon: TYPE_META[n.type]?.icon ?? '✦',
      text: nodeOutputs?.[outputKey(id)] ?? ''
    });
  }
  return streams;
}
