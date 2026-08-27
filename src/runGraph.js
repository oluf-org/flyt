// Work that exists in a run but has no node in the flow definition: tasks an
// agent spawned mid-run via create_task, plus the fix tasks a stitch node
// creates. They are real work — they call tools and write to the workspace —
// but the run canvas only ever mapped flow.nodes, so they were visible nowhere
// except tasks.json and the live panel. The run view has to show them for a run
// to be understandable without opening files (V1 task 9).
//
// Pure over a run snapshot, so it tests without a DOM.

// The snapshot-side mirror of RunStore.nodeOutputPath: nodes/<id>.md filenames
// are sanitized on write, so a port sidecar authored as "orch-1.plan" is keyed
// "orch-1_plan" in snapshot.nodeOutputs. One definition, because every reader of
// a node output needs it and three copies had already drifted into the codebase.
export const outputKey = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

// Returns [{ task, ownerNodeId }] for every task with no node of its own.
// ownerNodeId is the flow node the task hangs off, or null when it can't be
// traced (a task created outside any node's context).
export function spawnedTasks(snapshot) {
  const nodes = snapshot?.flow?.nodes;
  const tasks = snapshot?.tasks?.tasks ?? [];
  if (!nodes || !tasks.length) return [];

  // An agentTask node records its task id into the run's flow.json when it
  // queues the work, so a task claimed by no node was spawned.
  const nodeOfTask = new Map(nodes.filter(n => n.data?.taskId).map(n => [n.data.taskId, n.id]));
  const nodeIds = new Set(nodes.map(n => n.id));
  const byId = new Map(tasks.map(t => [t.id, t]));

  // Walk createdBy up to the flow node responsible for this task — the same
  // ownership walk the runner uses to attribute a tool gate (gateFor in
  // core/stackRunner.js). createdBy names EITHER a node or a task: create_task
  // records ctx.taskId, which is a parent task id when an agent calls the tool
  // from inside the loop, but a NODE id when the runner spawns on a node's
  // behalf (stitch fix tasks — see postProcess). Both shapes resolve here.
  const ownerOf = task => {
    let cur = task;
    for (let hops = 0; cur && hops < 100; hops++) { // hop cap: never trust a cycle
      const by = cur.createdBy;
      if (!by) return null;
      if (nodeIds.has(by)) return by;
      const parent = byId.get(by);
      if (!parent) return null;
      const owned = nodeOfTask.get(parent.id);
      if (owned) return owned;
      cur = parent;
    }
    return null;
  };

  return tasks
    .filter(t => !nodeOfTask.has(t.id))
    .map(t => ({ task: t, ownerNodeId: ownerOf(t) }));
}

// One resolver for a node's output TEXT, every shape a node comes in: a flow
// node (aiStep / orchestrator plan / agentTask / input's prompt), a run-time
// task with no flow node, or a legacy stage id from pre-flow runs. Shared by
// NodeFocus and the canvas reader cards (output-view phase 2) so the port-
// sidecar and task-output rules live in exactly one place.
export function nodeOutputText(snapshot, nodeId) {
  if (!snapshot) return '';
  const flowNode = snapshot.flow?.nodes?.find(n => n.id === nodeId);
  if (flowNode) {
    const outputs = snapshot.nodeOutputs ?? {};
    if (flowNode.type === 'agentTask') return snapshot.taskOutputs?.[flowNode.data?.taskId] ?? '';
    if (flowNode.type === 'input') return snapshot.prompt ?? '';
    if (flowNode.type === 'orchestrator') {
      // The orchestrator's own call is its planning turn, a port sidecar.
      return outputs[outputKey(`${nodeId}.plan`)] ?? outputs[outputKey(nodeId)] ?? '';
    }
    return outputs[outputKey(nodeId)] ?? '';
  }
  const task = snapshot.tasks?.tasks?.find(t => t.id === nodeId);
  if (task) return snapshot.taskOutputs?.[task.id] ?? '';
  if (nodeId === 'prompt') return snapshot.prompt ?? '';
  if (nodeId === 'planner') return snapshot.plan ?? '';
  return '';
}

// tasks.json statuses -> the canvas status vocabulary (see StatusGlyph).
export function taskNodeStatus(status) {
  if (status === 'running') return 'active';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  return 'pending';
}
