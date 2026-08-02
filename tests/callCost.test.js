// PIVOT-PLAN P2 — cost.
//
// The load-bearing rule this file guards: an unknown price NEVER collapses to
// zero. Every other test here exists so that rule stays cheap to keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callCost, normalizeUsage, priceFor, sumCosts, sumUsage, formatCost, PRICE_SOURCE
} from '../core/callCost.js';

// --- usage normalization ------------------------------------------------------

test('normalizeUsage separates cached input on both provider shapes', () => {
  // Anthropic: cache reads are counted SEPARATELY from input_tokens.
  const anthropic = normalizeUsage({
    input_tokens: 2600, cache_read_input_tokens: 9800,
    cache_creation_input_tokens: 400, output_tokens: 243
  });
  assert.equal(anthropic.inputTokens, 2600);
  assert.equal(anthropic.cachedInputTokens, 9800);
  assert.equal(anthropic.cacheWriteTokens, 400);
  assert.equal(anthropic.outputTokens, 243);
  assert.equal(anthropic.totalTokens, 2600 + 9800 + 400 + 243);

  // OpenAI: cached tokens are counted INSIDE prompt_tokens, so they come out.
  const openai = normalizeUsage({
    prompt_tokens: 12400, completion_tokens: 243,
    prompt_tokens_details: { cached_tokens: 9800 },
    completion_tokens_details: { reasoning_tokens: 64 }
  });
  assert.equal(openai.inputTokens, 12400 - 9800);
  assert.equal(openai.cachedInputTokens, 9800);
  assert.equal(openai.outputTokens, 243);
  assert.equal(openai.reasoningTokens, 64);
});

test('normalizeUsage returns null rather than a zeroed object for no usage', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ some_other_field: 3 }), null);
  // A call that genuinely reported zeros is NOT the same thing.
  assert.deepEqual(normalizeUsage({ input_tokens: 0, output_tokens: 0 })?.totalTokens, 0);
});

// --- price lookup --------------------------------------------------------------

test('priceFor resolves catalog ids, aliases and OpenRouter namespaces', () => {
  assert.equal(priceFor('claude-sonnet-5').input, 3.0);
  // A dated snapshot folds onto its rolling alias.
  assert.equal(priceFor('claude-sonnet-5-20260224').input, 3.0);
  // OpenRouter's namespaced id maps onto the bundled record.
  assert.equal(priceFor('anthropic/claude-sonnet-5').input, 3.0);
  // An override map (live OpenRouter pricing) wins over the bundled file.
  assert.equal(priceFor('claude-sonnet-5', { 'claude-sonnet-5': { input: 9, output: 9 } }).input, 9);
  assert.equal(priceFor('a-model-nobody-has-heard-of'), null);
});

// --- the rule ------------------------------------------------------------------

test('an unknown price yields null and estimated:true — never 0', () => {
  const c = callCost({ usage: { input_tokens: 1000, output_tokens: 500 }, model: 'nope/unknown' });
  assert.equal(c.total, null);
  assert.equal(c.estimated, true);
  assert.equal(c.reason, 'no-price');
  // The thing a fabricated zero would look like:
  assert.notEqual(c.total, 0);
});

test('no usage yields null cost even when the price is known', () => {
  const c = callCost({ usage: null, model: 'claude-sonnet-5' });
  assert.equal(c.total, null);
  assert.equal(c.estimated, true);
  assert.equal(c.reason, 'no-usage');
});

test('cached input is priced at the cached rate when the catalog publishes one', () => {
  // Sonnet 5: input $3, cacheRead $0.30 per Mtok.
  const c = callCost({
    usage: { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 0 },
    model: 'claude-sonnet-5'
  });
  assert.equal(c.input, 3);
  assert.equal(c.cachedInput, 0.3);
  assert.equal(c.total, 3.3);
  assert.equal(c.estimated, false);
  assert.equal(c.priceSource, PRICE_SOURCE);
});

test('an unknown cached rate bills at the full input rate and says so', () => {
  // Kimi K2.6 publishes no cacheRead. Never undercount, never guess a discount.
  const c = callCost({
    usage: { prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 1_000_000 }, completion_tokens: 0 },
    model: 'kimi-k2.6'
  });
  assert.equal(c.input, 0);            // all of it was cached
  assert.equal(c.cachedInput, 0.6);    // billed at the 0.60 input rate
  assert.equal(c.estimated, true);
  assert.equal(c.reason, 'cache-rate-unknown');
});

test('a plan-priced model reports plan capacity, not dollars', () => {
  const c = callCost({ usage: { input_tokens: 100, output_tokens: 200 }, model: 'gpt-5.2-codex' });
  assert.equal(c.costKind, 'plan');
  assert.equal(c.total, null);
  // Not "estimated" — precisely known to be not-dollars.
  assert.equal(c.estimated, false);
});

// --- rollups -------------------------------------------------------------------

test('sumCosts excludes plan calls from dollars but counts them', () => {
  const priced = callCost({ usage: { input_tokens: 1_000_000, output_tokens: 0 }, model: 'claude-sonnet-5' });
  const plan = callCost({ usage: { input_tokens: 500, output_tokens: 500 }, model: 'gpt-5.2-codex' });
  const roll = sumCosts([priced, plan]);
  assert.equal(roll.total, 3);
  assert.equal(roll.priced, 1);
  assert.equal(roll.plan, 1);
  assert.equal(roll.estimated, false);
});

test('sumCosts marks the total estimated when any call could not be priced', () => {
  const priced = callCost({ usage: { input_tokens: 1_000_000, output_tokens: 0 }, model: 'claude-sonnet-5' });
  const unknown = callCost({ usage: { input_tokens: 10, output_tokens: 10 }, model: 'who/knows' });
  const roll = sumCosts([priced, unknown]);
  assert.equal(roll.total, 3);
  assert.equal(roll.estimated, true);
  assert.equal(roll.unpriced, 1);
});

test('sumCosts over nothing priceable is null, not zero', () => {
  assert.equal(sumCosts([]).total, null);
  assert.equal(sumCosts([callCost({ usage: null, model: 'x' })]).total, null);
});

test('sumUsage adds tokens across every call including plan-priced ones', () => {
  const a = normalizeUsage({ input_tokens: 100, output_tokens: 200 });
  const b = normalizeUsage({ prompt_tokens: 50, completion_tokens: 25 });
  const total = sumUsage([a, b, null]);
  assert.equal(total.inputTokens, 150);
  assert.equal(total.outputTokens, 225);
  assert.equal(sumUsage([]), null);
});

// --- formatting ----------------------------------------------------------------

test('formatCost keeps sub-cent calls visible instead of printing $0.00', () => {
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(0.0179), '$0.0179');
  assert.equal(formatCost(0.00001), '<$0.0001');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost(null, { plan: true }), 'plan');
});
