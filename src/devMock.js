// Browser-only fallback for window.llmflow so the renderer can be previewed
// (and the design iterated on) outside Electron. Never active in the app:
// installed only when the preload bridge is missing.
import { SEED_NODE_TEMPLATES, normalizeTemplate } from './flowTypes.js';

const snapshots = {
  'run-20260712-101512': {
    meta: { runId: 'run-20260712-101512', stage: 'execution', currentTaskId: 'task-2', error: null },
    prompt: 'Build a small web app to track daily habits and show weekly streaks. Clean, mobile-first.',
    plan: '# Plan\n\n1. Scaffold mobile-first shell\n2. Habit & entry data model\n3. Weekly streak calculation\n4. Tests, polish, deploy',
    tasks: {
      tasks: [
        { id: 'task-1', title: 'Scaffold mobile-first shell', goal: 'Create the base layout and navigation.', status: 'done', worker: { provider: 'openai', model: 'gpt-4o' }, constraints: [], dependsOn: [] },
        { id: 'task-2', title: 'Habit & entry data model', goal: 'Design the local-first data model.', status: 'running', worker: { provider: 'anthropic', model: 'claude-sonnet-5' }, constraints: ['local-first'], dependsOn: ['task-1'] },
        { id: 'task-3', title: 'Weekly streak calculation', goal: 'Compute streaks per habit per week.', status: 'pending', worker: { provider: 'anthropic', model: 'claude-haiku-4-5' }, constraints: [], dependsOn: ['task-2'] }
      ]
    },
    retrospectives: {
      'executor-task-1': {
        status: 'success', confidence: 0.75, problems: [],
        model: { provider: 'openai', model: 'gpt-4o' }, durationMs: 5400,
        recommendation: 'Task "Scaffold mobile-first shell" completed using 2 tool call(s).',
        toolCalls: [
          { tool: 'write_task_md', args: { content: '# Spec — shell scaffold…' }, ok: true, result: { written: 'tasks/task-1.spec.md' }, ms: 3 },
          { tool: 'write_file', args: { path: 'src/App.jsx', content: '…' }, ok: false, error: 'Invalid arguments: args.content: required property missing', ms: 1 }
        ]
      }
    },
    taskOutputs: { 'task-1': 'Shell scaffolded with responsive layout.' }
  },
  // A flow run mid-orchestration: the container has planned, its children are
  // running — previews the nested box + the animated active border.
  'run-20260714-091500': {
    meta: {
      runId: 'run-20260714-091500', stage: 'execution', error: null,
      flowId: 'orch-demo', flowName: 'Orchestrated build',
      nodeStatus: { in: 'done', orch: 'active', w1: 'done', w2: 'active', w3: 'pending', out: 'pending' }
    },
    prompt: 'Add CSV export to the reporting page, with tests and docs.',
    flow: {
      id: 'orch-demo', name: 'Orchestrated build',
      nodes: [
        { id: 'in', type: 'input', kind: 'user', position: { x: 130, y: 0 }, data: {} },
        { id: 'orch', type: 'orchestrator', kind: 'ai', position: { x: 40, y: 120 },
          data: { title: 'Orchestrator', box: { w: 522, h: 270 } } },
        { id: 'w1', type: 'aiStep', kind: 'ai', parentId: 'orch', extent: 'parent', position: { x: 22, y: 58 },
          data: { title: 'Export service', role: 'execute', category: 'Code general', managedBy: 'orch', generatedBy: 'orch' } },
        { id: 'w2', type: 'aiStep', kind: 'ai', parentId: 'orch', extent: 'parent', position: { x: 272, y: 58 },
          data: { title: 'CSV formatter', role: 'execute', category: 'Code design', managedBy: 'orch', generatedBy: 'orch' } },
        { id: 'w3', type: 'aiStep', kind: 'ai', parentId: 'orch', extent: 'parent', position: { x: 147, y: 154 },
          data: { title: 'Export docs', role: 'execute', category: 'documentation', managedBy: 'orch', generatedBy: 'orch' } },
        { id: 'out', type: 'output', kind: 'user', position: { x: 130, y: 440 }, data: {} }
      ],
      edges: [
        { id: 'e-in-orch', source: 'in', target: 'orch' },
        { id: 'gen-e-orch-w1', source: 'orch', target: 'w1', generatedBy: 'orch' },
        { id: 'gen-e-orch-w2', source: 'orch', target: 'w2', generatedBy: 'orch' },
        { id: 'gen-e-w1-w3', source: 'w1', target: 'w3', generatedBy: 'orch' },
        { id: 'gen-e-w2-w3', source: 'w2', target: 'w3', generatedBy: 'orch' },
        { id: 'e-orch-out', source: 'orch', target: 'out' }
      ]
    },
    retrospectives: {},
    nodeOutputs: {
      w1: 'Export service implemented.',
      orch_plan: '```json\n{ "nodes": [ … ], "summary": "Three nodes: service, formatter, docs." }\n```'
    }
  }
};

// In-memory stand-ins for the settings/models IPC surface.
const mockSettings = {
  hasKey: false,
  workers: {
    executor: { provider: 'mock', model: 'mock-large' }
  }
};
const mockModels = [
  { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', contextLength: 128000, supportsTools: true },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', contextLength: 200000, supportsTools: true },
  { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct', contextLength: 131072, supportsTools: false }
];

// In-memory Node Library mirroring core/nodestore.js (seed catalog).
const mockTemplates = new Map(SEED_NODE_TEMPLATES.map(t => [t.id, structuredClone(t)]));

// In-memory flow store mirroring core/flowstore.js, incl. the shipped
// Default pipeline built from Node Library templates.
const mockFlows = {
  'default-pipeline': {
    id: 'default-pipeline',
    name: 'Default pipeline',
    nodes: [
      { id: 'user-input', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'plan', templateId: 'plan-start', position: { x: 0, y: 130 }, overrides: { title: 'Planning' } },
      { id: 'route', templateId: 'plan-eval', position: { x: 0, y: 260 }, overrides: { title: 'Routing', requiresApproval: true } },
      { id: 'verify', templateId: 'final-eval', position: { x: 0, y: 390 }, overrides: { title: 'Verification' } },
      { id: 'result', type: 'output', kind: 'user', position: { x: 0, y: 520 }, data: {} }
    ],
    edges: [
      { id: 'e-user-input-plan', source: 'user-input', target: 'plan' },
      { id: 'e-plan-route', source: 'plan', target: 'route' },
      { id: 'e-route-verify', source: 'route', target: 'verify' },
      { id: 'e-verify-result', source: 'verify', target: 'result' }
    ]
  }
};

export function installDevMock() {
  window.llmflow = {
    listRuns: async () => Object.keys(snapshots).sort(),
    getSnapshot: async id => snapshots[id] ?? null,
    approvePlan: async () => {},
    rejectPlan: async () => {},
    openRunFolder: async () => {},
    pickWorkspace: async () => null, // no native folder picker in the browser dev shell
    openWorkspace: async () => {},
    onRunUpdate: () => () => {},
    getConfig: async () => ({ workers: structuredClone(mockSettings.workers) }),
    getSettings: async () => structuredClone(mockSettings),
    setSettings: async (patch = {}) => {
      if (typeof patch.openrouterApiKey === 'string' && patch.openrouterApiKey.trim()) mockSettings.hasKey = true;
      if (patch.workers) Object.assign(mockSettings.workers, structuredClone(patch.workers));
      return structuredClone(mockSettings);
    },
    listModels: async () => {
      if (!mockSettings.hasKey) throw new Error('No OpenRouter API key saved. Add one in Settings first.');
      return mockModels;
    },
    listFlows: async () => Object.values(mockFlows).map(f => ({ id: f.id, name: f.name })),
    loadFlow: async id => structuredClone(mockFlows[id]),
    saveFlow: async flow => { mockFlows[flow.id] = structuredClone(flow); return flow; },
    newFlow: async () => {
      const id = 'flow-' + Date.now().toString(36);
      mockFlows[id] = {
        id, name: 'Untitled flow',
        nodes: [
          { id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
          { id: 'step-1', templateId: 'code-general-step', position: { x: 0, y: 130 }, overrides: {} },
          { id: 'output-1', type: 'output', kind: 'user', position: { x: 0, y: 260 }, data: {} }
        ],
        edges: [
          { id: 'e-input-1-step-1', source: 'input-1', target: 'step-1' },
          { id: 'e-step-1-output-1', source: 'step-1', target: 'output-1' }
        ]
      };
      return structuredClone(mockFlows[id]);
    },
    deleteFlow: async id => { delete mockFlows[id]; },
    runFlow: async () => Object.keys(snapshots).sort().at(-1),
    listNodeTemplates: async () => [...mockTemplates.values()].map(t => normalizeTemplate(structuredClone(t)))
      .sort((a, b) => a.name.localeCompare(b.name)),
    saveNodeTemplate: async tpl => { mockTemplates.set(tpl.id, structuredClone(tpl)); return tpl; },
    newNodeTemplate: async () => {
      const tpl = normalizeTemplate({ id: 'node-' + Date.now().toString(36), name: 'Untitled node' });
      mockTemplates.set(tpl.id, tpl);
      return structuredClone(tpl);
    },
    deleteNodeTemplate: async id => { mockTemplates.delete(id); }
  };
}
