// DECISIONS.md D27 — the launch-override foundation (T1) and the modes:
// DSL block (T2). Launch overrides are the single primitive: a per-node map
// applied at run start on top of stored overrides. Modes are named, saved
// bundles of exactly that map, carried in the flow file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { lintText, lintFlow } from '../core/flowlang/lint.js';
import {
  resolveFlow, overridableFields, validateOverrideMap, mergeOverrideMaps,
  exposedFields, SEED_NODE_TEMPLATES
} from '../src/flowTypes.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// --- T1: resolveFlow launch overrides ---------------------------------------

function workFlow() {
  // input -> work (instance) -> output, plus a raw orchestrator to exercise
  // the raw-node merge path (minNodes/maxNodes live on data).
  return makeFlow(
    [node('input', 'input', { text: 'brief' }),
     { id: 'w', templateId: 'work', position: { x: 0, y: 0 }, overrides: { effort: 'low', category: 'Code general' } },
     node('orch', 'orchestrator', { title: 'Orch', maxNodes: 5 }),
     node('output', 'output')],
    [edge('input', 'w'), edge('w', 'orch'), edge('orch', 'output')]);
}

test('resolveFlow merges launch overrides over instance overrides (launch wins)', () => {
  const resolved = resolveFlow(workFlow(), SEED_NODE_TEMPLATES, { w: { effort: 'high' } });
  const w = resolved.nodes.find(n => n.id === 'w');
  assert.equal(w.data.effort, 'high'); // launch beat the stored 'low'
  assert.equal(w.data.category, 'Code general'); // untouched field preserved
});

test('resolveFlow merges launch overrides into a raw node data', () => {
  const resolved = resolveFlow(workFlow(), SEED_NODE_TEMPLATES, { orch: { maxNodes: 10, minNodes: 2 } });
  const orch = resolved.nodes.find(n => n.id === 'orch');
  assert.equal(orch.data.maxNodes, 10);
  assert.equal(orch.data.minNodes, 2);
});

test('resolveFlow never overrides structural input/output content', () => {
  const resolved = resolveFlow(workFlow(), SEED_NODE_TEMPLATES, { input: { worker: { provider: 'x', model: 'y' } } });
  const input = resolved.nodes.find(n => n.id === 'input');
  assert.equal(input.data.worker, undefined);
  assert.equal(input.data.text, 'brief');
});

test('resolveFlow with no launch overrides is unchanged behavior', () => {
  const a = resolveFlow(workFlow(), SEED_NODE_TEMPLATES);
  const b = resolveFlow(workFlow(), SEED_NODE_TEMPLATES, null);
  assert.deepEqual(a.nodes.find(n => n.id === 'w').data.effort, 'low');
  assert.deepEqual(b.nodes.find(n => n.id === 'w').data.effort, 'low');
});

// --- T1: overridableFields / validateOverrideMap ----------------------------

test('overridableFields gates fields by node type/role', () => {
  const resolved = resolveFlow(workFlow(), SEED_NODE_TEMPLATES);
  const w = resolved.nodes.find(n => n.id === 'w');
  const orch = resolved.nodes.find(n => n.id === 'orch');
  const input = resolved.nodes.find(n => n.id === 'input');

  const wf = overridableFields(w);
  assert.ok(wf.has('worker') && wf.has('effort') && wf.has('category'));
  assert.ok(wf.has('tools')); // work is an agentTask
  assert.ok(!wf.has('minNodes'));

  const of = overridableFields(orch);
  assert.ok(of.has('minNodes') && of.has('maxNodes'));

  assert.equal(overridableFields(input).size, 0); // structural: nothing
});

test('validateOverrideMap flags unknown nodes and illegal fields', () => {
  const resolved = resolveFlow(workFlow(), SEED_NODE_TEMPLATES);
  assert.deepEqual(validateOverrideMap(resolved, { w: { effort: 'high' } }), []);
  const errs = validateOverrideMap(resolved, {
    nope: { effort: 'high' },        // unknown node
    w: { minNodes: 3 },              // minNodes not valid on a work node
    output: { worker: {} }           // structural accepts nothing
  });
  assert.equal(errs.length, 3);
  assert.ok(errs.some(e => /unknown node "nope"/.test(e)));
  assert.ok(errs.some(e => /"minNodes" is not overridable on node "w"/.test(e)));
  assert.ok(errs.some(e => /"output".*accepts no overrides/.test(e)));
});

test('mergeOverrideMaps layers maps, later wins per field', () => {
  const merged = mergeOverrideMaps(
    { w: { effort: 'high', worker: { provider: 'a', model: 'm' } } },
    { w: { effort: 'low' }, x: { language: 'French' } }
  );
  assert.deepEqual(merged, {
    w: { effort: 'low', worker: { provider: 'a', model: 'm' } },
    x: { language: 'French' }
  });
});

// --- T1: runner.start applies mode + run-input overrides --------------------

function modeFlow() {
  const f = makeFlow(
    [node('input', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'custom', title: 'Step' }),
     node('output', 'output')],
    [edge('input', 'step'), edge('step', 'output')]);
  f.modes = {
    fast: { name: 'Fast', overrides: { step: { effort: 'high', worker: { provider: 'script', model: 'a' } } } }
  };
  return f;
}

test('start() applies a picked mode and records provenance in meta', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(modeFlow(), { userInput: 'brief', modeId: 'fast' });
  await waitForStage(store, runId, ['done', 'failed']);

  const flow = store.readFlow(runId);
  const step = flow.nodes.find(n => n.id === 'step');
  assert.equal(step.data.effort, 'high');
  assert.equal(step.data.worker.model, 'a');

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  assert.equal(meta.modeId, 'fast');
  assert.equal(meta.modeName, 'Fast');
  assert.deepEqual(meta.launchOverrides.step.effort, 'high');
});

test('start() layers run inputs over the mode (run input > mode)', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(modeFlow(), {
    userInput: 'brief', modeId: 'fast',
    overrides: { step: { effort: 'low' } } // run input overrides the mode's 'high'
  });
  await waitForStage(store, runId, ['done', 'failed']);
  const step = store.readFlow(runId).nodes.find(n => n.id === 'step');
  assert.equal(step.data.effort, 'low');
  assert.equal(step.data.worker.model, 'a'); // still the mode's worker
});

test('start() rejects an unknown mode', () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  assert.throws(() => runner.start(modeFlow(), { modeId: 'nope' }), /no mode "nope"/);
});

test('start() rejects launch overrides that reference an unknown node', () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  assert.throws(
    () => runner.start(modeFlow(), { overrides: { ghost: { effort: 'high' } } }),
    /launch overrides are invalid[\s\S]*unknown node "ghost"/);
});

// --- T2: modes: block parse / serialize round-trip --------------------------

const MODES_YAML = [
  'version: 1',
  'id: m',
  'name: M',
  '',
  'nodes:',
  '  refine:',
  '    type: aiStep',
  '    role: refine',
  '  orchestrate:',
  '    type: orchestrator',
  '',
  'flow:',
  '  - input -> refine',
  '  - refine -> orchestrate',
  '  - orchestrate -> output',
  '',
  'modes:',
  '  fable-high:',
  '    name: High — Fable',
  '    overrides:',
  '      refine: { worker: { provider: anthropic, model: claude-fable-5 } }',
  '      orchestrate: { maxNodes: 10 }',
  '  gpt-high:',
  '    name: High — GPT',
  '    overrides:',
  '      refine: { worker: { provider: openai, model: gpt-5 } }',
  ''
].join('\n');

test('parseFlow reads the modes block', () => {
  const flow = parseFlow(MODES_YAML);
  assert.deepEqual(Object.keys(flow.modes), ['fable-high', 'gpt-high']);
  assert.equal(flow.modes['fable-high'].name, 'High — Fable');
  assert.deepEqual(flow.modes['fable-high'].overrides.orchestrate, { maxNodes: 10 });
  assert.deepEqual(flow.modes['gpt-high'].overrides.refine.worker, { provider: 'openai', model: 'gpt-5' });
});

test('serializeFlow(parseFlow(x)) round-trips the modes block byte-for-byte', () => {
  const once = serializeFlow(parseFlow(MODES_YAML));
  const twice = serializeFlow(parseFlow(once));
  assert.equal(once, twice);
  assert.match(once, /modes:/);
  assert.match(once, /fable-high:/);
});

test('parseFlow rejects a malformed modes block', () => {
  assert.throws(() => parseFlow('version: 1\nid: m\nname: M\nflow:\n  - input -> output\nmodes:\n  - a\n'),
    /"modes" must be a map/);
  assert.throws(() => parseFlow('version: 1\nid: m\nname: M\nflow:\n  - input -> output\nmodes:\n  bad:\n    junk: 1\n'),
    /unknown field/);
});

// --- T2: mode linting -------------------------------------------------------

test('lint warns on a mode overriding a node not in the flow', () => {
  const flow = parseFlow(MODES_YAML.replace('orchestrate: { maxNodes: 10 }', 'ghost: { effort: high }'));
  const res = lintFlow(flow, { templates: null });
  assert.ok(res.warnings.some(w => w.rule === 'mode' && /ghost/.test(w.message)));
});

test('lint errors on a mode override field the node cannot accept', () => {
  // minNodes is orchestrator-only; putting it on the refine aiStep is illegal.
  const flow = parseFlow(MODES_YAML.replace(
    'refine: { worker: { provider: anthropic, model: claude-fable-5 } }',
    'refine: { minNodes: 3 }'));
  const res = lintFlow(flow, { templates: null });
  assert.ok(res.errors.some(e => e.rule === 'mode' && /minNodes/.test(e.message)));
});

test('lintText accepts a valid modes block through the schema', () => {
  const res = lintText(MODES_YAML, { templates: null });
  assert.ok(res.ok, JSON.stringify(res.errors));
});

// --- T9: expose ------------------------------------------------------------

const EXPOSE_YAML = [
  'version: 1',
  'id: e',
  'name: E',
  '',
  'nodes:',
  '  work:',
  '    type: aiStep',
  '    role: execute',
  '    category: Code general',
  '    expose: [worker, effort]',
  '',
  'flow:',
  '  - input -> work',
  '  - work -> output',
  ''
].join('\n');

test('expose parses as a first-class node field and round-trips', () => {
  const flow = parseFlow(EXPOSE_YAML);
  const work = flow.nodes.find(n => n.id === 'work');
  assert.deepEqual(work.expose, ['worker', 'effort']);
  const once = serializeFlow(flow);
  assert.match(once, /expose: \[worker, effort\]/);
  assert.equal(serializeFlow(parseFlow(once)), once); // round-trips
});

test('resolveFlow surfaces expose on data; exposedFields filters to overridable', () => {
  const resolved = resolveFlow(parseFlow(EXPOSE_YAML), SEED_NODE_TEMPLATES);
  const work = resolved.nodes.find(n => n.id === 'work');
  assert.deepEqual(work.data.expose, ['worker', 'effort']);
  assert.deepEqual(exposedFields(work), ['worker', 'effort']);
});

test('lint errors on an exposed field the node cannot accept', () => {
  const flow = parseFlow(EXPOSE_YAML.replace('expose: [worker, effort]', 'expose: [worker, maxNodes]'));
  const res = lintFlow(flow, { templates: null });
  assert.ok(res.errors.some(e => e.rule === 'expose' && /maxNodes/.test(e.message)));
});
