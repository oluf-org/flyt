// PIVOT-PLAN P8 — conditionals and bounded loops (§5.3).
//
// The heaviest engine work in the plan, and the one that retires a `GOALS.md`
// non-goal. The narrowed rule this file keeps honest: conditionals and BOUNDED
// loops are in; arbitrary recursion, unbounded iteration and
// sub-flows-as-a-language stay out.
//
// The load-bearing assertion is the last section's: a loop that would otherwise
// run forever stops at its bound, and lint rejects one declared without a
// bound. Unbounded iteration against a metered API is the one way this feature
// becomes a liability (§11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseExpr, evalExpr, checkExpr, ExprError } from '../core/flowlang/expr.js';
import { buildScope } from '../core/conditionScope.js';
import { lintFlow, RUNTIME_RULES } from '../core/flowlang/lint.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// --- the expression language -----------------------------------------------------

test('the grammar covers exactly what §5.3 says it does', () => {
  const scope = {
    implement: { status: 'done', text: 'has a TODO left', cost: { total: 0.75 }, usage: { outputTokens: 5000 }, retries: 2 },
    review: { status: 'failed', text: '', cost: { total: null } },
    loop: { iteration: 2 }
  };
  const t = src => evalExpr(src, scope).value;
  // field access + string comparison
  assert.equal(t('implement.status == "done"'), true);
  assert.equal(t('implement.status != "done"'), false);
  assert.equal(t('implement.text contains "TODO"'), true);
  assert.equal(t('implement.text contains "nope"'), false);
  assert.equal(t('implement.text matches "todo"'), true);   // case-insensitive
  assert.equal(t('implement.text startsWith "has"'), true);
  assert.equal(t('implement.text endsWith "left"'), true);
  // numeric comparison — including the metric paths, which is the point
  assert.equal(t('implement.cost.total > 0.50'), true);
  assert.equal(t('implement.cost.total > 1.00'), false);
  assert.equal(t('implement.usage.outputTokens > 4000'), true);
  assert.equal(t('loop.iteration >= 2'), true);
  // and / or / not, with parens
  assert.equal(t('implement.status == "done" and implement.retries > 1'), true);
  assert.equal(t('implement.status == "x" or implement.retries > 1'), true);
  assert.equal(t('not (implement.status == "done")'), false);
  assert.equal(t('(implement.retries > 5 or implement.cost.total > 0.5) and not review.status == "done"'), true);
});

test('an unknown path is null, and null compares false rather than throwing', () => {
  const scope = { a: { cost: { total: null } } };
  assert.equal(evalExpr('nope.at.all > 1', scope).value, false);
  assert.equal(evalExpr('a.cost.total > 0', scope).value, false);
  assert.equal(evalExpr('a.cost.total == null', scope).value, true);
  assert.equal(evalExpr('nope.at.all', scope).error, null, 'a missing path is not an error');
});

test('a malformed condition is false with a reason — never a thrown run', () => {
  const r = evalExpr('a.b >', {});
  assert.equal(r.value, false);
  assert.match(r.error, /Unexpected end/);
  assert.equal(evalExpr('', {}).value, false);
  assert.equal(checkExpr('a.b == "x"').ok, true);
  assert.equal(checkExpr('a.b ==').ok, false);
});

test('there is no escape hatch into JavaScript', () => {
  // The DSL's whole point is that a flow file is data. A condition that could
  // run arbitrary code would quietly turn every .flow.yaml into a program.
  for (const src of [
    'process.exit(1)',
    'a["__proto__"]',
    'constructor.constructor("return 1")()',
    'a.b; c.d'
  ]) {
    const r = evalExpr(src, { a: {} });
    // Either it fails to parse, or it evaluates to a plain false — never a side effect.
    assert.equal(typeof r.value, 'boolean', `${src} must not produce anything but a boolean`);
  }
  assert.throws(() => parseExpr('a.b; c.d'), ExprError);
  assert.throws(() => tokenize('a $ b'), ExprError);
});

test('checkExpr reports what a condition reads, for the linter', () => {
  const { paths } = checkExpr('implement.cost.total > 0.5 and review.text contains "ok"');
  assert.deepEqual(paths, [['implement', 'cost', 'total'], ['review', 'text']]);
});

// --- the scope ----------------------------------------------------------------------

test('a condition can read what a node produced AND what it cost', async () => {
  // §5.3: "this is where the pivot closes its own loop — the investigator's
  // data becomes an input to control flow."
  const store = makeStore();
  const runId = store.createRun('scope test');
  store.writeNodeOutput(runId, 'a', 'the output\nwith two lines');
  store.writeMeta(runId, { ...store.readMeta(runId), nodeStatus: { a: 'done' } });
  store.writeCallRecord(runId, {
    runId, nodeId: 'a', role: 'aiStep', attempt: 0, ok: true,
    provider: 'anthropic', model: 'claude-sonnet-5',
    startedAt: new Date().toISOString(), durationMs: 4000, ttftMs: 500, outputTokensPerSec: 30,
    usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 900, reasoningTokens: 0, totalTokens: 1000 },
    cost: { total: 0.75, costKind: 'tokens', estimated: false }
  });
  const flow = { nodes: [{ id: 'a', type: 'aiStep', data: {} }] };
  const scope = buildScope(store, runId, flow);
  assert.equal(scope.a.status, 'done');
  assert.equal(scope.a.lines, 2);
  assert.equal(evalExpr('a.text contains "two lines"', scope).value, true);
  assert.equal(evalExpr('a.cost.total > 0.5', scope).value, true);
  assert.equal(evalExpr('a.cost > 0.5', scope).value, true, 'the bare `cost` reads as the number too');
  assert.equal(evalExpr('a.usage.outputTokens > 500', scope).value, true);
  assert.equal(evalExpr('a.latencyMs > 1000', scope).value, true);
  assert.equal(evalExpr('a.model == "claude-sonnet-5"', scope).value, true);
  assert.equal(evalExpr('run.calls == 1', scope).value, true);
});

// --- the DSL --------------------------------------------------------------------------

test('branch and loop round-trip through the .flow.yaml DSL', () => {
  const flow = {
    id: 'cf', name: 'CF',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'gate', type: 'branch', kind: 'logic', position: { x: 0, y: 1 },
        data: { title: 'Expensive?', arms: [{ when: 'draft.cost.total > 0.5', to: 'cheap' }, { to: 'rich' }] } },
      { id: 'cheap', type: 'aiStep', kind: 'ai', position: { x: 0, y: 2 }, data: {} },
      { id: 'rich', type: 'aiStep', kind: 'ai', position: { x: 1, y: 2 }, data: {} },
      { id: 'spin', type: 'loop', kind: 'logic', position: { x: 0, y: 3 },
        data: { title: 'Refine', maxIterations: 3, until: 'body.text contains "OK"', maxCost: 1 } },
      { id: 'body', type: 'aiStep', kind: 'ai', position: { x: 0, y: 4 }, parentId: 'spin', data: {} },
      { id: 'output', type: 'output', kind: 'user', position: { x: 0, y: 5 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'cheap' },
      { id: 'e3', source: 'gate', target: 'rich' },
      { id: 'e4', source: 'cheap', target: 'spin' },
      { id: 'e5', source: 'spin', target: 'output' }
    ]
  };
  const back = parseFlow(serializeFlow(flow));
  const gate = back.nodes.find(n => n.id === 'gate');
  const spin = back.nodes.find(n => n.id === 'spin');
  assert.equal(gate.type, 'branch');
  assert.equal(gate.kind, 'logic');
  assert.deepEqual(gate.data.arms, [{ when: 'draft.cost.total > 0.5', to: 'cheap' }, { to: 'rich' }]);
  assert.equal(spin.type, 'loop');
  assert.equal(spin.data.maxIterations, 3);
  assert.equal(spin.data.until, 'body.text contains "OK"');
  assert.equal(back.nodes.find(n => n.id === 'body').parentId, 'spin');
});

// --- the four new lint rules ----------------------------------------------------------

const branchFlow = (arms, edges = ['cheap', 'rich']) => ({
  id: 'f', name: 'F',
  nodes: [
    { id: 'input', type: 'input', kind: 'user', data: {} },
    { id: 'gate', type: 'branch', kind: 'logic', data: { arms } },
    { id: 'cheap', type: 'aiStep', kind: 'ai', data: {} },
    { id: 'rich', type: 'aiStep', kind: 'ai', data: {} },
    { id: 'output', type: 'output', kind: 'user', data: {} }
  ],
  edges: [
    { id: 'e0', source: 'input', target: 'gate' },
    ...edges.map((t, i) => ({ id: `e${i + 1}`, source: 'gate', target: t })),
    { id: 'ec', source: 'cheap', target: 'output' },
    { id: 'er', source: 'rich', target: 'output' }
  ]
});

const loopFlow = data => ({
  id: 'f', name: 'F',
  nodes: [
    { id: 'input', type: 'input', kind: 'user', data: {} },
    { id: 'spin', type: 'loop', kind: 'logic', data },
    { id: 'body', type: 'aiStep', kind: 'ai', parentId: 'spin', data: {} },
    { id: 'output', type: 'output', kind: 'user', data: {} }
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'spin' },
    { id: 'e2', source: 'spin', target: 'output' }
  ]
});

test('lint: a loop with no bound is an ERROR — the rule the feature rests on', () => {
  const r = lintFlow(loopFlow({ until: 'body.text contains "OK"' }), { templates: null });
  const hit = r.errors.find(f => f.rule === 'unbounded-loop');
  assert.ok(hit, `expected unbounded-loop in [${r.findings.map(f => f.rule)}]`);
  assert.match(hit.message, /maxIterations is required/);
  assert.equal(r.ok, false);
  // And it blocks the pre-run gate, not just the author-time lint.
  assert.ok(RUNTIME_RULES.includes('unbounded-loop'));
  assert.equal(lintFlow(loopFlow({ until: 'body.text contains "OK"' }), { templates: null, rules: RUNTIME_RULES }).ok, false);
});

test('lint: a bounded loop with an exit condition is clean', () => {
  const r = lintFlow(loopFlow({ maxIterations: 3, until: 'body.text contains "OK"' }), { templates: null });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings.filter(w => w.rule === 'unbounded-loop' || w.rule === 'loop-no-exit'), []);
});

test('lint: a long loop with no budget, and a loop with no exit, both warn', () => {
  const noBudget = lintFlow(loopFlow({ maxIterations: 10, until: 'body.text contains "OK"' }), { templates: null });
  assert.ok(noBudget.warnings.some(w => w.rule === 'unbounded-loop' && /maxCost/.test(w.message)));
  const noExit = lintFlow(loopFlow({ maxIterations: 2 }), { templates: null });
  assert.ok(noExit.warnings.some(w => w.rule === 'loop-no-exit'));
});

test('lint: an `until` reading a node outside the body can never become true', () => {
  const outside = lintFlow(loopFlow({ maxIterations: 2, until: 'input.text contains "OK"' }), { templates: null });
  assert.ok(outside.warnings.some(w => w.rule === 'loop-no-exit' && /outside the loop body/.test(w.message)));
  const ghost = lintFlow(loopFlow({ maxIterations: 2, until: 'ghost.text contains "OK"' }), { templates: null });
  assert.ok(ghost.errors.some(e => e.rule === 'loop-no-exit' && /not a node in this flow/.test(e.message)));
});

test('lint: a branch with no default arm is an error', () => {
  const r = lintFlow(branchFlow([{ when: 'cheap.cost > 1', to: 'cheap' }, { when: 'cheap.cost > 2', to: 'rich' }]), { templates: null });
  assert.ok(r.errors.some(e => e.rule === 'branch-no-default'));
  const ok = lintFlow(branchFlow([{ when: 'cheap.cost > 1', to: 'cheap' }, { to: 'rich' }]), { templates: null });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('lint: an arm pointing nowhere, or sitting after the default, is caught', () => {
  const nowhere = lintFlow(branchFlow([{ when: 'cheap.cost > 1', to: 'ghost' }, { to: 'rich' }]), { templates: null });
  assert.ok(nowhere.errors.some(e => e.rule === 'unreachable-arm' && /no edge/.test(e.message)));
  const after = lintFlow(branchFlow([{ to: 'cheap' }, { when: 'cheap.cost > 1', to: 'rich' }]), { templates: null });
  assert.ok(after.warnings.some(w => w.rule === 'unreachable-arm' && /after the default arm/.test(w.message)));
});

test('lint: a bad condition in an arm is an error, not a runtime surprise', () => {
  const r = lintFlow(branchFlow([{ when: 'cheap.cost >', to: 'cheap' }, { to: 'rich' }]), { templates: null });
  assert.ok(r.errors.some(e => e.rule === 'branch-no-default' && /not a valid condition/.test(e.message)));
});

// --- the runner ---------------------------------------------------------------------------

test('a branch activates exactly one arm and skips the other path', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  setScript(({ prompt }) => (prompt.includes('DRAFT') ? 'a short draft' : 'ran'));
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('draft', 'aiStep', { prompt: 'DRAFT' }),
      node('gate', 'branch', { arms: [{ when: 'draft.text contains "short"', to: 'cheap' }, { to: 'rich' }] }),
      node('cheap', 'aiStep', {}),
      node('rich', 'aiStep', {}),
      node('out', 'output')],
    [edge('in', 'draft'), edge('draft', 'gate'), edge('gate', 'cheap'), edge('gate', 'rich'),
      edge('cheap', 'out'), edge('rich', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const status = store.readMeta(runId).nodeStatus;
  assert.equal(status.cheap, 'done');
  assert.equal(status.rich, 'skipped');
  assert.equal(status.out, 'done', 'the join still runs — a skipped arm satisfies its dependents');
  assert.match(store.readNodeOutput(runId, 'gate'), /took cheap/);
});

test('a branch can decide on what the previous node COST', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig({
    workers: { executor: { provider: 'script', model: 'claude-sonnet-5' } }
  }), () => {});
  // 1M input tokens against Sonnet 5's $3/Mtok = $3.00, comfortably over the arm.
  setScript(() => ({ text: 'done', usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('draft', 'aiStep', {}),
      node('gate', 'branch', { arms: [{ when: 'draft.cost.total > 0.50', to: 'expensive' }, { to: 'fine' }] }),
      node('expensive', 'aiStep', {}),
      node('fine', 'aiStep', {}),
      node('out', 'output')],
    [edge('in', 'draft'), edge('draft', 'gate'), edge('gate', 'expensive'), edge('gate', 'fine'),
      edge('expensive', 'out'), edge('fine', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const status = store.readMeta(runId).nodeStatus;
  assert.equal(status.expensive, 'done', 'the ledger drove the decision');
  assert.equal(status.fine, 'skipped');
});

test('a loop that would run forever stops at its bound', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  let runs = 0;
  // The exit condition can never hold: the body never says APPROVED.
  setScript(() => { runs += 1; return 'still not right'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('spin', 'loop', { maxIterations: 3, until: 'body.text contains "APPROVED"' }),
      { ...node('body', 'aiStep', {}), parentId: 'spin' },
      node('out', 'output')],
    [edge('in', 'spin'), edge('spin', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(runs, 3, 'exactly the declared bound, no more');
  assert.match(store.readNodeOutput(runId, 'spin'), /3 iterations/);
  assert.match(store.readNodeOutput(runId, 'spin'), /iteration bound was reached/);
});

test('a loop stops early when its exit condition holds', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  let runs = 0;
  setScript(() => { runs += 1; return runs >= 2 ? 'APPROVED at last' : 'not yet'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('spin', 'loop', { maxIterations: 8, until: 'body.text contains "APPROVED"', maxCost: 5 }),
      { ...node('body', 'aiStep', {}), parentId: 'spin' },
      node('out', 'output')],
    [edge('in', 'spin'), edge('spin', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(runs, 2);
  assert.match(store.readNodeOutput(runId, 'spin'), /exit condition held/);
  // The per-iteration record is an artifact like everything else.
  assert.match(store.readNodeOutput(runId, 'spin.iterations'), /iteration 2/);
});

test('a loop stops when it has spent its cost budget', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig({
    workers: { executor: { provider: 'script', model: 'claude-sonnet-5' } }
  }), () => {});
  let runs = 0;
  // $3.00 per iteration against a $4 budget: the second iteration crosses it.
  setScript(() => { runs += 1; return { text: 'more', usage: { input_tokens: 1_000_000, output_tokens: 0 } }; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('spin', 'loop', { maxIterations: 10, until: 'body.text contains "NEVER"', maxCost: 4 }),
      { ...node('body', 'aiStep', {}), parentId: 'spin' },
      node('out', 'output')],
    [edge('in', 'spin'), edge('spin', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(runs, 2, 'the budget stopped it long before the iteration bound');
  assert.match(store.readNodeOutput(runId, 'spin'), /cost budget was reached/);
});

test('each loop iteration starts from a clean body', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  let runs = 0;
  setScript(() => { runs += 1; return `iteration ${runs}`; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
      node('spin', 'loop', { maxIterations: 3, until: 'body.text contains "iteration 3"' }),
      { ...node('body', 'aiStep', {}), parentId: 'spin' },
      node('out', 'output')],
    [edge('in', 'spin'), edge('spin', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  // Stale output from a previous pass must never be read as this pass's result.
  assert.equal(store.readNodeOutput(runId, 'body'), 'iteration 3');
  assert.equal(runs, 3);
});
