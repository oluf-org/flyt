// PIVOT-PLAN P5 — the empty library, the presets, and the kernel.
//
// This file replaces tests/seedPipelines.test.js's premise. The tiered
// pipelines still have to parse, lint clean, resolve and carry their two modes;
// what changed is that they are OFFERED rather than installed (decision 4), so
// every assertion here runs against presets/ and an installed copy rather than
// against a library the app filled in behind the user's back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowStore, SEED_PIPELINE_IDS, DEFAULT_PIPELINE_ID } from '../core/flowstore.js';
import { NodeStore } from '../core/nodestore.js';
import { lintFlow } from '../core/flowlang/lint.js';
import { resolveFlow, validateOverrideMap, PRESET_NODE_TEMPLATES } from '../src/flowTypes.js';
import {
  listNodePresets, listFlowPresets, installNodePreset, installFlowPreset, PRESET_ORIGIN
} from '../core/presets.js';
import { KERNEL_TEMPLATES, KERNEL_IDS } from '../core/kernel.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-preset-'));

// --- the empty library ------------------------------------------------------------

test('a fresh Node Library is EMPTY — nothing is installed behind the user', () => {
  const ns = new NodeStore(tmp());
  assert.deepEqual(ns.listFull(), []);
  assert.deepEqual(ns.list(), []);
});

test('the kernel exists, is hidden from the library, and resolves by id', () => {
  const ns = new NodeStore(tmp());
  // Hidden: it is not part of "your library" by any listing the UI uses.
  assert.deepEqual(ns.listFull().map(t => t.id), []);
  // Present: the builder's nodes resolve.
  assert.deepEqual(ns.listSystem().map(t => t.id).sort(), [...KERNEL_IDS].sort());
  assert.deepEqual(ns.listResolvable().map(t => t.id).sort(), [...KERNEL_IDS].sort());
  for (const id of KERNEL_IDS) {
    assert.equal(ns.get(id)?.system, true, `${id} must carry system: true`);
    assert.ok(ns.get(id).prompt?.length > 40, `${id} must carry a real, readable prompt`);
  }
});

test('the kernel is app-owned: restored if deleted, refused if shadowed', () => {
  const dir = tmp();
  const ns = new NodeStore(dir);
  fs.rmSync(path.join(ns.systemDir(), '_node-drafter.json'), { force: true });
  assert.equal(new NodeStore(dir).get('_node-drafter')?.id, '_node-drafter');
  assert.throws(() => ns.save({ id: '_node-drafter', name: 'mine' }), /system node/);
});

// --- node presets -------------------------------------------------------------------

test('every in-code preset has a file, and the files are what gets installed', () => {
  const presets = listNodePresets();
  assert.deepEqual(
    presets.map(p => p.presetId).sort(),
    PRESET_NODE_TEMPLATES.map(t => t.id).sort(),
    'presets/nodes/ has drifted from PRESET_NODE_TEMPLATES — re-run scripts/build-presets.mjs'
  );
  assert.ok(presets.every(p => p.name && p.description), 'a preset with no description is unofferable');
});

test('installing a node preset copies it in and marks where it came from', () => {
  const ns = new NodeStore(tmp());
  const tpl = installNodePreset(ns, 'work');
  assert.equal(tpl.id, 'work');
  assert.equal(tpl.origin, PRESET_ORIGIN);
  assert.equal(tpl.fromPreset, 'work');
  assert.deepEqual(ns.listFull().map(t => t.id), ['work']);
  // §10.5: provenance survives the round trip through the file.
  assert.equal(ns.get('work').origin, PRESET_ORIGIN);
});

test('a preset never eats a template the user already has', () => {
  const ns = new NodeStore(tmp());
  ns.save({ id: 'work', name: 'My own work node' });
  assert.throws(() => installNodePreset(ns, 'work'), /already exists/);
  assert.equal(ns.get('work').name, 'My own work node');
  // Renaming on the way in is the escape hatch.
  installNodePreset(ns, 'work', { asId: 'work-preset' });
  assert.equal(ns.get('work-preset').fromPreset, 'work');
});

// --- flow presets ---------------------------------------------------------------------

test('flow presets parse, and each declares the templates it needs', () => {
  const presets = listFlowPresets();
  assert.deepEqual(
    presets.map(p => p.presetId).sort(),
    [DEFAULT_PIPELINE_ID, ...SEED_PIPELINE_IDS].sort()
  );
  for (const p of presets) {
    assert.ok(p.nodeCount >= 4, `${p.presetId} should be a real pipeline`);
    assert.ok(p.needs.length > 0, `${p.presetId} must declare the templates it instantiates`);
  }
});

test('installing a flow preset brings the templates it needs with it', () => {
  const flows = new FlowStore(tmp());
  const nodes = new NodeStore(tmp());
  const { flowId, templates } = installFlowPreset(flows, nodes, 'pipeline-low');
  assert.equal(flowId, 'pipeline-low');
  assert.ok(templates.includes('work'), 'a flow that instantiates `work` must install it');
  // And the installed flow lints clean against the library it just created.
  const res = lintFlow(flows.load(flowId), { templates: nodes.listFull() });
  assert.ok(res.ok, `lint errors: ${JSON.stringify(res.errors)}`);
});

test('every flow preset lints clean, resolves, and carries its two modes', () => {
  for (const id of SEED_PIPELINE_IDS) {
    const flows = new FlowStore(tmp());
    const nodes = new NodeStore(tmp());
    installFlowPreset(flows, nodes, id);
    const flow = flows.load(id);
    const templates = nodes.listFull();
    const res = lintFlow(flow, { templates });
    assert.ok(res.ok, `${id} lint errors: ${JSON.stringify(res.errors)}`);
    const resolved = resolveFlow(flow, templates);
    assert.ok(resolved.nodes.length >= 4, `${id} resolved`);
    assert.equal(Object.keys(flow.modes).length, 2, `${id} has two modes`);
    for (const mode of Object.values(flow.modes)) {
      assert.deepEqual(validateOverrideMap(resolved, mode.overrides, {}), [], `${id} mode valid`);
    }
  }
});

test('the High preset carries the enriched planner prompt as node data (T8)', () => {
  const flows = new FlowStore(tmp());
  const nodes = new NodeStore(tmp());
  installFlowPreset(flows, nodes, 'pipeline-high');
  const high = flows.load('pipeline-high');
  const plan = high.nodes.find(n => n.id === 'plan');
  assert.equal(plan.overrides.effort, 'high');
  assert.match(plan.overrides.system, /HIGH effort/);
  assert.match(plan.overrides.system, /IN PARALLEL/);
  const orch = high.nodes.find(n => n.id === 'orchestrate');
  assert.equal(orch.data.maxNodes, 10);
  assert.deepEqual(orch.expose, ['minNodes', 'maxNodes']);
});

test('a flow preset never eats a flow the user already has', () => {
  const flows = new FlowStore(tmp());
  const nodes = new NodeStore(tmp());
  installFlowPreset(flows, nodes, 'pipeline-low');
  assert.throws(() => installFlowPreset(flows, nodes, 'pipeline-low'), /already exists/);
});
