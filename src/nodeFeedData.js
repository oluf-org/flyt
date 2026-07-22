// The chat-style node feed (CHAT-RUN rework): a run's graph flattened into the
// top-down reading order a chat thread has — prompt at the top, then every
// node in execution order, newest work appending at the bottom. Pure over a
// run snapshot, so it tests without a DOM — same split as runStreams.js /
// runGraph.js / runProgress.js.
//
// One feed item per unit of work:
//   { id, depth, icon, label, sub, kind, status, turn, spawned,
//     streamText, outputPreview, retro }
// depth 1 marks work nested under a container (orchestrator children, spawned
// tasks, classic-pipeline execution tasks) — the feed indents it under its
// owner instead of drawing the box.
import { TYPE_META, nodeLabel, nodeSub, forwardEdges, isFeedbackEdge } from './flowTypes.js';
import { outputKey, spawnedTasks } from './runGraph.js';
import { activeStreams } from './runStreams.js';

const PREVIEW_CHARS = 320;

function preview(text) {
  const t = (text ?? '').trim();
  if (!t) return null;
  return t.length > PREVIEW_CHARS ? t.slice(0, PREVIEW_CHARS).trimEnd() + '…' : t;
}

// Execution-respecting reading order: Kahn over the forward edges, breaking
// ties by canvas position (top-to-bottom, left-to-right) so sibling waves read
// in the order the layout shows them. Feedback edges never order anything.
function topoOrder(nodes, edges) {
  const ids = new Set(nodes.map(n => n.id));
  const fwd = forwardEdges(edges).filter(e => ids.has(e.source) && ids.has(e.target) && !isFeedbackEdge(e));
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const out = new Map();
  for (const e of fwd) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e.target);
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const rank = id => {
    const p = byId.get(id)?.position ?? {};
    return [p.y ?? 0, p.x ?? 0, id];
  };
  const cmp = (a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
  };
  const ready = nodes.map(n => n.id).filter(id => (indeg.get(id) ?? 0) === 0).sort(cmp);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const t of out.get(id) ?? []) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) {
        // Insert sorted: ready stays in reading order without a full re-sort.
        let i = ready.length;
        while (i > 0 && cmp(t, ready[i - 1]) < 0) i--;
        ready.splice(i, 0, t);
      }
    }
  }
  // A cycle (hand-edited YAML) leaves nodes stranded — append them in reading
  // order rather than dropping them from the feed.
  if (order.length < nodes.length) {
    const seen = new Set(order);
    order.push(...nodes.map(n => n.id).filter(id => !seen.has(id)).sort(cmp));
  }
  return order;
}

function streamByKey(snapshot) {
  const m = new Map();
  for (const s of activeStreams(snapshot)) m.set(s.key, s.text);
  return m;
}

function retroBrief(retro) {
  if (!retro) return null;
  return {
    status: retro.status ?? null,
    confidence: retro.confidence ?? null,
    recommendation: retro.recommendation || null,
    problems: (retro.problems ?? []).filter(Boolean)
  };
}

// --- Flow runs ---------------------------------------------------------------

function flowFeed(snapshot) {
  const { flow, meta } = snapshot;
  const statusOf = id => meta.nodeStatus?.[id] ?? 'pending';
  const streams = streamByKey(snapshot);
  const byId = new Map(flow.nodes.map(n => [n.id, n]));

  const itemFor = (n, depth, extra = {}) => ({
    id: n.id,
    depth,
    icon: n.data?.icon ?? TYPE_META[n.type]?.icon ?? '▢',
    label: nodeLabel(n),
    sub: nodeSub(n),
    kind: n.kind,
    nodeType: n.type,
    status: statusOf(n.id),
    // Follow-up provenance badge, same rule as the canvas card (FU5).
    ...(n.data?.origin === 'followup' ? { turn: n.data.turn } : {}),
    streamText: streams.get(`node:${n.id}`) ?? null,
    outputPreview: statusOf(n.id) === 'done' ? preview(snapshot.nodeOutputs?.[outputKey(n.id)]) : null,
    retro: retroBrief(snapshot.retrospectives?.[n.id]),
    spawned: false,
    ...extra
  });

  const top = flow.nodes.filter(n => !n.parentId || !byId.has(n.parentId));
  const items = [];
  for (const id of topoOrder(top, flow.edges)) {
    const n = byId.get(id);
    items.push(itemFor(n, 0));
    if (n.type === 'orchestrator') {
      const kids = flow.nodes.filter(k => k.parentId === id);
      for (const kidId of topoOrder(kids, flow.edges)) {
        items.push(itemFor(byId.get(kidId), 1));
      }
    }
  }

  // Runtime-spawned tasks have no node of their own — they append right under
  // the node that spawned them (or at the tail when ownership is untraceable).
  const spawned = spawnedTasks(snapshot);
  if (spawned.length) {
    const taskItem = ({ task }) => ({
      id: task.id,
      depth: 1,
      icon: TYPE_META.agentTask.icon,
      label: task.title || task.id,
      sub: `spawned task · ${task.worker?.provider}/${task.worker?.model}`,
      kind: 'ai',
      nodeType: 'agentTask',
      status: task.status === 'running' ? 'active' : task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : 'pending',
      streamText: streams.get(`task:${task.id}`) ?? null,
      outputPreview: task.status === 'done' ? preview(snapshot.taskOutputs?.[task.id]) : null,
      retro: retroBrief(snapshot.retrospectives?.[`executor-${task.id}`]),
      spawned: true
    });
    for (const s of spawned) {
      const it = taskItem(s);
      const ownerIdx = s.ownerNodeId ? items.findIndex(i => i.id === s.ownerNodeId) : -1;
      if (ownerIdx < 0) { items.push(it); continue; }
      // After the owner's whole subtree so a child never splits the group.
      let insert = ownerIdx + 1;
      while (insert < items.length && items[insert].depth > 0) insert++;
      items.splice(insert, 0, it);
    }
  }
  return items;
}

// --- Classic pipeline runs (no flow.json) -------------------------------------

const STAGE_ORDER = ['prompt', 'planning', 'awaiting_approval', 'routing', 'execution', 'verification', 'done'];
const STAGE_DEFS = [
  { id: 'prompt', label: 'Prompt', stage: 'prompt', icon: '✎', sub: 'brief · user request' },
  { id: 'planner', label: 'Planning', stage: 'planning', icon: '▤' },
  { id: 'router', label: 'Routing', stage: 'routing', icon: '⇄' },
  { id: 'execution', label: 'Execution', stage: 'execution', icon: '⚙' },
  { id: 'verifier', label: 'Verification', stage: 'verification', icon: '⚖' }
];

function stageStatus(nodeStage, meta) {
  const cur = meta.stage;
  if (cur === 'failed' || cur === 'rejected') {
    const failedAt = meta.error ? 'execution' : 'planning';
    return STAGE_ORDER.indexOf(nodeStage) < STAGE_ORDER.indexOf(failedAt) ? 'done' : 'failed';
  }
  const curIdx = STAGE_ORDER.indexOf(cur);
  const nodeIdx = STAGE_ORDER.indexOf(nodeStage);
  if (cur === 'done') return 'done';
  if (nodeIdx < curIdx) return 'done';
  if (nodeIdx === curIdx || (nodeStage === 'planning' && cur === 'awaiting_approval')) {
    return cur === 'awaiting_approval' ? 'waiting' : 'active';
  }
  return 'pending';
}

function classicFeed(snapshot) {
  const { meta, tasks, retrospectives } = snapshot;
  const streams = streamByKey(snapshot);
  const items = STAGE_DEFS.map(def => ({
    id: def.id,
    depth: 0,
    icon: def.icon,
    label: def.label,
    sub: def.sub ?? `${def.id === 'router' ? 'logic' : def.id === 'execution' ? 'tool' : def.id === 'verifier' ? 'eval' : 'llm'} · ${retrospectives?.[def.id]?.model ? `${retrospectives[def.id].model.provider}/${retrospectives[def.id].model.model}` : 'idle'}`,
    kind: null,
    nodeType: def.id,
    status: def.id === 'prompt' ? 'done' : stageStatus(def.stage, meta),
    streamText: streams.get(`node:${def.id}`) ?? null,
    outputPreview: null,
    retro: retroBrief(retrospectives?.[def.id]),
    spawned: false
  }));
  let execIdx = items.findIndex(i => i.id === 'execution');
  for (const t of tasks?.tasks ?? []) {
    const running = t.status === 'running' || (meta.currentTaskId === t.id && meta.stage === 'execution');
    items.splice(++execIdx, 0, {
      id: t.id,
      depth: 1,
      icon: '⚙',
      label: t.title || t.id,
      sub: `tool · ${t.worker.provider}/${t.worker.model}`,
      kind: null,
      nodeType: 'task',
      status: running ? 'active' : t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'pending',
      streamText: streams.get(`task:${t.id}`) ?? null,
      outputPreview: t.status === 'done' ? preview(snapshot.taskOutputs?.[t.id]) : null,
      retro: retroBrief(retrospectives?.[`executor-${t.id}`]),
      spawned: false
    });
  }
  return items;
}

// The feed for any run snapshot, or [] before the snapshot lands.
export function feedItems(snapshot) {
  if (!snapshot?.meta) return [];
  if (snapshot.flow) return flowFeed(snapshot);
  return classicFeed(snapshot);
}

// The final answer, when the run has produced one: the Output node's primary
// output for flow runs — the sidebar's "what did I get" section.
export function finalAnswer(snapshot) {
  if (!snapshot?.flow) return null;
  const out = snapshot.flow.nodes.find(n => n.type === 'output');
  if (!out) return null;
  const text = (snapshot.nodeOutputs?.[outputKey(out.id)] ?? '').trim();
  return text || null;
}
