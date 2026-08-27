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
  // Fan-out (D36): N deliberately diverged takes on ONE brief, run inside
  // its own box. Like the orchestrator it is a container — but its children
  // come from a lane list the author wrote, not from a model's plan.
  fanout:       { icon: '⋔', kind: 'ai',   label: 'Fan-out',      sub: 'container · one lane per model' },
  // Sub-flow (D36): a flow used as a node. Its children are spliced in from
  // another flow file at run start — composition, not programming (§0.2).
  subflow:      { icon: '⧉', kind: 'ai',   label: 'Sub-flow',     sub: 'container · another flow, inline' },
  // The doorway into the loop (D36): enqueues the tasks a backlog-plan
  // node produced and stays running until the supervisor lands them. NOT a
  // container — the work happens in the loop engine, not inside this box.
  loop:         { icon: '↻', kind: 'ai',   label: 'Loop',         sub: 'hand-off · queue it and wait' },
  // Typed run inputs (D36): one node whose output ports are the values this
  // run was given. An input is a node you can see and wire, not hidden binding.
  inputs:       { icon: '⌸', kind: 'user', label: 'Run inputs',   sub: 'typed · filled in the composer' },
  output:       { icon: '◎', kind: 'user', label: 'Output',       sub: 'result · collects upstream' }
};

// Node types that hold other nodes inside a box on the canvas and run them as
// a scoped subgraph (core/nodes/expand.js). Containment, layout, the linter's
// `parent` rule and the run canvas all key off this rather than naming the
// orchestrator specifically.
export const CONTAINER_TYPES = ['orchestrator', 'fanout', 'subflow'];
export const isContainerType = type => CONTAINER_TYPES.includes(type);

// The name a flow carries until the user gives it one. Also what the editor
// falls back to when the name field is left blank: the DSL requires a name, so
// an empty field is a transient editing state (you must clear the old name to
// type a new one) and never something that reaches the store.
export const UNTITLED_FLOW = 'Untitled flow';

// Guarantee the name the store demands. Renaming necessarily passes through a
// blank field on the way to the new name, and the editor autosaves as you type;
// without this, that keystroke fails the save and the rename is stranded.
export const namedFlow = flow => (flow.name?.trim() ? flow : { ...flow, name: UNTITLED_FLOW });

// Tools an agentTask node may be granted. The tool library is data now
// (tools/<id>.json, core/toolstore.js), so this array is the BUILT-IN
// fallback: what every build ships and what a host without a library — the
// test suite, a renderer before its first IPC round trip — validates against.
export const AGENT_TOOLS = ['read_file', 'glob', 'search_files', 'create_file', 'write_file', 'bash', 'create_task', 'enqueue_task', 'search_references', 'write_task_md', 'read_tool_result'];

// The live snapshot, installed by the renderer from the main process's
// ToolStore (`tool:list`). Grants are filtered against this, so a template can
// name a user-authored or imported tool without flowTypes knowing about it —
// and an unknown id is still dropped rather than carried into a run.
let knownToolIds = AGENT_TOOLS;
export const knownTools = () => knownToolIds;

// The same snapshot with each tool's record (effects, risk, trust), installed
// by the renderer so a picker can offer only what the node can actually hold —
// an aiStep may be granted read-effect tools and nothing else (§6.4), and a
// checkbox for a tool the runtime will drop is the "silently does nothing"
// failure this codebase keeps writing tests against.
let toolRecords = [];
export const toolCatalog = () => toolRecords;
export function setToolCatalog(records) {
  toolRecords = Array.isArray(records) ? records : [];
  return toolRecords;
}
// Ids a node of this type may be granted.
export function grantableTools(type) {
  if (!toolRecords.length) return knownTools();
  const usable = type === 'agentTask'
    ? toolRecords
    : toolRecords.filter(t => (t.effects ?? []).every(e => e === 'read'));
  return usable.filter(t => t.enabled !== false).map(t => t.id);
}

// A ceiling is a toolset id, a selector, a literal list, or absent. Stored as
// written (a string stays a string) so the file reads like it was authored.
export function normalizeCeiling(value) {
  if (Array.isArray(value)) {
    const list = value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
    return list.length ? list : null;
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function setKnownTools(ids) {
  knownToolIds = Array.isArray(ids) && ids.length ? [...new Set(ids.map(String))] : AGENT_TOOLS;
  return knownToolIds;
}

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
  'plan-backlog': [
    { id: 'tasks', label: 'tasks', description: 'Backlog task records (strict JSON) a loop node can enqueue.' }
  ],
  compare: [
    { id: 'report', label: 'comparison', description: 'Differences, per-alternative strengths/weaknesses, and a keep-the-best recommendation.' }
  ],
  translate: [
    { id: 'result', label: 'translation', description: 'The translated text.' }
  ],
  refine: [
    { id: 'prompt', label: 'refined prompt', description: 'The user request rewritten into a precise, self-contained brief.' },
    { id: 'questions', label: 'questions', description: 'Clarifying questions (JSON) — present only when an ambiguity would materially change the work.' }
  ],
  // The interrogation node. `spec` is the deliverable; `transcript` is the
  // evidence for it — every question asked and every answer given, in order,
  // so the spec can be argued with rather than merely believed.
  interrogate: [
    { id: 'spec', label: 'spec', description: 'The settled specification: goal, non-goals, constraints, deliverable, acceptance, open questions.' },
    { id: 'transcript', label: 'transcript', description: 'The interrogation itself — every round of questions and the answers given.' },
    { id: 'open', label: 'open', description: 'What is still unsettled: assumptions taken and questions the rounds ran out before asking.' },
    { id: 'questions', label: 'questions', description: 'The current round of questions (JSON), while the run is parked at the input gate.' }
  ],
  // The orientation node (D38). `summary` is capped in code, not by
  // instruction: it reaches every lane of a fan-out, and a detailed shared
  // prior collapses the divergence a fan-out exists to produce (D36 point 4).
  orient: [
    { id: 'context', label: 'context', description: 'What this project is, and its relationship to the subject being read. The full context file.' },
    { id: 'summary', label: 'summary', description: 'The same orientation in ≤120 words — safe to hand to every lane of a fan-out.' },
    { id: 'stance', label: 'stance', description: 'The structured stance (JSON): relation, confidence, mission, focus, ignore, assumptions.' },
    { id: 'questions', label: 'questions', description: 'Clarifying questions (JSON) — present only when an ambiguity would materially change what the flow is for.' }
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
  fanout: [
    { id: 'results', label: 'results', description: 'Every lane\'s output, one labelled section per lane.' },
    { id: 'lanes', label: 'lanes', description: 'The lane roster: label, id, model and intent for each lane that ran.' },
    // Written only under `plan: auto` (DECISIONS.md D37). Both are empty on a
    // fan-out that runs its authored roster, the same way an orchestrator's
    // `summary` port is empty until it has planned.
    { id: 'brief', label: 'brief', description: 'Why these lanes: the mission, what was treated as central, and each lane\'s reason for existing.' },
    { id: 'peek', label: 'peek', description: 'The bounded read-only look at the subject that the lane planner read before choosing the roster.' }
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
  if (isContainerType(node?.type)) return true;
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
  'evaluation', 'combine', 'split', 'analyze', 'translate', 'compare',
  // The flow -> backlog contract (D36): turns a plan into work the
  // supervisor can claim. Strict JSON, like plan-eval.
  'plan-backlog',
  // The prompt refiner (DECISIONS.md D27): rewrites the run request into a
  // precise brief, and may park the run with clarifying questions.
  'refine',
  // Orientation (D38): what THIS workspace is and how it relates to the subject
  // a flow is about to read. Holds read-only tools and, like refine, may park
  // the run with clarifying questions.
  'orient',
  // Interrogation (D46): the refiner's opposite. Asks the person several
  // bounded rounds of questions and only then writes the specification.
  'interrogate'
];

// --- Interrogation rounds ----------------------------------------------------
//
// How many times ONE node may park the run to ask. `refine` and `orient` get
// exactly one round each — for them a question is an exception, and a second
// one means the first was asked badly. `interrogate` is the node whose whole
// job is the asking, so it gets several; the ceiling is low on purpose, because
// the failure mode of an interrogation is not asking too little, it is becoming
// a questionnaire nobody finishes.
export const DEFAULT_QUESTION_ROUNDS = 3;
export const MAX_QUESTION_ROUNDS = 5;
export function normalizeRounds(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, MAX_QUESTION_ROUNDS);
}
// The rounds a node actually gets: its own `maxRounds`, else one per role.
export function questionRoundsFor(node) {
  const role = node?.data?.role ?? node?.role ?? null;
  if (role !== 'interrogate') return 1;
  return normalizeRounds(node?.data?.maxRounds ?? node?.maxRounds) ?? DEFAULT_QUESTION_ROUNDS;
}

// The four (minimum) categories used by plan-eval nodes to drive model selection
// and template choice. Extend only after updating FLOW_NODES.md and config examples.
// --- The deliverable/effect contract (WR-01) --------------------------------
//
// What a node owes before it may call itself done. The modes and their
// normalization live HERE rather than in core/effect.js because both the
// renderer (authoring, node inspector) and the engine need them, and
// core/effect.js reaches for node:fs and node:child_process to measure a
// workspace — importing that into the renderer bundle would break the build.
// core/effect.js imports these; the measurement stays on the engine side.
//
//   artifact         a non-empty deliverable; no repository change required.
//   workspace-change a non-empty change in the bound project, within scope.
//   either           one or the other.
//   none             structural/control nodes that claim no deliverable.
export const EFFECT_MODES = ['artifact', 'workspace-change', 'either', 'none'];

export function normalizeEffect(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (EFFECT_MODES.includes(v)) return v;
  // Spellings a plan or a hand-edited flow will produce.
  if (['workspace', 'change', 'code', 'diff'].includes(v)) return 'workspace-change';
  if (['text', 'output', 'markdown', 'doc'].includes(v)) return 'artifact';
  return null;
}

// The optional path globs a required change must land inside, so a task cannot
// satisfy "change the application" by writing an unrelated note.
export function normalizeEffectScope(value) {
  const list = Array.isArray(value) ? value
    : typeof value === 'string' && value.trim() ? [value] : [];
  const out = list.map(s => String(s ?? '').trim()).filter(Boolean);
  return out.length ? out : null;
}

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
// The ANSWER budget — how much deliverable a node at this effort may write.
export const EFFORT_MAX_TOKENS = { low: 2048, medium: 4096, high: 8192 };

// Room for the model to think in, on top of the answer budget (D40).
//
// `max_tokens` bounds the WHOLE completion, and on a reasoning model most of a
// completion is reasoning the caller never sees. Sending the answer budget as
// max_tokens therefore hands a thinking model a budget it can exhaust before
// writing its first visible character — which is not a hypothetical:
//
//   deepseek-v4-pro-0813, max_tokens 4096 (this app's `medium`):
//     0 characters of answer, 4096 reasoning tokens, finish_reason "length", 69s
//   the same model, same question, max_tokens 12288:
//     311 characters of answer, 939 reasoning tokens, finish_reason "stop", 18s
//
// Note the second line: given room, it thought LESS. A tight budget does not
// buy a shorter answer, it buys a model that reasons until it is cut off and
// returns nothing. Four evenings of fan-out runs died on exactly that, reported
// as "returned an empty response".
//
// Headroom is free when it is not used — max_tokens is a ceiling, and billing
// is per token actually generated — so a model that does not reason is
// unaffected by this.
export const REASONING_HEADROOM = 8192;

// What to put on the wire for a node at this effort. Nodes that declare no
// effort get the default one rather than the adapter's bare 4096, because
// "unset" is where the same starvation was hiding for every non-lane node —
// the `combine` step that merges a fan-out sets no effort and failed the same
// way.
export function effortBudget(effort) {
  return (EFFORT_MAX_TOKENS[effort] ?? EFFORT_MAX_TOKENS[DEFAULT_EFFORT]) + REASONING_HEADROOM;
}

// The Work node's task types are exactly the model-selection categories.
export const WORK_CATEGORIES = NODE_CATEGORIES;

// Per-task-type tool grants for the Work node (template id 'work'):
// Test-creation is the one that runs commands, so it alone gets bash and
// ships with the per-call approval gate on by default.
//
// read_tool_result is on every list because a truncated result the node
// cannot read the rest of is worse than no truncation at all (DESIGN-SPEC.md §5):
// it is read-effect, run-scoped, and can only reach results this same run
// already produced — so granting it widens nothing.
//
// `glob` is on every list for the reason its own header gives: "a model that
// cannot list guesses paths". It was built and then granted to nobody, so every
// work node had `read_file` and no way to find out what to read. Watched live:
// an agent looking for one file tried the repository root, `src/`, `backend/`,
// `lib/`, `packages/` and `python/` one read at a time, then invented a
// `list_files` tool that does not exist here. Read-effect, workspace-confined,
// safe — it widens nothing either.
// `search_references` is on every list for the same reason `glob` is, one level
// out: a task LEARNED from another repository (§16) names that repository's
// files, and `read_file` already opens them through the `reference:<name>/…`
// prefix — but only if the node can find out what to open. Without the search
// half the agent knows a reference exists, cannot grep it, and falls back to
// guessing paths in the wrong tree. Read-effect and confined to the read-only
// library, so it widens nothing either.
//
// `search_files` is on every list for the reason `glob` is, one level in: glob
// finds files by NAME and read_file opens a path you already know, so locating
// a symbol inside a large file meant reading it in windows until the budget ran
// out. Watched exactly that — a task spent forty rounds and fifty-eight reads
// on three large files, wrote nothing, and named the missing tool in its own
// failure report ("grep for the exact function name"). Read-effect and
// workspace-confined, so it widens nothing.
export const WORK_TOOLS = {
  'Test-creation': ['read_file', 'glob', 'search_files', 'search_references', 'create_file', 'write_file', 'bash', 'create_task', 'write_task_md', 'read_tool_result'],
  default: ['read_file', 'glob', 'search_files', 'search_references', 'create_file', 'write_file', 'write_task_md', 'read_tool_result']
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
// Pinned nodes the author does not build or delete: the two ends of a flow,
// and the run-inputs node, which exists only because the flow declared inputs.
export const isStructuralType = t => t === 'input' || t === 'output' || t === 'inputs';
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
    description: 'Merge parallel upstream outputs — complementary parts or alternative attempts at the same task — into one coherent deliverable, keeping the best of each; small fixes inline, larger gaps become fix tasks.',
    defaultData: () => ({ title: 'Combine', role: 'combine', effort: DEFAULT_EFFORT, system: '' })
  },
  'compare': {
    label: 'Compare',
    baseType: 'aiStep',
    role: 'compare',
    category: null,
    icon: '⇄',
    description: 'Compare multiple upstream alternatives (same task done by different models, drafts, plans): agreements, differences, per-alternative strengths, and a keep-the-best recommendation.',
    defaultData: () => ({ title: 'Compare', role: 'compare', effort: DEFAULT_EFFORT, system: '' })
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
  // An UNRESOLVED template instance has neither a type nor a templateName —
  // it is just { id, templateId, overrides } straight off a .flow.yaml. This
  // function claims to be total, so it falls back to the template id and then
  // the node id rather than returning undefined.
  return byTemplate || TYPE_META[node.type]?.label || node.type || node.templateId || node.id;
}

// The card's second line. `worker: false` drops the model from the text — the
// flow editor renders it as a clickable badge instead (D36 P0.4), and the same
// id twice on one card is noise. The run canvas keeps the full string.
export function nodeSub(node, { worker: showWorker = true } = {}) {
  const d = node.data || {};
  const w = d.worker;
  // 'auto' = an active-models pick, resolved per provider priority at call time.
  const workerText = w?.provider === 'auto' ? w.model : w?.provider ? `${w.provider}/${w.model}` : 'default worker';
  const suffix = showWorker ? ` · ${workerText}` : '';
  const cat = d.category ? `${d.category} · ` : '';
  // Non-default effort is worth a glance on the card; medium stays quiet.
  const eff = d.effort && d.effort !== DEFAULT_EFFORT ? ` · ${d.effort} effort` : '';

  // Library template instances: show template name + effective worker.
  if (d.templateId) return `${cat}${d.templateName ?? d.templateId}${suffix}${eff}`;

  // Legacy catalog nodes (generated nodes carry data.template)
  const tmpl = d.template ? NODE_TEMPLATES[d.template] : null;
  if (tmpl) {
    return `${cat}${tmpl.label}${suffix}`;
  }
  if (node.type === 'aiStep') {
    const role = d.role ?? 'custom';
    return `${cat}${role}${suffix}`;
  }
  if (node.type === 'agentTask') return `task${suffix}`;
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
    id: 'prompt-refiner', name: 'Prompt refiner', category: null, icon: '✍',
    baseType: 'aiStep', role: 'refine', effort: 'medium',
    description: 'Rewrites the run request into a precise, self-contained brief (goal, constraints, deliverable, acceptance). Asks clarifying questions only when an ambiguity would materially change the work.'
  },
  {
    // D38. Deliberately cheap — medium effort, read-only tools — because it
    // exists so the expensive steps after it are aimed. `glob` is what lets it
    // see a project rather than guess at one.
    id: 'orient', name: 'Orient', category: null, icon: '⌖',
    baseType: 'aiStep', role: 'orient', effort: 'medium',
    tools: ['glob', 'search_files', 'read_file', 'search_references'],
    description: 'Surveys the workspace this run is standing in and says what it is, and what relationship it has to the subject the flow is about to read. Everything downstream is aimed by its answer.'
  },
  {
    // D46. The refiner's opposite number, and the reason both exist: `refine`
    // is told to resolve ambiguity itself and ask only when it must, which is
    // right when the request is already clear and wrong when it is an idea. Put
    // a half-formed idea through the refiner and it does not ask — it invents
    // the missing half as an assumption and hands the flow a confident brief
    // for work nobody wanted. This node asks first and writes second.
    // It reads before it asks, for the reason `orient` does: a question the
    // repository already answers is a round spent, and the person answering it
    // knows the answer was on disk. Watched it, live — two good rounds, and
    // then a specification whose assumptions invented a command name, a config
    // filename and four field names, every one of them checkable here.
    // Bounded like orient's: enough to check what it is about to assert, not
    // enough to audit the project before the first question.
    id: 'interrogate', name: 'Interrogate', category: null, icon: '?',
    baseType: 'aiStep', role: 'interrogate', effort: 'medium',
    maxRounds: DEFAULT_QUESTION_ROUNDS,
    tools: ['glob', 'search_files', 'read_file', 'search_references'],
    maxToolIterations: 8,
    description: 'Interrogates the person behind the request over several bounded rounds — goal, non-goals, constraints, acceptance — then writes the specification their answers settled.'
  },
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
    description: 'Merge parallel upstream outputs — complementary parts or alternative attempts at the same task — into one coherent deliverable, keeping the best of each; small fixes inline, larger gaps become fix tasks.'
  },
  {
    // Compare: review multiple alternatives to the same deliverable (e.g. the
    // same task fanned out to two different models) and summarize differences,
    // strengths, and what to keep from each. Pairs with Combine downstream for
    // the best-of merge; requiresApproval on that Combine makes the human the
    // judge — the run pauses with this report on screen.
    id: 'compare', name: 'Compare', category: null, icon: '⇄',
    baseType: 'aiStep', role: 'compare', effort: 'medium',
    description: 'Compare multiple upstream alternatives (same task done by different models, drafts, plans): agreements, differences, per-alternative strengths, and a keep-the-best recommendation.'
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
].map(t => ({ worker: null, instructions: '', tools: null, skills: [], skillToolGrants: [], requiresApproval: false, approveToolCalls: false, ...t }));

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
    ...(Number(tpl.maxToolIterations) > 0
      ? { maxToolIterations: Math.floor(Number(tpl.maxToolIterations)) }
      : {}),
    ...(normalizeRounds(tpl.maxRounds) ? { maxRounds: normalizeRounds(tpl.maxRounds) } : {}),
    evalType: tpl.evalType in EVAL_TYPES ? tpl.evalType : DEFAULT_EVAL_TYPE,
    ...(typeof tpl.language === 'string' && tpl.language.trim() ? { language: tpl.language.trim() } : {}),
    worker: tpl.worker?.provider && tpl.worker?.model
      ? { provider: tpl.worker.provider, model: tpl.worker.model } : null,
    instructions: tpl.instructions ?? '',
    tools: Array.isArray(tpl.tools) ? tpl.tools.filter(t => knownTools().includes(t)) : null,
    // The ceiling is NOT filtered against the known tools: it may name a
    // toolset or a selector (`effects:read`), and it is resolved against the
    // library at run time (core/tools/index.js resolveTools). Absent ⇒ the
    // ceiling is the static grant, which is what keeps every pre-ceiling flow
    // at exactly its present envelope (DESIGN-SPEC.md §5).
    toolCeiling: normalizeCeiling(tpl.toolCeiling),
    // The deliverable contract (WR-01): what "done" requires of this node —
    // an artifact, a change in the bound project, either, or nothing. Absent
    // means inferred from role/category/tools at execution time, which is what
    // keeps every flow authored before the contract existed working unchanged.
    ...(normalizeEffect(tpl.effect) ? { effect: normalizeEffect(tpl.effect) } : {}),
    ...(normalizeEffectScope(tpl.effectScope) ? { effectScope: normalizeEffectScope(tpl.effectScope) } : {}),
    skills: Array.isArray(tpl.skills) ? tpl.skills.map(String) : [],
    skillToolGrants: Array.isArray(tpl.skillToolGrants) ? [...new Set(tpl.skillToolGrants.map(String))] : [],
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
  // Ceiling precedence, narrowest wins: the instance's own, else the
  // template's. Absent from both, the static grant IS the ceiling — resolved
  // downstream rather than materialized here, so a flow file stays honest
  // about what its author actually wrote (DESIGN-SPEC.md §5).
  const toolCeiling = normalizeCeiling(ov.toolCeiling) ?? t?.toolCeiling ?? null;
  // Same narrowest-wins precedence as the ceiling: the instance's own, else
  // the template's, else absent (⇒ inferred downstream).
  const effect = normalizeEffect(ov.effect) ?? t?.effect ?? null;
  const effectScope = normalizeEffectScope(ov.effectScope) ?? t?.effectScope ?? null;
  const skillToolGrants = Array.isArray(ov.skillToolGrants)
    ? [...new Set(ov.skillToolGrants.map(String))]
    : t?.skillToolGrants ?? [];
  const workGate = isWork && (tools ?? []).includes('bash');
  const data = {
    templateId: node.templateId,
    templateName: t?.name ?? node.templateId,
    icon: t?.icon ?? '✦',
    title: ov.title ?? t?.name ?? node.templateId,
    role,
    effort,
    ...(Number(ov.maxToolIterations ?? t?.maxToolIterations) > 0
      ? { maxToolIterations: Math.floor(Number(ov.maxToolIterations ?? t.maxToolIterations)) }
      : {}),
    ...(normalizeRounds(ov.maxRounds ?? t?.maxRounds)
      ? { maxRounds: normalizeRounds(ov.maxRounds ?? t.maxRounds) }
      : {}),
    ...(t?.role === 'evaluation' ? { evalType } : {}),
    ...(role === 'translate' ? { language: ov.language ?? t?.language ?? 'English' } : {}),
    worker: ov.worker ?? t?.worker ?? null,
    ...(instructions ? { instructions } : {}),
    // A `system` override replaces the role's default system prompt wholesale
    // (the runner reads node.data.system). Templates don't carry one, so this
    // is purely an instance/launch-override concern (T8's planner tiering).
    ...(typeof ov.system === 'string' && ov.system.trim() ? { system: ov.system } : {}),
    ...(category ? { category } : {}),
    ...(tools ? { tools } : {}),
    ...(toolCeiling ? { toolCeiling } : {}),
    ...(effect ? { effect } : {}),
    ...(effectScope ? { effectScope } : {}),
    ...((ov.skills ?? t?.skills)?.length ? { skills: ov.skills ?? t.skills } : {}),
    ...(skillToolGrants.length ? { skillToolGrants } : {}),
    requiresApproval: ov.requiresApproval ?? t?.requiresApproval ?? false,
    approveToolCalls: ov.approveToolCalls ?? (workGate ? true : t?.approveToolCalls ?? false),
    ...(t?.outputs?.length ? { outputs: t.outputs } : {}),
    ...(ov.goal ? { goal: ov.goal } : {}),
    ...(ov.contextSpec ? { contextSpec: ov.contextSpec } : {}),
    // expose (DECISIONS.md D27): surfaced on data so the resolved flow the
    // composer consumes carries which fields become ad-hoc run inputs.
    ...(node.expose?.length ? { expose: node.expose } : {}),
    ...(t ? {} : { missingTemplate: true })
  };
  return {
    id: node.id, type, kind: 'ai', position: node.position, data,
    // Containment survives resolution: a template instance can live inside
    // an orchestrator's box like any raw node.
    ...(node.parentId ? { parentId: node.parentId } : {})
  };
}

// Resolve every template instance in a flow against the library. Structural
// (input/output) and already-resolved/legacy nodes pass through unchanged.
//
// launchOverrides (DECISIONS.md D27) is an optional per-node override map
// { [nodeId]: { worker?, effort?, system?, ... } } applied at run start on top
// of each node's stored overrides — launch WINS. It is the single primitive
// behind modes, run inputs, and comparison: all three assemble a map here.
// For a template instance the extra fields merge into `overrides` (so
// resolveInstance layers them over the template); for a raw node they merge
// straight into `data`. Structural input/output nodes are never overridden —
// their data is run content, not configuration.
export function resolveFlow(flow, templates = [], launchOverrides = null) {
  const byId = new Map(templates.map(t => [t.id, t]));
  const lo = launchOverrides && typeof launchOverrides === 'object' ? launchOverrides : null;
  return {
    ...flow,
    nodes: (flow.nodes ?? []).map(n => {
      const extra = lo && lo[n.id] ? lo[n.id] : null;
      if (isInstance(n)) {
        const merged = extra ? { ...n, overrides: { ...(n.overrides ?? {}), ...extra } } : n;
        return resolveInstance(merged, byId.get(n.templateId));
      }
      const hasExpose = Array.isArray(n.expose) && n.expose.length;
      const applyExtra = extra && n.type !== 'input' && n.type !== 'output';
      if (hasExpose || applyExtra) {
        return { ...n, data: {
          ...(n.data ?? {}),
          ...(hasExpose ? { expose: n.expose } : {}),
          ...(applyExtra ? extra : {})
        } };
      }
      return n;
    })
  };
}

// The subset of a node's exposed fields that are actually overridable on it
// Comparison exposure (DECISIONS.md D27). Takes a RESOLVED node (data.expose present). Drops
// any exposed name a node can't accept — the linter flags those, but the
// composer must never render a control that would be rejected at run start.
export function exposedFields(node) {
  const declared = node?.data?.expose ?? node?.expose;
  if (!Array.isArray(declared) || !declared.length) return [];
  const allowed = overridableFields(node);
  const seen = new Set();
  return declared.filter(f => typeof f === 'string' && allowed.has(f) && !seen.has(f) && seen.add(f));
}

// --- Launch overrides: modes, run inputs, comparison (DECISIONS.md D27) --------
//
// The one whitelist of fields a launch override (and therefore a mode override
// and an exposed run input) may set. Everything universal to AI nodes plus the
// per-kind fields, which `overridableFields` gates by node type/role.
export const LAUNCH_OVERRIDE_COMMON = [
  'worker', 'effort', 'maxToolIterations', 'instructions', 'system',
  'requiresApproval', 'approveToolCalls'
];

// The set of fields that may be overridden on ONE node, keyed off its resolved
// shape (type + data.role/category/evalType). Structural input/output nodes
// accept nothing. Used by the runner's launch-override validation (T1) and the
// `expose:` linter (T9), so both agree on what a given node exposes.
export function overridableFields(node) {
  const type = node?.type;
  if (isStructuralType(type)) return new Set();
  const fields = new Set(LAUNCH_OVERRIDE_COMMON);
  const d = node?.data ?? {};
  if (type === 'orchestrator') { fields.add('minNodes'); fields.add('maxNodes'); }
  // A fan-out's shape IS its lanes, so they are the thing worth overriding per
  // config: swap the model set, retarget the template, restate the goal (D36
  // B5 / P2.4). `goal` is already common to every AI node below.
  if (type === 'fanout') { fields.add('lanes'); fields.add('modelSet'); fields.add('template'); }
  // A sub-flow call site is parameterised by which saved config of the inner
  // flow it runs, and by ad-hoc per-inner-node tweaks (D36).
  if (type === 'subflow') { fields.add('flowMode'); fields.add('flowOverrides'); }
  // A loop node's knobs are all about how much autonomy to hand over and for
  // how long — exactly the things worth changing per config (D36).
  if (type === 'loop') {
    for (const f of ['waitFor', 'budgetUsd', 'parallelism', 'maxTasks']) fields.add(f);
  }
  // A work node carries a category; the Evaluation meta-role carries evalType;
  // translate carries a language. Resolved nodes surface these on data.
  if (d.category != null || d.role === 'execute') fields.add('category');
  if (d.evalType != null || d.role === 'evaluation') fields.add('evalType');
  if (d.role === 'translate' || d.language != null) fields.add('language');
  // How many rounds an interrogation gets is the one knob a person actually
  // wants per launch: three for a real idea, one when they already know.
  if (d.role === 'interrogate') fields.add('maxRounds');
  // `tools` is the grant. agentTask nodes hold any of them; an aiStep may hold
  // read-effect ones (a planner that can check the time or read a page plans
  // better — DESIGN-SPEC.md §5), which the linter polices by effect.
  if (type === 'agentTask' || type === 'aiStep') {
    fields.add('tools');
    fields.add('skillToolGrants');
  }
  // `toolCeiling` is the hard limit the grant lives inside. On an orchestrator
  // it is the envelope its generated children inherit (§6.3).
  if (type === 'agentTask' || type === 'aiStep' || isContainerType(type)) fields.add('toolCeiling');
  // The deliverable contract is overridable wherever a node actually claims a
  // deliverable: the same node can be "write the change" in one mode and
  // "describe the change" in another, and that is a config decision (WR-01).
  if (type === 'agentTask' || type === 'aiStep') { fields.add('effect'); fields.add('effectScope'); }
  return fields;
}

// Validate a per-node override map against a RESOLVED flow. Returns an array of
// human-readable error strings (empty = valid). Unknown node id and a field
// not overridable on its node are both errors (T1: reject the start).
export function validateOverrideMap(resolvedFlow, overrides, { label = 'override' } = {}) {
  const errors = [];
  if (overrides == null) return errors;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return [`${label} map must be an object of nodeId -> fields`];
  }
  const byId = new Map((resolvedFlow.nodes ?? []).map(n => [n.id, n]));
  for (const [nodeId, fields] of Object.entries(overrides)) {
    const node = byId.get(nodeId);
    if (!node) { errors.push(`${label}: unknown node "${nodeId}"`); continue; }
    if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
      errors.push(`${label}: node "${nodeId}" must map to an object of fields`);
      continue;
    }
    const allowed = overridableFields(node);
    for (const key of Object.keys(fields)) {
      if (!allowed.has(key)) {
        errors.push(allowed.size
          ? `${label}: "${key}" is not overridable on node "${nodeId}" (allowed: ${[...allowed].join(', ')})`
          : `${label}: node "${nodeId}" (${node.type}) accepts no overrides`);
      }
    }
  }
  return errors;
}

// Layer several per-node override maps into one, later maps winning per field.
// The merge is one level deep on purpose: `worker` is a whole object you pick,
// not a thing to deep-merge. This is precedence made concrete —
// mergeOverrideMaps(modeOverrides, runInputs): run input > mode.
export function mergeOverrideMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [id, fields] of Object.entries(m)) {
      if (!fields || typeof fields !== 'object') continue;
      out[id] = { ...(out[id] ?? {}), ...fields };
    }
  }
  return out;
}

// --- Config diff badges (DECISIONS.md D27) ---------------------------------
//
// diffOverrides answers the one question a config card or picker row must:
// "what does this config actually change?" It diffs a per-node override map
// against Default — the flow as authored on the canvas, passed in RESOLVED
// (resolveFlow(flow, templates) with no launch overrides) so the comparison
// baseline is what a default run would use. Pure; shared by the Configs
// panel, the pickers, and the main-process badge builder.
//
// Returns one entry per visible difference:
//   { nodeId, node, field, kind, from?, to?, text }
// `text` is the human badge, e.g. "work · model: claude-fable-5 → gpt-5",
// "refine · system rewritten", "work · effort: medium → high". Overrides that
// restate the default produce no entry; an override pointing at a deleted
// node yields a single 'unknown-node' entry (the linter also warns).
const DIFF_FIELD_ORDER = [
  'worker', 'effort', 'category', 'evalType', 'language', 'minNodes', 'maxNodes',
  'system', 'instructions', 'tools', 'skillToolGrants', 'requiresApproval', 'approveToolCalls'
];

export function diffOverrides(resolvedFlow, overrides) {
  const entries = [];
  if (!overrides || typeof overrides !== 'object') return entries;
  const byId = new Map((resolvedFlow?.nodes ?? []).map(n => [n.id, n]));
  for (const [nodeId, fields] of Object.entries(overrides)) {
    const node = byId.get(nodeId);
    if (!node) {
      entries.push({ nodeId, node: nodeId, field: null, kind: 'unknown-node', text: `${nodeId} · node not in flow` });
      continue;
    }
    if (!fields || typeof fields !== 'object') continue;
    const title = node.data?.title ?? nodeId;
    const allowed = overridableFields(node);
    const push = (field, text, extra = {}) =>
      entries.push({ nodeId, node: title, field, kind: 'change', text, ...extra });
    const rank = k => { const i = DIFF_FIELD_ORDER.indexOf(k); return i === -1 ? DIFF_FIELD_ORDER.length : i; };
    const keys = Object.keys(fields)
      .filter(k => fields[k] !== undefined)
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const field of keys) {
      const value = fields[field];
      const cur = node.data?.[field];
      if (!allowed.has(field)) {
        entries.push({ nodeId, node: title, field, kind: 'not-overridable', text: `${title} · ${field}: not overridable` });
        continue;
      }
      if (field === 'worker') {
        // Badges name the model (the spec's "model: claude-fable-5 → gpt-5");
        // 'default' marks the flow's own pick (template/app default).
        const from = cur?.model ?? 'default';
        const to = value?.model ?? 'default';
        if (from !== to) push(field, `${title} · model: ${from} → ${to}`, { from, to });
      } else if (field === 'system') {
        if ((cur ?? '') !== (value ?? '')) push(field, `${title} · system rewritten`);
      } else if (field === 'instructions') {
        if ((cur ?? '') !== (value ?? '')) push(field, `${title} · instructions rewritten`);
      } else if (field === 'tools') {
        if (JSON.stringify(cur ?? null) !== JSON.stringify(value ?? null)) push(field, `${title} · tools changed`);
      } else {
        if (cur !== value) push(field, `${title} · ${field}: ${cur ?? 'default'} → ${value}`, { from: cur ?? null, to: value });
      }
    }
  }
  return entries;
}
