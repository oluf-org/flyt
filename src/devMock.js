// Browser-only fallback for window.llmflow so the renderer can be previewed
// (and the design iterated on) outside Electron. Never active in the app:
// installed only when the preload bridge is missing.

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
      planner: { status: 'ok', confidence: 0.92, model: { provider: 'openai', model: 'gpt-4o' }, durationMs: 1900, problems: [] },
      router: { status: 'ok', confidence: 0.88, model: { provider: 'anthropic', model: 'claude-haiku-4-5' }, durationMs: 640, problems: [] }
    },
    taskOutputs: { 'task-1': 'Shell scaffolded with responsive layout.' }
  },
  'run-20260712-093004': {
    meta: { runId: 'run-20260712-093004', stage: 'awaiting_approval', currentTaskId: null, error: null },
    prompt: 'Summarize the quarterly report and draft an email to stakeholders.',
    plan: '# Plan\n\n1. Extract key figures\n2. Draft summary\n3. Compose email',
    tasks: null,
    retrospectives: {
      planner: { status: 'ok', confidence: 0.85, model: { provider: 'openai', model: 'gpt-4o' }, durationMs: 2300, problems: [] }
    },
    taskOutputs: {}
  }
};

// In-memory stand-ins for the settings/models IPC surface.
const mockSettings = {
  hasKey: false,
  workers: {
    planner:  { provider: 'mock', model: 'mock-large' },
    router:   { provider: 'mock', model: 'mock-small' },
    executor: { provider: 'mock', model: 'mock-large' },
    verifier: { provider: 'mock', model: 'mock-small' }
  }
};
const mockModels = [
  { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', contextLength: 128000, supportsTools: true },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', contextLength: 200000, supportsTools: true },
  { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct', contextLength: 131072, supportsTools: false }
];

// In-memory flow store mirroring core/flowstore.js.
const mockFlows = {
  'flow-demo': {
    id: 'flow-demo',
    name: 'Demo flow',
    nodes: [
      { id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: { text: 'Write a launch tweet for LLM Flow.' } },
      { id: 'task-a', type: 'agentTask', kind: 'user', position: { x: 0, y: 130 }, data: { title: 'Draft tweet', goal: 'Draft a 280-char tweet', constraints: [], worker: { provider: 'mock', model: 'mock-large' } } },
      { id: 'output-1', type: 'output', kind: 'user', position: { x: 0, y: 260 }, data: {} }
    ],
    edges: [
      { id: 'e-input-1-task-a', source: 'input-1', target: 'task-a' },
      { id: 'e-task-a-output-1', source: 'task-a', target: 'output-1' }
    ]
  }
};
const mockBuiltinFlow = () => ({
  id: 'builtin-linear', name: 'Linear pipeline', builtin: true,
  nodes: [
    { id: 'brief', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: { title: 'Brief', text: '' } },
    { id: 'planner', type: 'aiStep', kind: 'ai', position: { x: 0, y: 110 }, data: { title: 'Planning', role: 'plan', system: '' } },
    { id: 'verifier', type: 'aiStep', kind: 'ai', position: { x: 0, y: 220 }, data: { title: 'Verification', role: 'verify', system: '' } },
    { id: 'result', type: 'output', kind: 'user', position: { x: 0, y: 330 }, data: { title: 'Result' } }
  ],
  edges: [
    { id: 'e1', source: 'brief', target: 'planner' },
    { id: 'e2', source: 'planner', target: 'verifier' },
    { id: 'e3', source: 'verifier', target: 'result' }
  ]
});

export function installDevMock() {
  window.llmflow = {
    listRuns: async () => Object.keys(snapshots).sort(),
    getSnapshot: async id => snapshots[id] ?? null,
    startRun: async () => Object.keys(snapshots).sort().at(-1),
    approvePlan: async () => {},
    rejectPlan: async () => {},
    openRunFolder: async () => {},
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
    listFlows: async () => [
      { id: 'builtin-linear', name: 'Linear pipeline', builtin: true },
      ...Object.values(mockFlows).map(f => ({ id: f.id, name: f.name, builtin: false }))
    ],
    loadFlow: async id => id === 'builtin-linear' ? mockBuiltinFlow() : structuredClone(mockFlows[id]),
    saveFlow: async flow => { mockFlows[flow.id] = structuredClone(flow); return flow; },
    newFlow: async () => {
      const id = 'flow-' + Date.now().toString(36);
      mockFlows[id] = {
        id, name: 'Untitled flow',
        nodes: [{ id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: { text: '' } }],
        edges: []
      };
      return structuredClone(mockFlows[id]);
    },
    deleteFlow: async id => { delete mockFlows[id]; },
    runFlow: async () => Object.keys(snapshots).sort().at(-1)
  };
}
