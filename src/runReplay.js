// Replay scrubber (flare 6): fold a finished run's log.jsonl into an ordered
// list of frames, each a snapshot of node/task status at that instant. Pure over
// an already-loaded log + the run's flow, so it tests without a DOM. Scrubbing a
// frame feeds its status maps into the same props the live canvas consumes — the
// canvas never knows it's time-traveling.
//
// The log has no explicit "node done" event, so completion is inferred: a node
// is active on its node_start and done on its retrospective (a task node's
// retrospective is keyed executor-<taskId>, which also completes the owning
// node). Every event that changes state emits one frame.

const MAX_FRAMES = 5000;

export function foldReplay(log, flow) {
  const nodes = flow?.nodes ?? [];
  const nodeIds = new Set(nodes.map(n => n.id));
  const typeOf = new Map(nodes.map(n => [n.id, n.type]));
  const taskToNode = new Map();               // taskId -> owning flow node id
  for (const n of nodes) if (n.data?.taskId) taskToNode.set(n.data.taskId, n.id);

  const nodeStatus = {};
  for (const n of nodes) nodeStatus[n.id] = 'pending';
  const taskStatus = {};

  const frames = [];
  const push = (t, line) => frames.push({
    t: Number.isFinite(t) ? t : (frames.at(-1)?.t ?? 0),
    line,
    nodeStatus: { ...nodeStatus },
    taskStatus: { ...taskStatus },
  });

  const setTaskDone = (taskId, status) => {
    taskStatus[taskId] = status;
    const owner = taskToNode.get(taskId);
    if (owner) nodeStatus[owner] = status;
  };

  for (const e of (log ?? [])) {
    const t = Date.parse(e?.ts);
    let line = null;

    if (e.event === 'node_start') {
      const node = String(e.node ?? '');
      const ex = node.match(/^executor:(.+)$/);
      if (ex) { taskStatus[ex[1]] = 'running'; line = `${ex[1]} running`; }
      else if (nodeIds.has(node)) {
        // input/output nodes complete synchronously and log no retrospective,
        // so they'd otherwise linger 'active' forever — mark them done at start.
        const instant = typeOf.get(node) === 'input' || typeOf.get(node) === 'output';
        nodeStatus[node] = instant ? 'done' : 'active';
        line = `${node} ${instant ? 'done' : 'started'}`;
      }
    } else if (e.event === 'task_claimed') {
      const id = String(e.taskId ?? '').replace(/^executor:/, '');
      if (id && taskStatus[id] !== 'done') { taskStatus[id] = 'running'; line = `${id} claimed`; }
    } else if (e.event === 'retrospective') {
      const node = String(e.node ?? '');
      const ex = node.match(/^executor-(.+)$/);
      if (ex) { setTaskDone(ex[1], 'done'); line = `${ex[1]} done`; }
      else if (nodeIds.has(node)) { nodeStatus[node] = 'done'; line = `${node} done`; }
    } else if (e.event === 'node_error' || e.event === 'task_error') {
      const raw = String(e.node ?? e.taskId ?? '');
      const ex = raw.match(/^executor[-:](.+)$/);
      if (ex) { setTaskDone(ex[1], 'failed'); line = `${ex[1]} failed`; }
      else if (nodeIds.has(raw)) { nodeStatus[raw] = 'failed'; line = `${raw} failed`; }
    }
    // stage_change / materialized_nodes / tool_call etc. carry no per-node status
    // transition of their own, so they don't emit a frame.

    if (line) push(t, line);
  }

  // Safety cap (usually far fewer than this): keep first + an even sample so the
  // scrubber stays responsive on a pathologically long log.
  if (frames.length > MAX_FRAMES) {
    const step = frames.length / MAX_FRAMES;
    const kept = [];
    for (let i = 0; i < MAX_FRAMES; i++) kept.push(frames[Math.floor(i * step)]);
    kept[kept.length - 1] = frames[frames.length - 1];
    return kept;
  }
  return frames;
}

// Overlay a frame's status onto the real snapshot, so the canvas renders that
// moment. Everything else (flow, outputs) stays as-is — only status moves.
export function replaySnapshot(snapshot, frame) {
  if (!snapshot || !frame) return snapshot;
  return {
    ...snapshot,
    meta: { ...snapshot.meta, nodeStatus: frame.nodeStatus },
    tasks: snapshot.tasks
      ? { ...snapshot.tasks, tasks: snapshot.tasks.tasks.map(t => ({ ...t, status: frame.taskStatus[t.id] ?? 'pending' })) }
      : snapshot.tasks,
  };
}
