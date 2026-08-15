// Flow DSL linter: schema layer + every semantic rule, valid/invalid pairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lintText, lintFlow, RUNTIME_RULES } from '../core/flowlang/lint.js';
import { SEED_NODE_TEMPLATES, normalizeTemplate } from '../src/flowTypes.js';
import { builtinDefinitions } from '../core/tools/builtins.js';
import { normalizeTool } from '../src/toolTypes.js';

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

// invalid-override is unreachable through lintText (the schema layer rejects
// any key it doesn't know first), so it is exercised on a flow OBJECT — which
// is also how the runner's pre-run gate sees a flow. Since TOOLS-PLAN P3 the
// rule no longer fires for `tools`: an aiStep may hold read-effect tools, and
// `readonly-tools` polices which (tests/grants.test.js).
test('lint rule: invalid-override (error) on an unknown override key', () => {
  const flow = {
    id: 'p', name: 'P',
    nodes: [
      { id: 'input', type: 'input', data: {} },
      { id: 'a', templateId: 'plan-start', overrides: { nonsense: 1 } },
      { id: 'output', type: 'output', data: {} }
    ],
    edges: [{ id: 'e1', source: 'input', target: 'a' }, { id: 'e2', source: 'a', target: 'output' }]
  };
  const r = lintFlow(flow, { templates });
  const hit = r.findings.find(f => f.rule === 'invalid-override');
  assert.ok(hit, `expected invalid-override in [${rulesOf(r)}]`);
  assert.equal(r.ok, false);
});

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

test('lint: parent must be an existing container; structural/container nodes cannot be contained', () => {
  // "Container" is any node type that holds a scoped subgraph — orchestrator
  // and, since D36 P2, fanout. A lane living inside a fan-out is as valid as
  // an authored node inside an orchestrator.
  const base = {
    id: 'p', name: 'P',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 'orch', type: 'orchestrator', kind: 'ai', data: {} },
      { id: 'fan', type: 'fanout', kind: 'ai', data: { lanes: ['standard', 'wildcard'] } },
      { id: 'step', type: 'aiStep', kind: 'ai', data: {}, parentId: 'orch' },
      { id: 'lane', type: 'aiStep', kind: 'ai', data: {}, parentId: 'fan' },
      { id: 'lost', type: 'aiStep', kind: 'ai', data: {}, parentId: 'ghost' },
      { id: 'bad', type: 'aiStep', kind: 'ai', data: {}, parentId: 'step' },
      { id: 'nested', type: 'orchestrator', kind: 'ai', data: {}, parentId: 'orch' },
      { id: 'nestedFan', type: 'fanout', kind: 'ai', data: { lanes: ['standard'] }, parentId: 'orch' },
      { id: 'output', type: 'output', kind: 'user', data: {} }
    ],
    edges: [
      { id: 'e-input-orch', source: 'input', target: 'orch' },
      { id: 'e-orch-step', source: 'orch', target: 'step' },
      { id: 'e-fan-lane', source: 'fan', target: 'lane' },
      { id: 'e-orch-lost', source: 'orch', target: 'lost' },
      { id: 'e-orch-bad', source: 'orch', target: 'bad' },
      { id: 'e-orch-output', source: 'orch', target: 'output' }
    ]
  };
  const { errors } = lintFlow(base, { templates: null });
  const parentErrors = errors.filter(e => e.rule === 'parent');
  assert.ok(parentErrors.some(e => e.message.includes('parent "ghost" does not exist')));
  assert.ok(parentErrors.some(e => e.message.includes('parent "step" is not a container')));
  assert.ok(parentErrors.some(e => e.message.includes('"nested": orchestrator nodes cannot live inside a container')));
  assert.ok(parentErrors.some(e => e.message.includes('"nestedFan": fanout nodes cannot live inside a container')),
    'a fan-out is a container too — one level deep, like the orchestrator');
  assert.ok(!parentErrors.some(e => e.nodeId === 'step'), 'a valid child passes');
  assert.ok(!parentErrors.some(e => e.nodeId === 'lane'), 'a node inside a fan-out\'s box is valid');
  assert.ok(RUNTIME_RULES.includes('parent'), 'a broken parent blocks the pre-run gate');
});

// --- fan-out lanes (BRICKS P2.5) --------------------------------------------

const TEMPLATES = SEED_NODE_TEMPLATES.map(normalizeTemplate);
const SETS = { analysts: { name: 'Analysts', models: ['a/one', 'b/two'] } };

const fanFlow = data => ({
  id: 'f', name: 'F',
  nodes: [
    { id: 'input', type: 'input', kind: 'user', data: {} },
    { id: 'fan', type: 'fanout', kind: 'ai', data },
    { id: 'output', type: 'output', kind: 'user', data: {} }
  ],
  edges: [
    { id: 'e-input-fan', source: 'input', target: 'fan' },
    { id: 'e-fan-output', source: 'fan', target: 'output' }
  ]
});

test('lint: a fan-out with no lanes is an error, and blocks the pre-run gate', () => {
  const { errors } = lintFlow(fanFlow({ goal: 'g' }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(errors.some(e => e.rule === 'fanout-lanes' && /at least one lane/.test(e.message)));
  assert.ok(RUNTIME_RULES.includes('fanout-lanes'),
    'a container that cannot produce one child wedges the run rather than degrading it');
});

test('lint: lanes from a model set count — and an unknown set is named', () => {
  const ok = lintFlow(fanFlow({ goal: 'g', modelSet: 'analysts' }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!ok.errors.some(e => e.rule === 'fanout-lanes'), 'a set with members IS a lane list');

  const bad = lintFlow(fanFlow({ goal: 'g', modelSet: 'ghosts' }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(bad.errors.some(e => e.rule === 'fanout-lanes' && /"ghosts" does not exist/.test(e.message)));
});

test('lint: without the model sets, a set-driven fan-out is skipped rather than failed', () => {
  // The contract every data-dependent rule follows: skip rather than guess.
  // Guessing here would refuse to start a flow that is perfectly fine.
  const { errors } = lintFlow(fanFlow({ goal: 'g', modelSet: 'analysts' }), { templates: TEMPLATES });
  assert.ok(!errors.some(e => e.rule === 'fanout-lanes'));
});

test('lint: duplicate lane ids warn, because the second is not the lane you wrote', () => {
  const { findings } = lintFlow(fanFlow({ goal: 'g', lanes: [{ id: 'a' }, { id: 'a' }] }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(findings.some(f => f.rule === 'fanout-lanes' && f.severity === 'warning' && /runs as "a-2"/.test(f.message)));
});

test('lint: a fan-out where no lane names a model warns — that is N copies, not a fan-out', () => {
  const same = lintFlow(fanFlow({ goal: 'g', lanes: ['standard', 'wildcard'] }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(same.findings.some(f => f.rule === 'fanout-worker' && /same default worker/.test(f.message)));

  const varied = lintFlow(fanFlow({ goal: 'g', lanes: [{ id: 'a', worker: 'a/one' }, { id: 'b', worker: 'b/two' }] }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!varied.findings.some(f => f.rule === 'fanout-worker'));
});

test('lint: a lane on a model that is not active warns at author time', () => {
  const { findings } = lintFlow(fanFlow({ goal: 'g', lanes: [{ id: 'a', worker: 'a/one' }, { id: 'b', worker: 'nobody/x' }] }),
    { templates: TEMPLATES, modelSets: SETS, activeModels: [{ id: 'a/one', enabled: true }] });
  const warns = findings.filter(f => f.rule === 'fanout-worker');
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /lane "b" runs on "nobody\/x"/);
});

test('lint: a fan-out template that does not exist is an error, on the node or on a lane', () => {
  const onNode = lintFlow(fanFlow({ goal: 'g', template: 'nope', lanes: ['standard'] }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(onNode.errors.some(e => e.rule === 'fanout-template' && /"nope" does not exist/.test(e.message)));

  const onLane = lintFlow(fanFlow({ goal: 'g', lanes: [{ id: 'a', template: 'nope' }] }), { templates: TEMPLATES, modelSets: SETS });
  assert.ok(onLane.errors.some(e => e.rule === 'fanout-template'));

  const fine = lintFlow(fanFlow({ goal: 'g', lanes: [{ id: 'a', worker: 'a/one' }, { id: 'b', worker: 'b/two' }] }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!fine.errors.some(e => e.rule === 'fanout-template'), 'the default template ships in the library');
});

// --- the lane planner (FANOUT P4) -------------------------------------------

test('lint: a lane budget that cannot be satisfied is an error', () => {
  const { errors } = lintFlow(fanFlow({ goal: 'g', lanes: ['standard'], minLanes: 5, maxLanes: 3 }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(errors.some(e => e.rule === 'fanout-plan' && /minLanes \(5\) is greater than maxLanes \(3\)/.test(e.message)));

  const fine = lintFlow(fanFlow({ goal: 'g', lanes: ['standard'], minLanes: 2, maxLanes: 6 }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!fine.errors.some(e => e.rule === 'fanout-plan'));
});

test('lint: "plan: auto" with nothing to read warns', () => {
  // The planner reads the brief; a node with no goal and nothing wired in has
  // only the run prompt to choose a roster from.
  const bare = {
    id: 'f', name: 'F',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', data: {} },
      { id: 'fan', type: 'fanout', kind: 'ai', data: { plan: 'auto', lanes: ['standard', 'wildcard'] } },
      { id: 'output', type: 'output', kind: 'user', data: {} }
    ],
    edges: [{ id: 'e-fan-output', source: 'fan', target: 'output' }]
  };
  const { findings } = lintFlow(bare, { templates: TEMPLATES, modelSets: SETS });
  assert.ok(findings.some(f => f.rule === 'fanout-plan' && f.severity === 'warning' && /only the run prompt/.test(f.message)));

  // A goal is enough on its own, and so is an inbound edge.
  const withGoal = lintFlow(fanFlow({ plan: 'auto', goal: 'Read it.', lanes: ['standard', 'wildcard'] }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!withGoal.findings.some(f => f.rule === 'fanout-plan'));
  const wired = lintFlow(fanFlow({ plan: 'auto', lanes: ['standard', 'wildcard'] }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(!wired.findings.some(f => f.rule === 'fanout-plan'), 'something feeding the node IS a brief');
});

test('lint: a system prompt on the node makes "plan: auto" inert, and says so', () => {
  const { findings } = lintFlow(
    fanFlow({ plan: 'auto', goal: 'g', system: 'You are five readers.', lanes: ['standard', 'wildcard'] }),
    { templates: TEMPLATES, modelSets: SETS });
  assert.ok(findings.some(f => f.rule === 'fanout-plan' && f.severity === 'warning'
    && /wins over "plan: auto"/.test(f.message)),
  'both keys look active in the file; only one of them is');
});

test('lint: a peek cannot widen a fan-out past the read-only rule', () => {
  // The peek's grant is the INTERSECTION of PEEK_TOOLS with the node's own, so
  // the existing readonly-tools rule is what bounds it. Asserted here because
  // "the peek is read-only" is a safety claim, not a comment.
  const library = { tools: builtinDefinitions().map(normalizeTool), sets: [] };
  const { errors } = lintFlow(fanFlow({ plan: 'auto', goal: 'g', tools: ['write_file'], lanes: ['standard', 'wildcard'] }),
    { templates: TEMPLATES, modelSets: SETS, library });
  assert.ok(errors.some(e => e.rule === 'readonly-tools' && /write_file/.test(e.message)));
  assert.ok(RUNTIME_RULES.includes('readonly-tools'), 'and it blocks the pre-run gate');
});

test('lint: a fan-out written in the DSL parses and passes', () => {
  const text = [
    'version: 1',
    'id: fan-demo',
    'name: Fan demo',
    'nodes:',
    '  look:',
    '    type: fanout',
    '    title: Look at it',
    '    goal: Read this repo and say what matters.',
    '    lanes:',
    '      - standard',
    '      - id: wild',
    '        preset: wildcard',
    '        worker: a/one',
    '      - id: attack',
    '        preset: adversarial',
    '        worker: { provider: openrouter, model: b/two }',
    'flow:',
    '  - input -> look -> output',
    ''
  ].join('\n');
  const { ok, errors } = lintText(text, { templates: TEMPLATES, modelSets: SETS });
  assert.ok(ok, 'errors: ' + JSON.stringify(errors));
});
