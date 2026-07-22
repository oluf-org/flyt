// Node rework acceptance: pinned structural nodes, combined-node options,
// the feedback channel, orchestrator node budget, and model-priority defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowStore } from '../core/flowstore.js';
import { FlowRunner, resolveWorker, topoSort } from '../core/flowRunner.js';
import { NodeStore } from '../core/nodestore.js';
import { lintFlow } from '../core/flowlang/lint.js';
import {
  SEED_NODE_TEMPLATES, resolveInstance, ensureStructuralNodes, migrateLegacyTemplates,
  FEEDBACK_HANDLE
} from '../src/flowTypes.js';
import { pickDefaultWorker, taskKindOf, PROVIDER_MODEL_PRIORITY, PROVIDER_ORDER, TASK_KINDS } from '../core/modelPriority.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-rework-'));
const seed = id => SEED_NODE_TEMPLATES.find(t => t.id === id);

// --- Pinned structural nodes -------------------------------------------------

test('flowstore.save refuses a flow whose input or output was removed (YAML path)', () => {
  const store = new FlowStore(tmp());
  const base = {
    id: 'p', name: 'P',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'a', templateId: 'work', position: { x: 0, y: 100 }, overrides: {} },
      { id: 'output', type: 'output', kind: 'user', position: { x: 0, y: 200 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'a' },
      { id: 'e2', source: 'a', target: 'output' }
    ]
  };
  store.save(base); // fine with both
  assert.throws(
    () => store.save({ ...base, nodes: base.nodes.filter(n => n.type !== 'input') }),
    /User Input node/);
  assert.throws(
    () => store.save({ ...base, nodes: base.nodes.filter(n => n.type !== 'output') }),
    /Output node/);
});

test('ensureStructuralNodes restores missing input/output on load', () => {
  const flow = { id: 'f', name: 'F', nodes: [{ id: 'a', templateId: 'work', position: { x: 0, y: 0 }, overrides: {} }], edges: [] };
  const fixed = ensureStructuralNodes(flow);
  assert.ok(fixed.nodes.some(n => n.type === 'input'));
  assert.ok(fixed.nodes.some(n => n.type === 'output'));
  // Pure: nothing missing, same object back.
  assert.equal(ensureStructuralNodes(fixed), fixed);
});

// --- Legacy template migration ----------------------------------------------

test('retired template ids migrate to the combined nodes with the right options', () => {
  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'i', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'a', templateId: 'code-design-step', position: { x: 0, y: 0 }, overrides: { title: 'Kept' } },
      { id: 'b', templateId: 'step-eval', position: { x: 0, y: 0 }, overrides: {} },
      { id: 'c', templateId: 'stitch', position: { x: 0, y: 0 }, overrides: {} },
      { id: 'o', type: 'output', kind: 'user', position: { x: 0, y: 0 }, data: {} }
    ],
    edges: []
  };
  const m = migrateLegacyTemplates(flow);
  const [, a, b, c] = m.nodes;
  assert.equal(a.templateId, 'work');
  assert.equal(a.overrides.category, 'Code design');
  assert.equal(a.overrides.title, 'Kept'); // user overrides survive
  assert.equal(b.templateId, 'evaluation');
  assert.equal(b.overrides.evalType, 'step');
  assert.equal(c.templateId, 'combine');
});

// --- Combined-node option resolution ----------------------------------------

test('the Evaluation node resolves evalType to the concrete role', () => {
  const tpl = seed('evaluation');
  for (const [evalType, role] of [['plan', 'plan-eval'], ['step', 'step-eval'], ['final', 'final-eval']]) {
    const n = resolveInstance({ id: 'e', templateId: 'evaluation', position: { x: 0, y: 0 }, overrides: { evalType } }, tpl);
    assert.equal(n.data.role, role);
    assert.equal(n.data.evalType, evalType);
  }
  // Default is step evaluation.
  const d = resolveInstance({ id: 'e', templateId: 'evaluation', position: { x: 0, y: 0 }, overrides: {} }, tpl);
  assert.equal(d.data.role, 'step-eval');
});

test('effort rides on instances: template default, override wins', () => {
  const n1 = resolveInstance({ id: 'w', templateId: 'work', position: { x: 0, y: 0 }, overrides: {} }, seed('work'));
  assert.equal(n1.data.effort, 'medium');
  const n2 = resolveInstance({ id: 'w', templateId: 'work', position: { x: 0, y: 0 }, overrides: { effort: 'high' } }, seed('work'));
  assert.equal(n2.data.effort, 'high');
  assert.equal(seed('plan-start').effort, 'high'); // planning defaults high
});

test('the translation node carries its target language', () => {
  const n = resolveInstance({ id: 't', templateId: 'translation', position: { x: 0, y: 0 }, overrides: { language: 'Norwegian' } }, seed('translation'));
  assert.equal(n.data.role, 'translate');
  assert.equal(n.data.language, 'Norwegian');
});

// --- Feedback channel --------------------------------------------------------

test('lint: a feedback edge may point backwards; structural endpoints are errors', () => {
  const nodes = [
    { id: 'input', type: 'input', kind: 'user', data: {} },
    { id: 'w', templateId: 'work', overrides: {} },
    { id: 'r', templateId: 'general-analysis', overrides: {} },
    { id: 'output', type: 'output', kind: 'user', data: {} }
  ];
  const fwd = [
    { id: 'e1', source: 'input', target: 'w' },
    { id: 'e2', source: 'w', target: 'r' },
    { id: 'e3', source: 'r', target: 'output' }
  ];
  const templates = SEED_NODE_TEMPLATES;
  // Backwards feedback edge: no cycle error.
  const ok = lintFlow({ id: 'f', name: 'F', nodes, edges: [...fwd, { id: 'fb', source: 'r', target: 'w', sourceHandle: FEEDBACK_HANDLE }] }, { templates });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  // The same edge WITHOUT the feedback handle is a cycle.
  const cyc = lintFlow({ id: 'f', name: 'F', nodes, edges: [...fwd, { id: 'fb', source: 'r', target: 'w' }] }, { templates });
  assert.ok(cyc.errors.some(f => f.rule === 'cycle'));
  // Feedback into a structural node is an error.
  const bad = lintFlow({ id: 'f', name: 'F', nodes, edges: [...fwd, { id: 'fb', source: 'r', target: 'input', sourceHandle: FEEDBACK_HANDLE }] }, { templates });
  assert.ok(bad.errors.some(f => f.rule === 'feedback'));
});

test('topoSort ignores feedback edges', () => {
  const flow = makeFlow(
    [node('input', 'input'), node('a', 'aiStep', { role: 'execute' }), node('b', 'aiStep', { role: 'analyze' }), node('out', 'output')],
    [edge('input', 'a'), edge('a', 'b'), edge('b', 'out'),
      { id: 'fb', source: 'b', target: 'a', sourceHandle: FEEDBACK_HANDLE }]
  );
  const order = topoSort(flow).map(n => n.id);
  assert.deepEqual(order, ['input', 'a', 'b', 'out']);
});

test('a feedback-edge retry verdict re-runs the judged node with guidance, then passes', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  const attempts = { work: 0, review: 0 };
  setScript(({ system, prompt }) => {
    if (/FEEDBACK LINK/.test(system)) {
      attempts.review += 1;
      return attempts.review === 1
        ? 'Not good enough.\n```json\n{ "verdict": "retry", "reason": "too vague", "guidance": "Name the file." }\n```'
        : 'Looks right now.\n```json\n{ "verdict": "pass", "reason": "fixed" }\n```';
    }
    attempts.work += 1;
    return attempts.work === 1 ? 'draft v1' : `revised (saw guidance: ${/RETRY GUIDANCE/.test(prompt)})`;
  });
  const flow = makeFlow(
    [node('input', 'input', { text: 'brief' }),
      node('w', 'aiStep', { role: 'execute', title: 'Work' }),
      node('r', 'aiStep', { role: 'analyze', title: 'Review' }),
      node('out', 'output')],
    [edge('input', 'w'), edge('w', 'r'), edge('r', 'out'),
      { id: 'fb', source: 'r', target: 'w', sourceHandle: FEEDBACK_HANDLE }]
  );
  const runId = runner.start(flow, { userInput: 'brief' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(attempts.work, 2, 'the judged node re-ran once');
  assert.equal(attempts.review, 2, 'the reviewer re-ran after the retry');
  assert.match(store.readNodeOutput(runId, 'w'), /revised \(saw guidance: true\)/);
});

// --- Orchestrator node budget ------------------------------------------------

test('the orchestrator planning prompt carries the min/max node budget', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  let orchSystem = '';
  setScript(({ system }) => {
    if (roleOf(system) === 'orchestrate') {
      orchSystem = system;
      return '```json\n' + JSON.stringify({
        nodes: [
          { id: 'g1', template: 'work', category: 'Code general', title: 'A', goal: 'Do A fully.' },
          { id: 'g2', template: 'work', category: 'documentation', title: 'B', goal: 'Do B fully.' }
        ],
        summary: 'two nodes'
      }) + '\n```';
    }
    return 'ok';
  });
  const flow = makeFlow(
    [node('input', 'input', { text: 'brief' }),
      node('orch', 'orchestrator', { title: 'Orch', minNodes: 2, maxNodes: 3 }),
      node('out', 'output')],
    [edge('input', 'orch'), edge('orch', 'out')]
  );
  const runId = runner.start(flow, { userInput: 'brief' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.match(orchSystem, /NODE BUDGET: declare between 2 and 3 nodes/);
});

// --- Model-priority defaults -------------------------------------------------

test('taskKindOf maps roles and categories to task kinds', () => {
  assert.equal(taskKindOf({ type: 'agentTask', data: { role: 'execute', category: 'Code design' } }), 'code');
  assert.equal(taskKindOf({ type: 'agentTask', data: { role: 'execute', category: 'documentation' } }), 'docs');
  assert.equal(taskKindOf({ type: 'aiStep', data: { role: 'plan-start' } }), 'planning');
  assert.equal(taskKindOf({ type: 'aiStep', data: { role: 'step-eval' } }), 'evaluation');
  assert.equal(taskKindOf({ type: 'aiStep', data: { role: 'analyze' } }), 'analysis');
  assert.equal(taskKindOf({ type: 'aiStep', data: { role: 'translate' } }), 'translation');
  assert.equal(taskKindOf({ type: 'orchestrator', data: {} }), 'planning');
  assert.equal(taskKindOf({ type: 'aiStep', data: {} }), 'general');
});

test('every provider offers a model for every task kind and effort', () => {
  for (const kind of TASK_KINDS) {
    for (const effort of ['low', 'medium', 'high']) {
      assert.ok(PROVIDER_ORDER[kind][effort].length >= 4, `${kind}/${effort} orders all providers`);
      for (const provider of ['anthropic', 'openai', 'kimi', 'openrouter']) {
        const models = PROVIDER_MODEL_PRIORITY[provider][kind][effort];
        assert.ok(models.length > 0, `${provider} has no ${kind}/${effort} model`);
      }
    }
  }
});

test('pickDefaultWorker: single-provider users get that provider\'s best option', () => {
  const codeHigh = { type: 'agentTask', data: { role: 'execute', category: 'Code general', effort: 'high' } };
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { anthropic: 'k' } }),
    { provider: 'anthropic', model: 'claude-opus-4-5' });
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { openai: 'k' } }),
    { provider: 'openai', model: 'gpt-5.2' });
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { kimi: 'k' } }),
    { provider: 'kimi', model: 'kimi-k2.7-code' });
  // A Kimi-Code subscription key can only serve kimi-for-coding.
  assert.deepEqual(
    pickDefaultWorker(codeHigh, { providerKeys: { kimi: 'k' }, kimiKeyKind: 'code' }),
    { provider: 'kimi', model: 'kimi-for-coding' });
  // No keys at all -> null (caller falls back to the executor default).
  assert.equal(pickDefaultWorker(codeHigh, { providerKeys: {} }), null);
});

test('effort level changes the default pick', () => {
  const keys = { providerKeys: { anthropic: 'k' } };
  const at = effort => pickDefaultWorker({ type: 'aiStep', data: { role: 'execute', category: 'documentation', effort } }, keys).model;
  assert.equal(at('low'), 'claude-haiku-4-5');
  assert.equal(at('medium'), 'claude-sonnet-5');
});

test('resolveWorker: explicit worker > categoryWorkers > priority defaults > executor default', () => {
  const n = data => ({ type: 'aiStep', data });
  // Explicit wins over everything.
  assert.deepEqual(
    resolveWorker(n({ worker: { provider: 'mock', model: 'mock-large' }, category: 'Code general' }),
      testConfig({ providerKeys: { anthropic: 'k' } })),
    { provider: 'mock', model: 'mock-large' });
  // categoryWorkers beats the priority table.
  assert.deepEqual(
    resolveWorker(n({ category: 'documentation' }),
      testConfig({ categoryWorkers: { documentation: { provider: 'openrouter', model: 'cheap/model' } }, providerKeys: { anthropic: 'k' } })),
    { provider: 'openrouter', model: 'cheap/model' });
  // Priority defaults apply when a real provider is connected.
  assert.deepEqual(
    resolveWorker(n({ role: 'execute', category: 'Code general', effort: 'medium' }),
      testConfig({ providerKeys: { anthropic: 'k' } })),
    { provider: 'anthropic', model: 'claude-sonnet-5' });
  // No keys: the configured executor default, exactly as before the rework.
  assert.deepEqual(
    resolveWorker(n({ role: 'execute' }), testConfig()),
    { provider: 'script', model: 'test-model' });
});

// --- Seed library shape ------------------------------------------------------

test('the seed library is the combined set', () => {
  const ids = SEED_NODE_TEMPLATES.map(t => t.id).sort();
  assert.deepEqual(ids, ['combine', 'compare', 'evaluation', 'general-analysis', 'plan-start', 'prompt-refiner', 'split', 'translation', 'work']);
});

test('NodeStore.migrateSeeds retires the old set and writes the combined one, once', () => {
  const dir = tmp();
  // Fake a pre-rework library: one old seed file + one user template.
  fs.writeFileSync(path.join(dir, 'code-general-step.json'), JSON.stringify({ id: 'code-general-step', name: 'Code (general)' }));
  fs.writeFileSync(path.join(dir, 'my-custom.json'), JSON.stringify({ id: 'my-custom', name: 'Mine', baseType: 'aiStep', role: 'custom' }));
  const ns = new NodeStore(dir);
  assert.equal(ns.get('code-general-step'), null, 'retired seed removed');
  assert.ok(ns.get('work'), 'combined seed written');
  assert.ok(ns.get('my-custom'), 'user template untouched');
  // Second construction: user deletions are respected (no re-seed).
  ns.remove('split');
  new NodeStore(dir);
  assert.equal(ns.get('split'), null);
});
