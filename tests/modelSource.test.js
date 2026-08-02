// Unit tests for the multi-provider settings model and the resolution rule
// (PROVIDERS-PLAN §1–§2, task 8): migration, priority walk, pin, disconnected
// skip, and the no-match error — plus the new adapters' request shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateSettings, createResolver, resolveCallTarget,
  DEFAULT_PRIORITY, CURATED_MODELS, stampSeenModels, computeNewModelIds
} from '../core/modelSource.js';
import { canServe, callModel } from '../core/adapters/index.js';

// --- migration (legacy settings.json) --------------------------------------

test('migration moves a legacy openrouterApiKey into the providers map, once', () => {
  const s = migrateSettings({ openrouterApiKey: ' sk-or-legacy ', workers: { executor: { provider: 'openrouter', model: 'x/y' } } });
  assert.equal(s.providers.openrouter.apiKey, 'sk-or-legacy');
  assert.ok(!('openrouterApiKey' in s), 'the legacy field is deleted');
  assert.equal(s.workers.executor.model, 'x/y', 'unrelated fields survive');
});

test('migration does not overwrite a providers-map key with the legacy field', () => {
  const s = migrateSettings({ openrouterApiKey: 'old', providers: { openrouter: { apiKey: 'new' } } });
  // Both present: the providers map is the canonical store, the legacy value
  // only fills a gap. (The legacy field still gets deleted either way.)
  assert.equal(s.providers.openrouter.apiKey, 'new');
  assert.ok(!('openrouterApiKey' in s));
});

test('migration fills defaults: priority order, empty active models, kimi keyKind', () => {
  const s = migrateSettings({});
  assert.deepEqual(s.providerPriority, DEFAULT_PRIORITY);
  assert.deepEqual(s.activeModels, []);
  const k = migrateSettings({ providers: { kimi: { apiKey: 'k' } } });
  assert.equal(k.providers.kimi.keyKind, 'platform');
});

test('migration normalizes priority and active-model entries', () => {
  const s = migrateSettings({
    providerPriority: ['openrouter', 'openrouter', 'bogus'],
    activeModels: [
      { id: ' claude-sonnet-5 ', source: 'anthropic' },
      { id: 'gpt-5.2', source: 'not-a-provider' },
      { id: '', source: 'auto' },
      null
    ]
  });
  // Unknown ids dropped, duplicates removed, missing providers appended.
  assert.deepEqual(s.providerPriority, ['openrouter', ...DEFAULT_PRIORITY.filter(p => p !== 'openrouter')]);
  assert.deepEqual(s.activeModels, [
    { id: 'claude-sonnet-5', source: 'anthropic', enabled: true },
    { id: 'gpt-5.2', source: 'auto', enabled: true }
  ]);
});

// --- canServe rules ---------------------------------------------------------

test('canServe: each provider claims only its own id shapes', () => {
  assert.equal(canServe('anthropic', 'claude-sonnet-5'), true);
  assert.equal(canServe('anthropic', 'gpt-5.2'), false);
  assert.equal(canServe('openai', 'gpt-5.2'), true);
  assert.equal(canServe('openai', 'o4'), true);
  assert.equal(canServe('openai', 'claude-sonnet-5'), false);
  assert.equal(canServe('kimi', 'kimi-for-coding'), true);
  assert.equal(canServe('kimi', 'kimi-k2.7-code'), true);
  assert.equal(canServe('kimi', 'gpt-5.2'), false);
  assert.equal(canServe('openrouter', 'openai/gpt-4o-mini'), true);
  assert.equal(canServe('openrouter', 'gpt-4o-mini'), false);
  assert.equal(canServe('mock', 'mock-large'), true);
  assert.equal(canServe('mock', 'gpt-5.2'), false, 'a real model must never resolve to mock');
  assert.equal(canServe('nope', 'x'), false);
});

// --- the resolution rule ----------------------------------------------------

const resolverWith = (keys, priority) => createResolver({
  hasKey: p => p === 'mock' || keys.includes(p),
  canServe,
  priority
});

test('auto walks the priority list and takes the first connected hit', () => {
  const resolve = resolverWith(['openai', 'openrouter'], DEFAULT_PRIORITY);
  // anthropic has no key — skipped even though it leads the priority list and
  // could serve a claude id... but here openrouter can't serve bare ids, so a
  // gpt id lands on openai.
  assert.deepEqual(resolve('gpt-5.2'), { provider: 'openai', model: 'gpt-5.2' });
});

test('auto skips providers that cannot serve the id', () => {
  const resolve = resolverWith(['openai', 'openrouter'], DEFAULT_PRIORITY);
  assert.deepEqual(resolve('openai/gpt-4o-mini'), { provider: 'openrouter', model: 'openai/gpt-4o-mini' });
});

test('disconnected providers are skipped, and an id nobody connected can serve fails', () => {
  const resolve = resolverWith(['openrouter'], DEFAULT_PRIORITY);
  assert.throws(() => resolve('claude-sonnet-5'), /No connected provider can serve "claude-sonnet-5"/);
});

test('a pinned source wins over the priority list', () => {
  const resolve = resolverWith(['anthropic', 'openai'], DEFAULT_PRIORITY);
  assert.deepEqual(resolve('gpt-5.2', 'openai'), { provider: 'openai', model: 'gpt-5.2' });
});

test('a pinned source without a key fails fast and points at Settings', () => {
  const resolve = resolverWith(['openai'], DEFAULT_PRIORITY);
  assert.throws(() => resolve('claude-sonnet-5', 'anthropic'), /pinned to anthropic.*no API key.*Settings/);
});

test('no match fails with a settings-pointing error', () => {
  const resolve = resolverWith([], DEFAULT_PRIORITY);
  assert.throws(() => resolve('gpt-5.2'), /No connected provider can serve "gpt-5\.2".*Settings/);
});

test('mock serves its own ids without a key', () => {
  const resolve = resolverWith([], DEFAULT_PRIORITY);
  assert.deepEqual(resolve('mock-large'), { provider: 'mock', model: 'mock-large' });
});

// --- resolveCallTarget ------------------------------------------------------

test('resolveCallTarget: legacy workers read providerKeys; auto workers use the resolver', () => {
  const config = {
    providerKeys: { openrouter: 'sk-or' },
    resolveModelSource: id => ({ provider: 'openai', model: id, apiKey: 'sk-oai' })
  };
  assert.deepEqual(
    resolveCallTarget({ provider: 'openrouter', model: 'x/y' }, config),
    { provider: 'openrouter', model: 'x/y', apiKey: 'sk-or' }
  );
  assert.deepEqual(
    resolveCallTarget({ provider: 'auto', model: 'gpt-5.2' }, config),
    { provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-oai' }
  );
});

test('resolveCallTarget: kimi workers keep their keyKind', () => {
  const t = resolveCallTarget({ provider: 'kimi', model: 'kimi-for-coding', keyKind: 'code' },
    { providerKeys: { kimi: 'sk-kimi' } });
  assert.equal(t.keyKind, 'code');
  assert.equal(t.apiKey, 'sk-kimi');
});

// --- the curated catalogs cover their providers' canServe rules -------------

test('curated catalogs are consistent with canServe', () => {
  for (const [provider, list] of Object.entries(CURATED_MODELS)) {
    for (const m of list) assert.ok(canServe(provider, m.id), `${provider} must serve its curated id ${m.id}`);
  }
});

// --- catalog overlay state (SETTINGS-MODELS-PLAN §3, P2) ----------------------

test('migration defaults the new catalog-state keys and drops unknown shapes', () => {
  const s = migrateSettings({
    favouriteModels: [' claude-sonnet-5 ', 'gpt-5.2', 'gpt-5.2', 42, ''],
    seenModels: { 'claude-sonnet-5': '2026-07-01T00:00:00Z', 'bad': 42, '': 'x' },
    acknowledgedModels: ['claude-opus-4-5', null],
    modelGrouping: 'bogus',
    showAllModels: 'yes',
    mock: { enabled: 1, mode: 'bogus', customResponse: 7, perRole: { a: 'ok', b: 3 },
            latencyMs: -5, streaming: 'no', failureRate: 4 },
    unrelatedKey: 'kept'
  });
  assert.deepEqual(s.favouriteModels, ['claude-sonnet-5', 'gpt-5.2']);
  assert.deepEqual(s.seenModels, { 'claude-sonnet-5': '2026-07-01T00:00:00Z' });
  assert.deepEqual(s.acknowledgedModels, ['claude-opus-4-5']);
  assert.equal(s.modelGrouping, 'provider');
  assert.equal(s.showAllModels, false);
  assert.deepEqual(s.mock, {
    enabled: false, mode: 'roles', customResponse: '', perRole: { a: 'ok' },
    latencyMs: 700, streaming: true, failureRate: 1
  });
});

test('migration fills catalog-state defaults when absent', () => {
  const s = migrateSettings({});
  assert.deepEqual(s.favouriteModels, []);
  assert.deepEqual(s.seenModels, {});
  assert.deepEqual(s.acknowledgedModels, []);
  assert.equal(s.modelGrouping, 'provider');
  assert.equal(s.showAllModels, false);
  assert.deepEqual(s.mock, {
    enabled: false, mode: 'roles', customResponse: '', perRole: {},
    latencyMs: 700, streaming: true, failureRate: 0
  });
});

test('migration keeps valid mock overrides and clamps their ranges', () => {
  const s = migrateSettings({
    mock: { enabled: true, mode: 'custom', customResponse: 'hi',
            latencyMs: 120_000, streaming: false, failureRate: 0.5 }
  });
  assert.deepEqual(s.mock, {
    enabled: true, mode: 'custom', customResponse: 'hi', perRole: {},
    latencyMs: 60_000, streaming: false, failureRate: 0.5
  });
});

// --- NEW-badge diff, as pure functions (not through the UI) -------------------

const T0 = new Date('2026-07-01T12:00:00Z');
const daysLater = (d, n) => new Date(d.getTime() + n * 86_400_000);

test('NEW badges: first run ever stamps everything and badges nothing', () => {
  const r = stampSeenModels(['a', 'b', 'c'], {}, [], T0);
  assert.equal(r.firstRun, true);
  assert.equal(r.changed, true);
  assert.deepEqual(Object.keys(r.seenModels).sort(), ['a', 'b', 'c']);
  assert.deepEqual(computeNewModelIds(['a', 'b', 'c'], r.seenModels, r.acknowledgedModels, T0), [],
    'a fresh install where all models glow NEW is noise, not information');
});

test('NEW badges: a second run with a new catalog entry badges exactly that entry', () => {
  const first = stampSeenModels(['a', 'b'], {}, [], T0);
  const second = stampSeenModels(['a', 'b', 'c'], first.seenModels, first.acknowledgedModels, daysLater(T0, 3));
  assert.equal(second.firstRun, false);
  assert.equal(second.seenModels['c'], daysLater(T0, 3).toISOString(), 'the new id is stamped at detection');
  assert.deepEqual(
    computeNewModelIds(['a', 'b', 'c'], second.seenModels, second.acknowledgedModels, daysLater(T0, 3)),
    ['c']);
});

test('NEW badges: markSeen acknowledgement clears the badge immediately', () => {
  const first = stampSeenModels(['a'], {}, [], T0);
  const second = stampSeenModels(['a', 'b'], first.seenModels, first.acknowledgedModels, daysLater(T0, 1));
  const acked = [...second.acknowledgedModels, 'b']; // settings:markSeen(['b'])
  assert.deepEqual(computeNewModelIds(['a', 'b'], second.seenModels, acked, daysLater(T0, 1)), []);
});

test('NEW badges: an unacknowledged badge expires after 21 days', () => {
  const first = stampSeenModels(['a'], {}, [], T0);
  const second = stampSeenModels(['a', 'b'], first.seenModels, first.acknowledgedModels, T0);
  assert.deepEqual(computeNewModelIds(['a', 'b'], second.seenModels, second.acknowledgedModels, daysLater(T0, 20)), ['b']);
  assert.deepEqual(computeNewModelIds(['a', 'b'], second.seenModels, second.acknowledgedModels, daysLater(T0, 22)), [],
    'the badge expires on its own clock even if the user never expands the group');
});

test('NEW badges: stamping is idempotent — no change, no persist needed', () => {
  const first = stampSeenModels(['a', 'b'], {}, [], T0);
  const again = stampSeenModels(['a', 'b'], first.seenModels, first.acknowledgedModels, daysLater(T0, 1));
  assert.equal(again.changed, false);
  assert.deepEqual(again.seenModels, first.seenModels);
});

// --- new adapters over the shared factory (fetch-stubbed) -------------------

let calls = [];
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return handler();
  };
}
const jsonRes = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
test.afterEach(() => { globalThis.fetch = realFetch; });

test('openai: posts to api.openai.com with the bearer key', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const r = await callModel({ provider: 'openai', model: 'gpt-5.2', prompt: 'p', apiKey: 'sk-oai' });
  assert.equal(r.text, 'ok');
  assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-oai');
});

test('openai: falls back to OPENAI_API_KEY from the environment', async () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-env';
  try {
    stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
    await callModel({ provider: 'openai', model: 'm', prompt: 'p' });
    assert.equal(calls[0].headers.Authorization, 'Bearer sk-env');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
  }
});

test('kimi: a platform key hits api.moonshot.ai, a code key hits api.kimi.com/coding with the coding-agent UA', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
  await callModel({ provider: 'kimi', model: 'kimi-k2.7-code', prompt: 'p', apiKey: 'sk-moon', keyKind: 'platform' });
  assert.match(calls[0].url, /api\.moonshot\.ai\/v1\/chat\/completions$/);
  assert.equal(calls[0].headers['User-Agent'], undefined);

  await callModel({ provider: 'kimi', model: 'kimi-for-coding', prompt: 'p', apiKey: 'sk-kimi-x', keyKind: 'code' });
  assert.match(calls[1].url, /api\.kimi\.com\/coding\/v1\/chat\/completions$/);
  assert.equal(calls[1].headers['User-Agent'], 'claude-code/0.1.0', 'the Kimi Code endpoint 403s without a coding-agent UA');
  assert.equal(calls[1].headers.Authorization, 'Bearer sk-kimi-x');
});

test('kimi: missing keyKind defaults to the platform endpoint', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
  await callModel({ provider: 'kimi', model: 'kimi-k2.6', prompt: 'p', apiKey: 'sk-moon' });
  assert.match(calls[0].url, /api\.moonshot\.ai/);
});

test('openai/kimi: a missing key fails permanently, without a request', async () => {
  stubFetch(() => { throw new Error('must not be called'); });
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => callModel({ provider: 'openai', model: 'm', prompt: 'p', retry: { attempts: 3, baseMs: 1 } }),
      /OpenAI API key is not set/);
    await assert.rejects(
      () => callModel({ provider: 'kimi', model: 'm', prompt: 'p', retry: { attempts: 3, baseMs: 1 } }),
      /Kimi API key is not set/);
    assert.equal(calls.length, 0);
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});
