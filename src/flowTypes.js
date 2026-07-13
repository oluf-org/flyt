// Shared metadata for flow-definition node types, used by the canvas editor
// and the inspector. kind 'user' = user-authored box, 'ai' = AI-run box.
//
// See also FLOW_NODES.md for the full human + AI-readable contracts of the
// standard example nodes and the recommended reflective planning pattern.
export const TYPE_META = {
  input:      { icon: '✎', kind: 'user', label: 'Input',           sub: 'brief · user text' },
  agentTask:  { icon: '☑', kind: 'user', label: 'Agent task',      sub: 'task · for the executor' },
  aiStep:     { icon: '✦', kind: 'ai',   label: 'AI step',         sub: 'llm · model call' },
  output:     { icon: '◎', kind: 'user', label: 'Output',          sub: 'result · collects upstream' },

  // Prominent example / standard nodes (visual affordances + labels).
  // Most are realized at runtime as aiStep with a specific role or as
  // agentTask, but having dedicated entries makes the palette and docs clear.
  planStart:  { icon: '▶', kind: 'ai',   label: 'Start / Planner', sub: 'plan · tasks.md + context specs' },
  planEval:   { icon: '▤⇄', kind: 'ai',   label: 'Plan Evaluation', sub: 'eval · structure + categories + nodes' },
  stitch:     { icon: '🧵', kind: 'ai',   label: 'Stitch',          sub: 'integrate + repair' },
  finalEval:  { icon: '✓◌', kind: 'ai',   label: 'Final Evaluation', sub: 'completeness + deltas' }
};

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
  const byTemplate = node.data?.template && NODE_TEMPLATES[node.data.template]?.label;
  return byTemplate || TYPE_META[node.type]?.label || node.type;
}

export function nodeSub(node) {
  const d = node.data || {};
  const w = d.worker;
  const workerText = w?.provider ? `${w.provider}/${w.model}` : 'default worker';

  // Surface template + category when present (very useful for generated nodes)
  const tmpl = d.template ? NODE_TEMPLATES[d.template] : null;
  const cat = d.category ? `${d.category} · ` : '';

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

// Convenience: list of template names that are primarily for the advanced planning pattern
export const PLANNING_NODE_TEMPLATES = [
  'plan-start', 'plan-eval', 'step-eval', 'stitch', 'final-eval'
];
