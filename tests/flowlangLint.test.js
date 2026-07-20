// Flow DSL linter: schema layer + every semantic rule, valid/invalid pairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintText, lintFlow, RUNTIME_RULES } from '../core/flowlang/lint.js';
import { SEED_NODE_TEMPLATES, normalizeTemplate } from '../src/flowTypes.js';

const templates = SEED_NODE_TEMPLATES.map(normalizeTemplate);

const VALID = `version: 1
id: p
name: P

nodes:
  plan:
    use: plan-start
  route:
    use: evaluation
    evalType: plan
    requiresApproval: true

flow:
  - input -> plan
  - plan.tasks -> route
  - route -> output
`;

const doc = (body) => `version: 1\nid: p\nname: P\n${body}`;
const rulesOf = r => r.findings.map(f => f.rule);

test('lint: a valid flow is ok (no errors, no warnings)', () => {
  const r = lintText(VALID, { templates });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('lint: schema layer rejects structural garbage', () => {
  for (const [text, hint] of [
    ['id: p\nname: P\nflow: []\n', /version/],
    [doc('flow:\n  - "not an edge"\n'), /pattern|match/],
    [doc('nodes:\n  a:\n    use: plan-start\n    bogusKey: 1\nflow:\n  - input -> a -> output\n'), /./],
    [doc('extra: field\nflow:\n  - input -> output\n'), /unknown field/]
  ]) {
    const r = lintText(text, { templates });
    assert.equal(r.ok, false, `expected schema failure for: ${text.slice(0, 60)}`);
    assert.equal(r.errors[0].rule, r.errors[0].rule === 'parse' ? 'parse' : 'schema');
    assert.match(r.errors[0].message, hint);
  }
});

test('lint: unbalanced YAML is a parse error, not a crash', () => {
  const r = lintText('version: 1\n  id: broken\n', { templates });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].rule, 'parse');
});

const CASES = [
  ['unknown-template', 'error',
    doc('nodes:\n  a:\n    use: no-such-template\nflow:\n  - input -> a -> output\n')],
  ['unknown-node', 'error',
    doc('nodes:\n  a:\n    use: plan-start\nflow:\n  - input -> a -> ghost -> output\n')],
  ['unknown-port', 'error',
    doc('nodes:\n  a:\n    use: plan-start\nflow:\n  - input -> a\n  - a.nope -> output\n')],
  ['cycle', 'error',
    doc('nodes:\n  a:\n    use: plan-start\n  b:\n    use: evaluation\nflow:\n  - input -> a -> b -> output\n  - b -> a\n')],
  ['unreachable', 'error',
    doc('nodes:\n  a:\n    use: plan-start\n  loner:\n    use: evaluation\nflow:\n  - input -> a -> output\n  - loner -> output\n')],
  ['dead-end', 'warning',
    doc('nodes:\n  a:\n    use: plan-start\n  sink:\n    use: evaluation\nflow:\n  - input -> a -> output\n  - a -> sink\n')],
  ['no-input', 'error',
    doc('nodes:\n  a:\n    use: plan-start\nflow:\n  - a -> output\n')],
  ['no-output', 'error',
    doc('nodes:\n  a:\n    use: plan-start\nflow:\n  - input -> a\n')],
  ['duplicate-edge', 'warning',
    doc('nodes:\n  a:\n    use: plan-start\nflow:\n  - input -> a -> output\n  - input -> a\n')],
  ['invalid-override', 'error',
    doc('nodes:\n  a:\n    use: plan-start\n    tools: [write_file]\nflow:\n  - input -> a -> output\n')],
  ['unknown-tool', 'error',
    doc('nodes:\n  a:\n    use: work\n    tools: [rm_rf]\nflow:\n  - input -> a -> output\n')],
  ['orphan-approval', 'warning',
    doc('nodes:\n  in2:\n    type: input\n    requiresApproval: true\n  a:\n    use: plan-start\nflow:\n  - in2 -> a -> output\n  - input -> a\n')]
];

for (const [rule, severity, text] of CASES) {
  test(`lint rule: ${rule} (${severity})`, () => {
    const r = lintText(text, { templates });
    const hit = r.findings.find(f => f.rule === rule);
    assert.ok(hit, `expected ${rule} in [${rulesOf(r)}]`);
    assert.equal(hit.severity, severity);
    if (severity === 'error') assert.equal(r.ok, false);
  });
}

test('lint: tools override IS valid on agentTask templates', () => {
  const r = lintText(
    doc('nodes:\n  t:\n    use: work\n    tools: [write_file]\nflow:\n  - input -> t -> output\n'),
    { templates });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('lint: object contextSpec is valid on a template node; a string is rejected', () => {
  // contextSpec is { files: [{ path, description? }] } everywhere in the runtime
  // (core/planEval.js, core/flowRunner.js) — the schema must accept that shape
  // on a `use:` instance, not force it to a string.
  const ok = lintText(
    doc('nodes:\n  a:\n    use: work\n    contextSpec: { files: [{ path: src/x.ts, description: only the exports }] }\nflow:\n  - input -> a -> output\n'),
    { templates });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  const bad = lintText(
    doc('nodes:\n  a:\n    use: work\n    contextSpec: just a string\nflow:\n  - input -> a -> output\n'),
    { templates });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].rule, 'schema');
});

test('lint: ported edge to a declared template port is valid', () => {
  const r = lintText(VALID, { templates });
  assert.equal(r.ok, true);
});

test('lintFlow: works on canonical objects (canvas / runner surface)', () => {
  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 'a', templateId: 'plan-start', overrides: {} },
      { id: 'output', type: 'output', kind: 'user', data: {} }
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'a' },
      { id: 'e2', source: 'a', target: 'output' }
    ]
  };
  assert.equal(lintFlow(flow, { templates }).ok, true);
  assert.equal(lintFlow({ ...flow, edges: [...flow.edges, { id: 'e3', source: 'output', target: 'a' }] }, { templates })
    .errors.some(f => f.rule === 'cycle'), true);
});

test('lintFlow: RUNTIME_RULES subset ignores shape rules', () => {
  // no input, no output — but structurally sound: the runner accepts it
  const flow = {
    id: 'f', name: 'F',
    nodes: [{ id: 'a', templateId: 'plan-start', overrides: {} }, { id: 'out', type: 'output', kind: 'user', data: {} }],
    edges: [{ id: 'e1', source: 'a', target: 'out' }]
  };
  const full = lintFlow(flow, { templates });
  assert.equal(full.ok, false); // no-input
  const gate = lintFlow(flow, { templates, rules: RUNTIME_RULES });
  assert.equal(gate.ok, true, JSON.stringify(gate.errors));
});

test('lintFlow: without templates, template-dependent rules skip', () => {
  const flow = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 'a', templateId: 'anything-goes', overrides: {} },
      { id: 'output', type: 'output', kind: 'user', data: {} }
    ],
    edges: [{ id: 'e1', source: 'input', target: 'a' }, { id: 'e2', source: 'a', target: 'output' }]
  };
  assert.equal(lintFlow(flow, { templates: null }).ok, true);
});

test('lint: machine-readable finding shape', () => {
  const r = lintText(doc('nodes:\n  a:\n    use: nope\nflow:\n  - input -> a -> output\n'), { templates });
  const f = r.errors[0];
  assert.deepEqual(Object.keys(f).sort(), ['message', 'nodeId', 'rule', 'severity'].sort());
  assert.equal(f.nodeId, 'a');
});
