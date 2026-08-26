// Can this balance still pay for a call? (t-0103)
//
// An OpenRouter balance ran out mid-loop on 2026-08-24 and the refusal read
// "You requested up to 12288 tokens, but can only afford 1411". `flyt doctor`
// at the time reported "$1.85 left of $65.00" and a warning that a long run
// would end partway through — both true, and neither of them the fact that
// mattered. $1.85 was not "some money left". It could not serve one call.
//
// So the finding is the provider's own comparison: the tokens an ordinary
// request asks for, against the tokens the balance affords.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { affordability, priceOfTheNextCall, doctor } from '../core/diagnostics.js';
import { effortBudget, DEFAULT_EFFORT } from '../src/flowTypes.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- the arithmetic, on its own --------------------------------------------
//
// Pure, so it is pinned here rather than inferred from a doctor run: the
// integration test below proves it is WIRED, and these prove it is RIGHT.

test('affordability compares tokens, not dollars', () => {
  // The live shape: $1.85 against a model at $1310.77 per million completion
  // tokens affords 1411, and an ordinary request wants 12288.
  const short = affordability({ usdLeft: 1.85, usdPerMillion: 1.31077e3, tokensWanted: 12288 });
  assert.deepEqual(short, { affordTokens: 1411, tokensWanted: 12288 });

  // Exactly enough is enough.
  assert.equal(affordability({ usdLeft: 1, usdPerMillion: 1000, tokensWanted: 1000 }), null);
  // One token short is not.
  assert.deepEqual(affordability({ usdLeft: 1, usdPerMillion: 1000, tokensWanted: 1001 }),
    { affordTokens: 1000, tokensWanted: 1001 });
});

test('affordability has nothing to say about a free model or an unknown price', () => {
  // A free model affords infinitely many tokens, and "unknown" is not "short".
  // Reporting either as a shortfall would make the check fire on the one
  // configuration it should never fire on.
  for (const usdPerMillion of [0, null, undefined, NaN, -1]) {
    assert.equal(affordability({ usdLeft: 0.01, usdPerMillion, tokensWanted: 12288 }), null,
      `price ${usdPerMillion}`);
  }
  assert.equal(affordability({ usdLeft: 0, usdPerMillion: 5, tokensWanted: 10 }), null);
});

test('the price is the dearest band the loop can reach, not the cheapest model known', () => {
  // The band that 402s first is the one a balance has to clear. An earlier
  // version fell back to the cheapest priced model in the whole catalogue,
  // which made the check least likely to fire — a safety check failing open.
  const runtimeConfig = {
    modelFacts: {
      'cheap/one': { outUsdPerM: 0.2 },
      'dear/one': { outUsdPerM: 15 },
      'unpriced/one': {}
    },
    loop: { models: { low: 'cheap/one', high: 'dear/one', max: 'unpriced/one' } }
  };
  assert.deepEqual(priceOfTheNextCall(runtimeConfig), { model: 'dear/one', usdPerMillion: 15 });
});

test('with no loop bands, the price is what an unpinned node would cost', () => {
  const runtimeConfig = {
    modelFacts: { 'some/model': { outUsdPerM: 3 } },
    providerPriority: ['openrouter'],
    providers: { openrouter: { connected: true } },
    pinnedModels: [{ provider: 'openrouter', model: 'some/model', kinds: ['code'] }]
  };
  const priced = priceOfTheNextCall(runtimeConfig);
  // Either it priced the default route, or there is no route to price — both
  // are answers. What must never happen is a number from an unrelated model.
  if (priced) assert.equal(priced.usdPerMillion, 3);
});

test('completion price is preferred, prompt price is the fallback', () => {
  assert.equal(priceOfTheNextCall({
    modelFacts: { m: { inUsdPerM: 1, outUsdPerM: 9 } }, loop: { models: { low: 'm' } }
  }).usdPerMillion, 9, 'max_tokens is reserved at the completion rate');
  assert.equal(priceOfTheNextCall({
    modelFacts: { m: { inUsdPerM: 1 } }, loop: { models: { low: 'm' } }
  }).usdPerMillion, 1);
  assert.equal(priceOfTheNextCall({ modelFacts: {}, loop: { models: { low: 'm' } } }), null);
});

// --- and wired into the report ---------------------------------------------

function tmpEngine(loopModels, modelFacts) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-afford-'));
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.providers = { openrouter: { apiKey: 'sk-test' } };
  engine.settings.providerPriority = ['openrouter'];
  engine.settings.loopModels = loopModels;
  engine.settings.modelFacts = modelFacts;
  engine.rebuildRuntimeConfig();
  return { engine, dataRoot };
}

// Only the credit endpoint is answered, so a doctor that starts fetching
// something else fails loudly here instead of quietly reading a credit payload.
async function withCredit({ limit, usage }, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('openrouter.ai/api/v1/key')) {
      return { ok: true, json: async () => ({ data: { limit, usage, is_free_tier: false } }) };
    }
    return real(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('doctor reports an unaffordable balance in the provider\'s own terms', async () => {
  const { engine, dataRoot } = tmpEngine({ high: 'dear/model' }, { 'dear/model': { outUsdPerM: 1310.77 } });
  const report = await withCredit({ limit: 65, usage: 65 - 1.85 }, () => doctor(engine));

  const finding = report.findings.find(f => /cannot fund an ordinary request/.test(f.message));
  assert.ok(finding, `expected the affordability finding:\n${report.findings.map(f => f.message).join('\n')}`);
  assert.equal(finding.level, 'error');
  assert.match(finding.message, new RegExp(`up to ${effortBudget(DEFAULT_EFFORT)} tokens`));
  assert.match(finding.message, /affords 1411/);
  assert.match(finding.message, /dear\/model/, 'and which model it is about');
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('doctor is quiet when the balance can fund a request', async () => {
  const { engine, dataRoot } = tmpEngine({ high: 'ordinary/model' }, { 'ordinary/model': { outUsdPerM: 10 } });
  const report = await withCredit({ limit: 50, usage: 30 }, () => doctor(engine));
  assert.ok(!report.findings.some(f => /cannot fund|affords|could not be checked/.test(f.message)),
    report.findings.map(f => f.message).join('\n'));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('a balance that cannot be checked says so, once it is low enough to matter', async () => {
  // The unknowable, which the first version reported as nothing. "No finding"
  // and "checked, and fine" have to look different, or the check quietly does
  // not exist — and it is only worth saying where it changes what to do.
  const low = await withCredit({ limit: 65, usage: 63.15 },
    () => doctor(tmpEngine({ high: 'unpriced/model' }, {}).engine));
  assert.ok(low.findings.some(f => f.level === 'info' && /could not be checked/.test(f.message)),
    low.findings.map(f => f.message).join('\n'));

  const healthy = await withCredit({ limit: 65, usage: 5 },
    () => doctor(tmpEngine({ high: 'unpriced/model' }, {}).engine));
  assert.ok(!healthy.findings.some(f => /could not be checked/.test(f.message)),
    'a healthy key is not worth a note about pricing');
});
