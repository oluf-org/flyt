// Container expansion: "materialize children into my box, then walk them as a
// scoped subgraph" (BRICKS P2.0).
//
// This is one mechanism with three consumers. The Orchestrator materializes
// its children from a model's plan; a fan-out node will mint them from a lane
// list (P2); a sub-flow node will splice them from another flow file (P3).
// What happens AFTER the children exist is identical in all three — and if it
// were written three times it would drift three ways, so it is written here.
//
// The seam is deliberate: deciding WHICH children exist stays with the caller,
// because that is the only part that actually differs. Everything from "the
// container goes active" to "the aggregate output is written" lives here.
//
// `runner` is the FlowRunner. Passing it in rather than inheriting from it
// keeps the dependency edge visible: this module needs exactly store,
// setNodeStatus, runNode, runPendingTasks, stopRequests and config.maxParallel,
// and nothing else.
import { abortError } from '../adapters/index.js';
import { forwardEdges } from '../../src/flowTypes.js';

// Children that appeared without passing through the outer scheduler (authored
// nodes, spliced nodes, minted lanes) have no status yet. The canvas reads
// nodeStatus to draw them, so they need one before the walk starts — pending,
// exactly as the outer walk would have left them.
export function ensureChildStatuses(store, runId, children) {
  const meta = store.readMeta(runId);
  const missing = Object.fromEntries(children
    .filter(c => !meta.nodeStatus?.[c.id])
    .map(c => [c.id, 'pending']));
  if (!Object.keys(missing).length) return;
  store.writeMeta(runId, { ...meta, nodeStatus: { ...(meta.nodeStatus ?? {}), ...missing } });
}

// Which children can run right now. Dependencies are scoped to the box: an
// edge from outside it is the container's own inbound wiring and says nothing
// about the order of the children.
export function readyChildren(children, edges, done, childIds) {
  return children.filter(c => !done.has(c.id) &&
    forwardEdges(edges).every(e => e.target !== c.id || !childIds.has(e.source) || done.has(e.source)));
}

// One wave. Children are never gated (a container runs autonomously), so both
// aiStep and agentTask children are wave-safe (V1 task 6); anything else runs
// alone.
export function containerWave(ready, maxParallel) {
  const safe = ready.filter(c => c.type === 'aiStep' || c.type === 'agentTask');
  return safe.length > 1 ? safe.slice(0, maxParallel) : [ready[0]];
}

// The default aggregation: every child's output under its own heading, in the
// order the children were declared. A consumer with a better label for a child
// (a fan-out lane, say) passes its own `label`.
export function aggregateChildren(runner, runId, node, children, opts = {}) {
  const label = opts.label ?? (c => c.data?.title?.trim() || c.id);
  return children.map(c => {
    const content = c.type === 'agentTask'
      ? runner.store.readTaskOutput(runId, opts.taskIdByNode?.get(c.id) ?? c.data?.taskId ?? '')
      : runner.store.readNodeOutput(runId, c.id);
    return `--- ${label(c)} (${c.id}) ---\n\n${content ?? '(no output)'}`;
  });
}

// Run a container's children as a scoped subgraph and write its aggregated
// primary output. The container stays visibly `active` throughout; a child
// failure fails the container and rethrows; a stop unwinds the box the same
// way it unwinds the outer walk (children have already returned themselves to
// 'pending' via their own catches, so there is nothing to undo here).
//
// The caller keeps the retrospective and the final `done` status: the wording
// of "what this container just did" is the one part that is genuinely per
// consumer.
export async function runContainer(runner, runId, flow, node, children, opts = {}) {
  // What this container is called in its own error messages. Those strings
  // reach log.jsonl and the run's error banner, so each consumer names itself
  // rather than every box in the app calling itself "Container".
  const kind = opts.kind ?? 'Container';
  runner.setNodeStatus(runId, node.id, 'active');

  const childIds = new Set(children.map(c => c.id));
  // Already-done children (resume after a restart) are skipped.
  const done = new Set(children
    .filter(c => runner.store.readMeta(runId).nodeStatus?.[c.id] === 'done')
    .map(c => c.id));
  const maxParallel = Math.max(1, Number(runner.config.maxParallel ?? 4));

  for (;;) {
    if (runner.stopRequests.has(runId)) throw abortError(`${kind} ${node.id} stopped`);
    const ready = readyChildren(children, flow.edges, done, childIds);
    if (!ready.length) break;
    const batch = containerWave(ready, maxParallel);

    if (batch.length > 1) {
      runner.store.appendLog(runId, { event: 'wave_start', container: node.id, nodes: batch.map(n => n.id) });
      const results = await Promise.allSettled(batch.map(c => runner.runNode(runId, flow, c, opts)));
      batch.forEach((c, i) => { if (results[i].status === 'fulfilled') done.add(c.id); });
      const rejected = results.find(r => r.status === 'rejected');
      if (rejected) {
        // Under a stop the container isn't failing — it's being cancelled.
        if (!runner.stopRequests.has(runId)) runner.setNodeStatus(runId, node.id, 'failed');
        throw rejected.reason;
      }
      if (batch.some(c => c.type === 'agentTask')
        && !await runner.runPendingTasks(runId, opts.taskIdByNode, flow)) {
        if (!runner.stopRequests.has(runId)) runner.setNodeStatus(runId, node.id, 'failed');
        throw new Error(`${kind} ${node.id}: a child task failed`);
      }
      continue;
    }

    const child = batch[0];
    try {
      await runner.runNode(runId, flow, child, opts);
      if (child.type === 'agentTask' && !await runner.runPendingTasks(runId, opts.taskIdByNode, flow)) {
        throw new Error(`${kind} ${node.id}: child task ${child.id} failed`);
      }
    } catch (err) {
      if (!runner.stopRequests.has(runId)) runner.setNodeStatus(runId, node.id, 'failed');
      throw err;
    }
    done.add(child.id);
  }

  const title = opts.title ?? (node.data?.title?.trim() || node.id);
  const sections = aggregateChildren(runner, runId, node, children, opts);
  runner.store.writeNodeOutput(runId, node.id,
    `# ${title} — ${opts.aggregateLabel ?? 'aggregated results'}\n\n${sections.join('\n\n')}`);
}
