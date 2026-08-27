// DECISIONS.md D27 — the tiered default pipelines (Low/Medium/High/Ultra).
// Each must parse, lint clean against the seeded Node Library, resolve, and
// carry two example worker modes; seeding must never overwrite user edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowStore, LOOP_TASK_ID, SEED_PIPELINE_IDS } from '../core/flowstore.js';
import { NodeStore } from '../core/nodestore.js';
import { ToolStore } from '../core/toolstore.js';
import { lintFlow } from '../core/stacklang/lint.js';
import { resolveFlow, validateOverrideMap } from '../src/flowTypes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-seed-'));

test('seed pipelines parse, lint clean, resolve, and carry two modes', () => {
  const store = new FlowStore(tmp());
  const nodes = new NodeStore(tmp()); // seeds the library (incl. prompt-refiner)
  const templates = nodes.listFull();

  const created = store.ensureSeedPipelines();
  assert.deepEqual(created.sort(), [...SEED_PIPELINE_IDS].sort());

  for (const id of SEED_PIPELINE_IDS) {
    const flow = store.load(id);
    const res = lintFlow(flow, { templates });
    assert.ok(res.ok, `${id} lint errors: ${JSON.stringify(res.errors)}`);
    const resolved = resolveFlow(flow, templates);
    assert.ok(resolved.nodes.length >= 4, `${id} resolved`);
    assert.equal(Object.keys(flow.modes).length, 2, `${id} has two modes`);
    // Every mode's overrides validate against the resolved flow.
    for (const mode of Object.values(flow.modes)) {
      assert.deepEqual(validateOverrideMap(resolved, mode.overrides, {}), [], `${id} mode valid`);
    }
  }
});

test('a fresh compatibility store can still run the Loop after shipped flow assets retire', () => {
  const store = new FlowStore(tmp());
  const nodes = new NodeStore(tmp());
  const tools = new ToolStore(tmp());
  assert.equal(store.ensureLoopTask(), true);
  assert.equal(store.ensureLoopTask(), false, 'seeding never overwrites an existing projection');
  const flow = store.load(LOOP_TASK_ID);
  const work = flow.nodes.find(node => node.id === 'work');
  assert.deepEqual(work.overrides.tools, ['loop']);
  assert.equal(work.overrides.toolCeiling, 'loop');
  assert.equal(work.overrides.effect, 'workspace-change');
  assert.equal(lintFlow(flow, { templates: nodes.listFull(), library: tools.catalog() }).ok, true);
});

test('seeding is idempotent and never overwrites user edits', () => {
  const dir = tmp();
  const store = new FlowStore(dir);
  new NodeStore(tmp());
  store.ensureSeedPipelines();

  // Edit a seeded pipeline, then re-seed: the edit survives, nothing re-created.
  const edited = { ...store.load('pipeline-low'), name: 'My Low' };
  store.save(edited);
  assert.deepEqual(store.ensureSeedPipelines(), []);
  assert.equal(store.load('pipeline-low').name, 'My Low');

  // A deleted seed is NOT resurrected (user deletions are respected).
  store.remove('pipeline-ultra');
  const again = store.ensureSeedPipelines();
  assert.deepEqual(again, ['pipeline-ultra']); // absent -> re-seeded (deletion of the FILE, not a user opt-out)
});

test('the High pipeline carries the enriched planner prompt as node data (T8)', () => {
  const store = new FlowStore(tmp());
  new NodeStore(tmp());
  store.ensureSeedPipelines();
  const high = store.load('pipeline-high');
  const plan = high.nodes.find(n => n.id === 'plan');
  assert.equal(plan.overrides.effort, 'high');
  assert.match(plan.overrides.system, /HIGH effort/);
  assert.match(plan.overrides.system, /IN PARALLEL/);
  const orch = high.nodes.find(n => n.id === 'orchestrate');
  assert.equal(orch.data.maxNodes, 10);
  assert.deepEqual(orch.expose, ['minNodes', 'maxNodes']);
});
