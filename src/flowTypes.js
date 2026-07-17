// Shared metadata for flow-definition node types, used by the canvas editor
// and the inspector. kind 'user' = user-authored box, 'ai' = AI-run box.
//
// See also FLOW_NODES.md for the full human + AI-readable contracts of the
// standard example nodes and the recommended reflective planning pattern.
export const TYPE_META = {
  input:        { icon: '✎', kind: 'user', label: 'User Input',   sub: 'run request · from the run panel' },
  agentTask:    { icon: '☑', kind: 'user', label: 'Agent task',   sub: 'task · for the executor' },
  aiStep:       { icon: '✦', kind: 'ai',   label: 'AI step',      sub: 'llm · model call' },
  orchestrator: { icon: '▦', kind: 'ai',   label: 'Orchestrator', sub: 'container · creates & runs task nodes' },
  output:       { icon: '◎', kind: 'user', label: 'Output',       sub: 'result · collects upstream' }
};

// The name a flow carries until the user gives it one. Also what the editor
// falls back to when the name field is left blank: the DSL requires a name, so
// an empty field is a transient editing state (you must clear the old name to
// type a new one) and never something that reaches the store.
export const UNTITLED_FLOW = 'Untitled flow';

// Guarantee the name the store demands. Renaming necessarily passes through a
// blank field on the way to the new name, and the editor autosaves as you type;
// without this, that keystroke fails the save and the rename is stranded.
export const namedFlow = flow => (flow.name?.trim() ? flow : { ...flow, name: UNTITLED_FLOW });

// Tools an agentTask node may be granted (core/tools/index.js registry).
export const AGENT_TOOLS = ['read_file', 'create_file', 'write_file', 'bash', 'create_task', 'write_task_md'];

// --- Output ports: what each node CREATES -----------------------------------
//
// Every node declares named outputs. The FIRST port is the primary output
// (nodes/<id>.md); auxiliary ports are written as nodes/<id>.<port>.md by the
// runner. Edges may carry sourceHandle = <port id> to pick which output feeds
// the target; edges without one use the primary output (legacy behavior).
// Node Library templates may override these with an `outputs` array.
export const ROLE_PORTS = {
  'plan-start': [
    { id: 'tasks', label: 'tasks.md', description: 'Structured task list with per-task minimal context specs.' }
  ],
  'plan-eval': [
    { id: 'plan', label: 'plan json', description: 'The validated node-creation contract (nodes, waves, categories).' },
    { id: 'summary', label: 'summary', description: 'One-line summary of the evaluated plan.' }
  ],
  'step-eval': [
    { id: 'report', label: 'report', description: 'The evaluation report for the preceding node.' },
    { id: 'verdict', label: 'verdict', description: 'Structured pass / retry / escalate verdict (JSON).' }
  ],
  stitch: [
    { id: 'report', label: 'stitch-report', description: 'Coherence review across the prior parallel work.' }
  ],
  'final-eval': [
    { id: 'report', label: 'final-eval.md', description: 'Completeness verdict + documented differences from the plan.' }
  ],
  plan: [
    { id: 'plan', label: 'plan.md', description: 'The produced plan.' }
  ],
  verify: [
    { id: 'report', label: 'report', description: 'PASS/FAIL verification report.' }
  ],
  execute: [
    { id: 'result', label: 'result', description: 'The produced deliverable.' }
  ],
  custom: [
    { id: 'result', label: 'result', description: 'The produced deliverable.' }
  ]
};

export const TYPE_PORTS = {
  input: [{ id: 'prompt', label: 'prompt', description: 'The run request text.' }],
  agentTask: [{ id: 'result', label: 'result', description: 'The executor task output.' }],
  orchestrator: [
    { id: 'results', label: 'results', description: 'Aggregated outputs of every node this orchestrator created and ran.' },
    { id: 'summary', label: 'summary', description: 'The orchestration plan summary + node inventory.' }
  ],
  output: []
};

// The declared outputs of a node: explicit template outputs win, then the
// structural type, then the AI role. Total — always returns an array.
export function nodePorts(node) {
  if (!node) return [];
  const explicit = node.data?.outputs;
  if (Array.isArray(explicit) && explicit.length) return explicit;
  if (node.type && node.type in TYPE_PORTS && node.type !== 'agentTask') return TYPE_PORTS[node.type];
  if (node.type === 'agentTask') return TYPE_PORTS.agentTask;
  const role = node.data?.role ?? 'custom';
  return ROLE_PORTS[role] ?? ROLE_PORTS.custom;
}

// The primary (first-declared) output port id, or null for sink nodes.
export function primaryPort(node) {
  return nodePorts(node)[0]?.id ?? null;
}

// True for nodes whose contract lets them create other nodes at run time.
export function createsNodes(node) {
  if (node?.type === 'orchestrator') return true;
  const role = node?.data?.role;
  return role === 'plan-eval' || role === 'stitch';
}

// Validate/normalize a template's declared outputs ({ id, label?, description? }[]).
export function normalizeOutputs(outputs) {
  if (!Array.isArray(outputs)) return null;
  const clean = outputs
    .filter(o => o && typeof o.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(o.id.trim()))
    .map(o => ({
      id: o.id.trim(),
      label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : o.id.trim(),
      ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim() } : {})
    }));
  return clean.length ? clean : null;
}

export const AI_ROLES = ['plan', 'execute', 'verify', 'custom', 'plan-start', 'plan-eval', 'step-eval', 'stitch', 'final-eval'];

// The four (minimum) categories used by plan-eval nodes to drive model selection
// and template choice. Extend only after updating FLOW_NODES.md and config examples.
export const NODE_CATEGORIES = [
  'Code general',
  'Code design',
  'documentation',
  'Test-creation'
];

// NODE_TEMPLATES — the catalog that AI authors pick from when generating nodes.
// Keys are the stable names referenced in plan-eval output and in flow data.template.
// This is the machine-readable counterpart to the polished descriptions in FLOW_NODES.md.
export const NODE_TEMPLATES = {
  'plan-start': {
    label: 'Start / Plan-Start',
    baseType: 'aiStep',
    role: 'plan-start',
    category: null,
    icon: '▶',
    description: 'Produces tasks.md with well-defined tasks and explicit per-file context descriptions (to avoid unnecessary context bloat).',
    defaultData: () => ({ title: 'Start', role: 'plan-start', system: '' })
  },
  'plan-eval': {
    label: 'Plan Evaluation',
    baseType: 'aiStep',
    role: 'plan-eval',
    category: null,
    icon: '▤⇄',
    description: 'Consumes tasks.md. Emits parallel groups, dependency order, task categories, and a list of nodes to create using other templates.',
    defaultData: () => ({ title: 'Plan Evaluation', role: 'plan-eval', system: '' })
  },
  'code-general-step': {
    label: 'Code General Step',
    baseType: 'aiStep',
    role: 'execute',
    category: 'Code general',
    icon: '✦',
    description: 'Straightforward implementation work. Balanced model is usually sufficient.',
    defaultData: () => ({ title: 'Code work', role: 'execute', category: 'Code general', system: '' })
  },
  'code-design-step': {
    label: 'Code Design Step',
    baseType: 'aiStep',
    role: 'execute',
    category: 'Code design',
    icon: '✦',
    description: 'Architecture, interfaces, data models. Prefer stronger model.',
    defaultData: () => ({ title: 'Design', role: 'execute', category: 'Code design', system: '' })
  },
  'documentation-step': {
    label: 'Documentation Step',
    baseType: 'aiStep',
    role: 'execute',
    category: 'documentation',
    icon: '✦',
    description: 'Docs, README sections, comments, usage examples. Lighter/faster model often works.',
    defaultData: () => ({ title: 'Docs', role: 'execute', category: 'documentation', system: '' })
  },
  'test-creation-step': {
    label: 'Test Creation Step',
    baseType: 'agentTask', // benefits from tools + write_file
    role: 'execute',
    category: 'Test-creation',
    icon: '☑',
    description: 'Create or extend tests. Full agent executor recommended.',
    defaultData: () => ({ title: 'Tests', role: 'execute', category: 'Test-creation', system: '' })
  },
  'step-eval': {
    label: 'Step Evaluation',
    baseType: 'aiStep',
    role: 'step-eval',
    category: null,
    icon: '⚖',
    description: 'Review the preceding node. Note plan impact, escalate, or produce enriched context for auto-retry.',
    defaultData: () => ({ title: 'Step Eval', role: 'step-eval', system: '' })
  },
  'stitch': {
    label: 'Stitch Together',
    baseType: 'aiStep',
    role: 'stitch',
    category: null,
    icon: '🧵',
    description: 'Review outputs from prior work (especially parallel). Make small fixes or create follow-up task nodes for larger gaps.',
    defaultData: () => ({ title: 'Stitch', role: 'stitch', system: '' })
  },
  'final-eval': {
    label: 'Final Evaluation',
    baseType: 'aiStep',
    role: 'final-eval',
    category: null,
    icon: '✓◌',
    description: 'Evaluate completeness against the original plan. Explicitly document differences + reasoning in final-eval.md.',
    defaultData: () => ({ title: 'Final Eval', role: 'final-eval', system: '' })
  }
};

export function getTemplate(name) {
  return NODE_TEMPLATES[name] || null;
}

// Create a fresh node object (for use in App.jsx add-from-template and runner materialization).
// The caller is responsible for id and position.
export function createNodeFromTemplate(name, overrides = {}) {
  const t = getTemplate(name);
  if (!t) throw new Error(`Unknown node template "${name}"`);
  const baseType = t.baseType || 'aiStep';
  const { data: dataOverrides, ...rest } = overrides;
  const data = {
    ...(t.defaultData ? t.defaultData() : {}),
    template: name,
    ...(dataOverrides || {})
  };
  // Ensure category is present when the template declares one
  if (t.category && !data.category) data.category = t.category;
  return {
    type: baseType,
    kind: baseType === 'agentTask' ? 'user' : 'ai',
    data,
    ...rest
  };
}

export function nodeLabel(node) {
  if (node.data?.title?.trim()) return node.data.title.trim();
  if (node.data?.templateName) return node.data.templateName;
  const byTemplate = node.data?.template && NODE_TEMPLATES[node.data.template]?.label;
  return byTemplate || TYPE_META[node.type]?.label || node.type;
}

export function nodeSub(node) {
  const d = node.data || {};
  const w = d.worker;
  const workerText = w?.provider ? `${w.provider}/${w.model}` : 'default worker';
  const cat = d.category ? `${d.category} · ` : '';

  // Library template instances: show template name + effective worker.
  if (d.templateId) return `${cat}${d.templateName ?? d.templateId} · ${workerText}`;

  // Legacy catalog nodes (generated nodes carry data.template)
  const tmpl = d.template ? NODE_TEMPLATES[d.template] : null;
  if (tmpl) {
    return `${cat}${tmpl.label} · ${workerText}`;
  }
  if (node.type === 'aiStep') {
    const role = d.role ?? 'custom';
    return `${cat}${role} · ${workerText}`;
  }
  if (node.type === 'agentTask') return `task · ${workerText}`;
  return TYPE_META[node.type]?.sub ?? '';
}

// --- Node Library: template seed catalog + instance resolution -------------
//
// The Node Library (core/nodestore.js, nodes/<id>.json) holds reusable AI
// node templates. A workflow node is an INSTANCE of a template:
//
//   { id, templateId, position, overrides: { title?, worker?, instructions?,
//     tools?, requiresApproval?, goal?, category?, contextSpec? } }
//
// Overrides live in that workflow's flows/<id>.json only and never write
// back to the template. resolveFlow() merges template defaults with the
// instance overrides into the runtime node shape ({ id, type, kind,
// position, data }) that the runner and canvas operate on. Structural nodes
// (input/output) and legacy raw nodes pass through untouched.

// Seed catalog for the Node Library — the FLOW_NODES.md standard nodes.
// core/nodestore.js writes these to nodes/<id>.json on first launch; after
// that the files are the source of truth and the user can edit them freely.
//
// The work templates are agentTasks, not aiSteps (V1 task 12). An aiStep calls
// the model directly and never enters the agent loop, so it cannot hold a tool
// at all — which meant the templates that are supposed to DO the work could only
// emit markdown describing it. The file and bash tools built in V1 tasks 2/3
// existed but nothing in the library could reach them: out of the box the coding
// agent could not read a repo or run a test.
//
// Tool grants follow what each tool can actually reach:
//   - read_file / create_file / write_file resolve through Workspace.resolve(),
//     which confines them to the bound project (traversal and symlink escapes
//     rejected). Safe to run unattended, which is what the library already did.
//   - bash is NOT confined — it only *starts* in the workspace and can `cd ..`
//     (see core/tools/bash.js). Its own guard is the approval gate, so every
//     template granting it ships approveToolCalls: true. Turn it off per node
//     for an unattended run — that is D16's "skippable by choice", the right way
//     round: a default that asks, not a default that acts.
export const SEED_NODE_TEMPLATES = [
  {
    id: 'plan-start', name: 'Plan', category: null, icon: '▶',
    baseType: 'aiStep', role: 'plan-start',
    description: 'Produces tasks.md with well-defined tasks and explicit per-file context descriptions.'
  },
  {
    id: 'plan-eval', name: 'Plan evaluation', category: null, icon: '▤⇄',
    baseType: 'aiStep', role: 'plan-eval',
    description: 'Consumes tasks.md; emits dependency order, task categories, and the work nodes to create.'
  },
  {
    id: 'code-general-step', name: 'Code (general)', category: 'Code general', icon: '✦',
    baseType: 'agentTask', role: 'execute',
    tools: ['read_file', 'create_file', 'write_file', 'write_task_md'],
    description: 'Straightforward implementation work: reads the project and writes the code. Balanced model is usually sufficient.'
  },
  {
    id: 'code-design-step', name: 'Code (design)', category: 'Code design', icon: '✦',
    baseType: 'agentTask', role: 'execute',
    // Writes, like every other work template. This shipped read-only ("a design
    // step designs, it does not edit") and a live acceptance run showed why that
    // is wrong: the planner handed it "Implement and export tag filtering", the
    // node held no write tool, so it produced a spec, reported success, and the
    // feature was never written — a silent no-op that nothing downstream caught.
    // A work template that cannot do the work it is handed is a trap, and what
    // actually distinguishes design here is the MODEL (FLOW_NODES: "prefers a
    // stronger model"), not the toolset. Writes stay confined by
    // Workspace.resolve(), so this remains ungated and parallel-safe.
    tools: ['read_file', 'create_file', 'write_file', 'write_task_md'],
    description: 'Architecture, interfaces, data models: reads the project and writes the code. Prefer a stronger model.'
  },
  {
    id: 'documentation-step', name: 'Documentation', category: 'documentation', icon: '✦',
    baseType: 'agentTask', role: 'execute',
    tools: ['read_file', 'create_file', 'write_file'],
    description: 'Docs, README sections, usage examples: reads the code, writes the docs. Lighter/faster model often works.'
  },
  {
    id: 'test-creation-step', name: 'Test creation', category: 'Test-creation', icon: '☑',
    baseType: 'agentTask', role: 'execute',
    tools: ['read_file', 'create_file', 'write_file', 'bash', 'create_task', 'write_task_md'],
    // The one template that can run commands, so the one that ships gated.
    approveToolCalls: true,
    // This is the node that holds the test suite, so it is the node that must
    // not lie about it. A live acceptance run had it write tests, run them, read
    // `npm test` exit 1, and report success — leaving the repo redder than it
    // found it while the run said "done". Nothing downstream caught it, so the
    // instruction is the lever: a non-zero exit is a result, not noise.
    instructions: [
      'Run the test suite after writing or changing tests, and read the exit code.',
      'A non-zero exit means the suite FAILED — fix the cause and run it again.',
      'Never report the task complete while the suite is failing. If you cannot make',
      'it pass, say so plainly at the top of your deliverable, state which tests fail',
      'and why, and do not describe the work as done.'
    ].join(' '),
    description: 'Create or extend tests, and run them until they pass. Can execute shell commands, so it asks before each destructive call — untick to run unattended.'
  },
  {
    id: 'step-eval', name: 'Step evaluation', category: null, icon: '⚖',
    baseType: 'aiStep', role: 'step-eval',
    description: 'Review the preceding node: pass, bounded auto-retry with guidance, or escalate to human.'
  },
  {
    id: 'stitch', name: 'Stitch', category: null, icon: '🧵',
    baseType: 'aiStep', role: 'stitch',
    description: 'Review prior outputs, make small fixes, or create corrective fix tasks.'
  },
  {
    id: 'final-eval', name: 'Final evaluation', category: null, icon: '✓◌',
    baseType: 'aiStep', role: 'final-eval',
    description: 'Evaluate completeness against the original plan; document differences and reasoning.'
  }
].map(t => ({ worker: null, instructions: '', tools: null, skills: [], requiresApproval: false, approveToolCalls: false, ...t }));

// Fill in the optional template fields so every consumer sees one shape.
export function normalizeTemplate(tpl) {
  return {
    id: tpl.id,
    name: tpl.name ?? tpl.id,
    description: tpl.description ?? '',
    category: tpl.category ?? null,
    icon: tpl.icon ?? '✦',
    baseType: tpl.baseType === 'agentTask' ? 'agentTask' : 'aiStep',
    role: tpl.role ?? 'custom',
    worker: tpl.worker?.provider && tpl.worker?.model
      ? { provider: tpl.worker.provider, model: tpl.worker.model } : null,
    instructions: tpl.instructions ?? '',
    tools: Array.isArray(tpl.tools) ? tpl.tools.filter(t => AGENT_TOOLS.includes(t)) : null,
    skills: Array.isArray(tpl.skills) ? tpl.skills.map(String) : [],
    requiresApproval: Boolean(tpl.requiresApproval),
    approveToolCalls: Boolean(tpl.approveToolCalls),
    outputs: normalizeOutputs(tpl.outputs)
  };
}

// True when the flow node is a template instance (vs structural/legacy raw).
export const isInstance = node => Boolean(node?.templateId);

// Merge a template with one instance's overrides into the runtime node
// shape. A missing template resolves to a clearly-flagged custom aiStep so
// the flow still loads (and the run fails honestly at that node).
export function resolveInstance(node, tpl) {
  const t = tpl ? normalizeTemplate(tpl) : null;
  const ov = node.overrides ?? {};
  const type = (t?.baseType) === 'agentTask' ? 'agentTask' : 'aiStep';
  const instructions = [t?.instructions, ov.instructions]
    .filter(s => typeof s === 'string' && s.trim()).join('\n\n');
  const data = {
    templateId: node.templateId,
    templateName: t?.name ?? node.templateId,
    icon: t?.icon ?? '✦',
    title: ov.title ?? t?.name ?? node.templateId,
    role: t?.role ?? 'custom',
    worker: ov.worker ?? t?.worker ?? null,
    ...(instructions ? { instructions } : {}),
    ...(ov.category ?? t?.category ? { category: ov.category ?? t.category } : {}),
    ...((ov.tools ?? t?.tools) ? { tools: ov.tools ?? t.tools } : {}),
    ...((ov.skills ?? t?.skills)?.length ? { skills: ov.skills ?? t.skills } : {}),
    requiresApproval: ov.requiresApproval ?? t?.requiresApproval ?? false,
    approveToolCalls: ov.approveToolCalls ?? t?.approveToolCalls ?? false,
    ...(t?.outputs?.length ? { outputs: t.outputs } : {}),
    ...(ov.goal ? { goal: ov.goal } : {}),
    ...(ov.contextSpec ? { contextSpec: ov.contextSpec } : {}),
    ...(t ? {} : { missingTemplate: true })
  };
  return { id: node.id, type, kind: 'ai', position: node.position, data };
}

// Resolve every template instance in a flow against the library. Structural
// (input/output) and already-resolved/legacy nodes pass through unchanged.
export function resolveFlow(flow, templates = []) {
  const byId = new Map(templates.map(t => [t.id, t]));
  return {
    ...flow,
    nodes: (flow.nodes ?? []).map(n =>
      isInstance(n) ? resolveInstance(n, byId.get(n.templateId)) : n)
  };
}
