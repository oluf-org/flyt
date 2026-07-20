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
  combine: [
    { id: 'report', label: 'combined', description: 'The merged, coherent deliverable assembled from the parallel upstream outputs.' }
  ],
  split: [
    { id: 'parts', label: 'parts', description: 'The work divided into clearly labeled independent parts for parallel downstream nodes.' }
  ],
  analyze: [
    { id: 'report', label: 'analysis', description: 'The structured analysis report.' }
  ],
  translate: [
    { id: 'result', label: 'translation', description: 'The translated text.' }
  ],
  'final-eval': [
    { id: 'report', label: 'final-eval.md', description: 'Completeness verdict + documented differences from the plan.' }
  ],
  'feedback-review': [
    { id: 'report', label: 'review', description: 'Whether the follow-up feedback is solved, and why.' },
    { id: 'verdict', label: 'verdict', description: 'Structured solved / more-work verdict (JSON).' }
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
  // The 'evaluation' meta-role declares the ports of the eval type it is set to.
  const role = effectiveRole(node.data?.role ?? 'custom', node.data?.evalType);
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
  return role === 'plan-eval' || role === 'stitch' || role === 'combine';
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

export const AI_ROLES = [
  'plan', 'execute', 'verify', 'custom', 'plan-start', 'plan-eval', 'step-eval',
  'stitch', 'final-eval', 'feedback-review',
  // Combined-node meta role ('evaluation' resolves to plan-eval / step-eval /
  // final-eval via evalType) and the standalone roles added in the node rework.
  'evaluation', 'combine', 'split', 'analyze', 'translate'
];

// The four (minimum) categories used by plan-eval nodes to drive model selection
// and template choice. Extend only after updating FLOW_NODES.md and config examples.
export const NODE_CATEGORIES = [
  'Code general',
  'Code design',
  'documentation',
  'Test-creation'
];

// --- Combined-node options (node rework) ------------------------------------
//
// Effort level: every AI node carries one. It drives default model selection
// (core/modelPriority.js) and the response token budget — it never overrides
// an explicitly chosen worker.
export const EFFORT_LEVELS = ['low', 'medium', 'high'];
export const DEFAULT_EFFORT = 'medium';
export const EFFORT_MAX_TOKENS = { low: 2048, medium: 4096, high: 8192 };

// The Work node's task types are exactly the model-selection categories.
export const WORK_CATEGORIES = NODE_CATEGORIES;

// Per-task-type tool grants for the Work node (template id 'work'):
// Test-creation is the one that runs commands, so it alone gets bash and
// ships with the per-call approval gate on by default.
export const WORK_TOOLS = {
  'Test-creation': ['read_file', 'create_file', 'write_file', 'bash', 'create_task', 'write_task_md'],
  default: ['read_file', 'create_file', 'write_file', 'write_task_md']
};

// The Evaluation node's evalType option -> the concrete runtime role.
export const EVAL_TYPES = {
  plan: 'plan-eval',
  step: 'step-eval',
  final: 'final-eval'
};
export const DEFAULT_EVAL_TYPE = 'step';

// The role a node actually runs as: the 'evaluation' meta-role resolves
// through evalType; everything else is taken literally.
export function effectiveRole(role, evalType) {
  if (role === 'evaluation') return EVAL_TYPES[evalType] ?? EVAL_TYPES[DEFAULT_EVAL_TYPE];
  return role;
}

// --- Feedback channel --------------------------------------------------------
//
// Every AI node exposes a feedback point at its top: a source handle with this
// reserved id. A feedback edge points BACK to an upstream node (usually the one
// that fed this node) and is excluded from topological ordering, cycle checks,
// and forward context — it exists so a node can send a structured
// pass/retry verdict to the node whose output it received.
export const FEEDBACK_HANDLE = 'feedback';
export const isFeedbackEdge = e => (e?.sourceHandle ?? null) === FEEDBACK_HANDLE;
// The graph without its feedback channel — what ordering/cycle logic sees.
export const forwardEdges = edges => (edges ?? []).filter(e => !isFeedbackEdge(e));

// --- Structural nodes (pinned input/output) ---------------------------------
//
// Every flow always carries a User Input and an Output node: they are created
// automatically, cannot be deleted on the canvas, and removing them from the
// YAML fails the save. True for the pinned structural types.
export const isStructuralType = t => t === 'input' || t === 'output';
export const isStructuralNode = n => Boolean(n) && !n.templateId && isStructuralType(n.type);

// Append any missing input/output node so a loaded flow always has both
// (legacy files may predate the pinned-structural rule). Pure: returns the
// same object when nothing is missing.
export function ensureStructuralNodes(flow) {
  const nodes = flow.nodes ?? [];
  const hasInput = nodes.some(n => n.type === 'input');
  const hasOutput = nodes.some(n => n.type === 'output');
  if (hasInput && hasOutput) return flow;
  const maxY = Math.max(0, ...nodes.map(n => n.position?.y ?? 0));
  const added = [];
  if (!hasInput) added.push({ id: 'input', type: 'input', kind: 'user', position: { x: 40, y: 40 }, data: {} });
  if (!hasOutput) added.push({ id: 'output', type: 'output', kind: 'user', position: { x: 40, y: maxY + 130 }, data: {} });
  return { ...flow, nodes: [...nodes, ...added] };
}

// Legacy template ids -> their combined replacement. Applied when loading a
// stored flow (core/flowstore.js) and when migrating the seed library
// (core/nodestore.js), so old flows keep working after the node rework.
export const LEGACY_TEMPLATE_MAP = {
  'code-general-step': { templateId: 'work', overrides: { category: 'Code general' } },
  'code-design-step': { templateId: 'work', overrides: { category: 'Code design' } },
  'documentation-step': { templateId: 'work', overrides: { category: 'documentation' } },
  'test-creation-step': { templateId: 'work', overrides: { category: 'Test-creation' } },
  'plan-eval': { templateId: 'evaluation', overrides: { evalType: 'plan' } },
  'step-eval': { templateId: 'evaluation', overrides: { evalType: 'step' } },
  'final-eval': { templateId: 'evaluation', overrides: { evalType: 'final' } },
  'stitch': { templateId: 'combine', overrides: {} }
};

// Rewrite legacy template references in a stored flow to the combined nodes.
// Pure: returns the same object when nothing referenced a retired template.
export function migrateLegacyTemplates(flow) {
  if (!(flow.nodes ?? []).some(n => n.templateId && LEGACY_TEMPLATE_MAP[n.templateId])) return flow;
  return {
    ...flow,
    nodes: flow.nodes.map(n => {
      const m = n.templateId ? LEGACY_TEMPLATE_MAP[n.templateId] : null;
      if (!m) return n;
      return { ...n, templateId: m.templateId, overrides: { ...m.overrides, ...(n.overrides ?? {}) } };
    })
  };
}

// NODE_TEMPLATES — the catalog that AI authors pick from when generating nodes.
// Keys are the stable names referenced in plan-eval output and in flow data.template.
// This is the machine-readable counterpart to the polished descriptions in FLOW_NODES.md.
// The combined nodes (work / evaluation / combine / split) are the primary set;
// the retired per-category ids stay as aliases so plans and flows written
// before the rework still materialize.
export const NODE_TEMPLATES = {
  'work': {
    label: 'Work',
    baseType: 'agentTask',
    role: 'execute',
    category: null, // the spec's category picks the task type
    icon: '✦',
    description: 'The one work node: implementation, design, docs, or tests — pick the task type via category, and an effort level.',
    defaultData: () => ({ title: 'Work', role: 'execute', category: 'Code general', effort: DEFAULT_EFFORT })
  },
  'evaluation': {
    label: 'Evaluation',
    baseType: 'aiStep',
    role: 'evaluation',
    category: null,
    icon: '⚖',
    description: 'The one evaluation node: plan / step / final — pick via evalType, plus an effort level.',
    defaultData: () => ({ title: 'Evaluation', role: 'evaluation', evalType: DEFAULT_EVAL_TYPE, effort: DEFAULT_EFFORT, system: '' })
  },
  'combine': {
    label: 'Combine',
    baseType: 'aiStep',
    role: 'combine',
    category: null,
    icon: '⧉',
    description: 'Merge parallel upstream outputs into one coherent deliverable; small fixes inline, larger gaps become fix tasks.',
    defaultData: () => ({ title: 'Combine', role: 'combine', effort: DEFAULT_EFFORT, system: '' })
  },
  'split': {
    label: 'Split',
    baseType: 'aiStep',
    role: 'split',
    category: null,
    icon: '⑃',
    description: 'Divide the upstream work into clearly labeled independent parts for parallel downstream nodes.',
    defaultData: () => ({ title: 'Split', role: 'split', effort: DEFAULT_EFFORT, system: '' })
  },
  'general-analysis': {
    label: 'General analysis',
    baseType: 'aiStep',
    role: 'analyze',
    category: null,
    icon: '◉',
    description: 'General text analysis: structure, claims, evidence, gaps, recommendations. Effort level picks the depth.',
    defaultData: () => ({ title: 'Analysis', role: 'analyze', effort: DEFAULT_EFFORT, system: '' })
  },
  'translation': {
    label: 'Translation',
    baseType: 'aiStep',
    role: 'translate',
    category: null,
    icon: '文',
    description: 'Faithful translation preserving meaning, tone, and formatting. Set the target language on the node.',
    defaultData: () => ({ title: 'Translate', role: 'translate', effort: DEFAULT_EFFORT, language: 'English', system: '' })
  },
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
  // 'auto' = an active-models pick, resolved per provider priority at call time.
  const workerText = w?.provider === 'auto' ? w.model : w?.provider ? `${w.provider}/${w.model}` : 'default worker';
  const cat = d.category ? `${d.category} · ` : '';
  // Non-default effort is worth a glance on the card; medium stays quiet.
  const eff = d.effort && d.effort !== DEFAULT_EFFORT ? ` · ${d.effort} effort` : '';

  // Library template instances: show template name + effective worker.
  if (d.templateId) return `${cat}${d.templateName ?? d.templateId} · ${workerText}${eff}`;

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
    baseType: 'aiStep', role: 'plan-start', effort: 'high',
    description: 'Produces tasks.md with well-defined tasks and explicit per-file context descriptions.'
  },
  {
    // The one work node (rework): the retired code-general / code-design /
    // documentation / test-creation templates are its task types, picked via
    // `category`. Tools follow the task type (WORK_TOOLS): only Test-creation
    // gets bash, and it alone defaults the per-call approval gate on — a
    // default that asks, not a default that acts (D16). Category still drives
    // model selection exactly as before; effort refines it.
    id: 'work', name: 'Work', category: 'Code general', icon: '✦',
    baseType: 'agentTask', role: 'execute', effort: 'medium',
    tools: null, // derived from the task type at resolve time (WORK_TOOLS)
    // The test-suite honesty rule rides on the template so the Test-creation
    // task type inherits it: a non-zero exit is a result, not noise.
    instructions: [
      'If your task includes running tests or commands: read every exit code.',
      'A non-zero exit means FAILURE — fix the cause and run it again. Never report',
      'the task complete while a suite is failing; say so plainly instead.'
    ].join(' '),
    description: 'The work node: implementation, design, docs, or tests — pick the task type and effort level on the node.'
  },
  {
    // The one evaluation node: plan / step / final evaluation picked via
    // `evalType` (resolves to the plan-eval / step-eval / final-eval role).
    id: 'evaluation', name: 'Evaluation', category: null, icon: '⚖',
    baseType: 'aiStep', role: 'evaluation', evalType: 'step', effort: 'medium',
    description: 'The evaluation node: plan evaluation (creates work nodes), step evaluation (pass/retry/escalate), or final evaluation — pick the type and effort level on the node.'
  },
  {
    id: 'combine', name: 'Combine', category: null, icon: '⧉',
    baseType: 'aiStep', role: 'combine', effort: 'medium',
    description: 'Merge parallel upstream outputs into one coherent deliverable; small fixes inline, larger gaps become fix tasks.'
  },
  {
    id: 'split', name: 'Split', category: null, icon: '⑃',
    baseType: 'aiStep', role: 'split', effort: 'medium',
    description: 'Divide the upstream work into clearly labeled independent parts that downstream nodes can run in parallel.'
  },
  {
    id: 'general-analysis', name: 'General analysis', category: null, icon: '◉',
    baseType: 'aiStep', role: 'analyze', effort: 'medium',
    description: 'General text analysis: summary, structure, claims and evidence, gaps, risks, recommendations. Effort level picks the depth.'
  },
  {
    id: 'translation', name: 'Translation', category: null, icon: '文',
    baseType: 'aiStep', role: 'translate', effort: 'medium', language: 'English',
    description: 'Faithful translation preserving meaning, tone, register, and formatting. Set the target language on the node.'
  }
].map(t => ({ worker: null, instructions: '', tools: null, skills: [], requiresApproval: false, approveToolCalls: false, ...t }));

// Seed ids retired by the node rework: their files are removed from the
// library on startup (core/nodestore.js) and stored flows referencing them are
// rewritten via LEGACY_TEMPLATE_MAP.
export const RETIRED_SEED_IDS = Object.keys(LEGACY_TEMPLATE_MAP);

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
    // Combined-node options (node rework). effort is universal; evalType only
    // means anything on the 'evaluation' meta-role; language on 'translate'.
    effort: EFFORT_LEVELS.includes(tpl.effort) ? tpl.effort : DEFAULT_EFFORT,
    evalType: tpl.evalType in EVAL_TYPES ? tpl.evalType : DEFAULT_EVAL_TYPE,
    ...(typeof tpl.language === 'string' && tpl.language.trim() ? { language: tpl.language.trim() } : {}),
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
  // Combined-node options: the 'evaluation' meta-role resolves to a concrete
  // eval role via evalType; the Work node derives its tools (and its
  // approve-every-tool-call default) from the chosen task type.
  const evalType = (ov.evalType in EVAL_TYPES ? ov.evalType : null) ?? t?.evalType ?? DEFAULT_EVAL_TYPE;
  const role = effectiveRole(t?.role ?? 'custom', evalType);
  const effort = (EFFORT_LEVELS.includes(ov.effort) ? ov.effort : null) ?? t?.effort ?? DEFAULT_EFFORT;
  const category = ov.category ?? t?.category ?? null;
  const isWork = t?.id === 'work';
  const workTools = isWork ? (WORK_TOOLS[category] ?? WORK_TOOLS.default) : null;
  const tools = ov.tools ?? t?.tools ?? workTools;
  const workGate = isWork && (tools ?? []).includes('bash');
  const data = {
    templateId: node.templateId,
    templateName: t?.name ?? node.templateId,
    icon: t?.icon ?? '✦',
    title: ov.title ?? t?.name ?? node.templateId,
    role,
    effort,
    ...(t?.role === 'evaluation' ? { evalType } : {}),
    ...(role === 'translate' ? { language: ov.language ?? t?.language ?? 'English' } : {}),
    worker: ov.worker ?? t?.worker ?? null,
    ...(instructions ? { instructions } : {}),
    ...(category ? { category } : {}),
    ...(tools ? { tools } : {}),
    ...((ov.skills ?? t?.skills)?.length ? { skills: ov.skills ?? t.skills } : {}),
    requiresApproval: ov.requiresApproval ?? t?.requiresApproval ?? false,
    approveToolCalls: ov.approveToolCalls ?? (workGate ? true : t?.approveToolCalls ?? false),
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
