// Node Library + template-instance model (GOALS.md refocus):
//   - NodeStore seeds itself from the BLOCKS.md catalog and round-trips CRUD
//   - resolveFlow merges template defaults with per-workflow overrides
//   - StackRunner: unified run entry (user input -> User Input node), library
//     resolution and per-template instructions
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../core/nodestore.js';
import { StackRunner } from '../core/stackRunner.js';
import { SEED_NODE_TEMPLATES, resolveFlow, resolveInstance, namedFlow, UNTITLED_FLOW } from '../src/flowTypes.js';
import { makeStore, setScript, testConfig, waitForStage } from './helpers.js';

const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const makeNodeStore = () => new NodeStore(tmpDir('llm-flow-nodes-'));

// --- NodeStore ---

test('NodeStore seeds the BLOCKS.md catalog into an empty directory', () => {
  const ns = makeNodeStore();
  const ids = ns.listFull().map(t => t.id).sort();
  assert.deepEqual(ids, SEED_NODE_TEMPLATES.map(t => t.id).sort());
  // Files, not memory, are the source of truth.
  assert.ok(fs.existsSync(path.join(ns.rootDir, 'plan-start.json')));
  // A non-empty directory is never re-seeded.
  ns.remove('split');
  assert.equal(ns.seedIfEmpty(), false);
  assert.equal(ns.get('split'), null);
});

test('NodeStore CRUD round-trips and normalizes templates', () => {
  const ns = makeNodeStore();
  const created = ns.create();
  assert.equal(created.baseType, 'aiStep');
  ns.save({ ...created, name: 'Refactor', baseType: 'agentTask', tools: ['write_file', 'nope'], worker: { provider: 'mock', model: 'mock-small' } });
  const loaded = ns.load(created.id);
  assert.equal(loaded.name, 'Refactor');
  assert.equal(loaded.baseType, 'agentTask');
  assert.deepEqual(loaded.tools, ['write_file']); // unknown tools dropped
  assert.deepEqual(loaded.worker, { provider: 'mock', model: 'mock-small' });
  ns.remove(created.id);
  assert.equal(ns.get(created.id), null);
});

// --- resolution: template defaults + per-workflow overrides ---

test('resolveFlow merges overrides over template defaults; structural nodes pass through', () => {
  const tpl = SEED_NODE_TEMPLATES.find(t => t.id === 'work');
  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'a', templateId: 'work', position: { x: 0, y: 100 }, overrides: {} },
      { id: 'b', templateId: 'work', position: { x: 0, y: 200 }, overrides: {
        title: 'My step', worker: { provider: 'script', model: 'override-m' }, requiresApproval: true, instructions: 'workflow extra'
      } }
    ],
    edges: []
  };
  const r = resolveFlow(flow, [{ ...tpl, instructions: 'template guidance' }]);
  const [inn, a, b] = r.nodes;
  assert.equal(inn.type, 'input'); // untouched
  assert.equal(a.type, tpl.baseType); // whatever the template declares, not a hardcoded shape
  assert.equal(a.data.title, 'Work');
  assert.equal(a.data.category, 'Code general');
  assert.equal(a.data.requiresApproval, false);
  assert.equal(a.data.instructions, 'template guidance');
  assert.equal(b.data.title, 'My step');
  assert.deepEqual(b.data.worker, { provider: 'script', model: 'override-m' });
  assert.equal(b.data.requiresApproval, true);
  assert.equal(b.data.instructions, 'template guidance\n\nworkflow extra');
  // Overrides never leak between instances of the same template.
  assert.notEqual(a.data.title, b.data.title);
});

test('resolveInstance flags a missing template instead of crashing', () => {
  const n = resolveInstance({ id: 'x', templateId: 'gone', position: { x: 0, y: 0 }, overrides: {} }, null);
  assert.equal(n.type, 'aiStep');
  assert.equal(n.data.missingTemplate, true);
  assert.equal(n.data.title, 'gone');
});

// --- StackRunner + Node Library: the unified run entry, end to end ---

test('template + override instructions reach the model prompt; agentTask templates carry tools', async () => {
  const store = makeStore();
  const ns = makeNodeStore();
  ns.save({ ...ns.load('work'), instructions: 'TPL-GUIDANCE' });
  const runner = new StackRunner(store, testConfig(), () => {}, ns);

  const prompts = [];
  setScript(({ prompt }) => { prompts.push(prompt); return 'ok'; });

  const flow = {
    id: 'f1', name: 'F1',
    nodes: [
      { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'work', templateId: 'work', position: { x: 0, y: 100 }, overrides: { instructions: 'OV-GUIDANCE' } },
      { id: 'tests', templateId: 'work', position: { x: 0, y: 200 }, overrides: { title: 'Test creation', category: 'Test-creation', goal: 'Write the tests.', tools: ['write_file'] } },
      { id: 'out', type: 'output', kind: 'user', position: { x: 0, y: 300 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'in', target: 'work' },
      { id: 'e2', source: 'work', target: 'tests' },
      { id: 'e3', source: 'tests', target: 'out' }
    ]
  };
  const runId = runner.start(flow, { userInput: 'do the thing' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const workPrompt = prompts.find(p => p.includes('TPL-GUIDANCE')) ?? '';
  assert.match(workPrompt, /TPL-GUIDANCE[\s\S]*OV-GUIDANCE/);
  // The agentTask instance became a real executor task with the tool subset.
  const task = store.readTasks(runId).tasks.find(t => t.title === 'Test creation');
  assert.deepEqual(task.tools, ['write_file']);
  assert.equal(store.readMeta(runId).nodeStatus.tests, 'done');
});

// Renaming a flow clears the field before the new name is typed, and the editor
// autosaves as you type — so the blank keystroke must still produce a saveable
// flow (FlowStore.save rejects a nameless one) instead of stranding the rename.
test('namedFlow: a blank name falls back, a real name is untouched', () => {
  const flow = { id: 'f1', nodes: [], edges: [] };
  assert.equal(namedFlow({ ...flow, name: '' }).name, UNTITLED_FLOW);
  assert.equal(namedFlow({ ...flow, name: '   ' }).name, UNTITLED_FLOW);
  assert.equal(namedFlow({ ...flow }).name, UNTITLED_FLOW); // name absent entirely
  const named = { ...flow, name: 'Docs pipeline' };
  assert.equal(namedFlow(named), named); // no needless copy
});
