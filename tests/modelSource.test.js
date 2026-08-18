// Unit tests for the multi-provider settings model and the resolution rule
// (DESIGN-SPEC.md §6): migration, priority walk, pin, disconnected
// skip, and the no-match error — plus the new adapters' request shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateSettings, createResolver, resolveCallTarget,
  DEFAULT_PRIORITY, DEFAULT_PINNED_MODELS, CURATED_MODELS,
  usdPerMillion, catalogFromOpenRouter, factsFromCatalog, normalizeModelFacts,
  normalizeModelSets, modelSetId, resolveModelSet, MODEL_SET_MAX,
  proposeStarterSet, STARTER_ROLES
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

test('migration fills defaults: priority order, pinned starter models, kimi keyKind', () => {
  const s = migrateSettings({});
  assert.deepEqual(s.providerPriority, DEFAULT_PRIORITY);
  assert.deepEqual(s.activeModels, DEFAULT_PINNED_MODELS);
  assert.deepEqual(migrateSettings({ activeModels: [] }).activeModels, [], 'an explicit empty list stays empty');
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
    { id: 'claude-sonnet-5', source: 'anthropic', enabled: true, pinned: true },
    { id: 'gpt-5.2', source: 'auto', enabled: true, pinned: true }
  ]);
});

// --- model facts (DECISIONS.md D36) ---------------------------------------------

test('per-token catalog prices become per-million; junk becomes null', () => {
  assert.equal(usdPerMillion('0.000003'), 3);
  assert.equal(usdPerMillion('0.000000015'), 0.015);
  assert.equal(usdPerMillion(0), 0, 'free is a price, not an absence');
  assert.equal(usdPerMillion('-1'), null);
  assert.equal(usdPerMillion(''), null);
  assert.equal(usdPerMillion(undefined), null);
  assert.equal(usdPerMillion('not a number'), null);
});

test('the OpenRouter payload keeps the facts the pickers show', () => {
  const list = catalogFromOpenRouter({
    data: [
      {
        id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5',
        context_length: 200000, supported_parameters: ['tools', 'temperature'],
        pricing: { prompt: '0.000003', completion: '0.000015' }
      },
      { id: 'tiny/model', pricing: {} },
      { id: '   ' },
      null
    ]
  });
  assert.equal(list.length, 2, 'entries without a usable id are dropped');
  assert.deepEqual(list[0], {
    id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5',
    contextLength: 200000, supportsTools: true, inUsdPerM: 3, outUsdPerM: 15
  });
  assert.equal(list[1].name, 'tiny/model', 'a missing name falls back to the id');
  assert.equal(list[1].supportsTools, false);
  assert.equal(list[1].inUsdPerM, null);
});

test('facts omit what the catalog did not say — unknown must not read as free', () => {
  const facts = factsFromCatalog([{ id: 'a/b', name: 'a/b', contextLength: null, supportsTools: true, inUsdPerM: null }]);
  assert.deepEqual(facts['a/b'], { supportsTools: true });
  assert.ok(!('inUsdPerM' in facts['a/b']));
  assert.ok(!('name' in facts['a/b']), 'a name identical to the id is not a fact');
});

test('a later fetch updates the ids it covers and leaves the rest alone', () => {
  const first = factsFromCatalog([{ id: 'a/b', inUsdPerM: 1 }, { id: 'c/d', inUsdPerM: 2 }]);
  const second = factsFromCatalog([{ id: 'a/b', inUsdPerM: 9 }], first);
  assert.equal(second['a/b'].inUsdPerM, 9);
  assert.equal(second['c/d'].inUsdPerM, 2, 'fetching one catalog must not blank another');
});

test('migration normalizes stored facts and drops empty ones', () => {
  const s = migrateSettings({ modelFacts: { 'a/b': { inUsdPerM: 3, junk: true }, 'c/d': {}, '': { inUsdPerM: 1 } } });
  assert.deepEqual(s.modelFacts, { 'a/b': { inUsdPerM: 3 } });
  assert.deepEqual(normalizeModelFacts(null), {});
});

// --- model sets (DECISIONS.md D36) ------------------------------------

test('set ids are slugs; names survive', () => {
  assert.equal(modelSetId('The Analysts!'), 'the-analysts');
  assert.equal(modelSetId('  --  '), '');
  const sets = normalizeModelSets({ 'The Analysts': { name: 'The Analysts', models: ['a/b', 'a/b', 'c/d'] } });
  assert.deepEqual(sets, { 'the-analysts': { name: 'The Analysts', models: ['a/b', 'c/d'] } });
});

test('a bare array is accepted as shorthand, and an empty set is legal', () => {
  const sets = normalizeModelSets({ cheap: ['a/b'], empty: { name: 'Empty', models: [] }, bad: 'nope' });
  assert.deepEqual(sets.cheap, { name: 'cheap', models: ['a/b'] });
  assert.deepEqual(sets.empty, { name: 'Empty', models: [] }, 'you create a set, then fill it');
  assert.ok(!('bad' in sets));
});

test('sets are capped so one cannot become the whole catalog', () => {
  const many = Array.from({ length: MODEL_SET_MAX + 10 }, (_, i) => `v/m${i}`);
  assert.equal(normalizeModelSets({ big: many }).big.models.length, MODEL_SET_MAX);
});

test('resolving a set drops members that are no longer active models', () => {
  const sets = { analysts: { name: 'Analysts', models: ['a/b', 'c/d', 'gone/x'] } };
  const active = [{ id: 'a/b', enabled: true }, { id: 'c/d', enabled: false }];
  assert.deepEqual(resolveModelSet(sets, 'analysts', active), ['a/b'],
    'a disabled or removed member shrinks the set rather than resolving to something unrunnable');
  assert.deepEqual(resolveModelSet(sets, 'nope', active), []);
});

test('migration keeps model sets and defaults them to empty', () => {
  assert.deepEqual(migrateSettings({}).modelSets, {});
  assert.deepEqual(migrateSettings({ modelSets: { A: ['x/y'] } }).modelSets, { a: { name: 'a', models: ['x/y'] } });
});

// --- the starter set (DECISIONS.md D36) -----------------------------------------

const CATALOG = [
  { id: 'anthropic/claude-haiku-4.5', contextLength: 200000, supportsTools: true, inUsdPerM: 1 },
  { id: 'anthropic/claude-opus-4.5', contextLength: 200000, supportsTools: true, inUsdPerM: 5 },
  { id: 'openai/gpt-5.2', contextLength: 400000, supportsTools: true, inUsdPerM: 1.25 },
  { id: 'google/gemini-2.5-pro', contextLength: 1000000, supportsTools: true, inUsdPerM: 1.25 },
  { id: 'x-ai/grok-4', contextLength: 256000, supportsTools: true, inUsdPerM: 3 },
  { id: 'someone/enormous', contextLength: 200000, supportsTools: true, inUsdPerM: 75 },
  { id: 'noteool/model', contextLength: 200000, supportsTools: false, inUsdPerM: 0.01 }
];

test('the starter set fills every role, from four different labs', () => {
  const picks = proposeStarterSet(CATALOG);
  assert.equal(picks.length, STARTER_ROLES.length);
  assert.deepEqual(picks.map(p => p.role), STARTER_ROLES.map(r => r.id));
  const vendors = picks.map(p => p.id.split('/')[0]);
  assert.equal(new Set(vendors).size, vendors.length, 'a wildcard from the same lab is not a wildcard');
});

test('the starter set refuses models the agent loop cannot give tools to, and the price outlier', () => {
  const picks = proposeStarterSet(CATALOG);
  const ids = picks.map(p => p.id);
  assert.ok(!ids.includes('notool/model'));
  assert.ok(!ids.includes('someone/enormous'), 'nobody with a ninety-second-old key gets a $75/M default');
});

test('the starter set is deterministic and survives a catalog with none of the preferred ids', () => {
  assert.deepEqual(proposeStarterSet(CATALOG), proposeStarterSet(CATALOG));
  const unknown = [
    { id: 'lab-a/cheap', contextLength: 128000, supportsTools: true, inUsdPerM: 0.2 },
    { id: 'lab-b/big', contextLength: 900000, supportsTools: true, inUsdPerM: 2 },
    { id: 'lab-c/strong', contextLength: 200000, supportsTools: true, inUsdPerM: 8 },
    { id: 'lab-d/other', contextLength: 150000, supportsTools: true, inUsdPerM: 1 }
  ];
  const picks = proposeStarterSet(unknown);
  assert.equal(picks.length, 4);
  assert.equal(picks.find(p => p.role === 'fast').id, 'lab-a/cheap');
  assert.equal(picks.find(p => p.role === 'reasoner').id, 'lab-c/strong');
  assert.equal(picks.find(p => p.role === 'reader').id, 'lab-b/big');
});

test('an empty or tool-less catalog proposes nothing rather than guessing', () => {
  assert.deepEqual(proposeStarterSet([]), []);
  assert.deepEqual(proposeStarterSet([{ id: 'a/b', supportsTools: false }]), []);
});

test('a catalog with no pricing at all still fills every role', () => {
  // The curated per-provider lists carry names and tool support but no prices
  // — a user with only an Anthropic key must still get a proposal.
  const curated = [
    { id: 'claude-sonnet-5', supportsTools: true },
    { id: 'claude-haiku-4-5', supportsTools: true },
    { id: 'gpt-5.2', supportsTools: true },
    { id: 'kimi-k2.6', supportsTools: true }
  ];
  const picks = proposeStarterSet(curated);
  assert.equal(picks.length, STARTER_ROLES.length, 'an unknown price is not a price over the ceiling');
  assert.equal(new Set(picks.map(p => p.id)).size, 4, 'and no model is proposed twice');
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
