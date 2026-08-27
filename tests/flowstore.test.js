// FlowStore: dual-format read (legacy .json + *.flow.yaml), DSL+sidecar
// writes, layout merge/auto-layout, save-migrates-legacy, seeding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowStore, DEFAULT_PIPELINE_ID } from '../core/flowstore.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-store-'));

const LEGACY = {
  id: 'legacy-flow', name: 'Legacy',
  nodes: [
    { id: 'in', type: 'input', kind: 'user', position: { x: 5, y: 6 }, data: {} },
    { id: 'a', templateId: 'plan-start', position: { x: 7, y: 8 }, overrides: { title: 'Plan' } },
    { id: 'out', type: 'output', kind: 'user', position: { x: 9, y: 10 }, data: {} }
  ],
  edges: [
    { id: 'e-in-a', source: 'in', target: 'a' },
    { id: 'e-a-out', source: 'a', target: 'out' }
  ]
};

test('flowstore: reads legacy .json as-is', () => {
  const store = new FlowStore(tmp());
  fs.writeFileSync(path.join(store.rootDir, 'legacy-flow.json'), JSON.stringify(LEGACY));
  assert.deepEqual(store.load('legacy-flow'), LEGACY);
  assert.deepEqual(store.list(), [{ id: 'legacy-flow', name: 'Legacy' }]);
});

test('flowstore: save writes DSL + layout sidecar and retires legacy .json', () => {
  const store = new FlowStore(tmp());
  fs.writeFileSync(path.join(store.rootDir, 'legacy-flow.json'), JSON.stringify(LEGACY));
  store.save(store.load('legacy-flow'));
  assert.ok(fs.existsSync(store.flowPath('legacy-flow')));
  assert.ok(fs.existsSync(store.layoutPath('legacy-flow')));
  assert.ok(!fs.existsSync(store.legacyPath('legacy-flow')), 'legacy file should be removed on save');
  const yaml = fs.readFileSync(store.flowPath('legacy-flow'), 'utf8');
  assert.ok(!yaml.includes('position'), 'positions must not leak into the DSL');
  const layout = JSON.parse(fs.readFileSync(store.layoutPath('legacy-flow'), 'utf8'));
  assert.deepEqual(layout.a, { x: 7, y: 8 });
  // load round-trips structure + positions
  assert.deepEqual(store.load('legacy-flow'), LEGACY);
});

test('flowstore: DSL wins when both formats exist', () => {
  const store = new FlowStore(tmp());
  fs.writeFileSync(path.join(store.rootDir, 'f.json'), JSON.stringify({ ...LEGACY, id: 'f', name: 'Old name' }));
  fs.writeFileSync(store.flowPath('f'), 'version: 1\nid: f\nname: New name\n\nflow:\n  - input -> output\n');
  assert.equal(store.load('f').name, 'New name');
  assert.deepEqual(store.list(), [{ id: 'f', name: 'New name' }]);
});

test('flowstore: AI-authored flow without layout gets auto-layout', () => {
  const store = new FlowStore(tmp());
  fs.writeFileSync(store.flowPath('ai'), [
    'version: 1', 'id: ai', 'name: AI authored', '',
    'nodes:', '  plan:', '    use: plan-start', '',
    'flow:', '  - input -> plan -> output', ''
  ].join('\n'));
  const flow = store.load('ai');
  assert.equal(flow.nodes.length, 3);
  const ys = flow.nodes.map(n => n.position.y);
  assert.ok(new Set(ys).size === 3, `auto-layout should spread rows, got ${ys}`);
});

test('flowstore: stale layout entries are ignored and pruned on save', () => {
  const store = new FlowStore(tmp());
  fs.writeFileSync(store.flowPath('p'), 'version: 1\nid: p\nname: P\n\nflow:\n  - input -> output\n');
  fs.writeFileSync(store.layoutPath('p'), JSON.stringify({ input: { x: 1, y: 2 }, output: { x: 3, y: 4 }, ghost: { x: 9, y: 9 } }));
  const flow = store.load('p');
  assert.deepEqual(flow.nodes.find(n => n.id === 'input').position, { x: 1, y: 2 });
  store.save(flow);
  const layout = JSON.parse(fs.readFileSync(store.layoutPath('p'), 'utf8'));
  assert.ok(!('ghost' in layout), 'stale entries pruned');
});

test('flowstore: create + remove use the DSL files', () => {
  const store = new FlowStore(tmp());
  const flow = store.create('work');
  assert.ok(fs.existsSync(store.flowPath(flow.id)));
  const loaded = store.load(flow.id);
  assert.deepEqual(loaded.nodes.map(n => n.id), ['input-1', 'step-1', 'output-1']);
  assert.equal(loaded.nodes[1].templateId, 'work');
  store.remove(flow.id);
  assert.ok(!fs.existsSync(store.flowPath(flow.id)));
  assert.ok(!fs.existsSync(store.layoutPath(flow.id)));
});

test('flowstore: default pipeline seeds once, as DSL', () => {
  const store = new FlowStore(tmp());
  assert.equal(store.ensureDefaultPipeline(), true);
  assert.equal(store.ensureDefaultPipeline(), false);
  const flow = store.load(DEFAULT_PIPELINE_ID);
  assert.deepEqual(flow.nodes.map(n => n.id), ['user-input', 'plan', 'route', 'verify', 'result']);
  assert.equal(flow.nodes.find(n => n.id === 'route').overrides.requiresApproval, true);
  assert.deepEqual(store.list()[0], { id: DEFAULT_PIPELINE_ID, name: 'Default pipeline' });
});
