// Tests for the bundled model catalog (SETTINGS-MODELS-PLAN §2, phase P1
// "Done when"): every record validates, every non-'unknown' training policy
// has a citable source, no duplicate ids, every providers[] entry is a known
// provider, and every id is servable by at least one of its providers per the
// adapter registry's canServe. Plus: alias resolution, the OpenRouter merge
// rule, and CURATED_MODELS staying consistent as a derived view.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CATALOG, TIERS, TRAINING_POLICIES,
  catalogEntry, resolveCatalogId, modelsForProvider,
  mergeModelRecords, bundledIdForOpenRouterId, validateCatalog
} from '../core/modelCatalog.js';
import { CURATED_MODELS, PROVIDER_IDS, SUBSCRIPTION_PROVIDERS } from '../core/modelSource.js';
import { canServe } from '../core/adapters/index.js';

test('catalog: every record validates against the known provider set', () => {
  assert.deepEqual(validateCatalog({ knownProviders: PROVIDER_IDS }), []);
});

test('catalog: no duplicate ids', () => {
  const ids = MODEL_CATALOG.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('catalog: every providers[] entry is a known provider', () => {
  for (const m of MODEL_CATALOG) {
    for (const p of m.providers) {
      assert.ok(PROVIDER_IDS.includes(p), `${m.id} lists unknown provider "${p}"`);
    }
  }
});

test('catalog: tier and training policy come from the closed enums', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(TIERS.includes(m.tier), `${m.id}: bad tier ${m.tier}`);
    assert.ok(TRAINING_POLICIES.includes(m.training.policy), `${m.id}: bad policy`);
  }
});

test('catalog: every non-unknown training policy carries a source URL', () => {
  // The honesty rule (§2): the app never asserts a training policy it cannot
  // cite. 'unknown' is the honest absence of a claim and needs no source.
  for (const m of MODEL_CATALOG) {
    if (m.training.policy === 'unknown') continue;
    assert.ok(typeof m.training.source === 'string' && m.training.source.startsWith('https://'),
      `${m.id}: policy "${m.training.policy}" must cite an https source`);
  }
});

test('catalog: every id is servable by at least one of its providers', () => {
  for (const m of MODEL_CATALOG) {
    assert.ok(
      m.providers.some(p => canServe(p, m.id)),
      `${m.id}: none of [${m.providers.join(', ')}] can serve it per canServe`
    );
  }
});

test('catalog: alias ids resolve to their canonical record', () => {
  const canonical = resolveCatalogId('claude-sonnet-5-20260224');
  assert.equal(canonical.id, 'claude-sonnet-5');
  assert.equal(resolveCatalogId('claude-sonnet-5').id, 'claude-sonnet-5');
  assert.equal(resolveCatalogId('not-a-model'), null);
  assert.equal(catalogEntry('claude-sonnet-5-20260224').aliasOf, 'claude-sonnet-5');
});

test('catalog: modelsForProvider folds aliases and keeps the CURATED shape', () => {
  const anthropic = modelsForProvider('anthropic');
  assert.ok(anthropic.every(m => typeof m.id === 'string' && typeof m.name === 'string' &&
    typeof m.supportsTools === 'boolean'));
  assert.ok(!anthropic.some(m => m.id === 'claude-sonnet-5-20260224'),
    'dated snapshots are folded away, not offered in pickers');
  const kimi = modelsForProvider('kimi');
  assert.equal(kimi.find(m => m.id === 'kimi-for-coding').keyKind, 'code');
  assert.equal(kimi.find(m => m.id === 'kimi-k2.6').keyKind, 'platform');
});

test('catalog: CURATED_MODELS is derived from the catalog, shape preserved', () => {
  for (const provider of ['anthropic', 'openai', 'kimi', 'claude-code', 'codex']) {
    const expected = modelsForProvider(provider, { subscriptionSuffix: SUBSCRIPTION_PROVIDERS.includes(provider) });
    assert.deepEqual(CURATED_MODELS[provider], expected);
  }
  // The legacy contract: subscription lists carried the "(subscription)" suffix.
  assert.ok(CURATED_MODELS['claude-code'].every(m => m.name.endsWith('(subscription)')));
  assert.ok(CURATED_MODELS.codex.every(m => m.name.endsWith('(subscription)')));
  assert.ok(!CURATED_MODELS.anthropic.some(m => m.name.endsWith('(subscription)')));
});

test('catalog: OpenRouter merge — bundled wins name/tier/training, live wins price/context', () => {
  const bundled = resolveCatalogId('claude-sonnet-5');
  const live = {
    id: 'anthropic/claude-sonnet-5',
    name: 'Anthropic: Something Renamed',
    contextLength: 1_000_000,
    price: { input: 9.99, output: 99.99 },
    releasedAt: '2026-03-01'
  };
  const merged = mergeModelRecords(bundled, live);
  assert.equal(merged.name, 'Claude Sonnet 5');
  assert.equal(merged.tier, 'balanced');
  assert.equal(merged.training.policy, 'no-train');
  assert.deepEqual(merged.price, { input: 9.99, output: 99.99 });
  assert.equal(merged.contextLength, 1_000_000);
  // releasedAt: bundled wins when present; live fills the gap otherwise.
  assert.equal(merged.releasedAt, '2026-02-24');
  assert.equal(mergeModelRecords({ ...bundled, releasedAt: null }, live).releasedAt, '2026-03-01');
  assert.equal(mergeModelRecords(bundled, null), bundled);
});

test('catalog: OpenRouter ids map back onto bundled ids by second segment', () => {
  assert.equal(bundledIdForOpenRouterId('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(bundledIdForOpenRouterId('openai/gpt-5.2'), 'gpt-5.2');
  // A dated snapshot upstream maps to its canonical bundled id.
  assert.equal(bundledIdForOpenRouterId('anthropic/claude-sonnet-5-20260224'), 'claude-sonnet-5');
  assert.equal(bundledIdForOpenRouterId('meta-llama/llama-4'), null);
  assert.equal(bundledIdForOpenRouterId('gpt-5.2'), null, 'bare ids are not OpenRouter-shaped');
});
