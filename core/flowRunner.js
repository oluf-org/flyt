// Graph runner: executes an editable flow definition (core/flowstore.js) the
// same way pipeline.js executes the hardcoded linear sequence — through the
// RunStore, one file per artifact, a retrospective per node, everything in
// log.jsonl. This is the "graph walker over an editable workflow definition"
// extension point.
//
// Semantics per node type:
//   input     -> its text becomes prompt.md / the run brief
//   agentTask -> contributes a task to tasks.json (executed later by the
//                EXISTING executor node, unchanged)
//   aiStep    -> one callModel() with context assembled from upstream outputs
//   output    -> collects upstream outputs into result.md
//
// Order: topological (cycles are an error). Nodes that depend on an agentTask
// (directly or transitively) run AFTER the task-execution phase so they see
// real task outputs. A node with data.requiresApproval pauses the run at the
// existing human-approval checkpoint (run:approve / run:reject IPC).
import { callModel } from './adapters/index.js';
import { makeRetrospective } from './retrospective.js';
import { runExecutorTask } from './nodes/executor.js';

const DEFAULT_SYSTEM = {
  plan: [
    'ROLE: planner',
    'You are the planning step of an AI workflow.',
    'Produce a Markdown plan for the brief. Structure it as:',
    '# Plan\n\nGoal: <one line>\n\n## Steps\n1. <step>\n2. <step> ...',
    'Each step must be small, self-contained, and independently verifiable.',
    'Prefer 3-7 steps. Do not include anything except the plan.'
  ].join('\n'),
  execute: [
    'ROLE: executor',
    'You are an execution step in an AI workflow.',
    'Complete exactly the work described by the brief and upstream context.',
    'Produce the deliverable as Markdown.'
  ].join('\n'),
  verify: [
    'ROLE: verifier',
    'You are the verification step of an AI workflow.',
    'Check the upstream outputs against the brief. Produce a short Markdown',
    'report: a PASS/FAIL verdict line, then bullet points per check.'
  ].join('\n'),
  custom: [
    'ROLE: workflow step',
    'You are one step in an AI workflow. Follow your instructions and the',
    'upstream context. Produce the deliverable as Markdown.'
  ].join('\n')
};

// Kahn topological sort over the flow; throws on cycles.
export function topoSort(flow) {
  const indegree = new Map(flow.nodes.map(n => [n.id, 0]));
  const adj = new Map(flow.nodes.map(n => [n.id, []]));
  for (const e of flow.edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue; // dangling edge
    indegree.set(e.target, indegree.get(e.target) + 1);
    adj.get(e.source).push(e.target);
  }
  const queue = flow.nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== flow.nodes.length) {
    const stuck = flow.nodes.filter(n => !order.includes(n.id)).map(n => n.id);
    throw new Error(`Flow contains a cycle involving: ${stuck.join(', ')}`);
  }
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  return order.map(id => byId.get(id));
}

export class FlowRunner {
  constructor(store, config, onUpdate = () => {}) {
    this.store = store;
    this.config = config;
    this.onUpdate = onUpdate;
    this.gates = new Map(); // runId -> resolve(bool) for a pending approval
  }

  notify(runId) { this.onUpdate(runId); }
  owns(runId) { try { return Boolean(this.store.readMeta(runId)?.flowId); } catch { return false; } }

  start(flow) {
    const input = flow.nodes.find(n => n.type === 'input');
    const brief = input?.data?.text?.trim() || `Flow: ${flow.name}`;
    const runId = this.store.createRun(brief);
    const flowCopy = JSON.parse(JSON.stringify({ ...flow, builtin: undefined }));
    this.store.writeFlow(runId, flowCopy);
    this.store.writeMeta(runId, {
      ...this.store.readMeta(runId),
      flowId: flow.id,
      flowName: flow.name,
      nodeStatus: Object.fromEntries(flow.nodes.map(n => [n.id, 'pending']))
    });
    this.store.appendLog(runId, { event: 'flow_run_created', flowId: flow.id, nodes: flow.nodes.length, edges: flow.edges.length });
    this.notify(runId);
    this.execute(runId, flowCopy).catch(err => this.fail(runId, err));
    return runId;
  }

  approvePlan(runId) { this.resolveGate(runId, true); }
  rejectPlan(runId, reason = '') {
    this.store.appendLog(runId, { event: 'human_decision', decision: 'rejected', reason });
    this.resolveGate(runId, false);
  }
  resolveGate(runId, approved) {
    const resolve = this.gates.get(runId);
    if (!resolve) throw new Error('No pending approval for this run (flow runs cannot resume after an app restart).');
    this.gates.delete(runId);
    resolve(approved);
  }

  setNodeStatus(runId, nodeId, status, extra = {}) {
    const meta = this.store.readMeta(runId);
    this.store.writeMeta(runId, {
      ...meta, ...extra,
      nodeStatus: { ...meta.nodeStatus, [nodeId]: status },
      updatedAt: new Date().toISOString()
    });
    this.notify(runId);
  }

  async execute(runId, flow) {
    const order = topoSort(flow);

    // Nodes downstream of an agentTask must wait for the execution phase.
    const upstreamOf = id => flow.edges.filter(e => e.target === id).map(e => e.source);
    const afterTasks = new Set();
    for (const node of order) {
      if (upstreamOf(node.id).some(src =>
        afterTasks.has(src) || flow.nodes.find(n => n.id === src)?.type === 'agentTask')) {
        afterTasks.add(node.id);
      }
    }

    this.store.setStage(runId, 'execution');
    this.notify(runId);

    const taskIdByNode = new Map();
    let nextTaskNum = 1;

    // Phase 1: everything that doesn't need task outputs. agentTask nodes
    // contribute their task here; aiSteps run their model call.
    for (const node of order) {
      if (node.type !== 'agentTask' && afterTasks.has(node.id)) continue;
      if (!await this.gate(runId, node)) return; // rejected at a checkpoint
      await this.runNode(runId, flow, node, { taskIdByNode, nextTaskId: () => `task-${nextTaskNum++}` });
    }

    // Phase 2: run contributed tasks through the existing executor.
    const tasksDoc = this.store.readTasks(runId);
    for (const task of tasksDoc?.tasks ?? []) {
      const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
      this.setNodeStatus(runId, nodeId, 'active', { currentTaskId: task.id });
      const retro = await runExecutorTask(this.store, runId, task.id, this.config);
      this.setNodeStatus(runId, nodeId, retro.status === 'failed' ? 'failed' : 'done', { currentTaskId: null });
      if (retro.status === 'failed') {
        this.store.setStage(runId, 'failed', { error: `Task ${task.id} failed: ${retro.problems.join('; ')}` });
        this.notify(runId);
        return;
      }
    }

    // Phase 3: nodes that needed task outputs (downstream aiSteps, outputs).
    for (const node of order) {
      if (node.type === 'agentTask' || !afterTasks.has(node.id)) continue;
      if (!await this.gate(runId, node)) return;
      await this.runNode(runId, flow, node, { taskIdByNode });
    }

    this.store.setStage(runId, 'done', { currentTaskId: null });
    this.notify(runId);
  }

  // Optional human checkpoint before a node. Returns false when rejected.
  async gate(runId, node) {
    if (!node.data?.requiresApproval) return true;
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      this.store.setStage(runId, 'rejected', { pendingNodeId: null });
      this.setNodeStatus(runId, node.id, 'pending');
      return false;
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id });
    this.store.setStage(runId, 'execution', { pendingNodeId: null });
    this.notify(runId);
    return true;
  }

  // Upstream context: every incoming node's output, labeled by its title.
  upstreamContext(runId, flow, node, taskIdByNode) {
    const parts = [];
    for (const e of flow.edges.filter(e => e.target === node.id)) {
      const src = flow.nodes.find(n => n.id === e.source);
      if (!src) continue;
      const label = src.data?.title?.trim() || src.type;
      const content = src.type === 'agentTask'
        ? this.store.readTaskOutput(runId, taskIdByNode.get(src.id) ?? '')
        : src.type === 'input'
          ? src.data?.text
          : this.store.readNodeOutput(runId, src.id);
      if (content) parts.push(`--- ${label} (${src.id}) ---\n${content}`);
    }
    return parts;
  }

  async runNode(runId, flow, node, { taskIdByNode, nextTaskId }) {
    this.setNodeStatus(runId, node.id, 'active', { currentNodeId: node.id });

    if (node.type === 'input') {
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'input' });
      this.store.writeNodeOutput(runId, node.id, node.data?.text ?? '');
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    if (node.type === 'agentTask') {
      const taskId = nextTaskId();
      taskIdByNode.set(node.id, taskId);
      const upstream = flow.edges.filter(e => e.source && e.target === node.id).map(e => e.source);
      const inputs = ['prompt.md', ...upstream
        .map(srcId => {
          const src = flow.nodes.find(n => n.id === srcId);
          if (!src || src.type === 'input') return null;
          return src.type === 'agentTask' ? `${taskIdByNode.get(srcId)} output` : srcId;
        })
        .filter(Boolean)];
      const worker = node.data?.worker?.provider
        ? { provider: node.data.worker.provider, model: node.data.worker.model }
        : { provider: this.config.workers.executor.provider, model: this.config.workers.executor.model };
      const task = {
        id: taskId,
        title: node.data?.title || 'Task',
        goal: node.data?.goal || node.data?.title || '',
        inputs,
        constraints: node.data?.constraints ?? [],
        dependsOn: upstream.map(srcId => taskIdByNode.get(srcId)).filter(Boolean),
        worker,
        status: 'pending'
      };
      const tasksDoc = this.store.readTasks(runId) ?? { tasks: [] };
      tasksDoc.tasks.push(task);
      this.store.writeTasks(runId, tasksDoc);
      // Record the node -> task mapping in the run's flow copy for the UI.
      node.data = { ...node.data, taskId };
      this.store.writeFlow(runId, flow);
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'agentTask', taskId, worker });
      this.setNodeStatus(runId, node.id, 'queued');
      return;
    }

    if (node.type === 'aiStep') {
      const role = node.data?.role ?? 'custom';
      const worker = node.data?.worker?.provider ? node.data.worker : this.config.workers.executor;
      const apiKey = this.config.providerKeys?.[worker.provider];
      this.store.appendLog(runId, {
        event: 'node_start', node: node.id, type: 'aiStep', role,
        worker: { provider: worker.provider, model: worker.model }
      });
      const system = node.data?.system?.trim() || DEFAULT_SYSTEM[role] || DEFAULT_SYSTEM.custom;
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : ''
      ].filter(Boolean).join('\n\n');

      const result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt: userMsg });
      this.store.writeNodeOutput(runId, node.id, result.text.trim());
      if (role === 'plan') this.store.writePlan(runId, result.text.trim());
      const retro = makeRetrospective({
        node: node.id,
        status: 'success',
        confidence: 0.75,
        recommendation: `AI step "${node.data?.title || role}" completed by ${worker.provider}/${worker.model}.`,
        model: { provider: worker.provider, model: worker.model },
        usage: result.usage,
        durationMs: result.durationMs
      });
      this.store.writeRetrospective(runId, node.id, retro);
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    if (node.type === 'output') {
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'output' });
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const result = parts.length
        ? `# Result — ${flow.name}\n\n${parts.join('\n\n')}`
        : `# Result — ${flow.name}\n\n(no upstream outputs)`;
      this.store.writeNodeOutput(runId, node.id, result);
      this.store.writeResult(runId, result);
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    throw new Error(`Unknown node type "${node.type}" (node ${node.id})`);
  }

  fail(runId, err) {
    this.store.appendLog(runId, { event: 'flow_error', error: String(err?.stack ?? err) });
    const meta = this.store.readMeta(runId);
    const current = meta.currentNodeId;
    this.store.setStage(runId, 'failed', { error: String(err?.message ?? err) });
    if (current) this.setNodeStatus(runId, current, 'failed');
    this.notify(runId);
  }
}
