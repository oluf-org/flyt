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
// Independent aiSteps AND agentTasks run concurrently (bounded by
// config.maxParallel, default 4); gates, plan-eval, and tool-gated tasks
// stay sequential. Queued agent tasks are claimed atomically out of
// tasks.json and drained with the same bound (see runPendingTasks).
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
import { Workspace } from './workspace.js';
import { loadSkills, withSkillsSection } from './skills.js';
import { createWriteLedger } from './writeLedger.js';
import { executeTool } from './tools/index.js';
import { parsePlanEval, parseStepEvalVerdict, parseStitchDirectives, extractJson } from './planEval.js';
import { createNodeFromTemplate, getTemplate, resolveFlow, resolveInstance, primaryPort } from '../src/flowTypes.js';
import { layoutPositions, containerLayout } from '../src/flowLayout.js';
import { lintFlow, RUNTIME_RULES } from './flowlang/lint.js';

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
  orchestrate: [
    'ROLE: orchestrate',
    'You are an Orchestrator node. From the brief and the upstream task list,',
    'decide the complete set of work nodes needed and respond with ONE ```json',
    'block satisfying the STRICT plan contract — invalid output is rejected and',
    'the orchestrator fails:',
    '{',
    '  "nodes": [{',
    '    "id": "<unique; letters/digits/_/- only>",',
    '    "template": "<code-general-step | code-design-step | documentation-step | test-creation-step>",',
    '    "taskRef": "task-N",',
    '    "category": "<Code general | Code design | documentation | Test-creation>",',
    '    "title": "<short>", "goal": "<fully self-describing>",',
    '    "dependsOn": ["<id of a prerequisite node>"],',
    '    "contextSpec": { "files": [{ "path": "<file>", "description": "<exactly which part is needed>" }] }',
    '  }],',
    '  "parallelGroups": [["task-1","task-2"],["task-3"]],',
    '  "summary": "<one line>"',
    '}',
    'The nodes you declare are created inside you and run AUTOMATICALLY, without',
    'any human review — every goal must be fully self-describing, and every',
    'contextSpec minimal. Independent nodes run in parallel; use dependsOn (or',
    'parallelGroups as sequential waves) only where order truly matters.'
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

// How often a token stream may reach the disk and the renderer. Every flush is
// a file write plus an IPC push, and adapters call onText per chunk — at real
// token rates that is hundreds of calls a second. 250ms still reads as live.
const STREAM_FLUSH_MS = 250;

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

// Stages a run can't continue from: the walk is over, one way or another.
export const TERMINAL_STAGES = new Set(['done', 'failed', 'rejected']);

export class FlowRunner {
  constructor(store, config, onUpdate = () => {}, nodeStore = null) {
    this.store = store;
    this.config = config;
    this.onUpdate = onUpdate;
    this.nodeStore = nodeStore; // Node Library (template defaults for instances)
    this.gates = new Map(); // runId -> resolve(bool) for a pending approval
    // Runs this process is currently walking. Process state, not file state:
    // it's exactly what's lost in a crash, which is what makes an interrupted
    // run identifiable (see reconcileInterrupted).
    this.live = new Set();
  }

  notify(runId) { this.onUpdate(runId); }
  owns(runId) { try { return Boolean(this.store.readMeta(runId)?.flowId); } catch { return false; } }

  // Build an onText handler (the adapter contract in adapters/index.js) that
  // mirrors partial model output into the run's files as it arrives, so a live
  // run is watchable rather than silent until a node completes (D10, V1 task 8).
  // Throttled to STREAM_FLUSH_MS. Dropping chunks is safe precisely because
  // onText hands over the FULL text so far rather than a delta: every flush is
  // a complete prefix, the next supersedes it, and the caller's write once the
  // call returns is authoritative.
  streamInto(runId, write) {
    let lastFlush = 0;
    return (textSoFar, opts) => {
      const now = Date.now();
      // A call's LAST emit is never dropped. Throttling rests on "the caller's
      // write afterwards is authoritative", which holds for a single-shot call
      // but not inside an agent loop: an intermediate turn is superseded by the
      // next turn, not by any write. Dropping its final state meant a tool call
      // showed as "→ write_file()" — the name arrives first and takes the flush
      // window, and the arguments, the part that says what the agent is doing,
      // streamed in behind it and were thrown away (V1 task 12).
      if (!opts?.final && now - lastFlush < STREAM_FLUSH_MS) return;
      lastFlush = now;
      write(textSoFar);
      this.notify(runId);
    };
  }

  // Log each transient-error retry the adapter backs off through (V1 task 11).
  // Without this a retry leaves no trace: a call that recovers reports only a
  // `retries` count, and one that exhausts its budget just throws, so "did
  // backoff actually run under real latency?" was answerable only by timing the
  // wall clock. Real 429s are routine, so this belongs in the audit log.
  retryLogger(runId, nodeId) {
    return info => this.store.appendLog(runId, { event: 'model_retry', node: nodeId, ...info });
  }

  // The run's bound project, or null when it has none / the folder is gone.
  // Never throws: a missing workspace degrades the run, it doesn't kill it.
  workspaceFor(runId) {
    const p = this.store.readMeta(runId)?.workspace;
    if (!p) return null;
    try { return new Workspace(p); }
    catch { return null; }
  }

  // Attach a node's template-declared skills to its system prompt, resolved
  // from the bound project (V1 task 10, core/skills.js). Logged either way:
  // skills silently doing nothing was the original bug, so an attached skill
  // that couldn't be found has to be visible in the audit log rather than
  // being indistinguishable from one that worked.
  applySkills(runId, nodeId, system, names) {
    if (!names?.length) return system;
    const { found, missing } = loadSkills(this.workspaceFor(runId), names);
    if (found.length) {
      this.store.appendLog(runId, { event: 'skills_injected', node: nodeId, skills: found.map(s => s.name) });
    }
    for (const m of missing) {
      this.store.appendLog(runId, { event: 'skill_missing', node: nodeId, skill: m.name, reason: m.reason });
    }
    return withSkillsSection(system, found);
  }

  // Start walking a flow, tracking liveness for its whole lifetime — including
  // while it sits paused at a gate (execute() is still awaiting, so the run is
  // live and must not be resumable from underneath itself).
  launch(runId, flow, resume = false) {
    this.live.add(runId);
    this.execute(runId, flow, resume)
      .catch(err => this.fail(runId, err))
      .finally(() => this.live.delete(runId));
  }

  // At startup nothing is live yet, so any run left in a non-terminal stage was
  // cut off by the app dying — mark it so the UI can offer Resume (D17, V1
  // task 7). awaiting_approval is deliberately excluded: those runs already
  // have a way back (approve/reject → resumeFromGate), and a tool gate must
  // stay abandonable rather than look resumable.
  reconcileInterrupted() {
    const marked = [];
    for (const runId of this.store.listRuns()) {
      let meta;
      try { meta = this.store.readMeta(runId); } catch { continue; }
      if (!meta?.flowId || meta.interrupted) continue;
      if (TERMINAL_STAGES.has(meta.stage) || meta.stage === 'awaiting_approval') continue;
      if (this.live.has(runId)) continue;
      this.store.writeMeta(runId, { ...meta, interrupted: true });
      this.store.appendLog(runId, { event: 'run_interrupted', stage: meta.stage });
      this.rewindInFlight(runId);
      marked.push(runId);
    }
    return marked;
  }

  // Rewind whatever was mid-flight when the process died — its call stack is
  // gone, so it has to run again. Done here (the moment we know the run is
  // dead) rather than at resume, so an interrupted run reads honestly the
  // instant it's reopened: nothing spins, because nothing is running.
  //   - node statuses that aren't 'done' go back to 'pending'
  //   - tasks stuck at 'running' return to the queue for re-claiming, including
  //     agent-spawned tasks that have no node of their own
  // Returns how many completed nodes were preserved. Idempotent.
  rewindInFlight(runId) {
    const doc = this.store.readTasks(runId);
    if (doc) {
      const requeued = doc.tasks.filter(t => t.status === 'running');
      if (requeued.length) {
        for (const t of requeued) t.status = 'pending';
        this.store.writeTasks(runId, doc);
        this.store.appendLog(runId, { event: 'tasks_requeued', tasks: requeued.map(t => t.id) });
      }
    }
    const meta = this.store.readMeta(runId);
    const nodeStatus = Object.fromEntries(Object.entries(meta.nodeStatus ?? {})
      .map(([id, s]) => [id, s === 'done' ? 'done' : 'pending']));
    this.store.writeMeta(runId, { ...meta, nodeStatus, currentTaskId: null, currentNodeId: null });
    this.notify(runId);
    return Object.values(nodeStatus).filter(s => s === 'done').length;
  }

  // Why this run can't be resumed, or null when it can.
  resumeBlocker(runId) {
    let meta;
    try { meta = this.store.readMeta(runId); } catch { return 'Run not found.'; }
    if (!meta?.flowId) return 'Only flow runs can be resumed.';
    if (this.live.has(runId)) return 'That run is already running.';
    if (meta.stage === 'awaiting_approval') return 'This run is paused at an approval gate — approve or reject it instead.';
    if (TERMINAL_STAGES.has(meta.stage)) return `This run already finished (${meta.stage}).`;
    if (!this.store.readFlow(runId)) return 'This run has no flow.json; it cannot be resumed.';
    return null;
  }

  // Resume a run the app died in the middle of (V1 task 7). Completed nodes are
  // NOT re-executed: execute(resume) rebuilds `completed` from meta.nodeStatus,
  // so the walk picks up exactly where it stopped. The rewind is normally
  // already done by reconcileInterrupted at startup; repeating it here is a
  // no-op that keeps resume correct on its own.
  resume(runId) {
    const blocker = this.resumeBlocker(runId);
    if (blocker) throw new Error(blocker);
    const flow = this.store.readFlow(runId);
    const kept = this.rewindInFlight(runId);
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), interrupted: false, error: null });
    this.store.appendLog(runId, { event: 'flow_run_resume_requested', keptCompleted: kept });
    this.notify(runId);
    this.launch(runId, flow, true);
    return runId;
  }

  // Start a run of a flow definition. Template instances are resolved
  // against the Node Library HERE, so the run's flow.json is a fully
  // self-contained snapshot (template edits never mutate past runs).
  // userInput becomes the content of the flow's User Input node for this run.
  // workspace (an absolute path to a bound project folder, already validated +
  // .llmflow/-provisioned by the caller) is recorded in meta.json so the run,
  // its tools, and the UI all know which real repo it operates on (D15).
  start(flow, { userInput = '', workspace = null } = {}) {
    // Pre-run gate (REFACTOR-PLAN §4): refuse to start a structurally invalid
    // flow. Only RUNTIME_RULES — shape rules (no-input etc.) stay author-time
    // lint concerns; the runner has always tolerated partial flows.
    const gate = lintFlow(flow, { templates: this.nodeStore?.listFull() ?? null, rules: RUNTIME_RULES });
    if (!gate.ok) {
      throw new Error(`Flow "${flow.name ?? flow.id}" failed validation:\n`
        + gate.errors.map(e => `- [${e.rule}] ${e.message}`).join('\n'));
    }
    const resolved = resolveFlow(flow, this.nodeStore?.listFull() ?? []);
    const flowCopy = JSON.parse(JSON.stringify({ ...resolved, builtin: undefined }));
    const input = flowCopy.nodes.find(n => n.type === 'input');
    if (input && userInput.trim()) input.data = { ...input.data, text: userInput.trim() };
    const brief = input?.data?.text?.trim() || `Flow: ${flow.name}`;
    const runId = this.store.createRun(brief);
    this.store.writeFlow(runId, flowCopy);
    this.store.writeMeta(runId, {
      ...this.store.readMeta(runId),
      flowId: flow.id,
      flowName: flow.name,
      ...(workspace ? { workspace } : {}),
      nodeStatus: Object.fromEntries(flow.nodes.map(n => [n.id, 'pending']))
    });
    this.store.appendLog(runId, { event: 'flow_run_created', flowId: flow.id, workspace: workspace ?? null, nodes: flow.nodes.length, edges: flow.edges.length });
    this.notify(runId);
    this.launch(runId, flowCopy);
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

    // A tool gate paused mid-executor; that call stack died with the app and
    // can't be resumed. Abort the task honestly rather than pretending to
    // approve/reject an in-flight tool call.
    if (kind === 'tool') {
      this.store.appendLog(runId, { event: 'tool_gate_abandoned', node: nodeId, reason: 'app restarted during tool approval' });
      this.store.setStage(runId, 'failed', {
        pendingNodeId: null, pendingGateKind: null, pendingToolCall: null,
        error: 'The app restarted while a tool call was awaiting approval; the task was aborted. Re-run the flow.'
      });
      if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      this.notify(runId);
      return;
    }

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
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), ...extra, interrupted: false });
    if (kind === 'escalation' && nodeId) this.setNodeStatus(runId, nodeId, 'done');
    this.launch(runId, flow, true);
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
      // Orchestrator children (managedBy) are run by their container's inline
      // sub-walk — the outer scheduler never picks them up.
      const ready = order.filter(n => !completed.has(n.id) && !n.data?.managedBy &&
        flow.edges.every(e =>
          e.target !== n.id || completed.has(e.source) || !nodesById.has(e.source)));
      if (!ready.length) break;

      // Wave selection: independent nodes that neither rewrite the flow
      // (plan-eval) nor pause at a gate run concurrently; everything else runs
      // alone. agentTask belongs here too (D7, V1 task 6): its runNode only
      // queues a task into tasks.json — a synchronous, therefore atomic,
      // append — and the queued tasks then execute in parallel below.
      const parallelSafe = n => !n.data?.requiresApproval && (
        (n.type === 'aiStep' && (n.data?.role ?? 'custom') !== 'plan-eval')
        || n.type === 'agentTask');
      const safe = ready.filter(parallelSafe);
      const batch = safe.length > 1 ? safe.slice(0, maxParallel) : [ready[0]];

      if (batch.length > 1) {
        this.store.appendLog(runId, { event: 'wave_start', nodes: batch.map(n => n.id) });
        const results = await Promise.allSettled(batch.map(n => this.runNode(runId, flow, n, opts)));
        batch.forEach((n, i) => { if (results[i].status === 'fulfilled') completed.add(n.id); });
        const rejected = results.find(r => r.status === 'rejected');
        if (rejected) throw rejected.reason;
        // agentTasks in the wave only queued their work; run the queue (itself
        // bounded-parallel) before anything downstream sees their outputs.
        if (batch.some(n => n.type === 'agentTask')
          && !await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return;
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
        if (!await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return;
      }
      completed.add(node.id);
      if (!await this.applyPost(runId, flow, node, outcome, opts, completed)) return;
    }

    this.store.setStage(runId, 'done', { currentTaskId: null });
    this.notify(runId);
  }

  // Atomically claim the next runnable pending task, or null when there is
  // none. The read-modify-write of tasks.json is fully SYNCHRONOUS, so Node
  // runs it to completion before any other continuation can interleave: two
  // concurrent schedulers can never claim the same task. Claiming flips the
  // task to 'running', which is also what drives multi-active task status in
  // the UI (V1 task 6).
  //
  // A task is runnable when every dependsOn is 'done' (an unknown id is
  // ignored rather than deadlocking) and `canClaim` accepts it.
  claimNextTask(runId, canClaim = () => true) {
    const doc = this.store.readTasks(runId);
    if (!doc) return null;
    const byId = new Map(doc.tasks.map(t => [t.id, t]));
    const task = doc.tasks.find(t => t.status === 'pending'
      && (t.dependsOn ?? []).every(d => !byId.has(d) || byId.get(d).status === 'done')
      && canClaim(t));
    if (!task) return null;
    task.status = 'running';
    this.store.writeTasks(runId, doc);
    this.store.appendLog(runId, { event: 'task_claimed', task: task.id, node: `executor:${task.id}` });
    return task;
  }

  // Run one already-claimed task to completion. Never rejects: the outcome
  // comes back as a record so the scheduler can keep draining the other
  // in-flight tasks instead of losing them to an exception.
  // `gate` is { node } when this task's tool calls must be approved (node is
  // only the pause's attribution target and may be null), or null when they
  // run unattended. The caller decides — see gateFor in runPendingTasks.
  async runClaimedTask(runId, task, taskIdByNode, flow, ledger, gate = null) {
    const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
    if (nodeId) this.setNodeStatus(runId, nodeId, 'active', { currentTaskId: task.id });
    const opts = {
      ledger,
      // Mirror the agent's reply into the task's output file as it streams, so
      // a long tool-using task is watchable instead of silent (V1 task 8). Each
      // agent turn restarts the text (see runAgent), so what shows is the turn
      // in progress — including the tool block it is about to ask approval for.
      // Parallel tasks each stream into their own tasks/<id>.md, so they can't
      // scribble over one another.
      onText: this.streamInto(runId, t => this.store.writeTaskOutput(runId, task.id, t)),
      onRetry: this.retryLogger(runId, `executor:${task.id}`),
      retry: this.config.retry,
      ...(gate ? { approveToolCall: call => this.toolGate(runId, gate.node, call) } : {})
    };
    ledger.begin(task.id);
    try {
      const retro = await runExecutorTask(this.store, runId, task.id, this.config, opts);
      if (nodeId) this.setNodeStatus(runId, nodeId, retro.status === 'failed' ? 'failed' : 'done');
      return { taskId: task.id, ok: retro.status !== 'failed', retro };
    } catch (err) {
      // runExecutorTask folds model/tool errors into a failed retrospective, so
      // reaching here means something unexpected threw. Mark the task failed so
      // it is never re-claimed and its dependents stay blocked.
      const doc = this.store.readTasks(runId);
      const t = doc?.tasks.find(t => t.id === task.id);
      if (t) { t.status = 'failed'; this.store.writeTasks(runId, doc); }
      this.store.appendLog(runId, { event: 'task_error', task: task.id, error: String(err?.message ?? err) });
      if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      return { taskId: task.id, ok: false, error: String(err?.message ?? err) };
    } finally {
      ledger.end(task.id);
    }
  }

  // Drain tasks.json through the executor with bounded parallelism (D7, V1
  // task 6): independent tasks run concurrently up to config.maxParallel.
  // Returns false (and fails the run) when a task fails.
  //
  // Two things stay serialized on purpose:
  //   - a gated task runs ALONE, because the gate promise (this.gates) is
  //     per-run — two tasks pausing at once would collide over it. Same reason
  //     the outer walk keeps gated nodes solo.
  //   - once a task fails we stop claiming, but still await the in-flight ones
  //     so no task keeps writing after the run is marked failed.
  async runPendingTasks(runId, taskIdByNode, flow = null) {
    const maxParallel = Math.max(1, Number(this.config.maxParallel ?? 4));
    const ledger = createWriteLedger();
    const nodeFor = task => {
      const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
      return nodeId && flow ? flow.nodes.find(n => n.id === nodeId) : null;
    };

    // Does this task's tool calls need approval? The flag lives on the TASK
    // (persisted when an agentTask node queues it, and inherited by anything
    // create_task spawns) rather than being re-derived from the node graph: a
    // spawned task has no node of its own, so reading the gate off the graph let
    // an agent delegate its destructive work to a child and have it run against
    // the real workspace unapproved. Tasks recorded before the flag existed fall
    // back to their node.
    const isGated = task => Boolean(task.approveToolCalls ?? nodeFor(task)?.data?.approveToolCalls);

    // The gate to run a claimed task under, or null when it is unattended. The
    // node is the pause's attribution target only: walk createdBy up to the
    // nearest ancestor that has one, so a spawned task pauses under the node
    // whose gate it inherited. Gating never depends on finding one — toolGate
    // takes a null node and simply skips the canvas highlight.
    const gateFor = task => {
      if (!isGated(task)) return null;
      const own = nodeFor(task);
      if (own) return { node: own };
      const byId = new Map((this.store.readTasks(runId)?.tasks ?? []).map(t => [t.id, t]));
      let t = byId.get(task.createdBy);
      for (let hops = 0; t && hops < 100; hops++) {
        const n = nodeFor(t);
        if (n) return { node: n };
        t = byId.get(t.createdBy);
      }
      return { node: null };
    };

    const running = new Map(); // taskId -> Promise<outcome>
    let failure = null;

    for (;;) {
      while (!failure && running.size < maxParallel) {
        // A gated task may only start when nothing else is in flight.
        const task = this.claimNextTask(runId, t => !isGated(t) || running.size === 0);
        if (!task) break;
        running.set(task.id, this.runClaimedTask(runId, task, taskIdByNode, flow, ledger, gateFor(task)));
        if (isGated(task)) break; // keep it alone until it settles
      }
      if (!running.size) break;
      if (running.size > 1) {
        this.store.appendLog(runId, { event: 'task_wave', tasks: [...running.keys()] });
      }
      const outcome = await Promise.race(running.values());
      running.delete(outcome.taskId);
      if (!outcome.ok && !failure) failure = outcome;
    }

    // The batch has drained; no task is current any more.
    const meta = this.store.readMeta(runId);
    if (meta?.currentTaskId) this.store.writeMeta(runId, { ...meta, currentTaskId: null });

    if (failure) {
      // A human tool-gate rejection already set stage 'rejected'; don't
      // clobber it with a generic failure.
      if (!failure.retro?.aborted) {
        const why = failure.retro ? failure.retro.problems.join('; ') : failure.error;
        this.store.setStage(runId, 'failed', { error: `Task ${failure.taskId} failed: ${why}` });
      }
      this.notify(runId);
      return false;
    }
    this.notify(runId);
    return true;
  }

  // Per-tool-call approval gate: pause the run before a gated task's
  // destructive tool call and wait for a human decision, reusing the same gate
  // promise + IPC as the pre-node gate. Approve -> the tool runs; reject ->
  // false (the agent loop throws an abort). The pending call is surfaced in
  // meta for the UI. `node` is the pause's attribution target and may be null
  // (a task that inherited its gate but maps to no node) — the pause itself
  // still happens; only the canvas highlight is skipped.
  async toolGate(runId, node, call) {
    const summary = call.tool === 'bash' ? call.args?.command : call.args?.path;
    const nodeId = node?.id ?? null;
    if (nodeId) this.setNodeStatus(runId, nodeId, 'waiting');
    this.store.appendLog(runId, { event: 'tool_gate_pause', node: nodeId, tool: call.tool, summary: summary ?? null });
    this.store.setStage(runId, 'awaiting_approval', {
      pendingNodeId: nodeId, pendingGateKind: 'tool',
      pendingToolCall: { tool: call.tool, summary: summary ?? null }
    });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      this.store.appendLog(runId, { event: 'tool_gate_decision', node: nodeId, tool: call.tool, decision: 'rejected' });
      this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null, pendingToolCall: null });
      if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      return false;
    }
    this.store.appendLog(runId, { event: 'tool_gate_decision', node: nodeId, tool: call.tool, decision: 'approved' });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null, pendingToolCall: null });
    if (nodeId) this.setNodeStatus(runId, nodeId, 'active');
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
      if (!await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return { ok: false };
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
      let content;
      if (src.type === 'agentTask') {
        content = this.store.readTaskOutput(runId, taskIdByNode.get(src.id) ?? '');
      } else if (src.type === 'input') {
        content = src.data?.text;
      } else {
        // The edge may pick a declared output port of the source. Auxiliary
        // ports live in nodes/<id>.<port>.md; the primary port (or an absent
        // sourceHandle) is the node's main output. A missing port artifact
        // falls back to the main output rather than dropping the edge.
        const port = e.sourceHandle;
        const aux = port && port !== primaryPort(src)
          ? this.store.readNodeOutput(runId, `${src.id}.${port}`)
          : null;
        content = aux ?? this.store.readNodeOutput(runId, src.id);
        if (port && aux) {
          parts.push(`--- ${label} (${src.id} · output: ${port}) ---\n${content}`);
          continue;
        }
      }
      if (content) parts.push(`--- ${label} (${src.id}) ---\n${content}`);
    }
    return parts;
  }

  // Resolve one contextSpec path against the run's artifacts, in order:
  // agent workspace file, well-known artifacts (prompt/plan/tasks.md), a node
  // output (nodes/<id>.md), a task output (tasks/<id>.md). Null = not found.
  resolveContextFile(runId, rawPath) {
    const p = String(rawPath).trim();
    // The BOUND PROJECT first. When a run is pointed at a real repo, a planner
    // declaring "Context files: src/types.ts" means that repo's file. This
    // resolved only against the run's own sandbox, so every contextSpec naming a
    // real project file came back [NOT FOUND] — the minimal-context mechanism
    // couldn't see the project it was aimed at (V1 task 12).
    const ws = this.workspaceFor(runId);
    if (ws) {
      try {
        const c = ws.readFile(p);
        if (c != null) return { content: c, source: `${p} (project)` };
      } catch { /* escapes the project root — fall through to the other roots */ }
    }
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
        this.store.appendLog(runId, {
          event: 'node_resume', node: node.id, type: 'agentTask',
          taskId: prior.id, taskStatus: prior.status
        });
        // The task already finished on the previous pass (the app died between
        // the task's last write and this node being marked done): the node's
        // work IS the task, so honor it as done instead of re-running it.
        if (prior.status === 'done') {
          this.setNodeStatus(runId, node.id, 'done');
          return;
        }
        prior.status = 'pending';
        this.store.writeTasks(runId, priorDoc);
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
        // Template/override instructions ride along as constraints so the
        // executor honors them without a schema change.
        ...(node.data?.instructions?.trim()
          ? { constraints: [...(node.data?.constraints ?? []), node.data.instructions.trim()] }
          : {}),
        // Tool availability comes from the node template (overridable per
        // workflow); undefined = the full registry.
        ...(Array.isArray(node.data?.tools) ? { tools: node.data.tools } : {}),
        // Skills ride on the task for the same reason tools do: the executor
        // runs from tasks.json alone and never sees the node. Resolved against
        // the bound project at execution time, not here (V1 task 10).
        ...(node.data?.skills?.length ? { skills: node.data.skills } : {}),
        // The gate travels with the task, not the node: create_task copies it
        // onto anything this task spawns, so delegated work can't slip past the
        // approval the node asked for (see gateFor in runPendingTasks).
        ...(node.data?.approveToolCalls ? { approveToolCalls: true } : {}),
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
      const system = this.applySkills(runId, node.id,
        node.data?.system?.trim() || DEFAULT_SYSTEM[role] || DEFAULT_SYSTEM.custom,
        node.data?.skills);
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const retryGuidance = this.store.readNodeOutput(runId, `retry-for-${node.id}`);
      // Planning roles learn from prior runs' retrospectives (historyDigest),
      // matching the classic pipeline's planner behavior.
      const history = (role === 'plan' || role === 'plan-start') ? this.store.historyDigest() : '';
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        node.data?.goal?.trim() ? `GOAL:\n${node.data.goal.trim()}` : '',
        node.data?.instructions?.trim() ? `EXTRA INSTRUCTIONS (from the node template / workflow):\n${node.data.instructions.trim()}` : '',
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : '',
        history ? `LESSONS FROM PREVIOUS RUNS (retrospective recommendations):\n${history}` : '',
        retryGuidance ? `RETRY GUIDANCE (a previous attempt was rejected — fix this):\n${retryGuidance}` : ''
      ].filter(Boolean).join('\n\n');

      // Incremental output: stream the partial text into the node's output file
      // so the inspector and the live panel show work as it happens.
      const onText = this.streamInto(runId, t => this.store.writeNodeOutput(runId, node.id, t));

      let result;
      try {
        result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt: userMsg, onText, onRetry: this.retryLogger(runId, node.id), retry: this.config.retry });
        // A call that comes back with nothing is not a success. Recording one as
        // success wrote a 0-byte artifact, marked the node done, and handed
        // emptiness to every downstream node — the run read as healthy the whole
        // way while producing nothing. Only ever seen against a real provider;
        // the mock always answers, which is why this survived to V1 task 11.
        if (!String(result.text ?? '').trim()) {
          throw new Error(`${worker.provider}/${worker.model} returned an empty response`);
        }
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
        // Auxiliary "summary" output port (see flowTypes ROLE_PORTS).
        const summary = extractJson(this.store.readNodeOutput(runId, node.id))?.summary;
        if (typeof summary === 'string' && summary.trim()) {
          this.store.writeNodeOutput(runId, `${node.id}.summary`, summary.trim());
        }
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
          // Auxiliary "verdict" output port: just the structured decision.
          this.store.writeNodeOutput(runId, `${node.id}.verdict`, JSON.stringify(verdictObj, null, 2));
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

    if (node.type === 'orchestrator') {
      return this.runOrchestrator(runId, flow, node, opts);
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

  // The Orchestrator container: one autonomous planning call decides the set
  // of work nodes (same strict contract as plan-eval, one bounded re-ask),
  // the nodes are materialized INSIDE the box (parentId + managedBy, never
  // gated), executed by an inline sub-walk (parallel waves for aiSteps,
  // sequential agent tasks), and every child's output is aggregated into the
  // orchestrator's primary "results" output — downstream nodes only ever see
  // the orchestrator itself. No human intervention anywhere in the loop.
  async runOrchestrator(runId, flow, node, opts) {
    const worker = resolveWorker(node, this.config);
    const apiKey = this.config.providerKeys?.[worker.provider];
    this.store.appendLog(runId, {
      event: 'node_start', node: node.id, type: 'orchestrator',
      worker: { provider: worker.provider, model: worker.model }
    });

    const failNode = (msg, problems = [msg]) => {
      this.store.writeRetrospective(runId, node.id, makeRetrospective({
        node: node.id,
        status: 'failed',
        problems,
        resolution: 'Orchestrator failed; run stopped and escalated to human.',
        confidence: 0,
        recommendation: `Orchestrator "${node.data?.title || node.id}" failed (${worker.provider}/${worker.model}). ${msg}`,
        model: { provider: worker.provider, model: worker.model }
      }));
      this.setNodeStatus(runId, node.id, 'failed');
      return new Error(`Orchestrator ${node.id} failed: ${msg}`);
    };

    // Resume support: children already materialized on a previous pass are
    // reused — the planning call is skipped and unfinished children re-run.
    let children = flow.nodes.filter(n => n.data?.managedBy === node.id);
    if (!children.length) {
      const system = this.applySkills(runId, node.id,
        node.data?.system?.trim() || DEFAULT_SYSTEM.orchestrate,
        node.data?.skills);
      const parts = this.upstreamContext(runId, flow, node, opts.taskIdByNode);
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        node.data?.goal?.trim() ? `GOAL:\n${node.data.goal.trim()}` : '',
        node.data?.instructions?.trim() ? `EXTRA INSTRUCTIONS (from the workflow):\n${node.data.instructions.trim()}` : '',
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : ''
      ].filter(Boolean).join('\n\n');

      // Stream the planning output into the "plan" sidecar as it arrives.
      const onText = this.streamInto(runId, t => this.store.writeNodeOutput(runId, `${node.id}.plan`, t));
      let result;
      try {
        result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt: userMsg, onText, onRetry: this.retryLogger(runId, node.id), retry: this.config.retry });
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.store.appendLog(runId, { event: 'node_error', node: node.id, role: 'orchestrate', error: msg });
        throw failNode(msg);
      }
      let outText = String(result.text ?? '').trim();
      this.store.writeNodeOutput(runId, `${node.id}.plan`, outText);

      const templateIds = this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : [];
      let parsed = parsePlanEval(outText, templateIds);
      if (!parsed.ok) {
        const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, parsed.errors);
        if (fixed != null) {
          const reparsed = parsePlanEval(fixed, templateIds);
          if (reparsed.ok) {
            parsed = reparsed;
            outText = fixed;
            this.store.writeNodeOutput(runId, `${node.id}.plan`, fixed);
          }
        }
      }
      // Unlike plan-eval (which degrades gracefully), creating nodes IS the
      // orchestrator's job — an invalid plan fails the node honestly.
      if (!parsed.ok) throw failNode('planning output violated the node contract', parsed.errors);

      const mat = this.materializeParsedNodes(runId, flow, node, parsed.plan, { parentId: node.id });
      if (!mat.ok || !mat.created.length) {
        throw failNode('no nodes could be materialized from the plan', mat.errors.length ? mat.errors : ['plan declared no new nodes']);
      }
      children = mat.created;

      // Auxiliary "summary" output port: the plan summary + node inventory.
      this.store.writeNodeOutput(runId, `${node.id}.summary`, [
        parsed.plan.summary ?? `${children.length} node(s) orchestrated.`,
        '',
        ...children.map(c => `- ${c.data?.title ?? c.id} (${c.id})`)
      ].join('\n'));
      this.store.appendLog(runId, { event: 'orchestrator_spawned', node: node.id, children: children.map(c => c.id) });
    } else {
      this.store.appendLog(runId, { event: 'node_resume', node: node.id, type: 'orchestrator', children: children.length });
    }

    // The container stays visibly active while its children run.
    this.setNodeStatus(runId, node.id, 'active');

    // Inline sub-walk over the container's children: same wave semantics as
    // the outer scheduler, scoped to the box. Already-done children (resume
    // after a restart) are skipped.
    const childIds = new Set(children.map(c => c.id));
    const done = new Set(children
      .filter(c => this.store.readMeta(runId).nodeStatus?.[c.id] === 'done')
      .map(c => c.id));
    const maxParallel = Math.max(1, Number(this.config.maxParallel ?? 4));
    for (;;) {
      const ready = children.filter(c => !done.has(c.id) &&
        flow.edges.every(e => e.target !== c.id || !childIds.has(e.source) || done.has(e.source)));
      if (!ready.length) break;
      // Children are never gated (the container runs autonomously), so both
      // aiStep and agentTask children are wave-safe (V1 task 6).
      const safe = ready.filter(c => c.type === 'aiStep' || c.type === 'agentTask');
      const batch = safe.length > 1 ? safe.slice(0, maxParallel) : [ready[0]];

      if (batch.length > 1) {
        this.store.appendLog(runId, { event: 'wave_start', container: node.id, nodes: batch.map(n => n.id) });
        const results = await Promise.allSettled(batch.map(c => this.runNode(runId, flow, c, opts)));
        batch.forEach((c, i) => { if (results[i].status === 'fulfilled') done.add(c.id); });
        const rejected = results.find(r => r.status === 'rejected');
        if (rejected) {
          this.setNodeStatus(runId, node.id, 'failed');
          throw rejected.reason;
        }
        if (batch.some(c => c.type === 'agentTask')
          && !await this.runPendingTasks(runId, opts.taskIdByNode, flow)) {
          this.setNodeStatus(runId, node.id, 'failed');
          throw new Error(`Orchestrator ${node.id}: a child task failed`);
        }
        continue;
      }

      const child = batch[0];
      try {
        await this.runNode(runId, flow, child, opts);
        if (child.type === 'agentTask' && !await this.runPendingTasks(runId, opts.taskIdByNode, flow)) {
          throw new Error(`Orchestrator ${node.id}: child task ${child.id} failed`);
        }
      } catch (err) {
        this.setNodeStatus(runId, node.id, 'failed');
        throw err;
      }
      done.add(child.id);
    }

    // Aggregate every child's output into the primary "results" output.
    const sections = children.map(c => {
      const label = c.data?.title?.trim() || c.id;
      const content = c.type === 'agentTask'
        ? this.store.readTaskOutput(runId, opts.taskIdByNode.get(c.id) ?? c.data?.taskId ?? '')
        : this.store.readNodeOutput(runId, c.id);
      return `--- ${label} (${c.id}) ---\n\n${content ?? '(no output)'}`;
    });
    const title = node.data?.title?.trim() || 'Orchestrator';
    this.store.writeNodeOutput(runId, node.id, `# ${title} — aggregated results\n\n${sections.join('\n\n')}`);

    this.store.writeRetrospective(runId, node.id, makeRetrospective({
      node: node.id,
      status: 'success',
      problems: [],
      confidence: 0.75,
      recommendation: `Orchestrator "${title}" created and ran ${children.length} node(s) autonomously (${worker.provider}/${worker.model}).`,
      model: { provider: worker.provider, model: worker.model }
    }));
    this.setNodeStatus(runId, node.id, 'done');
    return {};
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
      const result = await callModel({ provider: worker.provider, model: worker.model, apiKey, system, prompt,
        onRetry: this.retryLogger(runId, node.id), retry: this.config.retry });
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
    const parsed = parsePlanEval(evalOutputText,
      this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : []);
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
    return this.materializeParsedNodes(runId, flow, planEvalNode, parsed.plan);
  }

  // Turn a validated plan into real nodes in the run's flow. Two modes:
  //   default   — plan-eval style: roots hang off the owner, leaves feed the
  //               owner's downstream targets, global re-layout.
  //   parentId  — orchestrator style: children live INSIDE the owner's box
  //               (parentId + relative grid positions), are flagged managedBy
  //               so the outer scheduler leaves them alone, never gate, and
  //               are NOT wired to anything outside the container.
  materializeParsedNodes(runId, flow, ownerNode, plan, { parentId = null } = {}) {
    const existing = new Set(flow.nodes.map(n => n.id));
    const specs = plan.nodes.filter(s => {
      if (existing.has(s.id)) {
        this.store.appendLog(runId, { event: 'materialize_skip', fromNode: ownerNode.id, node: s.id, reason: 'id already exists in flow' });
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
    if (!usedExplicit && Array.isArray(plan.parallelGroups)) {
      const waves = plan.parallelGroups
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
        this.store.appendLog(runId, { event: 'materialize_failed', fromNode: ownerNode.id, errors });
        return { ok: false, errors, created: [] };
      }
    }

    const created = [];
    for (const s of specs) {
      // A generated node without an explicit contextSpec at least gets the
      // task list, keeping "minimal declared context" the default.
      const contextSpec = s.contextSpec ?? (s.taskRef
        ? { files: [{ path: 'tasks-md', description: `The full task list from plan-start; only ${s.taskRef} is this node's assignment.` }] }
        : undefined);
      const goal = s.goal || (s.taskRef ? `Complete ${s.taskRef} exactly as defined in tasks.md.` : '');

      // Prefer the Node Library template (user-editable worker/instructions/
      // tools apply); fall back to the built-in catalog contract otherwise.
      const lib = this.nodeStore?.get(s.template);
      let node;
      if (lib) {
        node = resolveInstance({
          id: s.id,
          templateId: s.template,
          position: { x: 0, y: 0 }, // real position assigned by the layout pass below
          overrides: {
            title: s.title || (s.taskRef ? `${lib.name} (${s.taskRef})` : lib.name),
            goal,
            ...(s.category ? { category: s.category } : {}),
            ...(contextSpec ? { contextSpec } : {})
          }
        }, lib);
      } else {
        const tmpl = getTemplate(s.template);
        node = createNodeFromTemplate(s.template, {
          id: s.id,
          position: { x: 0, y: 0 },
          data: {
            title: s.title || (s.taskRef ? `${tmpl.label} (${s.taskRef})` : tmpl.label),
            goal,
            ...(s.category ? { category: s.category } : {}),
            ...(contextSpec ? { contextSpec } : {})
          }
        });
      }
      node.data = {
        ...node.data,
        ...(s.taskRef ? { taskRef: s.taskRef } : {}),
        generatedBy: ownerNode.id,
        // Container children run autonomously: managed by the orchestrator's
        // inline sub-walk, never pausing at an approval gate.
        ...(parentId ? { managedBy: parentId, requiresApproval: false } : {})
      };
      if (parentId) {
        node.parentId = parentId;
        node.extent = 'parent';
      }
      created.push(node);
    }

    // Wiring. Default (plan-eval): roots hang off the owner, internal
    // dependsOn edges, leaves feed the owner's original downstream targets.
    // Container (orchestrator): roots hang off the owner, internal edges
    // only — downstream stays connected to the owner, which completes after
    // its children and hands over the aggregated result.
    const downstreamTargets = parentId ? []
      : flow.edges.filter(e => e.source === ownerNode.id).map(e => e.target);
    const dependedOn = new Set();
    depsFor.forEach(set => set.forEach(id => dependedOn.add(id)));
    const edges = [];
    for (const n of created) {
      const deps = [...depsFor.get(n.id)];
      if (deps.length) {
        for (const d of deps) edges.push({ id: `gen-e-${d}-${n.id}`, source: d, target: n.id, generatedBy: ownerNode.id });
      } else {
        edges.push({ id: `gen-e-${ownerNode.id}-${n.id}`, source: ownerNode.id, target: n.id, generatedBy: ownerNode.id });
      }
      if (!dependedOn.has(n.id)) {
        for (const t of downstreamTargets) edges.push({ id: `gen-e-${n.id}-${t}`, source: n.id, target: t, generatedBy: ownerNode.id });
      }
    }

    flow.nodes.push(...created);
    flow.edges.push(...edges);
    if (parentId) {
      // Grid the children inside the container and size its box to fit.
      const { positions, box } = containerLayout(created, flow.edges);
      for (const n of created) n.position = positions.get(n.id) ?? n.position;
      ownerNode.data = { ...ownerNode.data, box };
    } else {
      // Re-layout the run's display copy so generated nodes slot into clean
      // dependency layers instead of overlapping the authored ones. This only
      // touches flow.json inside the run dir — never the saved flow definition.
      const pos = layoutPositions(flow);
      for (const n of flow.nodes) n.position = pos.get(n.id) ?? n.position;
    }
    this.store.writeFlow(runId, flow);
    const meta = this.store.readMeta(runId);
    this.store.writeMeta(runId, {
      ...meta,
      nodeStatus: { ...meta.nodeStatus, ...Object.fromEntries(created.map(n => [n.id, 'pending'])) }
    });
    this.store.appendLog(runId, {
      event: 'materialized_nodes',
      fromNode: ownerNode.id,
      ...(parentId ? { container: parentId } : {}),
      nodes: created.map(n => ({ id: n.id, template: n.data.template ?? n.data.templateId ?? null, category: n.data.category ?? null })),
      edges: edges.length
    });
    this.notify(runId);
    return { ok: true, errors: [], created };
  }
}
