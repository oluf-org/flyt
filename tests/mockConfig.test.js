// Tests for the mock provider's authoring state (SETTINGS-MODELS-PLAN §6, P4
// "Done when"): a run with mode 'custom' returns the typed text at every node;
// 'roles' mode is byte-identical to pre-G8 behaviour; per-role overrides beat
// the mode; echo returns the assembled prompt; error mode and failureRate
// throw transient errors; streaming and latency honour the config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter } from '../core/adapters/mock.js';
import { resolveCallTarget } from '../core/modelSource.js';
import { isTransientError } from '../core/adapters/index.js';

// Fast config: no latency, no streaming — behaviour under test is the TEXT.
const cfg = extra => ({ mode: 'roles', customResponse: '', perRole: {}, latencyMs: 0, streaming: false, failureRate: 0, ...extra });
const call = (mock, over = {}) =>
  mockAdapter({ system: 'ROLE: executor', prompt: 'USER PROMPT:\nwrite the thing', mock, ...over });

test('custom mode returns the typed text verbatim for every call', async () => {
  const r1 = await call(cfg({ mode: 'custom', customResponse: 'hello **world**' }));
  assert.equal(r1.text, 'hello **world**');
  // …including a different role's call — "every node" means every node.
  const r2 = await mockAdapter({ system: 'ROLE: planner', prompt: 'USER PROMPT:\nplan it', mock: cfg({ mode: 'custom', customResponse: 'hello **world**' }) });
  assert.equal(r2.text, 'hello **world**');
});

test('custom mode beats the executor tool-protocol special case', async () => {
  const r = await mockAdapter({
    system: 'ROLE: executor\nTOOL PROTOCOL: active', prompt: 'USER PROMPT:\nx',
    mock: cfg({ mode: 'custom', customResponse: 'no tool call here' })
  });
  assert.equal(r.text, 'no tool call here');
});

test('a per-role override beats customResponse for that role only', async () => {
  const mock = cfg({ mode: 'custom', customResponse: 'generic reply', perRole: { planner: 'planner says this' } });
  const planner = await mockAdapter({ system: 'ROLE: planner', prompt: 'USER PROMPT:\np', mock });
  assert.equal(planner.text, 'planner says this');
  const executor = await call(mock);
  assert.equal(executor.text, 'generic reply');
});

test('echo mode returns the prompt it received', async () => {
  const prompt = 'USER PROMPT:\nthe assembled context goes here';
  const r = await call(cfg({ mode: 'echo' }), { prompt });
  assert.equal(r.text, prompt);
});

test('error mode always throws a transient error', async () => {
  await assert.rejects(() => call(cfg({ mode: 'error' })), /Mock error mode/);
  const err = await call(cfg({ mode: 'error' })).catch(e => e);
  assert.ok(isTransientError(err), 'the retry loop should engage before the failure UI');
});

test('failureRate 1 always injects; failureRate 0 never does', async () => {
  await assert.rejects(() => call(cfg({ failureRate: 1 })), /Mock injected failure/);
  const r = await call(cfg({ failureRate: 0 }));
  assert.ok(r.text.length > 0);
});

test('streaming: off emits nothing, on emits growing prefixes ending in the full text', async () => {
  const silent = [];
  await call(cfg({ streaming: false }), { onText: t => silent.push(t) });
  assert.deepEqual(silent, []);

  const seen = [];
  const r = await call(cfg({ streaming: true }), { onText: (t, o) => seen.push({ t, final: o?.final === true }) });
  assert.ok(seen.length > 0);
  for (const { t } of seen.slice(0, -1)) assert.ok(r.text.startsWith(t) && t.length < r.text.length);
  assert.equal(seen.at(-1).t, r.text);
  assert.equal(seen.at(-1).final, true);
});

test('roles mode is byte-identical with and without the new config', async () => {
  // The legacy no-config path is what every pre-G8 test drives; roles mode
  // must produce the exact same text for the same prompts.
  for (const role of ['planner', 'router', 'executor', 'verifier', 'stitch', 'final-eval', 'unknown-role']) {
    const args = { system: `ROLE: ${role}`, prompt: 'USER PROMPT:\nwrite the thing' };
    const legacy = await mockAdapter(args);
    const configured = await mockAdapter({ ...args, mock: cfg({ mode: 'roles' }) });
    assert.equal(configured.text, legacy.text, `role ${role} drifted`);
  }
  // …and the executor tool-protocol special case too.
  const proto = { system: 'ROLE: executor\nTOOL PROTOCOL: active', prompt: 'USER PROMPT:\nwrite the thing' };
  const legacy = await mockAdapter(proto);
  const configured = await mockAdapter({ ...proto, mock: cfg({ mode: 'roles' }) });
  assert.equal(configured.text, legacy.text);
});

test('resolveCallTarget stamps the mock config onto mock targets only', () => {
  const mockState = { mode: 'custom', customResponse: 'x', perRole: {}, latencyMs: 0, streaming: false, failureRate: 0 };
  const t = resolveCallTarget({ provider: 'mock', model: 'mock-large' }, { providerKeys: {}, mock: mockState });
  assert.deepEqual(t.mock, mockState);
  const real = resolveCallTarget({ provider: 'openai', model: 'gpt-5.2' }, { providerKeys: {}, mock: mockState });
  assert.equal(real.mock, undefined, 'a real provider never carries mock config');
  // …and an auto worker that resolves to mock carries it too.
  const auto = resolveCallTarget({ provider: 'auto', model: 'mock-large' }, {
    mock: mockState,
    resolveModelSource: id => ({ provider: 'mock', model: id })
  });
  assert.deepEqual(auto.mock, mockState);
});
