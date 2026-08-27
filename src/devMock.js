// Browser-only fallback for window.flyt so the renderer can be previewed (D29)
// (and the design iterated on) outside Electron. Never active in the app:
// installed only when the preload bridge is missing.
import { SEED_NODE_TEMPLATES, normalizeTemplate, AGENT_TOOLS } from './flowTypes.js';
import { slugFromPrompt, dedupeSlug } from '../core/projectName.js';
import { factsFromCatalog } from '../core/modelSource.js';

const snapshots = {
  // A finished flow run with one follow-up turn: previews the thread view +
  // composer in RunResult and the turn badges on the canvas (DECISIONS.md D21).
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
          { tool: 'write_task_md', args: { content: '# Spec — shell scaffold…' }, ok: true, result: { written: 'tasks/task-1.spec.md' }, ms: 3, artifact: 'tools/1-write_task_md.json', handle: '@tool:1' },
          // A truncated result: preview in context, full result on disk (P2).
          { tool: 'bash', args: { command: 'npm test' }, ok: true, ms: 8400, truncated: true, bytes: 204_112, artifact: 'tools/2-bash.json', handle: '@tool:2',
            result: { command: 'npm test', exitCode: 0, stdout: '> flyt@0.1.3 test\n…[203,900 characters omitted]…\n# pass 583\n# fail 0', stderr: '' } },
          { tool: 'write_file', args: { path: 'src/App.jsx', content: '…' }, ok: false, error: 'Invalid arguments: args.content: required property missing', ms: 1, artifact: 'tools/3-write_file.json', handle: '@tool:3' }
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
  },
  // Died on the model it was pointed at — previews the failure panel, the
  // verbatim error on the card, and the retry-with-another-model box (D39).
  'run-20260815-140900': {
    meta: {
      runId: 'run-20260815-140900', stage: 'failed',
      flowId: 'learn-from-repo', flowName: 'Learn from a repo',
      name: 'Learn from a repo',
      createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      nodeStatus: { in: 'done', inputs: 'done', orient: 'failed', read: 'pending', out: 'pending' },
      error: 'Node orient (orient) failed: Codex CLI failed: Error loading config.toml: unknown variant `priority`, expected `fast` or `flex` in `service_tier`'
    },
    prompt: 'We are in an agent orchestration app, and want to learn how this other repo is handling agents working on long tasks.',
    flow: {
      id: 'learn-from-repo', name: 'Learn from a repo',
      nodes: [
        { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
        { id: 'inputs', type: 'inputs', kind: 'user', position: { x: 0, y: 110 }, data: {} },
        { id: 'orient', type: 'aiStep', kind: 'ai', position: { x: 0, y: 220 },
          data: { title: 'Where are we standing?', role: 'orient' } },
        { id: 'read', type: 'aiStep', kind: 'ai', position: { x: 0, y: 330 },
          data: { title: 'Read it, however many ways it takes', role: 'execute' } },
        { id: 'out', type: 'output', kind: 'user', position: { x: 0, y: 440 }, data: {} }
      ],
      edges: [
        { id: 'e-in-inputs', source: 'in', target: 'inputs' },
        { id: 'e-inputs-orient', source: 'inputs', target: 'orient' },
        { id: 'e-orient-read', source: 'orient', target: 'read' },
        { id: 'e-read-out', source: 'read', target: 'out' }
      ]
    },
    retrospectives: {
      orient: {
        status: 'failed', confidence: 0,
        problems: ['Codex CLI failed: Error loading config.toml: unknown variant `priority`, expected `fast` or `flex` in `service_tier`'],
        recommendation: 'AI step "Where are we standing?" failed calling codex/gpt-5.2 — check provider key/config, then retry the run.',
        model: { provider: 'codex', model: 'gpt-5.2' }
      }
    },
    nodeOutputs: {}
  }
};

// In-memory stand-ins for the settings/models IPC surface (DESIGN-SPEC.md §6).
const mockSettings = {
  hasKey: false,
  // The v2 flag, off, matching the shipped default. `?v2=1` turns it on, so
  // both shells are reachable in the browser preview — which has no settings
  // file to read and no main process to resolve one.
  v2: new URLSearchParams(globalThis.location?.search ?? '').get('v2') === '1',
  providers: {
    anthropic: { hasKey: false },
    // Subscription (CLI-delegation) providers: signed in but not yet enabled,
    // so the browser preview exercises the whole card (warning, toggle, test).
    'claude-code': {
      hasKey: false,
      subscription: {
        enabled: false, signedIn: true,
        credentialPath: 'C:\\Users\\dev\\.claude\\.credentials.json',
        cliFound: true, cliCommand: 'claude.exe', home: '', cliPath: ''
      }
    },
    openai: { hasKey: false },
    codex: {
      hasKey: false,
      subscription: {
        enabled: false, signedIn: false,
        credentialPath: 'C:\\Users\\dev\\.codex\\auth.json',
        cliFound: true, cliCommand: 'codex.exe', home: '', cliPath: ''
      }
    },
    kimi: { hasKey: false, keyKind: 'platform' },
    openrouter: { hasKey: false },
    mock: { hasKey: true }
  },
  claudeSubscriptionActive: false,
  providerPriority: ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter', 'mock'],
  // Enough of a registry that every picker in the app previews with something
  // in it. An empty list is a legitimate first-run state, but it is not the
  // state anyone is iterating on the design of.
  activeModels: [
    { id: 'deepseek/deepseek-v4-pro', source: 'openrouter', enabled: true, pinned: true },
    { id: 'anthropic/claude-sonnet-5', source: 'openrouter', enabled: true, pinned: true },
    { id: 'moonshotai/kimi-k3', source: 'openrouter', enabled: true, pinned: true },
    { id: 'openai/gpt-5.2', source: 'openrouter', enabled: true, pinned: true }
  ],
  modelFacts: {
    'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', contextLength: 1048576, supportsTools: true, inUsdPerM: 1.168, outUsdPerM: 2.336 },
    'anthropic/claude-sonnet-5': { name: 'Claude Sonnet 5', contextLength: 200000, supportsTools: true, inUsdPerM: 3, outUsdPerM: 15 },
    'moonshotai/kimi-k3': { name: 'Kimi K3', contextLength: 262144, supportsTools: true, inUsdPerM: 0.6, outUsdPerM: 2.5 },
    'openai/gpt-5.2': { name: 'GPT-5.2', contextLength: 400000, supportsTools: true, inUsdPerM: 1.25, outUsdPerM: 10 }
  },
  modelPopularity: {
    creators: [
      { key: 'deepseek', totalTokens: '16000000000000' },
      { key: 'anthropic', totalTokens: '15300000000000' },
      { key: 'openai', totalTokens: '8100000000000' },
      { key: 'moonshotai', totalTokens: '4200000000000' }
    ],
    asOf: '2026-08-17T02:00:00Z', startDate: '2026-07-19', endDate: '2026-08-17',
    fetchedAt: '2026-08-18T08:00:00Z'
  },
  modelSets: {},
  // The loop's band→model map (DESIGN-SPEC.md §8), empty by default: the shipped
  // state is "ask for an effort band", and naming models is the deliberate act.
  loopModels: {},
  workers: {
    executor: { provider: 'mock', model: 'mock-large' },
    // The loop's two (DESIGN-SPEC.md §8), unset: no pin means effort bands,
    // no reviewer means nothing lands.
    loop: { provider: null, model: null },
    reviewer: { provider: null, model: null }
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
// --- The loop (DESIGN-SPEC.md §8) ----------------------------------------------
// The Loop view is the one surface with no canvas behind it: everything on it
// comes from the supervisor, the backlog and the ledger, so without these the
// panel previews as an error message. Tasks carry their real frontmatter shape
// (core/backlog.js) — body, gates, blastRadius, dependsOn, runIds — because the
// expanded card is a projection OF that shape and a thinner fake would preview
// a panel that cannot exist.
const mockTasks = [
  {
    id: 't-0001', title: 'Add Evaluator and structured feedback schema',
    status: 'queued', level: 'medium', value: 4, effort: 3, attempts: 0,
    createdBy: 'human', createdAt: '2026-08-14T07:12:00.000Z', updatedAt: '2026-08-14T07:12:00.000Z',
    dependsOn: [], gates: ['npm test'], blastRadius: ['core/judge.js', 'tests/judge.test.js'],
    runIds: [], budgetUsd: null, blockedReason: null,
    body: '## Goal\n\nThe reviewer returns prose, so nothing downstream can act on it.\nGive it a schema the harness can read.\n\n## Done when\n\n- a verdict block parses to { verdict, reason, changes }\n- an unparseable review is a request for changes, not an approval'
  },
  {
    id: 't-0002', title: 'Implement Supervisor._update_coder_prompt with validation',
    status: 'queued', level: 'high', value: 5, effort: 4, attempts: 1,
    createdBy: 'agent:t-0031', createdAt: '2026-08-14T09:40:11.000Z', updatedAt: '2026-08-15T18:02:00.000Z',
    dependsOn: ['t-0001'], gates: [], blastRadius: ['core/supervisor.js'],
    runIds: ['run-20260712-101512'], budgetUsd: 1.5, blockedReason: null,
    // Queued by a flow rather than a person (D36 P4.5), so the link back to the
    // run that wrote it is exercised too.
    sourceRunId: 'run-20260712-101512', sourceNodeId: 'work',
    body: '## Goal\n\nThe supervisor rewrites the coder prompt in memory only, so a restart loses it.'
  },
  {
    id: 't-0003', title: 'Locate tests and benchmarking scripts',
    status: 'parked', level: 'max', value: 2, effort: 1, attempts: 3,
    createdBy: 'human', createdAt: '2026-08-13T06:00:00.000Z', updatedAt: '2026-08-16T04:11:00.000Z',
    startedAt: '2026-08-16T03:40:00.000Z',
    dependsOn: [], gates: [], blastRadius: [], runIds: ['run-20260716-142200'],
    blockedReason: 'Already at "max", the top of the ladder, after 3 attempt(s). A bigger model is not the missing piece.',
    body: ''
  },
  {
    id: 't-0004', title: 'Pin the supervisor to a known-good revision',
    status: 'landed', level: 'medium', value: 5, effort: 2, attempts: 1,
    createdBy: 'human', createdAt: '2026-08-12T06:00:00.000Z', updatedAt: '2026-08-15T22:14:00.000Z',
    dependsOn: [], gates: [], blastRadius: ['core/worktree.js'], runIds: [], body: '## Goal\n\nSelf-modification hazard (§6.3).'
  },
  {
    // The live fixture for the Blocked column: a task naming a dependency that
    // does not exist. Before the blocker model this sat in a list called
    // "Queued", which is a lie a person acts on.
    id: 't-0005', title: 'Wire the board columns to the blocker model',
    status: 'queued', level: 'high', value: 4, effort: 3, attempts: 0,
    createdBy: 'human', createdAt: '2026-08-17T08:00:00.000Z', updatedAt: '2026-08-17T08:00:00.000Z',
    dependsOn: ['t-0006'], gates: [], blastRadius: ['src/loopBoardData.js'],
    runIds: [], budgetUsd: null, blockedReason: null,
    body: ['## Goal', '', 'The columns are derived from the blocker model, not from status alone.'].join('\n')
  },
  {
    // A question an agent asked rather than guessed at (ask_human). The one
    // card on this page where a person unblocks a night by typing a word.
    id: 't-0008', title: 'Decide where the drawer height is remembered',
    status: 'parked', level: 'medium', value: 3, effort: 1, attempts: 1,
    createdBy: 'human', createdAt: '2026-08-17T10:00:00.000Z', updatedAt: '2026-08-17T11:30:00.000Z',
    dependsOn: [], gates: [], blastRadius: ['src/loop/LoopPage.jsx'], runIds: [],
    blockedReason: [
      'Q: Should the log drawer remember its height per project or globally?',
      'Options: (1) per project  (2) globally',
      'Already established: both are one line; nothing in the plan says which.'
    ].join('\n'),
    body: ['## Goal', '', 'The drawer is resizable and has to remember something.'].join('\n')
  }
];

// Conversations, in memory. One seeded so the rail is not empty on first open.
const mockChats = new Map([['c-mock1', {
  id: 'c-mock1', title: 'why is the queue stuck?', updatedAt: '2026-08-17T09:00:00.000Z',
  turns: [
    { role: 'user', text: 'why is the queue stuck?', at: '2026-08-17T09:00:00.000Z' },
    {
      role: 'assistant', at: '2026-08-17T09:00:04.000Z', model: 'mock-large',
      toolCalls: [{ tool: 'why_blocked', args: {}, ok: true, ms: 8 }],
      text: 'Two things. t-0005 names t-0006, which does not exist. And no reviewer is set, so nothing can land even once it runs.'
    }
  ]
}]]);

const mockProblems = [
  { id: 't-0007', error: 't-0007: no YAML frontmatter' }
];

const mockLoop = {
  running: false, stopping: null, model: null, models: {},
  inFlight: [], parked: [], completed: 4, landed: 1,
  log: [
    { at: '2026-08-16T04:02:11.000Z', line: '▶ t-0004 "Pin the supervisor" at medium' },
    { at: '2026-08-16T04:19:52.000Z', line: '✔ t-0004 landed 1f3c9a20' },
    { at: '2026-08-16T04:20:03.000Z', line: '⏸ t-0003 parked: out of ladder' }
  ]
};

const refreshMockSummary = () => {
  mockSettings.summary = {
    connected: ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter']
      .filter(p => mockSettings.providers[p].hasKey).length,
    activeModelCount: mockSettings.activeModels.filter(m => m.enabled !== false && m.pinned !== false).length
  };
  mockSettings.hasKey = mockSettings.summary.connected > 0;
  mockSettings.claudeSubscriptionActive = Boolean(mockSettings.providers['claude-code'].hasKey);
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
  ],
  'claude-code': [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (subscription)', supportsTools: true }
  ],
  codex: [
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (subscription)', supportsTools: true }
  ]
};
// Prices are per-million USD, as the real catalog fetch now returns them
// (D36 P0.2) — the dev harness has to exercise the fact chips too.
const mockModels = [
  { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini', contextLength: 128000, supportsTools: true, inUsdPerM: 0.15, outUsdPerM: 0.6 },
  { id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', contextLength: 200000, supportsTools: true, inUsdPerM: 3, outUsdPerM: 15 },
  { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', contextLength: 1048576, supportsTools: true, inUsdPerM: 1.25, outUsdPerM: 10 },
  { id: 'x-ai/grok-4', name: 'xAI: Grok 4', contextLength: 256000, supportsTools: true, inUsdPerM: 3, outUsdPerM: 15 },
  { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct', contextLength: 131072, supportsTools: false, inUsdPerM: 0.02, outUsdPerM: 0.03 }
];

// The reference library, as the real one ships it (core/references.js).
const mockRefs = [
  {
    name: 'self_improving_coding_agent',
    url: 'https://github.com/MaximeRobeyns/self_improving_coding_agent',
    about: 'An archive of scored agent versions, the best of which proposes the next improvement.',
    cloned: false, adopted: false, commit: null, clonedAt: null
  },
  {
    name: 'opencode',
    url: 'https://github.com/sst/opencode',
    about: 'The server/client split: a headless harness over HTTP with every surface as a client.',
    cloned: true, adopted: false, commit: 'a1b2c3d4e5f600000000000000000000000000aa',
    clonedAt: new Date().toISOString()
  }
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
    // Two example modes so the launch picker's expansion (DECISIONS.md D27) is
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
const mockRunAge = { 'run-20260815-140900': 0, 'run-20260720-091500': 0, 'run-20260716-142200': 0, 'run-20260714-091500': 0, 'run-20260712-101512': 3 }; // days ago
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
// The mock's snapshot push channel (see onRunUpdate). Bumping the rev keeps the
// renderer's stale-push guards happy without a diff engine behind them.
const pushListeners = new Set();
let mockRev = 0;
const pushRun = runId => {
  const full = snapshots[runId];
  if (!full) return;
  mockRev += 1;
  for (const fn of pushListeners) fn({ runId, full: { ...full }, rev: mockRev });
};

let mockRunCursor = 0; // rotates runFlow over the fixtures (compare preview)
const mockComparisons = []; // in-memory comparison records (P2 preview)
const mockAppdataSlugs = () => new Set(
  mockProjects.tabs.filter(t => t.kind === 'appdata').map(t => t.id.replace(/^appdata:/, '')));

export function installDevMock() {
  window.flyt = {
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
    // A copy, not the fixture itself: real IPC structured-clones every
    // snapshot, so the renderer always gets a fresh object and its useMemos
    // recompute. Handing back the same reference made mutations (restartNode)
    // land in the data but never on screen — a preview-only ghost bug.
    getSnapshot: async (_pid, id) => (snapshots[id] ? { ...snapshots[id] } : null),
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
    // Restart is the one stub that must not be inert: it carries the worker
    // re-pin (D39), and a mock that swallowed it would look exactly like the
    // stale-bridge case the renderer now warns about. So it applies the pin to
    // the fixture, rewinds the node, and echoes the pin back like the engine.
    restartNode: async (_pid, runId, nodeId, _guidance, worker = null) => {
      const snap = snapshots[runId];
      if (!snap?.flow) return { ok: true };
      const node = snap.flow.nodes.find(n => n.id === nodeId);
      if (worker?.provider && worker.model && node) node.data = { ...node.data, worker };
      snap.meta = { ...snap.meta, stage: 'execution', error: null };
      snap.meta.nodeStatus = { ...snap.meta.nodeStatus, [nodeId]: 'active' };
      delete snap.retrospectives?.[nodeId];
      pushRun(runId);
      return worker?.model ? { ok: true, worker } : { ok: true };
    },
    branchRun: async (_pid, runId) => ({ ok: true, runId }),
    investigateNode: async () => ({
      ok: true, status: 'done', output: '', retro: null, logTail: [],
      summary: '(mock) This node completed normally.', model: 'mock'
    }),
    followUpRun: async () => ({ turn: 1 }),
    answerInput: async () => ({ ok: true }),
    // Summary-node stubs (B4): no engine in the browser shell — summarize
    // reports the no-model state so the retry card path can be previewed.
    summarizeRun: async () => ({ ok: false, error: 'no-model' }),
    deleteSummary: async () => ({ ok: true }),
    moveSummary: async () => ({ ok: true }),
    openRunFolder: async () => {},
    pickWorkspace: async () => null, // no native folder picker in the browser dev shell
    openWorkspace: async () => {},
    // A real (if tiny) push channel. It used to be a no-op, which meant any
    // mock action that changed a run — restartNode above — landed in the data
    // and never on screen. Full pushes only: the mock has no diff engine, and
    // the renderer accepts `full` from any rev.
    onRunUpdate: fn => { pushListeners.add(fn); return () => pushListeners.delete(fn); },

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

    // What Build edits in the browser preview. Electron does not implement this
    // yet — a project has no `stacks/` until Phase 2 — so the desktop app shows
    // the empty editor, which is the honest state. Here it is a real parsed
    // stack over the real command surface, so the editor, the drag and the
    // agent-edit animation can all be looked at.
    // The run Trace is looking at, in the browser preview. A real fold over a
    // real event list, so what is on screen is what a session log produces —
    // including the two things this surface exists for: a degraded route, and
    // a tool call that never came back.
    v2Watching: async () => {
      const { foldTrace } = await import('./traceModel.js');
      const at = n => new Date(Date.UTC(2026, 7, 22, 10, 0, n)).toISOString();
      const { parseStack } = await import('#kernel');
      const stack = parseStack([
        'version: 2', 'id: preview-run', 'blocks:',
        '  - id: plan', '    use: flyt:work', '    title: Plan the change',
        '  - id: build', '    use: flyt:work', '    title: Make it',
      ].join('\n'));
      return { runId: 'preview-run', stack, trace: foldTrace([
        { seq: 1, at: at(0), type: 'run.created', data: { runId: 'preview-run', stackId: 'preview' } },
        { seq: 2, at: at(1), type: 'run.stage', data: { stage: 'execution' } },
        { seq: 2, at: at(1), type: 'turn.start', data: { runId: 'preview-run', turn: 1, blockId: 'plan' } },
        { seq: 21, at: at(1), type: 'block.status', data: { blockId: 'plan', status: 'active', use: 'flyt:work' } },
        { seq: 3, at: at(1), type: 'step.start', data: { runId: 'preview-run', blockId: 'plan', step: 1 } },
        { seq: 4, at: at(1), type: 'step.prompt', data: { content: 'You are the plan block.\n\nWork out what to change.' } },
        { seq: 5, at: at(2), type: 'llm.request', data: { callId: 'q1', model: 'deepseek/deepseek-v4-flash' } },
        { seq: 6, at: at(6), type: 'llm.response', data: {
          callId: 'q1', content: 'I will read the layout first.', reasoning: 'Weighing two orders of work.',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'kernel/src/stack/layout.ts' } }],
          usage: { promptTokens: 4021, completionTokens: 233, reasoningTokens: 96, costUsd: 0.0031 },
          route: { requested: 'deepseek/deepseek-v4-flash', effective: 'openrouter/deepseek/deepseek-v4-flash-0731',
            reason: 'the latest alias resolved to a dated build', degraded: true } } },
        { seq: 7, at: at(6), type: 'permission.decision', data: { callId: 'c1', decision: 'allow', reason: 'it only reads' } },
        { seq: 8, at: at(7), type: 'tool.result', data: { callId: 'c1', name: 'read_file', content: 'export interface Box { x: number; y: number }' } },
        { seq: 9, at: at(7), type: 'step.end', data: { runId: 'preview-run', blockId: 'plan', step: 1 } },
        { seq: 10, at: at(8), type: 'step.start', data: { runId: 'preview-run', blockId: 'plan', step: 2 } },
        { seq: 11, at: at(8), type: 'llm.request', data: { callId: 'q2', model: 'deepseek/deepseek-v4-flash' } },
        { seq: 12, at: at(11), type: 'llm.response', data: { callId: 'q2', content: 'Running the suite.', finishReason: 'tool_calls',
          toolCalls: [{ id: 'c2', name: 'bash', args: { command: 'npm test' } }],
          usage: { promptTokens: 5210, completionTokens: 88, costUsd: 0.0019 } } },
        { seq: 13, at: at(11), type: 'permission.decision', data: { callId: 'c2', decision: 'allow', reason: 'the loop ceiling names it' } },
        { seq: 22, at: at(12), type: 'block.status', data: { blockId: 'build', status: 'pending' } },
        { seq: 14, at: at(12), type: 'plugin/impeccable', data: { finding: 'a detector this surface has no shape for' } },
      ]) };
    },

    v2Build: async () => {
      const [{ parseStack, createKernel, flytApi, flytBlocks, flytUiExtensions, registerStackCommands }] =
        await Promise.all([import('#kernel')]);
      const kernel = createKernel();
      await kernel.ctx.plugin(flytApi);
      await kernel.ctx.plugin(flytBlocks);
      await kernel.ctx.plugin(flytUiExtensions);
      await kernel.ctx.plugin({
        name: 'preview-blocks',
        inject: ['blocks'],
        apply(ctx) {
          for (const use of ['flyt:work', 'flyt:evaluate']) {
            ctx.blocks.register({
              use, title: use.split(':')[1], description: '', category: 'work',
              settings: { type: 'object' }, ceiling: null,
              async execute() { return { status: 'done', output: '' }; },
            });
          }
        },
      });
      await kernel.ctx.plugin({
        name: 'preview-ui', inject: ['uiExtensions'],
        apply(ctx) {
          const declarations = [
            {
              point: 'block-configuration', id: 'preview.work.config', block: 'flyt:work',
              schema: { type: 'object', properties: {
                prompt: { type: 'string', title: 'Prompt', description: 'What should this block do?' },
                careful: { type: 'boolean', title: 'Careful', default: true },
              }, required: ['prompt'] },
            },
            {
              point: 'tool-view', id: 'preview.bash.view', tool: 'bash',
              view: { component: 'notice', tone: 'info', text: 'Shell result supplied by Flyt.' },
            },
          ];
          for (const contribution of declarations) {
            const accepted = ctx.uiExtensions.invoke({ method: 'ui.contribute', params: { contribution } });
            if (!accepted.ok) throw new Error(accepted.error.message);
          }
        },
      });

      let root = parseStack(`version: 2
id: preview
name: A stack to look at
blocks:
  - id: plan
    use: flyt:work
    title: Plan the change
  - id: fan
    kind: parallel
    maxParallel: 2
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: write
            use: flyt:work
            title: Write it
      - id: right
        kind: sequence
        blocks:
          - id: check
            use: flyt:evaluate
            title: Check it
  - id: gone
    use: flyt:not-installed
    title: A block nobody installed
`).root;

      const listeners = new Set();
      kernel.ctx.on('commands/invoke', record => { for (const fn of listeners) fn(record); });
      registerStackCommands(kernel.ctx, { get: () => root, set: next => { root = next; } });

      // What the library shows in the preview: the real block registry, plus
      // the tools and models this mock already carries. Six kinds, so the
      // facets and the empty-kind line can both be looked at.
      const library = {
        blocks: kernel.ctx.blocks,
        stacks: [{ id: 'loop-task', name: 'Work one backlog task', description: 'One work block.', blockCount: 1 }],
        tools: [
          { id: 'read_file', title: 'Read a file', description: 'Read a text file from the workspace.', effects: ['read'], risk: 'safe', scope: 'workspace' },
          { id: 'bash', title: 'Run a command', description: 'A shell in the workspace.', effects: ['shell'], risk: 'danger', scope: 'workspace' },
          { id: 'from_a_plugin', description: 'Contributed, and not yet classified.' },
        ],
        skills: [{ name: 'impeccable', description: 'Critique the work.', requiresTools: ['bash'] }],
        models: Object.keys(mockSettings.modelFacts ?? {}).slice(0, 12).map(id => ({ id, source: 'openrouter' })),
        modelFacts: mockSettings.modelFacts ?? {},
      };

      const surface = {
        get stack() { return { id: 'preview', root }; },
        blocks: kernel.ctx.blocks,
        library,
        pluginReviews: kernel.pluginReviews,
        uiExtensions: kernel.ctx.uiExtensions.invoke({ method: 'ui.list', params: {} }).result,
        commands: {
          invoke: (name, args, caller) => kernel.ctx.commands.invoke(name, args, caller),
          subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        },
      };
      // So a person can watch an agent edit: from the console,
      // `flytPreviewAgentEdit()` moves a block the way a model would.
      globalThis.flytPreviewAgentEdit = (nodeId = 'plan', container = 'left', index = 0) =>
        surface.commands.invoke('stack:move-block', { nodeId, to: { container, index } }, 'agent');
      return surface;
    },
    setSettings: async (patch = {}) => {
      if (patch.providerKeys) {
        for (const p of Object.keys(patch.providerKeys)) {
          if (mockSettings.providers[p]) mockSettings.providers[p].hasKey = true;
        }
      }
      if (patch.kimiKeyKind) mockSettings.providers.kimi.keyKind = patch.kimiKeyKind;
      if (patch.subscriptions) {
        for (const [p, inc] of Object.entries(patch.subscriptions)) {
          const entry = mockSettings.providers[p];
          if (!entry?.subscription || !inc) continue;
          if (typeof inc.enabled === 'boolean') entry.subscription.enabled = inc.enabled;
          if (typeof inc.home === 'string') entry.subscription.home = inc.home.trim();
          if (typeof inc.cliPath === 'string') entry.subscription.cliPath = inc.cliPath.trim();
          entry.hasKey = entry.subscription.enabled && entry.subscription.signedIn;
        }
      }
      if (Array.isArray(patch.providerPriority)) mockSettings.providerPriority = [...patch.providerPriority];
      if (Array.isArray(patch.activeModels)) mockSettings.activeModels = structuredClone(patch.activeModels);
      if (patch.modelSets && typeof patch.modelSets === 'object') mockSettings.modelSets = structuredClone(patch.modelSets);
      // Sent whole, like activeModels: clearing a band is its absence.
      if (patch.loopModels && typeof patch.loopModels === 'object') mockSettings.loopModels = structuredClone(patch.loopModels);
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
        // The real handler stows the catalog facts in settings on the way past
        // (D36 P0.2); mirror that so pickers show prices in the dev harness.
        mockSettings.modelFacts = factsFromCatalog(mockModels, mockSettings.modelFacts);
        return mockModels;
      }
      return mockCurated[provider] ?? [];
    },
    modelRankings: async () => ({ ...structuredClone(mockSettings.modelPopularity), stale: false }),
    testProvider: async provider => (
      provider === 'mock' || mockSettings.providers[provider]?.hasKey
        ? { ok: true }
        : { ok: false, error: `No API key saved for ${provider} yet.` }
    ),
    // The reference library (D36 P1). Enough shape for the Repositories panel
    // to be exercised without git.
    listReferences: async () => structuredClone(mockRefs),
    addReference: async ({ url }) => {
      if (!/^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(String(url ?? '').trim())) {
        throw new Error(`"${url}" is not a repository URL.`);
      }
      const name = String(url).replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop().toLowerCase();
      const existing = mockRefs.find(r => r.url === url);
      if (existing) { existing.commit = 'refreshed' + Date.now().toString(16).slice(-4); return { ...existing, refreshed: true }; }
      const entry = {
        name, url, about: `Adopted from ${url}.`, cloned: true, adopted: true,
        commit: Date.now().toString(16).padStart(40, '0'), clonedAt: new Date().toISOString()
      };
      mockRefs.push(entry);
      return { ...entry, adopted: true, refreshed: false };
    },
    removeReference: async name => {
      const i = mockRefs.findIndex(r => r.name === name);
      if (i >= 0) mockRefs.splice(i, 1);
      return { name, removed: true, uncloned: true };
    },
    updateReference: async name => {
      const r = mockRefs.find(x => x.name === name);
      if (r) { r.cloned = true; r.commit = Date.now().toString(16).padStart(40, '0'); }
      return r ?? null;
    },
    cloneRepo: async ({ url, parentDir }) => ({
      folder: `${parentDir}/${String(url).split('/').pop()}`, opened: true, id: 'cloned', name: 'cloned', kind: 'folder'
    }),
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
    // Exposed run inputs (DECISIONS.md D27): a canned spec for the mock
    // quick-fix flow so the composer controls render in the browser preview.
    // Two lists: exposed override fields, and typed run inputs (D36 P1.3).
    flowLaunchInputs: async id => id === 'quick-fix'
      ? {
          fields: [{ nodeId: 'fix', title: 'Fix', field: 'worker', current: null },
                   { nodeId: 'fix', title: 'Fix', field: 'effort', current: 'medium' }],
          declared: [
            { name: 'repo', type: 'repo', label: 'Repository', required: true,
              description: 'Cloned read-only before the run starts.' },
            { name: 'goal', type: 'text', label: 'What to look for', required: false },
            { name: 'depth', type: 'choice', label: 'Depth', options: ['quick', 'thorough'], default: 'quick' }
          ]
        }
      : { fields: [], declared: [] },
    // Rotate over the fixture runs so a Compare launch (T11) — two runFlow
    // calls from one prompt — yields two DISTINCT panes to preview. The first
    // call still returns the newest (the gate run) for the single-run chat.
    runFlow: async (_pid) => {
      const ids = Object.keys(snapshots).sort().reverse();
      if (!ids.length) return null;
      return ids[mockRunCursor++ % ids.length];
    },
    // Comparison records (DECISIONS.md D27): kept in memory so the launch,
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
    deleteNodeTemplate: async id => { mockTemplates.delete(id); },
    // The browser-dev shim has no ToolStore behind it: report the built-ins,
    // which is exactly what a fresh library seeds to.
    listTools: async () => AGENT_TOOLS.map(id => {
      const effects = id === 'bash' ? ['shell'] : /^read_/.test(id) ? ['read'] : ['write'];
      return {
        id, title: id, description: '', provider: 'builtin', effects,
        scope: /^(create_task|write_task_md)$/.test(id) ? 'run' : 'workspace',
        risk: effects[0] === 'read' ? 'safe' : 'caution', trust: 'trusted', enabled: true
      };
    }),
    toolsFolder: async () => ({ dir: 'tools', packaged: false }),
    // No shell to open a file with in a browser; the link is still exercised.
    openRunArtifact: async (_pid, _runId, rel) => { console.info('[devMock] would open', rel); },

    // --- The loop (DESIGN-SPEC.md §8) ---
    loopStatus: async () => structuredClone(mockLoop),
    loopStart: async (_pid, opts = {}) => {
      const pinned = mockSettings.workers.loop;
      mockLoop.running = true;
      mockLoop.stopping = null;
      mockLoop.models = opts.models ?? structuredClone(mockSettings.loopModels ?? {});
      mockLoop.model = opts.worker?.model ?? (pinned?.model ?? null);
      // One task moves into flight, so the health row previews as the thing it
      // is for: a task that is working rather than merely started.
      const next = mockTasks.find(t => t.status === 'queued');
      if (next) {
        next.status = 'running';
        mockLoop.inFlight = [{
          taskId: next.id, runId: 'run-20260712-101512', level: next.level,
          model: mockLoop.model, stage: 'execution',
          ageMs: 4 * 60_000, idleMs: 12_000, interventions: []
        }];
      }
      mockLoop.log.push({ at: new Date().toISOString(), line: `▶ ${next?.id ?? '—'} on ${mockLoop.model ?? 'effort bands'}` });
      return { started: true, parallelism: opts.parallelism ?? 1, model: mockLoop.model, levels: !mockLoop.model };
    },
    loopStop: async () => {
      mockLoop.running = false;
      mockLoop.stopping = 'stopped by request';
      for (const t of mockTasks) if (t.status === 'running') t.status = 'queued';
      mockLoop.inFlight = [];
      return { stopped: true };
    },
    loopReport: async () => '# Loop report (dev mock)\n\n**Spend:** $2.28 across 41 call(s)\n',
    loopLog: async () => structuredClone(mockLoop.log),
    onLoopEvent: () => () => {},
    // A file that would not parse comes back beside the tasks, never instead of
    // them. It is in the mock because it is the entry with no pile of its own —
    // the panel has to show it or it is invisible and permanent at once.
    // The board reads `blockers` and `boardBlockers` beside the tasks
    // (DECISIONS.md D45). The real backend computes them in core/blockers.js from
    // the whole backlog; the mock STATES them, because the point of a fixture is
    // to show the shapes a person has to be able to read — a missing dependency,
    // a question, an unreadable file, a project with no reviewer.
    listTasks: async () => ({
      tasks: structuredClone(mockTasks),
      problems: structuredClone(mockProblems),
      blockers: {
        't-0002': [{
          kind: 'dep-unlanded', severity: 'blocked',
          summary: 'Waiting on t-0001 (queued) to land.',
          detail: null, subjects: ['t-0001'], remedy: null
        }],
        't-0005': [{
          kind: 'dep-missing', severity: 'blocked',
          summary: 'Waiting on t-0006, which does not exist.',
          detail: 'It was removed, or the id was written down wrong. This task can never be picked while it names a task that is not there.',
          subjects: ['t-0006'],
          remedy: { action: 'remove-dep', label: 'Drop the dependency on t-0006', args: { id: 't-0005', dependsOn: [] } }
        }],
        't-0003': [{
          kind: 'attempts-exhausted', severity: 'blocked',
          summary: 'Parked after 3 attempt(s) at the top band — there is no bigger model to try.',
          detail: 'A bigger model is not the missing piece.',
          subjects: ['t-0003'],
          remedy: { action: 'requeue', label: 'Put it back in the queue', args: { id: 't-0003' } }
        }],
        't-0007': [{
          kind: 'unreadable', severity: 'blocked',
          summary: 'This file in the backlog directory could not be read, so the loop skips it.',
          detail: 't-0007: no YAML frontmatter',
          subjects: ['t-0007'],
          remedy: { action: 'remove-task', label: 'Remove it', args: { id: 't-0007' } }
        }]
      },
      boardBlockers: mockSettings.workers?.reviewer?.model ? [] : [{
        kind: 'no-reviewer', severity: 'blocked',
        summary: 'No reviewer model is set, so nothing can land.',
        detail: 'The loop will pick tasks, run them and verify them, then stop before merging. Set a reviewer to let work land.',
        subjects: [], remedy: { action: 'set-reviewer', label: 'Set a reviewer', args: {} }
      }]
    }),
    addTask: async (_pid, task) => task,
    getTask: async (_pid, id) => structuredClone(mockTasks.find(t => t.id === id) ?? null),
    // Inline editing on the board writes through this. The allowlist is the
    // backlog's business; the mock only has to move the fields.
    updateTask: async (_pid, id, patch = {}) => {
      const t = mockTasks.find(t => t.id === id);
      if (!t) throw new Error(`No task "${id}".`);
      Object.assign(t, patch, { updatedAt: new Date().toISOString() });
      return structuredClone(t);
    },
    taskStats: async () => ({ total: mockTasks.length, counts: {}, ready: 1, blocked: 2, open: 4 }),
    // A worktree diff, so the Working card's Changes tab previews as itself.
    workDiff: async () => [
      'diff --git a/core/supervisor.js b/core/supervisor.js',
      '--- a/core/supervisor.js',
      '+++ b/core/supervisor.js',
      '@@ -560,7 +560,7 @@',
      '   #whyNothingReady() {',
      '-    let blocked = [];',
      '+    return whyNothingReady({ tasks: this.backlog.list() });',
      '   }'
    ].join('\n'),
    workVerify: async () => ({
      ok: true, gates: ['npm test'],
      results: [{
        command: 'npm test', status: 'pass', code: 0, ms: 31200,
        output: ['# tests 1070', '# pass 1070', '# fail 0'].join('\n')
      }]
    }),
    runLive: async () => ({}),
    // Money is per task in the ledger, which is what the expanded card reads.
    ledgerTotals: async (_pid, { taskId = null } = {}) => (taskId
      ? { usd: 0.4213, calls: 9, estimated: 0, unknown: 1 }
      : { usd: 2.28, calls: 41, estimated: 0, unknown: 2 }),
    ledgerCheck: async () => ({
      ok: true, action: null,
      window: { usd: 2.28, calls: 41, estimated: 0, unknown: 2 },
      caps: { taskUsd: 1.5, softUsd: 3, hardUsd: 4 }
    }),
    releaseTask: async (_pid, id, status = 'queued') => {
      const t = mockTasks.find(t => t.id === id);
      if (t) { t.status = status; t.blockedReason = null; }
      return t;
    },
    escalateTask: async (_pid, id) => {
      const t = mockTasks.find(t => t.id === id);
      if (t) { t.status = 'queued'; t.blockedReason = null; }
      return t;
    },
    removeTask: async (_pid, id, force = false) => {
      const p = mockProblems.findIndex(x => x.id === id);
      if (p >= 0) {
        const [gone] = mockProblems.splice(p, 1);
        return { removed: gone.id, title: '(unreadable)', status: 'unknown', unreadable: gone.error };
      }
      const i = mockTasks.findIndex(t => t.id === id);
      if (i < 0) throw new Error(`No task "${id}".`);
      // The mock keeps the refusal, not just the happy path: the two-press
      // confirm in the Loop view only shows its second state when something
      // says no, and that is the half worth being able to see without a
      // worktree and a real lease behind it.
      if (!force && ['claimed', 'running'].includes(mockTasks[i].status)) {
        throw new Error(`Task "${id}" is claimed by supervisor. Release it before removing it.`);
      }
      const [removed] = mockTasks.splice(i, 1);
      return { removed: removed.id, title: removed.title, status: removed.status };
    },

    // --- The backlog chat (DECISIONS.md D45) ---
    // In-memory threads and a canned turn, so the drawer previews as itself:
    // a tool call rendered as one collapsed line, then an answer, then a task
    // the model queued shown as the card it became. There is no model here —
    // what is being previewed is the SHAPE of a turn, which is the half that
    // has to be legible.
    chatThreads: async () => ({ threads: [...mockChats.values()].map(t => ({
      id: t.id, title: t.title, turns: t.turns.length, updatedAt: t.updatedAt
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), problems: [] }),
    chatNew: async () => ({ threadId: `c-mock${mockChats.size + 1}` }),
    chatRead: async (_pid, threadId) => ({ turns: structuredClone(mockChats.get(threadId)?.turns ?? []) }),
    chatDelete: async (_pid, threadId) => ({ removed: mockChats.delete(threadId) }),
    chatStop: async () => ({ stopped: true }),
    chatTools: async () => ({ tools: ['list_tasks', 'read_task', 'why_blocked', 'read_file', 'glob', 'search_references', 'read_run', 'enqueue_task'] }),
    chatSend: async (_pid, threadId, text) => {
      const thread = mockChats.get(threadId) ?? { id: threadId, title: text.slice(0, 80), turns: [] };
      thread.title ||= text.slice(0, 80);
      thread.turns.push({ role: 'user', text, at: new Date().toISOString() });
      const queueing = /queue|task|build|add|split|write/i.test(text);
      const turn = {
        role: 'assistant', at: new Date().toISOString(), model: 'mock-large',
        toolCalls: [
          { tool: 'list_tasks', args: {}, ok: true, ms: 6 },
          ...(queueing ? [{ tool: 'enqueue_task', args: { title: text.slice(0, 60), goal: 'Queued from the chat.' }, ok: true, ms: 11 }] : [])
        ],
        text: queueing
          ? 'Nothing in the queue covers that, so I have queued it. The loop will pick it up.'
          : 't-0005 is the only one stuck: it names t-0006, which does not exist.',
        ...(queueing ? { proposals: [{ id: 't-0009', title: text.slice(0, 60), goal: 'Queued from the chat.' }] } : {})
      };
      thread.turns.push(turn);
      thread.updatedAt = turn.at;
      mockChats.set(threadId, thread);
      return turn;
    },
    onChatEvent: () => () => {},

    archiveTrend: async () => ({
      points: [
        { date: '2026-08-13', score: 0.5, verified: 1, cases: 2, benchUsd: 3.1 },
        { date: '2026-08-14', score: null },
        { date: '2026-08-15', score: 1, verified: 2, cases: 2, benchUsd: 2.4 }
      ],
      scored: 2, latest: { date: '2026-08-15', score: 1, verified: 2, cases: 2 }, direction: 'improving'
    }),
    feedbackStats: async () => ({ pending: 0, tools: [] })
  };
}
