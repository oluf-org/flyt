// Browser-only fallback for window.llmflow so the renderer can be previewed
// (and the design iterated on) outside Electron. Never active in the app:
// installed only when the preload bridge is missing.
import { SEED_NODE_TEMPLATES, normalizeTemplate } from './flowTypes.js';
import { slugFromPrompt, dedupeSlug } from '../core/projectName.js';

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
  },
  // Parked at a danger tool gate — previews the blocking approval dialog, the
  // waiting rail on the gated node, and the gate copy (CHAT-RUN rework).
  'run-20260720-091500': {
    meta: {
      runId: 'run-20260720-091500', stage: 'awaiting_approval', error: null,
      flowId: 'orch-demo', flowName: 'Orchestrated build',
      name: 'CSV export, with tests',
      createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      nodeStatus: { in: 'done', plan: 'done', apply: 'waiting', out: 'pending' },
      pendingGateKind: 'tool',
      pendingToolCall: {
        tool: 'bash',
        summary: 'rm -rf node_modules && npm ci',
        risk: 'danger',
        reason: 'Deletes a directory tree from the project root before reinstalling — irreversible.'
      }
    },
    prompt: 'Reinstall dependencies cleanly and rerun the export tests.',
    flow: {
      id: 'orch-demo', name: 'Orchestrated build',
      nodes: [
        { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
        { id: 'plan', type: 'aiStep', kind: 'ai', position: { x: 0, y: 120 },
          data: { title: 'Plan the reinstall', role: 'plan' } },
        { id: 'apply', type: 'aiStep', kind: 'ai', position: { x: 0, y: 240 },
          data: { title: 'Reinstall & test', role: 'execute' } },
        { id: 'out', type: 'output', kind: 'user', position: { x: 0, y: 360 }, data: {} }
      ],
      edges: [
        { id: 'e-in-plan', source: 'in', target: 'plan' },
        { id: 'e-plan-apply', source: 'plan', target: 'apply' },
        { id: 'e-apply-out', source: 'apply', target: 'out' }
      ]
    },
    retrospectives: {
      plan: { status: 'success', confidence: 0.86, problems: [], recommendation: 'Pin npm ci to the lockfile so the reinstall stays reproducible.' }
    },
    nodeOutputs: {
      plan: 'Plan: wipe node_modules, reinstall from the lockfile, rerun the export test suite.'
    }
  }
};

// In-memory stand-ins for the settings/models IPC surface (PROVIDERS-PLAN shape).
const mockSettings = {
  hasKey: false,
  providers: {
    anthropic: { hasKey: false },
    openai: { hasKey: false },
    kimi: { hasKey: false, keyKind: 'platform' },
    openrouter: { hasKey: false },
    mock: { hasKey: true }
  },
  providerPriority: ['anthropic', 'openai', 'kimi', 'openrouter', 'mock'],
  activeModels: [],
  workers: {
    executor: { provider: 'mock', model: 'mock-large' }
  },
  summary: { connected: 0, activeModelCount: 0 },
  projectStorage: 'workspace',
  approvalMode: 'ask',
  safetyModel: 'auto',
  resolvedSafetyModel: 'mock-small',
  safetyCandidates: [
    { id: 'claude-haiku-4-5', provider: 'anthropic', label: 'Claude Haiku 4.5', connected: false },
    { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna', connected: false },
    { id: 'kimi-k2.6', provider: 'kimi', label: 'Kimi K2.6', connected: false },
    { id: 'moonshotai/kimi-k2.6', provider: 'openrouter', label: 'Kimi K2.6 (OpenRouter)', connected: false },
    { id: 'anthropic/claude-haiku-4.5', provider: 'openrouter', label: 'Claude Haiku 4.5 (OpenRouter)', connected: false },
    { id: 'mock-small', provider: 'mock', label: 'Mock (dry runs only)', connected: true }
  ]
};
const refreshMockSummary = () => {
  mockSettings.summary = {
    connected: ['anthropic', 'openai', 'kimi', 'openrouter'].filter(p => mockSettings.providers[p].hasKey).length,
    activeModelCount: mockSettings.activeModels.filter(m => m.enabled !== false).length
  };
  mockSettings.hasKey = mockSettings.summary.connected > 0;
};
const mockCurated = {
  anthropic: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supportsTools: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsTools: true }
  ],
  openai: [
    { id: 'gpt-5.2', name: 'GPT-5.2', supportsTools: true },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', supportsTools: true }
  ],
  kimi: [
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsTools: true },
    { id: 'kimi-for-coding', name: 'Kimi for Coding', supportsTools: true }
  ]
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
      { id: 'route', templateId: 'evaluation', position: { x: 0, y: 260 }, overrides: { title: 'Routing', evalType: 'plan', requiresApproval: true } },
      { id: 'verify', templateId: 'evaluation', position: { x: 0, y: 390 }, overrides: { title: 'Verification', evalType: 'final' } },
      { id: 'result', type: 'output', kind: 'user', position: { x: 0, y: 520 }, data: {} }
    ],
    edges: [
      { id: 'e-user-input-plan', source: 'user-input', target: 'plan' },
      { id: 'e-plan-route', source: 'plan', target: 'route' },
      { id: 'e-route-verify', source: 'route', target: 'verify' },
      { id: 'e-verify-result', source: 'verify', target: 'result' }
    ]
  },
  // A second flow so the workflow picker has more than one option to preview.
  'quick-fix': {
    id: 'quick-fix',
    name: 'Quick fix',
    nodes: [
      { id: 'user-input', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'fix', templateId: 'work', position: { x: 0, y: 130 }, overrides: { title: 'Fix', category: 'Code general' } },
      { id: 'result', type: 'output', kind: 'user', position: { x: 0, y: 260 }, data: {} }
    ],
    edges: [
      { id: 'e-user-input-fix', source: 'user-input', target: 'fix' },
      { id: 'e-fix-result', source: 'fix', target: 'result' }
    ],
    // Two example modes so the launch picker's expansion (MODES-COMPARE T4) is
    // exercised in the browser preview.
    modes: {
      fable: { name: 'Fable', overrides: { fix: { worker: { provider: 'anthropic', model: 'claude-fable-5' } } } },
      gpt: { name: 'GPT', overrides: { fix: { worker: { provider: 'openai', model: 'gpt-5' } } } }
    }
  }
};

// Mirrors RunStore.runSummaries(): the list needs a name, a date and a stage,
// not just an id. The fixtures are dated relative to now so the date sections
// are actually exercised when previewing the list in a browser.
const runNameOverrides = {};
const mockRunAge = { 'run-20260720-091500': 0, 'run-20260716-142200': 0, 'run-20260714-091500': 0, 'run-20260712-101512': 3 }; // days ago
const derivedName = id => (snapshots[id]?.prompt ?? '').split('\n')[0].trim() || 'Untitled run';
const daysAgo = n => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

// One mock scratch tab plus a bound-looking one, so the tab strip, new-tab
// page and deck can be previewed in a browser. Run-scoped calls take a
// projectId first (matching the preload bridge) and ignore it — the mock has
// one shared run set.
const mockProjects = {
  tabs: [
    { id: 'appdata:fix-auth-flow', folder: null, kind: 'appdata', name: 'fix-auth-flow', live: 0, state: {} },
    { id: 'D:\\demo\\habit-tracker', folder: 'D:\\demo\\habit-tracker', kind: 'folder', name: 'habit-tracker', live: 1, state: {} }
  ],
  active: 'appdata:fix-auth-flow',
  storage: 'workspace'
};
let mockRunCursor = 0; // rotates runFlow over the fixtures (compare preview)
const mockComparisons = []; // in-memory comparison records (P2 preview)
const mockAppdataSlugs = () => new Set(
  mockProjects.tabs.filter(t => t.kind === 'appdata').map(t => t.id.replace(/^appdata:/, '')));

export function installDevMock() {
  window.llmflow = {
    listRuns: async (_pid) => Object.keys(snapshots)
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
    renameRun: async (_pid, id, name) => {
      const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
      if (clean) runNameOverrides[id] = clean; else delete runNameOverrides[id];
      return clean || derivedName(id);
    },
    deleteRun: async (_pid, id) => { delete snapshots[id]; return true; },
    getSnapshot: async (_pid, id) => snapshots[id] ?? null,
    // Synthesize a plausible in-order log from a finished mock run's flow, so the
    // replay scrubber can be previewed in the browser dev shell.
    readRunLog: async (_pid, id) => {
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
    // No OS to nudge in the browser shell — the gate dialog itself is visible.
    signalApprovalGate: async () => {},
    resumeRun: async () => {},
    // Run-control stubs (RUN-CONTROL): the browser shell has no live engine,
    // so these resolve with inert ok payloads — just enough to not crash.
    stopRun: async () => ({ ok: true }),
    pauseRun: async () => ({ ok: true }),
    restartNode: async () => ({ ok: true }),
    branchRun: async (_pid, runId) => ({ ok: true, runId }),
    investigateNode: async () => ({
      ok: true, status: 'done', output: '', retro: null, logTail: [],
      summary: '(mock) This node completed normally.', model: 'mock'
    }),
    followUpRun: async () => ({ turn: 1 }),
    answerInput: async () => ({ ok: true }),
    openRunFolder: async () => {},
    pickWorkspace: async () => null, // no native folder picker in the browser dev shell
    openWorkspace: async () => {},
    onRunUpdate: () => () => {},

    // --- Project tabs (D22) ---
    listProjects: async () => structuredClone(mockProjects),
    openProject: async folder => {
      const id = folder ?? 'default';
      if (!mockProjects.tabs.some(t => t.id === id)) {
        mockProjects.tabs.push({ id, folder, name: String(folder).split(/[\\/]/).pop(), live: 0, state: {} });
      }
      mockProjects.active = id;
      return { ...structuredClone(mockProjects), opened: id };
    },
    // Auto-create an appdata project from the first prompt (L5). Slug derived +
    // deduped exactly as the registry does main-side.
    createProject: async (promptOrName = '') => {
      const slug = dedupeSlug(slugFromPrompt(promptOrName), mockAppdataSlugs());
      const id = 'appdata:' + slug;
      mockProjects.tabs.push({ id, folder: null, kind: 'appdata', name: slug, live: 0, state: {} });
      mockProjects.active = id;
      return { ...structuredClone(mockProjects), opened: id };
    },
    renameProject: async (pid, name) => {
      const t = mockProjects.tabs.find(t => t.id === pid);
      if (t && String(name ?? '').trim()) t.name = String(name).trim();
      return structuredClone(mockProjects);
    },
    // Adopt an appdata project into a folder (Phase 6): swap the tab in place to
    // a bound folder, keeping its position + name.
    adoptProject: async (pid, folder) => {
      const t = mockProjects.tabs.find(t => t.id === pid);
      if (t) { t.id = folder; t.folder = folder; t.kind = 'folder'; } // keep name/position
      if (mockProjects.active === pid) mockProjects.active = folder;
      return { ...structuredClone(mockProjects), oldId: pid, opened: folder };
    },
    closeProject: async pid => {
      const idx = mockProjects.tabs.findIndex(t => t.id === pid);
      if (idx !== -1) {
        mockProjects.tabs.splice(idx, 1);
        // Closing the last tab lands projectless (L6): active = null.
        if (mockProjects.tabs.length === 0) mockProjects.active = null;
        else if (mockProjects.active === pid) mockProjects.active = mockProjects.tabs[Math.min(idx, mockProjects.tabs.length - 1)].id;
      }
      return structuredClone(mockProjects);
    },
    activateProject: async pid => { mockProjects.active = pid; return structuredClone(mockProjects); },
    reorderProjects: async ids => {
      mockProjects.tabs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return structuredClone(mockProjects);
    },
    saveProjectState: async (pid, state) => {
      const t = mockProjects.tabs.find(t => t.id === pid);
      if (t) t.state = state;
    },
    projectRecents: async () => [
      { folder: 'D:\\demo\\habit-tracker', name: 'habit-tracker', exists: true },
      { folder: 'D:\\demo\\reporting', name: 'reporting', exists: true }
    ],
    removeProjectRecent: async () => [],
    pickProjectFolder: async () => null, // no native folder picker in the browser dev shell
    deckData: async () => mockProjects.tabs.map(t => ({
      ...structuredClone(t),
      latestRun: (() => {
        const id = Object.keys(snapshots).sort().at(-1);
        return id ? { id, name: derivedName(id), stage: snapshots[id].meta?.stage ?? 'done' } : null;
      })(),
      topo: {
        nodes: [{ x: 0, y: 0 }, { x: 0, y: 130 }, { x: 0, y: 260 }, { x: 160, y: 130 }],
        edges: [[0, 1], [1, 2], [0, 3], [3, 2]]
      }
    })),
    onProjectActivity: () => () => {},
    onTabsKey: () => () => {},
    getConfig: async () => ({ workers: structuredClone(mockSettings.workers) }),
    getSettings: async () => structuredClone(mockSettings),
    setSettings: async (patch = {}) => {
      if (patch.providerKeys) {
        for (const p of Object.keys(patch.providerKeys)) {
          if (mockSettings.providers[p]) mockSettings.providers[p].hasKey = true;
        }
      }
      if (patch.kimiKeyKind) mockSettings.providers.kimi.keyKind = patch.kimiKeyKind;
      if (Array.isArray(patch.providerPriority)) mockSettings.providerPriority = [...patch.providerPriority];
      if (Array.isArray(patch.activeModels)) mockSettings.activeModels = structuredClone(patch.activeModels);
      if (patch.workers) Object.assign(mockSettings.workers, structuredClone(patch.workers));
      if (patch.projectStorage) mockSettings.projectStorage = patch.projectStorage;
      if (patch.approvalMode) mockSettings.approvalMode = patch.approvalMode;
      if (patch.safetyModel) {
        mockSettings.safetyModel = patch.safetyModel;
        mockSettings.resolvedSafetyModel = patch.safetyModel === 'auto' ? 'mock-small' : patch.safetyModel;
      }
      refreshMockSummary();
      return structuredClone(mockSettings);
    },
    listModels: async (provider = 'openrouter') => {
      if (provider === 'openrouter') {
        if (!mockSettings.providers.openrouter.hasKey) throw new Error('No OpenRouter API key saved. Add one in Settings first.');
        return mockModels;
      }
      return mockCurated[provider] ?? [];
    },
    testProvider: async provider => (
      provider === 'mock' || mockSettings.providers[provider]?.hasKey
        ? { ok: true }
        : { ok: false, error: `No API key saved for ${provider} yet.` }
    ),
    listFlows: async () => Object.values(mockFlows).map(f => ({
      id: f.id, name: f.name,
      ...(f.modes && Object.keys(f.modes).length
        ? { modes: Object.entries(f.modes).map(([id, m]) => ({ id, name: m?.name || id })) } : {})
    })),
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
    // Exposed run inputs (MODES-COMPARE T10): a canned spec for the mock
    // quick-fix flow so the composer controls render in the browser preview.
    flowLaunchInputs: async id => id === 'quick-fix'
      ? [{ nodeId: 'fix', title: 'Fix', field: 'worker', current: null },
         { nodeId: 'fix', title: 'Fix', field: 'effort', current: 'medium' }]
      : [],
    // Rotate over the fixture runs so a Compare launch (T11) — two runFlow
    // calls from one prompt — yields two DISTINCT panes to preview. The first
    // call still returns the newest (the gate run) for the single-run chat.
    runFlow: async (_pid) => {
      const ids = Object.keys(snapshots).sort().reverse();
      if (!ids.length) return null;
      return ids[mockRunCursor++ % ids.length];
    },
    // Comparison records (CONFIGS-COMPARE P2): kept in memory so the launch,
    // rematch and select-compare paths all run in the browser preview.
    beginCompare: async (_pid) => ({ id: 'cmp-mock-' + Date.now().toString(36) }),
    saveCompare: async (_pid, rec) => {
      const i = mockComparisons.findIndex(c => c.id === rec.id);
      if (i >= 0) mockComparisons[i] = { ...mockComparisons[i], ...rec };
      else mockComparisons.unshift({ createdAt: new Date().toISOString(), verdict: null, ...rec });
      return rec;
    },
    listComparisons: async (_pid) => [...mockComparisons],
    // P3 preview: a canned verdict, written straight into the pair's record.
    judgeRuns: async (_pid, a, b, cmpId = null) => {
      let rec = cmpId ? mockComparisons.find(c => c.id === cmpId) : null;
      rec ??= mockComparisons.find(c => c.runIds?.[0] === a && c.runIds?.[1] === b);
      if (!rec) {
        rec = { id: 'cmp-mock-' + Date.now().toString(36), runIds: [a, b], createdAt: new Date().toISOString(), origin: 'manual', verdict: null };
        mockComparisons.unshift(rec);
      }
      rec.verdict = {
        summary: '# Comparison\n\n## Agreements\nBoth answer the brief.\n\n## Differences\nB is more thorough; A is terser.\n\n## Verdict\nB edges it on completeness.',
        winner: 'B',
        axes: { correctness: 'tie', completeness: 'B' },
        notes: 'B covers the edge cases A skips; correctness is equal.',
        judgeModel: 'mock-judge',
        at: new Date().toISOString()
      };
      return rec;
    },
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
