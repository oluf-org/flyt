// Browser-only fallback for window.llmflow so the renderer can be previewed
// (and the design iterated on) outside Electron. Never active in the app:
// installed only when the preload bridge is missing.
import { SEED_NODE_TEMPLATES, normalizeTemplate } from './flowTypes.js';

const snapshots = {
  // A finished flow run with one follow-up turn: previews the thread view +
  // composer in RunResult and the turn badges on the canvas (FOLLOWUP-PLAN).
  'run-20260716-142200': {
    meta: {
      runId: 'run-20260716-142200', stage: 'done', error: null, turn: 1,
      flowId: 'default-pipeline', flowName: 'Default pipeline',
      nodeStatus: {
        in: 'done', work: 'done', out: 'done',
        'fu1-input': 'done', 'fu1-patch': 'done', 'fu1-review': 'done'
      }
    },
    prompt: 'Write a landing page hero section for the habit tracker.',
    flow: {
      id: 'default-pipeline', name: 'Default pipeline',
      nodes: [
        { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
        { id: 'work', type: 'aiStep', kind: 'ai', position: { x: 0, y: 120 }, data: { title: 'Write hero', role: 'execute' } },
        { id: 'out', type: 'output', kind: 'user', position: { x: 0, y: 240 }, data: {} },
        { id: 'fu1-input', type: 'input', kind: 'user', position: { x: 220, y: 120 },
          data: { title: 'Follow-up 1', text: 'Make the headline punchier.', origin: 'followup', turn: 1 } },
        { id: 'fu1-patch', type: 'aiStep', kind: 'ai', position: { x: 220, y: 240 },
          data: { title: 'Punch up headline', role: 'execute', category: 'Code general', origin: 'followup', turn: 1, generatedBy: 'fu1-input' } },
        { id: 'fu1-review', type: 'aiStep', kind: 'ai', position: { x: 220, y: 360 },
          data: { title: 'Feedback review 1', role: 'feedback-review', origin: 'followup', turn: 1 } }
      ],
      edges: [
        { id: 'e-in-work', source: 'in', target: 'work' },
        { id: 'e-work-out', source: 'work', target: 'out' },
        { id: 'fu1-e-work-patch', source: 'work', target: 'fu1-patch' },
        { id: 'fu1-e-input-patch', source: 'fu1-input', target: 'fu1-patch' },
        { id: 'fu1-e-patch-review', source: 'fu1-patch', target: 'fu1-review' },
        { id: 'fu1-e-input-review', source: 'fu1-input', target: 'fu1-review' }
      ]
    },
    retrospectives: {},
    nodeOutputs: {
      out: '# Result — Default pipeline\n\nBuild habits that stick.\nTrack today, see your streaks grow all week.',
      'fu1-patch': 'New headline: "Small habits. Big streaks."',
      'fu1-review': 'The revised headline is shorter and punchier, as requested.\n\n```json\n{ "verdict": "solved", "reason": "Headline tightened per feedback." }\n```'
    },
    followups: [
      {
        turn: 1,
        prompt: 'Make the headline punchier.',
        triage: { class: 'fix', reason: 'Small copy tweak to the produced hero.', contextNodes: ['work'] },
        answer: null
      }
    ]
  },
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
      nodeStatus: { in: 'done', orch: 'active', w1: 'done', w2: 'active', w3: 'pending', out: 'pending' },
      // Per-edge context sizes (chars) the runner would record — spread across
      // buckets so the edge-weight preview shows thin→thick (flare 3).
      edgeContext: { 'e-in-orch': 250, 'gen-e-w1-w3': 6500, 'gen-e-w2-w3': 0, 'e-orch-out': 1800 }
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

// Mirrors RunStore.runSummaries(): the list needs a name, a date and a stage,
// not just an id. The fixtures are dated relative to now so the date sections
// are actually exercised when previewing the list in a browser.
const runNameOverrides = {};
const mockRunAge = { 'run-20260716-142200': 0, 'run-20260714-091500': 0, 'run-20260712-101512': 3 }; // days ago
const derivedName = id => (snapshots[id]?.prompt ?? '').split('\n')[0].trim() || 'Untitled run';
const daysAgo = n => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

export function installDevMock() {
  window.llmflow = {
    listRuns: async () => Object.keys(snapshots)
      .map(id => ({
        id,
        name: runNameOverrides[id] ?? derivedName(id),
        named: id in runNameOverrides,
        createdAt: daysAgo(mockRunAge[id] ?? 0),
        updatedAt: daysAgo(mockRunAge[id] ?? 0),
        stage: snapshots[id].meta?.stage ?? 'unknown',
        flowName: snapshots[id].meta?.flowName ?? null,
        turns: Number(snapshots[id].meta?.turn ?? 0),
        interrupted: Boolean(snapshots[id].meta?.interrupted),
        error: snapshots[id].meta?.error ?? null
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // Same rule as the store: a blank name clears the override rather than
    // storing an empty one, so the prompt-derived name comes back.
    renameRun: async (id, name) => {
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
      if (clean) runNameOverrides[id] = clean; else delete runNameOverrides[id];
      return clean || derivedName(id);
    },
    deleteRun: async id => { delete snapshots[id]; return true; },
    getSnapshot: async id => snapshots[id] ?? null,
    // Synthesize a plausible in-order log from a finished mock run's flow, so the
    // replay scrubber can be previewed in the browser dev shell.
    readRunLog: async id => {
      const snap = snapshots[id];
      if (!snap?.flow) return [];
      const log = [];
      let t = Date.parse(snap.meta?.createdAt) || Date.now();
      const ts = () => { t += 600; return new Date(t).toISOString(); };
      for (const n of snap.flow.nodes) {
        if (n.parentId) continue; // orchestrator children handled with their parent
        log.push({ ts: ts(), event: 'node_start', node: n.id });
        const instant = n.type === 'input' || n.type === 'output';
        if (!instant) {
          const tid = n.data?.taskId;
          if (tid) log.push({ ts: ts(), event: 'node_start', node: `executor:${tid}` });
          log.push({ ts: ts(), event: 'retrospective', node: tid ? `executor-${tid}` : n.id });
        }
      }
      return log;
    },
    approvePlan: async () => {},
    rejectPlan: async () => {},
    resumeRun: async () => {},
    followUpRun: async () => ({ turn: 1 }),
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
