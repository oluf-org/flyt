// Sub-flows (DECISIONS.md D36): the splice as pure functions, then the
// call site end to end — one run, one canvas, inner nodes as real nodes with
// namespaced ids, the inner flow's RESULT as the call site's output, and the
// two guards (cycle, depth) that stand between "edit the brick" and "recurse
// the engine".
import test from 'node:test';
import assert from 'node:assert/strict';
import { StackRunner } from '../core/stackRunner.js';
import { lintFlow, RUNTIME_RULES } from '../core/stacklang/lint.js';
import { parseFlow } from '../core/stacklang/parse.js';
import { serializeFlow } from '../core/stacklang/serialize.js';
import {
  spliceSubflow, spliceAllSubflows, subflowChildId, subflowPorts, resultNodesOf,
  findFlowCycle, flowDepth, SubflowError, MAX_SUBFLOW_DEPTH, SUBFLOW_SEP
} from '../core/nodes/subflow.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// An inner flow: input -> a -> b -> output, so `b` is its result.
const innerFlow = (id = 'inner') => ({
  id, name: `Inner ${id}`,
  nodes: [
    { id: 'input', type: 'input', kind: 'user', data: {} },
    { id: 'a', type: 'aiStep', kind: 'ai', data: { title: 'Step A', role: 'execute', goal: 'goal-a' } },
    { id: 'b', type: 'aiStep', kind: 'ai', data: { title: 'Step B', role: 'execute', goal: 'goal-b' } },
    { id: 'output', type: 'output', kind: 'user', data: {} }
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'a' },
    { id: 'e2', source: 'a', target: 'b' },
    { id: 'e3', source: 'b', target: 'output' }
  ]
});

const outerFlow = (data = { flowId: 'inner' }) => ({
  id: 'outer', name: 'Outer',
  nodes: [
    { id: 'in', type: 'input', kind: 'user', data: { text: 'brief' } },
    { id: 'call', type: 'subflow', kind: 'ai', data: { title: 'The brick', ...data } },
    { id: 'out', type: 'output', kind: 'user', data: {} }
  ],
  edges: [
    { id: 'eo1', source: 'in', target: 'call' },
    { id: 'eo2', source: 'call', target: 'out' }
  ]
});

const loaderFor = (...flows) => {
  const byId = new Map(flows.map(f => [f.id, f]));
  return id => byId.get(id) ?? null;
};

// --- what a sub-flow declares -----------------------------------------------

test('a sub-flow\'s result is whatever feeds its output node', () => {
  assert.deepEqual(resultNodesOf(innerFlow()).map(n => n.id), ['b']);
  assert.deepEqual(subflowPorts(innerFlow()).map(p => p.id), ['b']);
});

test('a flow with no output node falls back to its sinks', () => {
  const f = {
    id: 'x', name: 'X',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 'a', type: 'aiStep', kind: 'ai', data: {} },
      { id: 'b', type: 'aiStep', kind: 'ai', data: {} }
    ],
    edges: [{ id: 'e', source: 'input', target: 'a' }, { id: 'e2', source: 'input', target: 'b' }]
  };
  assert.deepEqual(resultNodesOf(f).map(n => n.id).sort(), ['a', 'b'],
    '"what did this produce" must always have an answer');
});

// --- the splice -------------------------------------------------------------

test('splicing namespaces inner ids and parents them to the call site', () => {
  const outer = outerFlow();
  const call = outer.nodes.find(n => n.id === 'call');
  const r = spliceSubflow(outer, call, { loadFlow: loaderFor(innerFlow()) });

  assert.deepEqual(r.children.map(c => c.id), ['call__a', 'call__b']);
  assert.equal(subflowChildId('call', 'a'), 'call' + SUBFLOW_SEP + 'a');
  for (const c of r.children) {
    assert.equal(c.parentId, 'call');
    assert.equal(c.data.managedBy, 'call');
    assert.equal(c.data.subflowId, 'inner');
  }
  assert.equal(r.children[0].data.subflowNodeId, 'a', 'provenance keeps the inner id');
  assert.deepEqual(r.resultIds, ['call__b']);
});

test('the inner input is mapped to the call site\'s own sources, not spliced', () => {
  const outer = outerFlow();
  spliceSubflow(outer, outer.nodes.find(n => n.id === 'call'), { loadFlow: loaderFor(innerFlow()) });
  assert.ok(!outer.nodes.some(n => n.id === 'call__input'), 'no placeholder node with no output');
  assert.ok(!outer.nodes.some(n => n.id === 'call__output'));
  // input -> a became  in -> call__a, so upstream context reaches it normally.
  assert.ok(outer.edges.some(e => e.source === 'in' && e.target === 'call__a'));
  assert.ok(outer.edges.some(e => e.source === 'call__a' && e.target === 'call__b'));
  assert.ok(!outer.edges.some(e => e.target === 'call__output'));
});

test('an inner gate survives the splice (Q-B1)', () => {
  // An orchestrator forces its children autonomous because a MODEL invented
  // them. A sub-flow's nodes were authored by a human who put that gate there
  // on purpose — stripping it would silently remove oversight.
  const inner = innerFlow();
  inner.nodes.find(n => n.id === 'a').data.requiresApproval = true;
  const outer = outerFlow();
  const r = spliceSubflow(outer, outer.nodes.find(n => n.id === 'call'), { loadFlow: loaderFor(inner) });
  assert.equal(r.children.find(c => c.id === 'call__a').data.requiresApproval, true);
});

test('call-site overrides and a mode reach the inner nodes (B4)', () => {
  const inner = innerFlow();
  inner.modes = { deep: { name: 'Deep', overrides: { a: { effort: 'high' } } } };
  const outer = outerFlow({ flowId: 'inner', flowMode: 'deep', flowOverrides: { b: { effort: 'low' } } });
  const r = spliceSubflow(outer, outer.nodes.find(n => n.id === 'call'), { loadFlow: loaderFor(inner) });
  assert.equal(r.children.find(c => c.id === 'call__a').data.effort, 'high', 'from the mode');
  assert.equal(r.children.find(c => c.id === 'call__b').data.effort, 'low', 'from the call site');
});

test('an unknown mode or flow fails the splice with a message that names it', () => {
  const outer = outerFlow({ flowId: 'ghost' });
  assert.throws(() => spliceSubflow(outer, outer.nodes.find(n => n.id === 'call'), { loadFlow: loaderFor(innerFlow()) }),
    /flow "ghost" does not exist/);
  const outer2 = outerFlow({ flowId: 'inner', flowMode: 'nope' });
  assert.throws(() => spliceSubflow(outer2, outer2.nodes.find(n => n.id === 'call'), { loadFlow: loaderFor(innerFlow()) }),
    /has no mode "nope"/);
});

test('splicing stamps the call site\'s ports, so <call>.<port> resolves', () => {
  const outer = outerFlow();
  spliceAllSubflows(outer, { loadFlow: loaderFor(innerFlow()) });
  const call = outer.nodes.find(n => n.id === 'call');
  assert.deepEqual(call.data.outputs.map(p => p.id), ['b']);
});

// --- nesting: depth and cycles (B3) -----------------------------------------

test('a flow that contains itself is caught before it recurses', () => {
  const self = { ...innerFlow('self'), nodes: [...innerFlow('self').nodes, { id: 'me', type: 'subflow', kind: 'ai', data: { flowId: 'self' } }] };
  const byId = new Map([['self', self]]);
  assert.deepEqual(findFlowCycle('self', byId), ['self', 'self']);

  const outer = outerFlow({ flowId: 'self' });
  assert.throws(() => spliceAllSubflows(outer, { loadFlow: loaderFor(self) }),
    /already on the call path/);
});

test('an indirect cycle (A uses B uses A) is caught too', () => {
  const a = { ...innerFlow('a'), nodes: [...innerFlow('a').nodes, { id: 'toB', type: 'subflow', kind: 'ai', data: { flowId: 'b' } }] };
  const b = { ...innerFlow('b'), nodes: [...innerFlow('b').nodes, { id: 'toA', type: 'subflow', kind: 'ai', data: { flowId: 'a' } }] };
  const byId = new Map([['a', a], ['b', b]]);
  const cycle = findFlowCycle('a', byId);
  assert.ok(cycle && cycle.length >= 2, `expected a cycle, got ${JSON.stringify(cycle)}`);
  assert.equal(cycle[0], cycle[cycle.length - 1], 'a cycle closes on itself');
});

test('depth counts every container, and the cap is enforced at splice time', () => {
  // l1 -> l2 -> l3 -> l4: four levels of sub-flow, one too many.
  const chain = ['l1', 'l2', 'l3', 'l4'].map(id => innerFlow(id));
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].nodes.push({ id: 'next', type: 'subflow', kind: 'ai', data: { flowId: chain[i + 1].id } });
  }
  const byId = new Map(chain.map(f => [f.id, f]));
  assert.equal(flowDepth('l4', byId), 0, 'a leaf nests nothing');
  assert.equal(flowDepth('l1', byId), 3);

  const outer = outerFlow({ flowId: 'l1' });
  assert.throws(() => spliceAllSubflows(outer, { loadFlow: loaderFor(...chain) }),
    new RegExp(`deeper than ${MAX_SUBFLOW_DEPTH}`));
});

test('an orchestrator inside a sub-flow counts toward the depth', () => {
  const withOrch = innerFlow('o');
  withOrch.nodes.push({ id: 'orch', type: 'orchestrator', kind: 'ai', data: {} });
  assert.equal(flowDepth('o', new Map([['o', withOrch]])), 1,
    'the D8 two-tier rule stands on top of the sub-flow cap');
});

// --- lint (P3.4) ------------------------------------------------------------

test('lint: unknown-flow / flow-cycle / flow-depth, and all three gate the run', () => {
  const flows = [innerFlow()];
  const ok = lintFlow(outerFlow(), { templates: null, flows });
  assert.ok(!ok.errors.some(e => e.rule.startsWith('flow-') || e.rule === 'unknown-flow'), JSON.stringify(ok.errors));

  const missing = lintFlow(outerFlow({ flowId: 'ghost' }), { templates: null, flows });
  assert.ok(missing.errors.some(e => e.rule === 'unknown-flow' && /"ghost" does not exist/.test(e.message)));

  const selfRef = { ...outerFlow({ flowId: 'outer' }) };
  const cyc = lintFlow(selfRef, { templates: null, flows });
  assert.ok(cyc.errors.some(e => e.rule === 'flow-cycle'), JSON.stringify(cyc.errors));

  for (const rule of ['unknown-flow', 'flow-cycle', 'flow-depth']) {
    assert.ok(RUNTIME_RULES.includes(rule), `${rule} must gate the run`);
  }
});

test('lint: without the flow catalog, the sub-flow rules skip rather than guess', () => {
  const { errors } = lintFlow(outerFlow({ flowId: 'ghost' }), { templates: null });
  assert.ok(!errors.some(e => e.rule === 'unknown-flow'));
});

test('lint: an unknown port on a call site is resolved through the reference', () => {
  const f = outerFlow();
  f.edges.push({ id: 'bad', source: 'call', target: 'out', sourceHandle: 'nope' });
  const { errors } = lintFlow(f, { templates: null, flows: [innerFlow()] });
  assert.ok(errors.some(e => e.rule === 'unknown-port' && /declares no output "nope"/.test(e.message)));
});

// --- the DSL shape (P3.1) ---------------------------------------------------

test('the `flow:` node shape parses, and round-trips back to `flow:`', () => {
  const text = [
    'version: 1',
    'id: caller',
    'name: Caller',
    'nodes:',
    '  brick:',
    '    flow: inner',
    '    mode: deep',
    '    overrides:',
    '      a: { effort: high }',
    'flow:',
    '  - input -> brick -> output',
    ''
  ].join('\n');
  const parsed = parseFlow(text);
  const call = parsed.nodes.find(n => n.id === 'brick');
  assert.equal(call.type, 'subflow');
  assert.equal(call.kind, 'ai');
  assert.equal(call.data.flowId, 'inner');
  assert.equal(call.data.flowMode, 'deep');
  assert.deepEqual(call.data.flowOverrides, { a: { effort: 'high' } });

  const round = serializeFlow(parsed);
  assert.match(round, /flow: inner/);
  assert.match(round, /mode: deep/);
  assert.ok(!round.includes('type: subflow'), 'what you wrote is what gets written back');
  assert.deepEqual(parseFlow(round).nodes.find(n => n.id === 'brick').data, call.data);
});

test('a node cannot be two shapes at once', () => {
  const bad = 'version: 1\nid: c\nname: C\nnodes:\n  x:\n    flow: inner\n    use: work\nflow:\n  - input -> x -> output\n';
  assert.throws(() => parseFlow(bad), /pick one/);
});

// --- end to end -------------------------------------------------------------

test('a sub-flow runs inline: one run, namespaced children, the inner result as its output', async () => {
  const store = makeStore();
  const seen = [];
  setScript(({ prompt }) => {
    const goal = (prompt.match(/GOAL:\n(.+)/) ?? [])[1] ?? '?';
    seen.push(goal);
    return `did ${goal}`;
  });
  const runner = new StackRunner(store, testConfig(), () => {}, null, { load: loaderFor(innerFlow()) });
  const runId = runner.start(outerFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done', meta.error ?? '');
  assert.equal(meta.nodeStatus.call, 'done');
  assert.equal(meta.nodeStatus.call__a, 'done');
  assert.equal(meta.nodeStatus.call__b, 'done');
  assert.deepEqual(seen, ['goal-a', 'goal-b'], 'inner ordering is preserved');

  // One run folder, one flow.json — the spliced graph, so the snapshot always
  // shows what actually ran (P3.7).
  const flow = store.readFlow(runId);
  assert.equal(flow.nodes.find(n => n.id === 'call__a').parentId, 'call');
  assert.equal(flow.nodes.find(n => n.id === 'call__a').data.subflowId, 'inner');

  // The call site reports the inner RESULT, not everything inside it.
  const agg = store.readNodeOutput(runId, 'call');
  assert.match(agg, /did goal-b/);
  assert.ok(!agg.includes('did goal-a'), 'a caller means "what did it produce", not "what happened inside"');
  // …but the port sidecar and the inner node's own output are both there.
  assert.match(store.readNodeOutput(runId, 'call.b'), /did goal-b/);
  assert.match(store.readNodeOutput(runId, 'call__a'), /did goal-a/);
  assert.match(store.readNodeOutput(runId, 'out'), /did goal-b/);
});

test('a sub-flow with no flow library refuses to start rather than running an empty box', () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new StackRunner(store, testConfig());
  assert.throws(() => runner.start(outerFlow(), { userInput: 'brief' }), /no flow library/);
});

test('an unresolvable reference fails at start, naming the flow', () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new StackRunner(store, testConfig(), () => {}, null, { load: loaderFor(innerFlow()) });
  assert.throws(() => runner.start(outerFlow({ flowId: 'ghost' }), { userInput: 'brief' }),
    /could not be assembled[\s\S]*"ghost" does not exist/);
});

test('nested sub-flows splice in one pass', async () => {
  const store = makeStore();
  setScript(({ prompt }) => `did ${(prompt.match(/GOAL:\n(.+)/) ?? [])[1] ?? '?'}`);
  // mid calls inner; outer calls mid.
  const mid = innerFlow('mid');
  mid.nodes.push({ id: 'deeper', type: 'subflow', kind: 'ai', data: { flowId: 'inner' } });
  mid.edges.push({ id: 'em', source: 'a', target: 'deeper' });
  const runner = new StackRunner(store, testConfig(), () => {}, null, { load: loaderFor(mid, innerFlow()) });
  const runId = runner.start(outerFlow({ flowId: 'mid' }), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done', meta.error ?? '');
  assert.equal(meta.nodeStatus['call__deeper'], 'done');
  assert.equal(meta.nodeStatus['call__deeper__a'], 'done', 'two levels of namespacing');
  const flow = store.readFlow(runId);
  assert.equal(flow.nodes.find(n => n.id === 'call__deeper__a').parentId, 'call__deeper');
});

test('the spliced ids survive the run store\'s filename sanitiser', () => {
  // The reason the separator is '__' and not '/': nodeOutputPath() maps
  // anything outside [a-zA-Z0-9_-] to '_', and readNodeOutputs() turns
  // filenames back into node ids — a '/' would make every spliced node's
  // output unfindable.
  const store = makeStore();
  const runId = store.createRun('x');
  const id = subflowChildId('call', 'a');
  store.writeNodeOutput(runId, id, 'hello');
  assert.equal(store.readNodeOutput(runId, id), 'hello');
  assert.equal(store.readNodeOutputs(runId)[id], 'hello', 'the id round-trips through the filename');
});
