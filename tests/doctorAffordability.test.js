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
import { affordability, priceOfTheNextCall, bindingCredit, doctor } from '../core/diagnostics.js';
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

function closeTmp({ engine, dataRoot }) {
  engine.telemetry.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

// Only OpenRouter's two balance endpoints are answered, so a doctor that starts
// fetching something else fails loudly here instead of quietly reading a
// balance payload. `account` defaults to the same numbers as the key, which is
// the ordinary case: the two agree and nothing is said about it.
async function withCredit({ limit, usage, account = null }, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const at = String(url);
    if (at.includes('openrouter.ai/api/v1/key')) {
      return { ok: true, json: async () => ({ data: { limit, usage, is_free_tier: false } }) };
    }
    if (at.includes('openrouter.ai/api/v1/credits')) {
      const a = account ?? { limit, usage };
      if (a === 'unreachable') throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ data: { total_credits: a.limit, total_usage: a.usage } }) };
    }
    return real(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('doctor reports an unaffordable balance in the provider\'s own terms', async (t) => {
  const fixture = tmpEngine({ high: 'dear/model' }, { 'dear/model': { outUsdPerM: 1310.77 } });
  t.after(() => closeTmp(fixture));
  const { engine } = fixture;
  const report = await withCredit({ limit: 65, usage: 65 - 1.85 }, () => doctor(engine));

  const finding = report.findings.find(f => /cannot fund an ordinary request/.test(f.message));
  assert.ok(finding, `expected the affordability finding:\n${report.findings.map(f => f.message).join('\n')}`);
  assert.equal(finding.level, 'error');
  assert.match(finding.message, new RegExp(`up to ${effortBudget(DEFAULT_EFFORT)} tokens`));
  assert.match(finding.message, /affords 1411/);
  assert.match(finding.message, /dear\/model/, 'and which model it is about');
});

test('doctor is quiet when the balance can fund a request', async (t) => {
  const fixture = tmpEngine({ high: 'ordinary/model' }, { 'ordinary/model': { outUsdPerM: 10 } });
  t.after(() => closeTmp(fixture));
  const { engine } = fixture;
  const report = await withCredit({ limit: 50, usage: 30 }, () => doctor(engine));
  assert.ok(!report.findings.some(f => /cannot fund|affords|could not be checked/.test(f.message)),
    report.findings.map(f => f.message).join('\n'));
});

test('a balance that cannot be checked says so, once it is low enough to matter', async (t) => {
  // The unknowable, which the first version reported as nothing. "No finding"
  // and "checked, and fine" have to look different, or the check quietly does
  // not exist — and it is only worth saying where it changes what to do.
  const lowFixture = tmpEngine({ high: 'unpriced/model' }, {});
  const healthyFixture = tmpEngine({ high: 'unpriced/model' }, {});
  t.after(() => closeTmp(lowFixture));
  t.after(() => closeTmp(healthyFixture));
  const low = await withCredit({ limit: 65, usage: 63.15 },
    () => doctor(lowFixture.engine));
  assert.ok(low.findings.some(f => f.level === 'info' && /could not be checked/.test(f.message)),
    low.findings.map(f => f.message).join('\n'));

  const healthy = await withCredit({ limit: 65, usage: 5 },
    () => doctor(healthyFixture.engine));
  assert.ok(!healthy.findings.some(f => /could not be checked/.test(f.message)),
    'a healthy key is not worth a note about pricing');
});

// --- two ceilings, and the smaller binds (t-0109) ---------------------------
//
// `/key` describes THIS KEY; `/credits` describes the ACCOUNT. They are not the
// same number, and on 2026-08-26 they disagreed by a factor of five: $1.73 left
// of a $65 key limit against $9.79 left of $102 in the account. Doctor read the
// first and called it "the OpenRouter key has $1.73 left", which is literally
// true and reads to every operator as "this is what you have". A call fails
// when EITHER is exhausted, so the smaller one is the answer — and the two
// repairs are different: "add credit" against "raise the key limit".

test('the smaller remaining balance is the one that binds', () => {
  const key = { limit: 65, usage: 63.27 };        // $1.73 left
  const account = { limit: 102, usage: 92.21 };   // $9.79 left

  const bound = bindingCredit(key, account);
  assert.equal(bound.scope, 'key');
  assert.equal((bound.limit - bound.usage).toFixed(2), '1.73');
  assert.equal(bound.other.scope, 'account');
  assert.equal(bound.other.left.toFixed(2), '9.79');

  // And the other way round, when the account is the tighter of the two.
  const flipped = bindingCredit({ limit: 500, usage: 100 }, { limit: 102, usage: 100 });
  assert.equal(flipped.scope, 'account');
  assert.equal(flipped.other.scope, 'key');
});

test('an endpoint that could not be read does not vote, and does not take doctor down', () => {
  // The property openrouterCredit has always had and must keep: one source
  // failing degrades to the other rather than reporting nothing.
  const key = { limit: 65, usage: 63.27 };
  assert.equal(bindingCredit(key, { error: 'HTTP 500' }).scope, 'key');
  assert.equal(bindingCredit({ error: 'ECONNREFUSED' }, { limit: 102, usage: 92.21 }).scope, 'account');

  // Neither readable: the key's error is reported, as every previous version did.
  assert.deepEqual(bindingCredit({ error: 'HTTP 500' }, { error: 'HTTP 500' }), { error: 'HTTP 500' });
  assert.equal(bindingCredit(null, null), null);
});

test('doctor names both ceilings when they disagree, and neither when they do not', async (t) => {
  const fixture = tmpEngine({ high: 'ordinary/model' }, { 'ordinary/model': { outUsdPerM: 10 } });
  t.after(() => closeTmp(fixture));
  const { engine } = fixture;
  const apart = await withCredit(
    { limit: 65, usage: 63.27, account: { limit: 102, usage: 92.21 } },
    () => doctor(engine));
  const said = apart.findings.map(f => f.message).join('\n');
  assert.match(said, /The OpenRouter key has \$1\.73 left of \$65\.00/);
  assert.match(said, /The account has \$9\.79; the smaller of the two is what binds/);

  // Agreeing is the ordinary case, and it is not worth a sentence.
  const together = await withCredit({ limit: 65, usage: 63.27 }, () => doctor(engine));
  const also = together.findings.map(f => f.message).join('\n');
  assert.match(also, /has \$1\.73 left/);
  assert.ok(!/smaller of the two/.test(also), also);
});

test('a spent ceiling says which one, because the two repairs differ', async (t) => {
  const fixture = tmpEngine({ high: 'ordinary/model' }, { 'ordinary/model': { outUsdPerM: 10 } });
  t.after(() => closeTmp(fixture));
  const { engine } = fixture;

  const keySpent = await withCredit(
    { limit: 65, usage: 65, account: { limit: 102, usage: 50 } }, () => doctor(engine));
  const k = keySpent.findings.find(f => /is spent/.test(f.message));
  assert.match(k.message, /The OpenRouter key is spent/);
  assert.match(k.message, /Raise the key limit/);

  const accountSpent = await withCredit(
    { limit: 500, usage: 100, account: { limit: 102, usage: 102 } }, () => doctor(engine));
  const a = accountSpent.findings.find(f => /is spent/.test(f.message));
  assert.match(a.message, /The OpenRouter account is spent/);
  assert.match(a.message, /Add credit/);
});

test('the affordability check reads the binding number, not the roomier one', async (t) => {
  // The check inherits whatever balance is in front of it, so it has to be the
  // one that binds — otherwise it answers "can this fund a request" against a
  // ceiling that is not the one about to stop the call.
  const fixture = tmpEngine({ high: 'dear/model' }, { 'dear/model': { outUsdPerM: 1310.77 } });
  t.after(() => closeTmp(fixture));
  const { engine } = fixture;
  const report = await withCredit(
    // The key is nearly out; the account has plenty. The key binds.
    { limit: 65, usage: 63.15, account: { limit: 1000, usage: 0 } },
    () => doctor(engine));
  assert.ok(report.findings.some(f => /cannot fund an ordinary request/.test(f.message)),
    report.findings.map(f => f.message).join('\n'));
});
