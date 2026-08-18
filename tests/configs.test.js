// DECISIONS.md D27 — configs (modes, upgraded to first-class).
// description/derivedFrom pass through parse/serialize/schema; lint warns on
// a dangling derivedFrom; diffOverrides turns a config into diff-against-
// Default badges; the FlowStore config helpers back save/duplicate/promote.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { lintText, lintFlow } from '../core/flowlang/lint.js';
import { FlowStore } from '../core/flowstore.js';
import { resolveFlow, diffOverrides, SEED_NODE_TEMPLATES } from '../src/flowTypes.js';
import { makeFlow, node, edge } from './helpers.js';

// --- P1: description / derivedFrom parse + serialize round-trip -------------

const CONFIGS_YAML = [
  'version: 1',
  'id: c',
  'name: C',
  '',
  'nodes:',
  '  refine:',
  '    type: aiStep',
  '    role: refine',
  '',
  'flow:',
  '  - input -> refine',
  '  - refine -> output',
  '',
  'modes:',
  '  gpt5:',
  '    name: GPT-5',
  '    description: Baseline GPT-5 worker, medium effort everywhere.',
  '    overrides:',
  '      refine: { worker: { provider: openai, model: gpt-5 } }',
  '  gpt5-strict:',
  '    name: GPT-5 · strict refiner',
  '    derivedFrom: gpt5',
  '    description: Same workers, refiner gets a stricter system prompt.',
  '    overrides:',
  '      refine: { worker: { provider: openai, model: gpt-5 }, system: Be strict. }',
  ''
].join('\n');

test('parseFlow reads description and derivedFrom as pass-through scalars', () => {
  const flow = parseFlow(CONFIGS_YAML);
  assert.equal(flow.modes.gpt5.description, 'Baseline GPT-5 worker, medium effort everywhere.');
  assert.equal(flow.modes.gpt5.derivedFrom, undefined);
  assert.equal(flow.modes['gpt5-strict'].derivedFrom, 'gpt5');
  assert.equal(flow.modes['gpt5-strict'].description, 'Same workers, refiner gets a stricter system prompt.');
  assert.deepEqual(flow.modes['gpt5-strict'].overrides.refine.system, 'Be strict.');
});

test('serializeFlow(parseFlow(x)) round-trips description/derivedFrom byte-for-byte', () => {
  const once = serializeFlow(parseFlow(CONFIGS_YAML));
  assert.match(once, /description: Baseline GPT-5 worker/);
  assert.match(once, /derivedFrom: gpt5/);
  assert.equal(serializeFlow(parseFlow(once)), once);
});

test('parseFlow rejects malformed description / derivedFrom', () => {
  const head = 'version: 1\nid: m\nname: M\nflow:\n  - input -> output\nmodes:\n';
  assert.throws(() => parseFlow(head + '  a:\n    description: 3\n'), /description must be a string/);
  assert.throws(() => parseFlow(head + '  a:\n    derivedFrom: has a space\n'), /derivedFrom must be a mode id/);
  assert.throws(() => parseFlow(head + '  a:\n    junk: 1\n'), /unknown field/);
});

test('lintText accepts description/derivedFrom through the schema', () => {
  const res = lintText(CONFIGS_YAML, { templates: null });
  assert.ok(res.ok, JSON.stringify(res.errors));
});

// --- P1: dangling derivedFrom lint ------------------------------------------

test('lint warns on a dangling derivedFrom (lineage to a non-existent mode)', () => {
  const yaml = CONFIGS_YAML.replace('derivedFrom: gpt5', 'derivedFrom: ghost');
  const res = lintFlow(parseFlow(yaml), { templates: null });
  assert.ok(res.warnings.some(w => w.rule === 'mode' && /derives from "ghost"/.test(w.message)));
});

test('lint does not warn when derivedFrom points at a real mode', () => {
  const res = lintFlow(parseFlow(CONFIGS_YAML), { templates: null });
  assert.ok(!res.warnings.some(w => /derives from/.test(w.message)));
});

// --- P1: diffOverrides — the diff-against-Default badges --------------------

function configFlow() {
  // input -> work (instance, stored effort/category) -> orch -> output.
  return makeFlow(
    [node('input', 'input', { text: 'brief' }),
     { id: 'work', templateId: 'work', position: { x: 0, y: 0 }, overrides: { title: 'Work', effort: 'medium', category: 'Code general' } },
     node('orch', 'orchestrator', { title: 'Orch', minNodes: 1, maxNodes: 5 }),
     node('output', 'output')],
    [edge('input', 'work'), edge('work', 'orch'), edge('orch', 'output')]);
}

test('diffOverrides renders model, system and scalar changes as badges', () => {
  const resolved = resolveFlow(configFlow(), SEED_NODE_TEMPLATES);
  const entries = diffOverrides(resolved, {
    work: { worker: { provider: 'openai', model: 'gpt-5' }, effort: 'high', system: 'Be strict.' },
    orch: { maxNodes: 10 }
  });
  const texts = entries.map(e => e.text);
  assert.deepEqual(texts, [
    'Work · model: default → gpt-5',
    'Work · effort: medium → high',
    'Work · system rewritten',
    'Orch · maxNodes: 5 → 10'
  ]);
  assert.ok(entries.every(e => e.kind === 'change'));
});

test('diffOverrides skips overrides that restate the default', () => {
  const resolved = resolveFlow(configFlow(), SEED_NODE_TEMPLATES);
  assert.deepEqual(diffOverrides(resolved, { work: { effort: 'medium', category: 'Code general' } }), []);
  assert.deepEqual(diffOverrides(resolved, null), []);
  assert.deepEqual(diffOverrides(resolved, {}), []);
});

test('diffOverrides flags unknown nodes and non-overridable fields honestly', () => {
  const resolved = resolveFlow(configFlow(), SEED_NODE_TEMPLATES);
  const entries = diffOverrides(resolved, {
    ghost: { effort: 'high' },   // deleted node
    input: { worker: { provider: 'x', model: 'y' } }, // structural: nothing overridable
    orch: { nope: 1 }            // not a field at all
  });
  assert.equal(entries.find(e => e.nodeId === 'ghost')?.kind, 'unknown-node');
  assert.equal(entries.find(e => e.nodeId === 'input')?.kind, 'not-overridable');
  assert.equal(entries.find(e => e.nodeId === 'orch')?.kind, 'not-overridable');
});

// --- P1: FlowStore config helpers -------------------------------------------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-configs-'));

function configStore() {
  const store = new FlowStore(tmp());
  const flow = makeFlow(
    [node('input', 'input', {}),
     { id: 'work', templateId: 'work', position: { x: 0, y: 0 }, overrides: { effort: 'medium' } },
     node('output', 'output')],
    [edge('input', 'work'), edge('work', 'output')]);
  flow.modes = {
    fable: { name: 'Fable', description: 'Fable everywhere.', overrides: { work: { worker: { provider: 'anthropic', model: 'claude-fable-5' } } } }
  };
  store.save(flow);
  return { store, flowId: flow.id };
}

test('flowstore saveConfig creates and updates a mode (patch semantics)', () => {
  const { store, flowId } = configStore();
  const created = store.saveConfig(flowId, 'gpt', {
    name: 'GPT', description: 'GPT worker.', overrides: { work: { worker: { provider: 'openai', model: 'gpt-5' } } }
  });
  assert.equal(created.name, 'GPT');
  assert.deepEqual(store.load(flowId).modes.gpt.overrides.work.worker.model, 'gpt-5');

  // Patch: description untouched, overrides replaced, name updated.
  const updated = store.saveConfig(flowId, 'gpt', { name: 'GPT-5', overrides: { work: { effort: 'high' } } });
  assert.equal(updated.name, 'GPT-5');
  assert.equal(updated.description, 'GPT worker.');
  assert.deepEqual(updated.overrides, { work: { effort: 'high' } });

  // The YAML on disk carries the new mode.
  const yaml = fs.readFileSync(store.flowPath(flowId), 'utf8');
  assert.match(yaml, /gpt:/);
  assert.match(yaml, /description: GPT worker\./);

  assert.throws(() => store.saveConfig(flowId, 'bad id!', { name: 'X' }), /Invalid mode id/);
});

test('flowstore duplicateConfig copies the full map and records derivedFrom', () => {
  const { store, flowId } = configStore();
  const copy = store.duplicateConfig(flowId, 'fable', 'fable-strict');
  assert.equal(copy.name, 'Fable (copy)');
  assert.equal(copy.description, 'Fable everywhere.');
  assert.equal(copy.derivedFrom, 'fable');
  assert.deepEqual(copy.overrides, { work: { worker: { provider: 'anthropic', model: 'claude-fable-5' } } });

  // A deep copy: editing the duplicate must not touch the source.
  store.saveConfig(flowId, 'fable-strict', { overrides: { work: { system: 'strict' } } });
  const modes = store.load(flowId).modes;
  assert.deepEqual(modes.fable.overrides.work.worker.model, 'claude-fable-5');
  assert.equal(modes.fable.overrides.work.system, undefined);

  assert.throws(() => store.duplicateConfig(flowId, 'fable', 'fable-strict'), /already has a config/);
  assert.throws(() => store.duplicateConfig(flowId, 'ghost', 'x'), /has no config "ghost"/);
});

test('flowstore promoteRunConfig writes a run\'s launch overrides as a config', () => {
  const { store, flowId } = configStore();
  const meta = {
    flowId, modeId: 'fable',
    launchOverrides: { work: { worker: { provider: 'openai', model: 'gpt-5' }, effort: 'high' } }
  };
  const { modeId, mode } = store.promoteRunConfig(flowId, meta, { name: 'GPT high' });
  assert.equal(modeId, 'gpt-high');
  assert.equal(mode.name, 'GPT high');
  assert.equal(mode.derivedFrom, 'fable'); // lineage back to the run's mode
  assert.deepEqual(mode.overrides.work, { worker: { provider: 'openai', model: 'gpt-5' }, effort: 'high' });

  // Same name again dedupes the id rather than overwriting.
  const again = store.promoteRunConfig(flowId, meta, { name: 'GPT high' });
  assert.equal(again.modeId, 'gpt-high-2');

  // A run with no launch configuration has nothing to promote.
  assert.throws(() => store.promoteRunConfig(flowId, { flowId }), /nothing to save/);
  assert.throws(() => store.promoteRunConfig(flowId, { flowId, launchOverrides: {} }), /nothing to save/);
});
