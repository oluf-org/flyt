// Flow DSL core: YAML subset, parse, serialize — incl. the two round-trip
// guarantees serialize.js documents:
//   parseFlow(serializeFlow(x)) ≡ x            (minus positions / edge-id normalization)
//   serializeFlow(parseFlow(y)) === y  (byte)  (for serializer-produced y)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, formatScalar, formatInline } from '../core/flowlang/yaml.js';
import { parseFlow, parseEdgeExpr, FlowParseError } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const flowsDir = path.join(__dirname, '..', 'flows');

// --- YAML subset -------------------------------------------------------------

test('yaml: scalars, maps, sequences, comments', () => {
  const doc = parseYaml([
    'version: 1  # trailing comment',
    'id: my-flow',
    'count: 42',
    'ratio: -0.5',
    'on: true',
    'off: false',
    'nothing: null',
    'quoted: "a: b # not a comment"',
    "single: 'it''s'",
    'list: [a, b, 3]',
    'obj: { provider: mock, model: mock-large }',
    'block:',
    '  - one',
    '  - two',
    'nested:',
    '  inner:',
    '    deep: yes-plain',
    ''
  ].join('\n'));
  assert.deepEqual(doc, {
    version: 1, id: 'my-flow', count: 42, ratio: -0.5, on: true, off: false,
    nothing: null, quoted: 'a: b # not a comment', single: "it's",
    list: ['a', 'b', 3], obj: { provider: 'mock', model: 'mock-large' },
    block: ['one', 'two'], nested: { inner: { deep: 'yes-plain' } }
  });
});

test('yaml: literal blocks | and |-', () => {
  const doc = parseYaml('a: |\n  line 1\n  line 2\nb: |-\n  x\n\n  y\nc: 1\n');
  assert.equal(doc.a, 'line 1\nline 2\n');
  assert.equal(doc.b, 'x\n\ny');
  assert.equal(doc.c, 1);
});

test('yaml: compact map items in sequences', () => {
  const doc = parseYaml('outputs:\n  - id: tasks\n    label: tasks.md\n  - { id: b }\n');
  assert.deepEqual(doc.outputs, [{ id: 'tasks', label: 'tasks.md' }, { id: 'b' }]);
});

test('yaml: rejects unsupported features loudly', () => {
  assert.throws(() => parseYaml('a: &anchor 1'), /unsupported/);
  assert.throws(() => parseYaml('a: >\n  folded'), /folded/);
  assert.throws(() => parseYaml('---\na: 1\n---\nb: 2'), /multi-document/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => parseYaml('\ta: 1'), /tabs/);
});

test('yaml: formatScalar quotes anything doubtful', () => {
  assert.equal(formatScalar('Planning'), 'Planning');
  assert.equal(formatScalar('Plan → route (approval)'), 'Plan → route (approval)');
  assert.equal(formatScalar('has: colon'), '"has: colon"');
  assert.equal(formatScalar('true'), '"true"');
  assert.equal(formatScalar('12'), '"12"');
  assert.equal(formatScalar(' padded '), '" padded "');
  assert.equal(formatScalar('multi\nline'), '"multi\\nline"');
  assert.equal(formatInline({ a: 1, b: [1, 'x'] }), '{ a: 1, b: [1, x] }');
  // everything formatScalar emits must parse back to the same value
  for (const v of ['Planning', 'has: colon', 'true', '12', ' padded ', 'a # b', 'multi\nline', "it's"]) {
    assert.deepEqual(parseYaml(`k: ${formatScalar(v)}`), { k: v });
  }
});

// --- edge expressions ----------------------------------------------------------

test('parseEdgeExpr: simple, ported, chained', () => {
  assert.deepEqual(parseEdgeExpr('a -> b'), [{ source: 'a', target: 'b' }]);
  assert.deepEqual(parseEdgeExpr('plan.tasks -> route'), [{ source: 'plan', target: 'route', sourceHandle: 'tasks' }]);
  assert.deepEqual(parseEdgeExpr('a -> b -> c'), [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
  assert.deepEqual(parseEdgeExpr('a.x -> b.y -> c'),
    [{ source: 'a', target: 'b', sourceHandle: 'x' }, { source: 'b', target: 'c', sourceHandle: 'y' }]);
  assert.throws(() => parseEdgeExpr('a -> b.port'), /ends in a port/);
  assert.throws(() => parseEdgeExpr('a ->'), /bad flow entry/);
  assert.throws(() => parseEdgeExpr('a'), /bad flow entry/);
});

// --- parse ----------------------------------------------------------------------

const EXAMPLE = `version: 1
id: default-pipeline
name: Default pipeline
description: Plan → route (approval) → verify.

nodes:
  plan:
    use: plan-start
    title: Planning
  route:
    use: plan-eval
    title: Routing
    requiresApproval: true
  verify:
    use: final-eval
    title: Verification

flow:
  - input -> plan
  - plan.tasks -> route
  - route -> verify
  - verify -> output
`;

test('parseFlow: the REFACTOR-PLAN example', () => {
  const flow = parseFlow(EXAMPLE);
  assert.equal(flow.id, 'default-pipeline');
  assert.equal(flow.name, 'Default pipeline');
  assert.deepEqual(flow.nodes.map(n => n.id), ['input', 'plan', 'route', 'verify', 'output']);
  // implicit built-ins materialize as structural nodes
  assert.deepEqual(flow.nodes[0], { id: 'input', type: 'input', kind: 'user', data: {} });
  assert.deepEqual(flow.nodes[4], { id: 'output', type: 'output', kind: 'user', data: {} });
  // template instances carry overrides
  assert.deepEqual(flow.nodes[2], { id: 'route', templateId: 'plan-eval', overrides: { title: 'Routing', requiresApproval: true } });
  // ports become sourceHandle
  assert.deepEqual(flow.edges[1], { id: 'e-plan-route', source: 'plan', target: 'route', sourceHandle: 'tasks' });
  assert.equal(flow.edges.length, 4);
});

test('parseFlow: raw typed nodes with flattened data', () => {
  const flow = parseFlow([
    'version: 1', 'id: f', 'name: F', 'nodes:',
    '  task-a:', '    type: agentTask', '    title: Draft', '    goal: Write it.',
    '    worker: { provider: mock, model: mock-large }',
    '  step:', '    type: aiStep', '    role: custom', '    system: Summarize.',
    'flow:', '  - input -> task-a -> step -> output', ''
  ].join('\n'));
  assert.deepEqual(flow.nodes.find(n => n.id === 'task-a'), {
    id: 'task-a', type: 'agentTask', kind: 'user',
    data: { title: 'Draft', goal: 'Write it.', worker: { provider: 'mock', model: 'mock-large' } }
  });
  assert.equal(flow.nodes.find(n => n.id === 'step').kind, 'ai');
  assert.equal(flow.edges.length, 3);
});

test('parseFlow: rejects bad documents', () => {
  assert.throws(() => parseFlow('id: x\nname: y\nflow: []\n'), /version/);
  assert.throws(() => parseFlow('version: 1\nname: y\nflow: []\n'), /missing "id"/);
  assert.throws(() => parseFlow('version: 1\nid: x\nname: y\nnodes:\n  a:\n    use: t\n    type: aiStep\nflow: []\n'), /both "use" and "type"/);
  assert.throws(() => parseFlow('version: 1\nid: x\nname: y\nnodes:\n  a:\n    title: no-use\nflow: []\n'), /needs either/);
  assert.throws(() => parseFlow('version: 1\nid: x\nname: y\nnodes:\n  a:\n    type: nonsense\nflow: []\n'), /unknown type/);
});

test('parseFlow: malformed nodes/flow give a clean error, not a crash', () => {
  // These reach parseFlow directly via flowstore.load (no schema layer), so a
  // hand-edited file with the wrong shape must fail with FlowParseError.
  for (const bad of [
    'version: 1\nid: x\nname: y\nflow: { a: 1 }\n',   // flow is a map
    'version: 1\nid: x\nname: y\nflow: 42\n',          // flow is a number
    'version: 1\nid: x\nname: y\nflow: nope\n',        // flow is a bare string
    'version: 1\nid: x\nname: y\nnodes: hello\nflow: []\n',      // nodes is a string
    'version: 1\nid: x\nname: y\nnodes:\n  - a\nflow: []\n'      // nodes is a list
  ]) {
    assert.throws(() => parseFlow(bad), FlowParseError, `expected FlowParseError for: ${bad.slice(0, 40)}`);
  }
});

// --- round-trips -----------------------------------------------------------------

const stripPositions = flow => ({
  ...flow,
  nodes: flow.nodes.map(({ position, ...n }) => n),
  edges: flow.edges.map(e => ({ id: `e-${e.source}-${e.target}`, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) }))
});

test('round-trip: serialize(parse(y)) is byte-stable', () => {
  const y = serializeFlow(parseFlow(EXAMPLE));
  assert.equal(serializeFlow(parseFlow(y)), y);
});

// A legacy-format flow (the pre-DSL flows/*.json shape, Tweet-factory style).
const LEGACY_FIXTURE = {
  id: 'legacy-fixture', name: 'Tweet factory',
  nodes: [
    { id: 'input-1', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: { text: 'Write a short launch announcement.' } },
    { id: 'task-a', type: 'agentTask', kind: 'user', position: { x: 0, y: 130 }, data: { title: 'Draft announcement', goal: 'Draft the copy, under 120 words.', constraints: [], worker: { provider: 'mock', model: 'mock-large' } } },
    { id: 'output-1', type: 'output', kind: 'user', position: { x: -13, y: 302 }, data: {} },
    { id: 'aiStep-x', type: 'aiStep', kind: 'ai', position: { x: 426, y: 200 }, data: { title: 'Summarize', role: 'custom', system: 'Summarize the upstream content in one paragraph.', worker: { provider: 'mock', model: 'mock-large' } } }
  ],
  edges: [
    { id: 'e-input-1-task-a', source: 'input-1', target: 'task-a' },
    { id: 'e-task-a-output-1', source: 'task-a', target: 'output-1' },
    { id: 'e-task-a-aiStep-x', source: 'task-a', target: 'aiStep-x' }
  ]
};

test('round-trip: parse(serialize(x)) ≡ x for a legacy-format flow', () => {
  const yaml = serializeFlow(LEGACY_FIXTURE);
  const back = parseFlow(yaml);
  assert.deepEqual(back, stripPositions(LEGACY_FIXTURE));
  // and the text itself is stable
  assert.equal(serializeFlow(back), yaml);
});

test('round-trip: every shipped .flow.yaml is byte-stable', () => {
  const files = fs.readdirSync(flowsDir).filter(f => f.endsWith('.flow.yaml'));
  assert.ok(files.length >= 1, 'expected shipped DSL flows');
  for (const f of files) {
    const text = fs.readFileSync(path.join(flowsDir, f), 'utf8');
    assert.equal(serializeFlow(parseFlow(text)), text, `byte-stability mismatch for ${f}`);
  }
});

test('round-trip: multiline strings and odd titles survive', () => {
  const flow = {
    id: 'odd', name: 'Odd: strings & things',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 's', type: 'aiStep', kind: 'ai', data: { title: 'true', system: 'Line one.\n\n  indented\nLast.', role: 'custom' } },
      { id: 'output', type: 'output', kind: 'user', data: {} }
    ],
    edges: [
      { id: 'e-input-s', source: 'input', target: 's' },
      { id: 'e-s-output', source: 's', target: 'output' }
    ]
  };
  const yaml = serializeFlow(flow);
  assert.deepEqual(parseFlow(yaml), flow);
  assert.equal(serializeFlow(parseFlow(yaml)), yaml);
});

test('serialize: implicit input/output are omitted from nodes:', () => {
  const yaml = serializeFlow(parseFlow(EXAMPLE));
  assert.ok(!/^\s+input:/m.test(yaml));
  assert.ok(!/^\s+output:/m.test(yaml));
  assert.match(yaml, /- input -> plan/);
  assert.match(yaml, /- verify -> output/);
});

test('flow: parent (containment) survives a parse/serialize round-trip', () => {
  const text = [
    'version: 1',
    'id: cont-demo',
    'name: Containment demo',
    '',
    'nodes:',
    '  orch:',
    '    type: orchestrator',
    '    title: Orchestrator',
    '  worker:',
    '    type: aiStep',
    '    parent: orch',
    '    role: execute',
    '    title: Inside job',
    '  lib:',
    '    use: work',
    '    parent: orch',
    '    title: Library child',
    '',
    'flow:',
    '  - input -> orch',
    '  - orch -> worker',
    '  - orch -> output'
  ].join('\n') + '\n';
  const flow = parseFlow(text);
  const worker = flow.nodes.find(n => n.id === 'worker');
  assert.equal(worker.parentId, 'orch');
  assert.equal(worker.data.role, 'execute', 'parent is not swallowed into data');
  const lib = flow.nodes.find(n => n.id === 'lib');
  assert.equal(lib.parentId, 'orch');
  assert.equal(lib.templateId, 'work');
  assert.deepEqual(lib.overrides, { title: 'Library child' });

  const out = serializeFlow(flow);
  assert.match(out, /worker:\n(?:.+\n)*?\s+parent: orch\n/);
  const reparsed = parseFlow(out);
  assert.equal(reparsed.nodes.find(n => n.id === 'worker').parentId, 'orch');
  assert.equal(reparsed.nodes.find(n => n.id === 'lib').parentId, 'orch');
  // Byte-stable second pass: serializer output parses to identical YAML.
  assert.equal(serializeFlow(reparsed), out);
});
