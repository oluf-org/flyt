// PIVOT-PLAN P6 — prompt, model and limits as node fields (§5.2).
//
// The principle these guard is the one that REPLACED a `GOALS.md`
// non-negotiable. It used to read: templates do not contain hand-written
// prompts; the model generates its own. It now reads:
//
//   Nothing is sent to a model that the user cannot see and could not have
//   written. Prompts are authored artifacts. A model may draft one; it may
//   never conjure one at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTemplate, normalizeLimits, resolveInstance, overridableFields,
  validateOverrideMap, resolveFlow
} from '../src/flowTypes.js';
import { FlowRunner, resolveWorker } from '../core/flowRunner.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

// --- the fields exist and survive normalization -------------------------------------

test('a template carries a prompt and limits, and absent ones stay absent', () => {
  const t = normalizeTemplate({ id: 'x', prompt: 'Do the thing.', limits: { attempts: 3, timeoutMs: 60_000 } });
  assert.equal(t.prompt, 'Do the thing.');
  assert.deepEqual(t.limits, { attempts: 3, timeoutMs: 60_000 });
  // An absent field must not materialize as an empty object that then overrides
  // the run's defaults with nothing.
  const bare = normalizeTemplate({ id: 'y' });
  assert.equal('prompt' in bare, false);
  assert.equal('limits' in bare, false);
  assert.equal(normalizeTemplate({ id: 'z', prompt: '   ' }).prompt, undefined);
});

test('normalizeLimits keeps 0 as "no timeout" and rejects junk', () => {
  assert.deepEqual(normalizeLimits({ timeoutMs: 0 }), { timeoutMs: 0 });
  assert.equal(normalizeLimits({ attempts: 0 }), null);       // 0 attempts is not a policy
  assert.equal(normalizeLimits({ attempts: 'three' }), null);
  assert.equal(normalizeLimits(null), null);
  assert.deepEqual(normalizeLimits({ attempts: 999 }), { attempts: 20 }); // capped
});

test('an instance override wins over the template prompt and limits', () => {
  const tpl = normalizeTemplate({ id: 'w', name: 'W', prompt: 'template prompt', limits: { attempts: 2 } });
  const inherited = resolveInstance({ id: 'a', templateId: 'w', position: { x: 0, y: 0 }, overrides: {} }, tpl);
  assert.equal(inherited.data.prompt, 'template prompt');
  assert.deepEqual(inherited.data.limits, { attempts: 2 });
  const overridden = resolveInstance(
    { id: 'a', templateId: 'w', position: { x: 0, y: 0 }, overrides: { prompt: 'mine', limits: { attempts: 5 } } }, tpl);
  assert.equal(overridden.data.prompt, 'mine');
  assert.deepEqual(overridden.data.limits, { attempts: 5 });
});

test('prompt and limits are overridable — so a mode or a sweep can vary them', () => {
  const n = { type: 'aiStep', data: { role: 'execute' } };
  assert.ok(overridableFields(n).has('prompt'));
  assert.ok(overridableFields(n).has('limits'));
  // Structural nodes still accept nothing.
  assert.equal(overridableFields({ type: 'input' }).size, 0);
  const flow = resolveFlow({
    id: 'f', name: 'F',
    nodes: [
      { id: 'in', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'a', type: 'aiStep', kind: 'ai', position: { x: 0, y: 1 }, data: { role: 'execute' } },
      { id: 'out', type: 'output', kind: 'user', position: { x: 0, y: 2 }, data: {} }
    ],
    edges: []
  }, []);
  assert.deepEqual(validateOverrideMap(flow, { a: { prompt: 'x', limits: { attempts: 2 } } }), []);
  assert.ok(validateOverrideMap(flow, { in: { prompt: 'x' } }).length > 0);
});

// --- the DSL round-trips them ---------------------------------------------------------

test('prompt and limits round-trip through the .flow.yaml DSL', () => {
  const flow = {
    id: 't', name: 'T',
    nodes: [
      { id: 'input', type: 'input', kind: 'user', position: { x: 0, y: 0 }, data: {} },
      { id: 'a', type: 'aiStep', kind: 'ai', position: { x: 0, y: 1 },
        data: { title: 'A', prompt: 'Line one.\nLine two.', limits: { attempts: 2, timeoutMs: 60_000 } } },
      { id: 'b', templateId: 'work', position: { x: 0, y: 2 }, overrides: { prompt: 'Override', limits: { attempts: 3 } } },
      { id: 'output', type: 'output', kind: 'user', position: { x: 0, y: 3 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'output' }
    ]
  };
  const back = parseFlow(serializeFlow(flow));
  const a = back.nodes.find(n => n.id === 'a');
  const b = back.nodes.find(n => n.id === 'b');
  assert.equal(a.data.prompt, 'Line one.\nLine two.');
  assert.deepEqual(a.data.limits, { attempts: 2, timeoutMs: 60_000 });
  assert.equal(b.overrides.prompt, 'Override');
  assert.deepEqual(b.overrides.limits, { attempts: 3 });
});

// --- the runner actually sends it ------------------------------------------------------

test('the node prompt reaches the model, first and unwrapped', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  const seen = [];
  setScript(({ prompt }) => { seen.push(prompt); return 'done'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'the run request' }),
      node('a', 'aiStep', { role: 'execute', prompt: 'SPECIFIC-NODE-PROMPT' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const sent = seen.find(p => p.includes('SPECIFIC-NODE-PROMPT'));
  assert.ok(sent, 'the node prompt must reach the model');
  assert.ok(sent.startsWith('SPECIFIC-NODE-PROMPT'), 'it leads: it is the instruction, not a footnote');
  assert.ok(sent.includes('the run request'), 'the run request still travels with it');
});

test('a node with no prompt behaves exactly as it did before the field existed', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  const seen = [];
  setScript(({ prompt }) => { seen.push(prompt); return 'done'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('a', 'aiStep', { role: 'execute' }), node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.ok(seen[0].startsWith('USER PROMPT:'));
});

test('an agentTask carries its prompt onto the task, which is all the executor sees', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig(), () => {});
  const seen = [];
  setScript(({ prompt }) => { seen.push(prompt); return 'task complete'; });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('t', 'agentTask', { title: 'T', goal: 'Do it.', prompt: 'AGENT-NODE-PROMPT' }),
      node('out', 'output')],
    [edge('in', 't'), edge('t', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  // tasks.json is the executor's only input, so the prompt has to be on it.
  assert.equal(store.readTasks(runId).tasks[0].prompt, 'AGENT-NODE-PROMPT');
  assert.ok(seen.some(p => p.startsWith('AGENT-NODE-PROMPT')));
});

// --- limits reach the call ---------------------------------------------------------------

test('a node’s limits become the retry policy and the timeout for its call', () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig({ retry: { attempts: 5, baseMs: 1000, maxMs: 30_000 }, timeoutMs: 600_000 }), () => {});
  const withLimits = node('a', 'aiStep', { limits: { attempts: 2, backoffMs: 50, timeoutMs: 30_000 } });
  assert.deepEqual(runner.retryFor(withLimits), { attempts: 2, baseMs: 50, maxMs: 30_000 });
  assert.equal(runner.timeoutFor(withLimits), 30_000);
  // No limits: the run's configured defaults, unchanged.
  const bare = node('b', 'aiStep', {});
  assert.deepEqual(runner.retryFor(bare), { attempts: 5, baseMs: 1000, maxMs: 30_000 });
  assert.equal(runner.timeoutFor(bare), 600_000);
  // An explicit 0 means "no timeout" and must not read as "unset".
  assert.equal(runner.timeoutFor(node('c', 'aiStep', { limits: { timeoutMs: 0 } })), null);
});

// --- the retired routing --------------------------------------------------------------------

test('the model is a graph decision: config.categoryWorkers no longer routes', () => {
  // Decision 10. A static config-file map able to redirect a node's model is
  // exactly the hidden routing the pivot exists to remove — a run made with the
  // wrong model must be traceable to a node, not to config.json.
  const config = testConfig({ categoryWorkers: { documentation: { provider: 'ghost', model: 'ghost-m' } } });
  assert.deepEqual(
    resolveWorker({ type: 'aiStep', data: { category: 'documentation' } }, config),
    { provider: 'script', model: 'test-model' });
  // The node's own worker is how you change it, and it always wins.
  assert.deepEqual(
    resolveWorker({ type: 'aiStep', data: { category: 'documentation', worker: { provider: 'p', model: 'm' } } }, config),
    { provider: 'p', model: 'm' });
});
