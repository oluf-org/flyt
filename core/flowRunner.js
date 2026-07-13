// Graph runner: executes an editable flow definition (core/flowstore.js) the
// same way pipeline.js executes the hardcoded linear sequence — through the
// RunStore, one file per artifact, a retrospective per node, everything in
// log.jsonl. This is the "graph walker over an editable workflow definition"
// extension point.
//
// Semantics per node type:
//   input     -> its text becomes prompt.md / the run brief
//   agentTask -> contributes a task to tasks.json and runs it (plus anything
//                it spawns via create_task) through the EXISTING executor
//   aiStep    -> one callModel() with context assembled from upstream outputs
//   output    -> collects upstream outputs into result.md
//
// Scheduling is a dynamic topological walk: after every wave the runner
// re-derives "which nodes are ready" from the current flow. That is what
// lets a plan-eval node materialize new nodes mid-run (they join the walk),
// and lets step-eval verdicts requeue an upstream node before continuing.
// Independent aiSteps run concurrently (bounded by config.maxParallel,
// default 4); gates, plan-eval, and executor tasks stay sequential.
//
// Reflective-pattern support (see FLOW_NODES.md for the contracts):
//   plan-eval -> strict JSON contract parsed by core/planEval.js; valid nodes
//                are materialized into the run's flow.json with provenance
//   step-eval -> structured verdict: pass | retry (bounded, with enriched
//                retry-for-<node>.md guidance) | escalate (human gate)
//   stitch    -> fixTasks[] routed through the existing create_task tool
import { callModel } from './adapters/index.js';
import { makeRetrospective } from './retrospective.js';
import { runExecutorTask } from './nodes/executor.js';
import { executeTool } from './tools/index.js';
import { parsePlanEval, parseStepEvalVerdict, parseStitchDirectives } from './planEval.js';
import { createNodeFromTemplate, getTemplate } from '../src/flowTypes.js';
import { layoutPositions } from '../src/flowLayout.js';

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
  ].join('\n'),

  // === Polished prompts for the documented standard example nodes (see FLOW_NODES.md) ===
  'plan-start': [
    'ROLE: plan-start',
    'You are the Start node of an advanced planning flowchart.',
    'Given the user prompt, produce ONLY a structured tasks.md.',
    'Every task must be well-defined and independently verifiable.',
    'CRITICAL: for every task include a "Context files:" section.',
    'Each listed file must include a short description of *exactly* what part is needed.',
    'The goal is to give later steps the smallest possible context.',
    'Also assign a Category from: Code general, Code design, documentation, Test-creation.',
    'Suggest a template name from the known catalog (plan-eval, code-design-step, etc.).',
    'Format strictly as shown in the example in your instructions.'
  ].join('\n'),
  'plan-eval': [
    'ROLE: plan-eval',
    'You are the Plan Evaluation node. Read the tasks.md from the previous step.',
    'Respond with ONE ```json block satisfying this STRICT contract — invalid output is',
    'rejected and NO nodes are created:',
    '{',
    '  "nodes": [{',
    '    "id": "<unique; letters/digits/_/- only>",',
    '    "template": "<code-general-step | code-design-step | documentation-step | test-creation-step>",',
    '    "taskRef": "task-N",',
    '    "category": "<Code general | Code design | documentation | Test-creation>",',
    '    "title": "<short>", "goal": "<fully self-describing>",',
    '    "dependsOn": ["<id or taskRef of a prerequisite generated node>"],',
    '    "contextSpec": { "files": [{ "path": "<file>", "description": "<exactly which part is needed>" }] }',
    '  }],',
    '  "parallelGroups": [["task-1","task-2"],["task-3"]],',
    '  "categories": { "task-1": "Code design" },',
    '  "summary": "<one line>"',
    '}',
    'Every node MUST have id + template. parallelGroups are sequential waves used for',
    'ordering when dependsOn is omitted. Keep every contextSpec minimal — that is the point.'
  ].join('\n'),
  'step-eval': [
    'ROLE: step-eval',
    'You evaluate the output of the immediately preceding work node.',
    'Note any changes that would affect downstream work.',
    'End your report with ONE ```json block:',
    '{ "verdict": "pass" | "retry" | "escalate", "reason": "<one line>", "guidance": "<required for retry: what to do differently>" }',
    'Use "retry" when a re-attempt with better guidance would likely fix the problem;',
    'use "escalate" when a human must decide. Anything without a valid block counts as pass.'
  ].join('\n'),
  stitch: [
    'ROLE: stitch',
    'You are the Stitch node. Review all upstream work outputs.',
    'Decide if they fit together coherently.',
    'Make small fixes yourself (describe them).',
    'Produce a stitch-report.',
    'If larger fixes are required, end with ONE ```json block:',
    '{ "fixTasks": [{ "title": "<short>", "goal": "<fully self-describing>", "constraints": [], "dependsOn": [] }] }',
    'Each entry becomes a real executor task run before the flow continues.',
    'Omit the block (or emit "fixTasks": []) when nothing is needed.'
  ].join('\n'),
  'final-eval': [
    'ROLE: final-eval',
    'You are the final evaluation node.',
    'Compare the completed work against the original prompt and the tasks.md / plan-eval.',
    'In your output (final-eval.md style) explicitly list:',
    '- Completeness',
    '- Differences from the original plan (with locations and reasoning)',
    'Be honest and specific.'
  ].join('\n')
};

// Unified worker resolution for aiStep AND agentTask nodes:
//   1. an explicit worker set on the node wins,
//   2. otherwise the node's category picks from config.categoryWorkers
//      (the plan-eval pattern: category drives model selection),
//   3. otherwise the configured executor default.
export function resolveWorker(node, config) {
  const w = node?.data?.worker;
  if (w?.provider && w?.model) return { provider: w.provider, model: w.model };
  const cat = node?.data?.category;
  const pref = cat ? config.categoryWorkers?.[cat] : null;
  if (pref?.provider && pref?.model) return { provider: pref.provider, model: pref.model };
  const d = config.workers.executor;
  return { provider: d.provider, model: d.model };
}

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
    if (resolve) {
      this.gates.delete(runId);
      resolve(approved);
      return;
    }
    // No live gate (the app restarted while the run was paused): the gate
    // state lives in meta.json (stage awaiting_approval + pendingNodeId +
    // pendingGateKind), so resume the run from its persisted file state.
    this.resumeFromGate(runId, approved);
  }

  // Resume a flow run that was paused at an approval gate when the app died.
  // completed/taskIdByNode are rebuilt from meta.nodeStatus and flow.json in
  // execute(); retry budgets reset (they are bounded either way).
  resumeFromGate(runId, approved) {
    const meta = this.store.readMeta(runId);
    if (!meta?.flowId || meta.stage !== 'awaiting_approval') {
      throw new Error('No pending approval for this run.');
    }
    const flow = this.store.readFlow(runId);
    if (!flow) throw new Error(`Run ${runId} has no flow.json; cannot resume.`);
    const nodeId = meta.pendingNodeId;
    const kind = meta.pendingGateKind ?? 'pre';

    if (!approved) {
      this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
      if (nodeId) this.setNodeStatus(runId, nodeId, kind === 'escalation' ? 'failed' : 'pending');
      this.notify(runId);
      return;
    }

    this.store.appendLog(runId, {
      event: 'human_decision', decision: 'approved', node: nodeId,
      context: kind === 'escalation' ? 'step-eval escalation (resumed after restart)' : 'checkpoint (resumed after restart)'
    });
    const extra = { pendingNodeId: null, pendingGateKind: null };
    if (kind === 'pre' && nodeId) {
      // Remember the decision so the pre-node gate() doesn't pause again on
      // the resumed walk.
      extra.approvedGates = [...(meta.approvedGates ?? []), nodeId];
    }
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), ...extra });
    if (kind === 'escalation' && nodeId) this.setNodeStatus(runId, nodeId, 'done');
    this.execute(runId, flow, true).catch(err => this.fail(runId, err));
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

  async execute(runId, flow, resume = false) {
    this.store.setStage(runId, 'execution');
    this.notify(runId);

    // Next free task-N id, derived from tasks.json so ids never collide with
    // tasks spawned by create_task (tool calls or stitch fix tasks).
    const nextTaskId = () => {
      const doc = this.store.readTasks(runId) ?? { tasks: [] };
      const maxN = doc.tasks.reduce((m, t) =>
        Math.max(m, Number((String(t.id).match(/^task-(\d+)$/) ?? [])[1] ?? 0)), 0);
      return `task-${maxN + 1}`;
    };
    const opts = { taskIdByNode: new Map(), nextTaskId, retryBudget: new Map() };
    const completed = new Set();

    // Resuming from persisted state (after an app restart): completed nodes
    // come from meta.nodeStatus, and agentTask -> task mappings from the
    // taskIds recorded in the run's flow.json.
    if (resume) {
      const meta = this.store.readMeta(runId);
      for (const n of flow.nodes) {
        if (meta.nodeStatus?.[n.id] === 'done') completed.add(n.id);
        if (n.type === 'agentTask' && n.data?.taskId) opts.taskIdByNode.set(n.id, n.data.taskId);
      }
      this.store.appendLog(runId, { event: 'flow_run_resumed', completed: completed.size, total: flow.nodes.length });
    }

    // Dynamic topological walk: readiness is recomputed after every wave so
    // nodes materialized by plan-eval mid-run join the schedule, and nodes a
    // step-eval sends back for retry (postProcess requeue) re-enter it.
    const maxParallel = Math.max(1, Number(this.config.maxParallel ?? 4));
    for (;;) {
      const nodesById = new Map(flow.nodes.map(n => [n.id, n]));
      const order = topoSort(flow); // also validates: throws on cycles
      const ready = order.filter(n => !completed.has(n.id) &&
        flow.edges.every(e =>
          e.target !== n.id || completed.has(e.source) || !nodesById.has(e.source)));
      if (!ready.length) break;

      // Wave selection: independent aiSteps that neither mutate shared run
      // state (plan-eval rewrites the flow, agentTask appends to tasks.json)
      // nor pause at a gate run concurrently; everything else runs alone.
      const parallelSafe = n => n.type === 'aiStep'
        && (n.data?.role ?? 'custom') !== 'plan-eval'
        && !n.data?.requiresApproval;
      const safe = ready.filter(parallelSafe);
      const batch = safe.length > 1 ? safe.slice(0, maxParallel) : [ready[0]];

      if (batch.length > 1) {
        this.store.appendLog(runId, { event: 'wave_start', nodes: batch.map(n => n.id) });
        const results = await Promise.allSettled(batch.map(n => this.runNode(runId, flow, n, opts)));
        batch.forEach((n, i) => { if (results[i].status === 'fulfilled') completed.add(n.id); });
        const rejected = results.find(r => r.status === 'rejected');
        if (rejected) throw rejected.reason;
        for (let i = 0; i < batch.length; i++) {
          if (!await this.applyPost(runId, flow, batch[i], results[i].value, opts, completed)) return;
        }
        continue;
      }

      const node = batch[0];
      if (!await this.gate(runId, node)) return; // rejected at a checkpoint
      const outcome = await this.runNode(runId, flow, node, opts);
      if (node.type === 'agentTask') {
        // Run the contributed task (and anything it spawns via create_task)
        // through the existing executor before anything downstream.
        if (!await this.runPendingTasks(runId, opts.taskIdByNode)) return;
      }
      completed.add(node.id);
      if (!await this.applyPost(runId, flow, node, outcome, opts, completed)) return;
    }

    this.store.setStage(runId, 'done', { currentTaskId: null });
    this.notify(runId);
  }

  // Run every pending task in tasks.json through the executor. Returns false
  // (and fails the run) when a task fails.
  async runPendingTasks(runId, taskIdByNode) {
    let task;
    while ((task = this.store.readTasks(runId)?.tasks.find(t => t.status === 'pending'))) {
      const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
      if (nodeId) this.setNodeStatus(runId, nodeId, 'active', { currentTaskId: task.id });
      const retro = await runExecutorTask(this.store, runId, task.id, this.config);
      if (nodeId) this.setNodeStatus(runId, nodeId, retro.status === 'failed' ? 'failed' : 'done', { currentTaskId: null });
      if (retro.status === 'failed') {
        this.store.setStage(runId, 'failed', { error: `Task ${task.id} failed: ${retro.problems.join('; ')}` });
        this.notify(runId);
        return false;
      }
    }
    return true;
  }

  // React to a node's structured outcome (stitch fix tasks, step-eval
  // verdicts) and fold the result back into the scheduler's bookkeeping:
  // a step-eval retry un-completes the target + eval nodes so the main walk
  // re-runs them with normal status handling. Returns false to stop the run.
  async applyPost(runId, flow, node, outcome, opts, completed) {
    const post = await this.postProcess(runId, flow, node, outcome, opts);
    if (!post.ok) return false;
    for (const id of post.requeue ?? []) {
      completed.delete(id);
      this.setNodeStatus(runId, id, 'pending');
    }
    return true;
  }

  // Returns { ok, requeue?: nodeIds[] }.
  async postProcess(runId, flow, node, outcome, opts) {
    if (outcome?.fixTasks?.length) {
      for (const ft of outcome.fixTasks) {
        const rec = await executeTool('create_task', ft, {
          store: this.store, runId, taskId: node.id,
          defaultWorker: this.config.workers.executor
        });
        this.store.appendLog(runId, {
          event: 'stitch_fix_task', node: node.id,
          ok: rec.ok, created: rec.result?.created, error: rec.error
        });
      }
      if (!await this.runPendingTasks(runId, opts.taskIdByNode)) return { ok: false };
    }
    if (outcome?.stepEval) return this.handleStepEval(runId, flow, node, outcome.stepEval, opts);
    return { ok: true };
  }

  // Act on a structured step-eval verdict:
  //   pass     -> continue
  //   retry    -> bounded re-run of the evaluated upstream node with the
  //               guidance persisted as retry-for-<node>.md, then re-evaluate.
  //               Implemented as a requeue: the target and this eval node are
  //               un-completed so the main walk re-runs both in order (no
  //               recursion, normal scheduler status bookkeeping).
  //   escalate -> pause at the human approval gate (approve = continue)
  // Returns { ok, requeue? }.
  async handleStepEval(runId, flow, node, evalResult, opts) {
    const { verdict, reason, guidance } = evalResult;
    if (verdict === 'pass') return { ok: true };

    // The evaluated node: the last upstream work node (aiStep doing real work
    // or an agentTask) feeding this step-eval.
    const evalRoles = new Set(['plan-start', 'plan-eval', 'step-eval', 'stitch', 'final-eval', 'plan', 'verify']);
    const upstream = flow.edges.filter(e => e.target === node.id)
      .map(e => flow.nodes.find(n => n.id === e.source))
      .filter(Boolean);
    const target = upstream.filter(n =>
        n.type === 'agentTask' || (n.type === 'aiStep' && !evalRoles.has(n.data?.role ?? 'custom'))).pop()
      ?? upstream.filter(n => n.type === 'aiStep' || n.type === 'agentTask').pop();

    const maxRetries = Math.max(0, Number(node.data?.maxRetries ?? 1));
    const used = opts.retryBudget.get(node.id) ?? 0;

    if (verdict === 'retry' && target && used < maxRetries) {
      opts.retryBudget.set(node.id, used + 1);
      const guidanceText = [
        `# Retry guidance from ${node.data?.title || node.id} (attempt ${used + 1} of ${maxRetries})`,
        '',
        `Reason the previous attempt was rejected: ${reason || '(none given)'}`,
        '',
        guidance || '(no specific guidance — address the stated reason)'
      ].join('\n');
      this.store.writeNodeOutput(runId, `retry-for-${target.id}`, guidanceText);
      this.store.appendLog(runId, { event: 'step_eval_retry', node: node.id, target: target.id, attempt: used + 1, reason });

      if (target.type === 'agentTask') {
        // Reset the node's task to pending with the guidance as an extra
        // input; the requeued walk runs it through the executor again.
        const doc = this.store.readTasks(runId);
        const t = doc?.tasks.find(t => t.id === opts.taskIdByNode.get(target.id));
        if (t) {
          t.status = 'pending';
          if (!t.inputs.includes(`retry-for-${target.id}`)) t.inputs.push(`retry-for-${target.id}`);
          this.store.writeTasks(runId, doc);
        }
      }
      // Un-complete the work node and this eval node: the scheduler re-runs
      // the target (which picks up retry-for-<id>.md), then re-evaluates.
      return { ok: true, requeue: [target.id, node.id] };
    }

    // escalate — explicitly requested, retry budget exhausted, or no target.
    this.store.appendLog(runId, {
      event: 'step_eval_escalate', node: node.id, reason,
      retriesUsed: used, cause: verdict === 'retry' ? 'retry budget exhausted' : 'verdict'
    });
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id, pendingGateKind: 'escalation' });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
      this.setNodeStatus(runId, node.id, 'failed');
      this.notify(runId);
      return { ok: false };
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id, context: 'step-eval escalation' });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null });
    this.setNodeStatus(runId, node.id, 'done');
    return { ok: true };
  }

  // Optional human checkpoint before a node. Returns false when rejected.
  async gate(runId, node) {
    if (!node.data?.requiresApproval) return true;
    // Already approved before a restart (see resumeFromGate): don't re-pause.
    if (this.store.readMeta(runId).approvedGates?.includes(node.id)) return true;
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id, pendingGateKind: 'pre' });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
      this.setNodeStatus(runId, node.id, 'pending');
      return false;
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null });
    this.notify(runId);
    return true;
  }

  // Upstream context: every incoming node's output, labeled by its title.
  // When the target node has a contextSpec, we build a *minimal* context using only
  // the explicitly listed files + the per-file descriptions the planner provided.
  // This directly implements "do not use any more context than necessary".
  upstreamContext(runId, flow, node, taskIdByNode) {
    const spec = node.data?.contextSpec;
    if (spec && Array.isArray(spec.files) && spec.files.length) {
      return this.buildMinimalContext(runId, node);
    }

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

  // Resolve one contextSpec path against the run's artifacts, in order:
  // agent workspace file, well-known artifacts (prompt/plan/tasks.md), a node
  // output (nodes/<id>.md), a task output (tasks/<id>.md). Null = not found.
  resolveContextFile(runId, rawPath) {
    const p = String(rawPath).trim();
    try {
      const c = this.store.readWorkspaceFile(runId, p);
      if (c != null) return { content: c, source: `workspace/${p}` };
    } catch { /* path escapes the workspace — fall through to the other roots */ }
    const bare = p.replace(/^\.\//, '').replace(/\.md$/i, '');
    if (bare === 'prompt') return { content: this.store.readPrompt(runId), source: 'prompt.md' };
    if (bare === 'plan') {
      const c = this.store.readPlan(runId);
      if (c != null) return { content: c, source: 'plan.md' };
    }
    if (bare === 'tasks' || bare === 'tasks-md') {
      const c = this.store.readNodeOutput(runId, 'tasks-md');
      if (c != null) return { content: c, source: 'nodes/tasks-md.md' };
    }
    const n = this.store.readNodeOutput(runId, bare);
    if (n != null) return { content: n, source: `nodes/${bare}.md` };
    const t = this.store.readTaskOutput(runId, bare);
    if (t != null) return { content: t, source: `tasks/${bare}.md` };
    return null;
  }

  // Build minimal context from an explicit contextSpec on the node. Files
  // that cannot be resolved are surfaced explicitly (to the model AND the
  // audit log) instead of silently dropped.
  buildMinimalContext(runId, node) {
    const spec = node.data.contextSpec;
    const parts = [];
    for (const f of (spec.files || [])) {
      if (!f?.path) continue;
      const hit = this.resolveContextFile(runId, f.path);
      const desc = f.description ? ` (${f.description})` : '';
      if (hit) {
        parts.push(`--- ${f.path}${desc} [from ${hit.source}] ---\n${hit.content}`);
      } else {
        parts.push(`--- ${f.path}${desc} ---\n[NOT FOUND: no matching file in workspace/, nodes/, tasks/, or run artifacts. Proceed using the description above and state any assumptions you make.]`);
        this.store.appendLog(runId, { event: 'context_file_missing', node: node.id, path: f.path });
      }
    }
    if (parts.length === 0) return [];
    return [`MINIMAL CONTEXT (only explicitly declared files):\n\n${parts.join('\n\n')}`];
  }

  async runNode(runId, flow, node, opts) {
    const { taskIdByNode, nextTaskId } = opts;
    this.setNodeStatus(runId, node.id, 'active', { currentNodeId: node.id });

    if (node.type === 'input') {
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'input' });
      this.store.writeNodeOutput(runId, node.id, node.data?.text ?? '');
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    if (node.type === 'agentTask') {
      // Resuming after a restart: the node already contributed a task on a
      // previous pass — reuse it instead of queueing a duplicate.
      const priorId = node.data?.taskId;
      const priorDoc = priorId ? this.store.readTasks(runId) : null;
      const prior = priorDoc?.tasks.find(t => t.id === priorId);
      if (prior) {
        taskIdByNode.set(node.id, prior.id);
        if (prior.status !== 'done') {
          prior.status = 'pending';
          this.store.writeTasks(runId, priorDoc);
        }
        this.store.appendLog(runId, { event: 'node_resume', node: node.id, type: 'agentTask', taskId: prior.id });
        this.setNodeStatus(runId, node.id, 'queued');
        return;
      }
      const taskId = nextTaskId();
      taskIdByNode.set(node.id, taskId);
      const upstream = flow.edges.filter(e => e.source && e.target === node.id).map(e => e.source);
      const specFiles = (node.data?.contextSpec?.files ?? []).map(f => f?.path).filter(Boolean);
      const inputs = ['prompt.md', ...upstream
        .map(srcId => {
          const src = flow.nodes.find(n => n.id === srcId);
          if (!src || src.type === 'input') return null;
          return src.type === 'agentTask' ? `${taskIdByNode.get(srcId)} output` : srcId;
        })
        .filter(Boolean), ...specFiles];
      const worker = resolveWorker(node, this.config);
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
      const worker = resolveWorker(node, this.config);
      const apiKey = this.config.providerKeys?.[worker.provider];
      this.store.appendLog(runId, {
        event: 'node_start', node: node.id, type: 'aiStep', role,
        worker: { provider: worker.provider, model: worker.model }
      });
      const system = node.data?.system?.trim() || DEFAULT_SYSTEM[role] || DEFAULT_SYSTEM.custom;
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const retryGuidance = this.store.readNodeOutput(runId, `retry-for-${node.id}`);
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        node.data?.goal?.trim() ? `GOAL:\n${node.data.goal.trim()}` : '',
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : '',
        retryGuidance ? `RETRY GUIDANCE (a previous attempt was rejected — fix this):\n${retryGuidance}` : ''
      ].filter(Boolean).join('\n\n');

      // Incremental output: stream the partial text into the node's output
      // file (throttled) so the inspector shows work as it happens. onText
      // receives the full accumulated text, so each write is consistent.
      let lastFlush = 0;
      const onText = textSoFar => {
        const now = Date.now();
        if (now - lastFlush < 250) return;
        lastFlush = now;
        this.store.writeNodeOutput(runId, node.id, textSoFar);
        this.notify(runId);
      };

      let result;
      try {
        result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt: userMsg, onText });
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.store.appendLog(runId, { event: 'node_error', node: node.id, role, error: msg });
        this.store.writeRetrospective(runId, node.id, makeRetrospective({
          node: node.id,
          status: 'failed',
          problems: [msg],
          resolution: 'Node failed; run stopped and escalated to human.',
          confidence: 0,
          recommendation: `AI step "${node.data?.title || role}" failed calling ${worker.provider}/${worker.model} — check provider key/config, then retry the run.`,
          model: { provider: worker.provider, model: worker.model }
        }));
        this.setNodeStatus(runId, node.id, 'failed');
        throw new Error(`Node ${node.id} (${role}) failed: ${msg}`);
      }

      const outText = String(result.text ?? '').trim();
      this.store.writeNodeOutput(runId, node.id, outText);

      const outcome = {};
      const problems = [];

      // Special handling for the documented example nodes (FLOW_NODES.md)
      if (role === 'plan' || role === 'plan-start') {
        // Write the primary planning artifact as tasks.md (plus classic plan for compat)
        this.store.writePlan(runId, outText); // keep compat
        if (outText.includes('## task-') || outText.toLowerCase().includes('context files')) {
          this.store.writeNodeOutput(runId, 'tasks-md', outText);
        }
      }
      if (role === 'plan-eval') {
        // Persist a clean sidecar for downstream consumption / inspection
        this.store.writeNodeOutput(runId, 'plan-eval', outText);
        let mat = this.materializeGeneratedNodes(runId, flow, node, outText);
        if (!mat.ok) {
          // Real models sometimes emit malformed contract JSON: one bounded
          // re-ask that feeds the validation errors back before giving up.
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, mat.errors);
          if (fixed != null) {
            this.store.writeNodeOutput(runId, node.id, fixed);
            this.store.writeNodeOutput(runId, 'plan-eval', fixed);
            mat = this.materializeGeneratedNodes(runId, flow, node, fixed);
            if (mat.ok) {
              this.store.writeNodeOutput(runId, 'plan-eval-errors', [
                '# Plan-eval contract violations (resolved)',
                '',
                'The first attempt violated the contract; a re-ask with the validation errors produced a valid plan.'
              ].join('\n'));
            }
          }
        }
        if (!mat.ok) problems.push(...mat.errors);
        outcome.materialized = mat.ok && mat.created.length > 0;
        outcome.materializedCount = mat.created.length;
      }
      if (role === 'step-eval') {
        let verdictObj = parseStepEvalVerdict(outText);
        if (!verdictObj) {
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText,
            ['no ```json block with { "verdict": "pass" | "retry" | "escalate", "reason", "guidance" } found']);
          if (fixed != null) {
            verdictObj = parseStepEvalVerdict(fixed);
            if (verdictObj) this.store.writeNodeOutput(runId, node.id, fixed);
          }
        }
        if (verdictObj) {
          outcome.stepEval = verdictObj;
          this.store.appendLog(runId, { event: 'step_eval_verdict', node: node.id, ...verdictObj });
        } else {
          problems.push('step-eval emitted no structured verdict JSON block; treated as pass');
          this.store.appendLog(runId, { event: 'step_eval_no_verdict', node: node.id });
        }
      }
      if (role === 'stitch') {
        this.store.writeNodeOutput(runId, 'stitch-report', outText);
        const st = parseStitchDirectives(outText);
        if (st) {
          problems.push(...(st.errors ?? []));
          if (st.fixTasks.length) outcome.fixTasks = st.fixTasks;
        }
      }
      if (role === 'final-eval') {
        this.store.writeNodeOutput(runId, 'final-eval', outText);
      }

      const retro = makeRetrospective({
        node: node.id,
        status: problems.length ? 'partial' : 'success',
        problems,
        confidence: problems.length ? 0.4 : 0.75,
        recommendation: `AI step "${node.data?.title || role}" completed by ${worker.provider}/${worker.model}.`
          + (outcome.materializedCount ? ` Materialized ${outcome.materializedCount} generated node(s).` : '')
          + (outcome.stepEval ? ` Verdict: ${outcome.stepEval.verdict}.` : '')
          + (outcome.fixTasks ? ` Created ${outcome.fixTasks.length} fix task(s).` : ''),
        model: { provider: worker.provider, model: worker.model },
        usage: result.usage,
        durationMs: result.durationMs
      });
      this.store.writeRetrospective(runId, node.id, retro);
      this.setNodeStatus(runId, node.id, 'done');
      return outcome;
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

  // One bounded retry for structured-output roles: re-ask the SAME worker with
  // its rejected output and the concrete validation errors. Returns the new
  // output text, or null when the retry call itself failed (the caller then
  // falls back to its graceful-degradation path).
  async reAsk(runId, node, worker, apiKey, system, userMsg, badOutput, errors) {
    this.store.appendLog(runId, { event: 'structured_output_reask', node: node.id, errors });
    const prompt = [
      userMsg,
      `YOUR PREVIOUS ATTEMPT (rejected):\n${badOutput}`,
      `VALIDATION ERRORS — the previous output violated the required JSON contract:\n- ${errors.join('\n- ')}`,
      'Respond again in full, fixing every error above. Emit exactly ONE valid ```json block satisfying the contract.'
    ].join('\n\n');
    try {
      const result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt });
      return String(result.text ?? '').trim();
    } catch (err) {
      this.store.appendLog(runId, { event: 'structured_output_reask_failed', node: node.id, error: String(err?.message ?? err) });
      return null;
    }
  }

  fail(runId, err) {
    this.store.appendLog(runId, { event: 'flow_error', error: String(err?.stack ?? err) });
    const meta = this.store.readMeta(runId);
    const current = meta.currentNodeId;
    this.store.setStage(runId, 'failed', { error: String(err?.message ?? err) });
    // In a parallel wave currentNodeId is just the last node that went
    // active — it may have finished fine. Only flag it if it's still active.
    if (current && this.store.readMeta(runId).nodeStatus?.[current] === 'active') {
      this.setNodeStatus(runId, current, 'failed');
    }
    this.notify(runId);
  }

  // Materialize the nodes a plan-eval step declared (strict contract in
  // core/planEval.js): create real node objects from NODE_TEMPLATES, wire
  // them between the plan-eval node and its downstream targets, and persist
  // the updated flow.json so they appear live on the canvas with provenance.
  // Contract violations reject the whole document: they are written to
  // nodes/plan-eval-errors.md + log.jsonl and the run continues without
  // generated nodes (graceful failure).
  materializeGeneratedNodes(runId, flow, planEvalNode, evalOutputText) {
    const parsed = parsePlanEval(evalOutputText);
    if (!parsed.ok) {
      this.store.writeNodeOutput(runId, 'plan-eval-errors', [
        '# Plan-eval contract violations',
        '',
        'The plan-eval output did not satisfy the strict JSON contract; no nodes were materialized.',
        '',
        ...parsed.errors.map(e => `- ${e}`)
      ].join('\n'));
      this.store.appendLog(runId, { event: 'materialize_failed', fromNode: planEvalNode.id, errors: parsed.errors });
      return { ok: false, errors: parsed.errors, created: [] };
    }

    const existing = new Set(flow.nodes.map(n => n.id));
    const specs = parsed.plan.nodes.filter(s => {
      if (existing.has(s.id)) {
        this.store.appendLog(runId, { event: 'materialize_skip', fromNode: planEvalNode.id, node: s.id, reason: 'id already exists in flow' });
        return false;
      }
      return true;
    });
    if (!specs.length) return { ok: true, errors: [], created: [] };

    // Both a spec's id and its taskRef name the generated node in dependsOn /
    // parallelGroups references.
    const idMap = new Map();
    for (const s of specs) {
      idMap.set(s.id, s.id);
      if (s.taskRef) idMap.set(s.taskRef, s.id);
    }

    // Ordering between generated nodes: explicit dependsOn wins; otherwise
    // consecutive parallelGroups form sequential waves.
    const depsFor = new Map(specs.map(s => [s.id, new Set()]));
    let usedExplicit = false;
    for (const s of specs) {
      for (const d of s.dependsOn ?? []) {
        const dep = idMap.get(d);
        if (dep && dep !== s.id) { depsFor.get(s.id).add(dep); usedExplicit = true; }
      }
    }
    if (!usedExplicit && Array.isArray(parsed.plan.parallelGroups)) {
      const waves = parsed.plan.parallelGroups
        .map(g => g.map(ref => idMap.get(ref)).filter(id => id && depsFor.has(id)));
      for (let i = 1; i < waves.length; i++) {
        for (const id of waves[i]) for (const prev of waves[i - 1]) depsFor.get(id).add(prev);
      }
    }

    // Reject dependency cycles among generated nodes before touching the flow.
    {
      const state = new Map(); // 1 = visiting, 2 = done
      const cyclic = function visit(id) {
        if (state.get(id) === 1) return true;
        if (state.get(id) === 2) return false;
        state.set(id, 1);
        for (const d of depsFor.get(id)) if (visit(d)) return true;
        state.set(id, 2);
        return false;
      };
      if (specs.some(s => cyclic(s.id))) {
        const errors = ['dependsOn: generated nodes form a dependency cycle; nothing was materialized'];
        this.store.writeNodeOutput(runId, 'plan-eval-errors', `# Plan-eval contract violations\n\n- ${errors[0]}`);
        this.store.appendLog(runId, { event: 'materialize_failed', fromNode: planEvalNode.id, errors });
        return { ok: false, errors, created: [] };
      }
    }

    const created = [];
    for (const s of specs) {
      const tmpl = getTemplate(s.template);
      // A generated node without an explicit contextSpec at least gets the
      // task list, keeping "minimal declared context" the default.
      const contextSpec = s.contextSpec ?? (s.taskRef
        ? { files: [{ path: 'tasks-md', description: `The full task list from plan-start; only ${s.taskRef} is this node's assignment.` }] }
        : undefined);
      created.push(createNodeFromTemplate(s.template, {
        id: s.id,
        position: { x: 0, y: 0 }, // real position assigned by the layout pass below
        data: {
          title: s.title || (s.taskRef ? `${tmpl.label} (${s.taskRef})` : tmpl.label),
          goal: s.goal || (s.taskRef ? `Complete ${s.taskRef} exactly as defined in tasks.md.` : ''),
          ...(s.category ? { category: s.category } : {}),
          ...(contextSpec ? { contextSpec } : {}),
          ...(s.taskRef ? { taskRef: s.taskRef } : {}),
          generatedBy: planEvalNode.id
        }
      }));
    }

    // Wiring: roots hang off the plan-eval node; internal dependsOn edges;
    // leaves feed the plan-eval node's original downstream targets (stitch /
    // final-eval / output in the documented pattern).
    const downstreamTargets = flow.edges.filter(e => e.source === planEvalNode.id).map(e => e.target);
    const dependedOn = new Set();
    depsFor.forEach(set => set.forEach(id => dependedOn.add(id)));
    const edges = [];
    for (const n of created) {
      const deps = [...depsFor.get(n.id)];
      if (deps.length) {
        for (const d of deps) edges.push({ id: `gen-e-${d}-${n.id}`, source: d, target: n.id, generatedBy: planEvalNode.id });
      } else {
        edges.push({ id: `gen-e-${planEvalNode.id}-${n.id}`, source: planEvalNode.id, target: n.id, generatedBy: planEvalNode.id });
      }
      if (!dependedOn.has(n.id)) {
        for (const t of downstreamTargets) edges.push({ id: `gen-e-${n.id}-${t}`, source: n.id, target: t, generatedBy: planEvalNode.id });
      }
    }

    flow.nodes.push(...created);
    flow.edges.push(...edges);
    // Re-layout the run's display copy so generated nodes slot into clean
    // dependency layers instead of overlapping the authored ones. This only
    // touches flow.json inside the run dir — never the saved flow definition.
    const pos = layoutPositions(flow);
    for (const n of flow.nodes) n.position = pos.get(n.id) ?? n.position;
    this.store.writeFlow(runId, flow);
    const meta = this.store.readMeta(runId);
    this.store.writeMeta(runId, {
      ...meta,
      nodeStatus: { ...meta.nodeStatus, ...Object.fromEntries(created.map(n => [n.id, 'pending'])) }
    });
    this.store.appendLog(runId, {
      event: 'materialized_nodes',
      fromNode: planEvalNode.id,
      nodes: created.map(n => ({ id: n.id, template: n.data.template, category: n.data.category ?? null })),
      edges: edges.length
    });
    this.notify(runId);
    return { ok: true, errors: [], created };
  }
}
