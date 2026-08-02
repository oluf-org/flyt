// What one model call cost (PIVOT-PLAN §4.4).
//
// Takes a raw provider `usage` object and a price record from
// core/modelCatalog.js and returns dollars. Pure, so the numbers can be tested
// without a run — and load-bearing, because an investigator product whose
// numbers are wrong is worse than no investigator product (PIVOT-PLAN §11).
//
// Four rules, in the order they bite:
//
//   1. Cached input tokens are priced at the cached rate when the catalog
//      publishes one.
//   2. An unpublished price, an off-catalog model, or a usage object the
//      provider never sent yields `total: null, estimated: true`. It must
//      NEVER collapse to 0 — a fabricated zero is worse than a blank, and it
//      would silently poison every aggregate downstream.
//   3. Subscription entries (`{ kind: 'plan' }`) cost plan capacity, not
//      dollars: `total: null, costKind: 'plan'`. Excluded from spend charts,
//      included in token and latency charts.
//   4. The catalog version is stamped into the record, so a later price change
//      never retroactively rewrites history.
import { resolveCatalogId, bundledIdForOpenRouterId } from './modelCatalog.js';

// Bumped by hand whenever a price in core/modelCatalog.js changes. Records
// carry it so two calls priced under different catalogs stay distinguishable
// forever.
export const PRICE_SOURCE = 'catalog@2026-07-25';

export const CURRENCY = 'USD';

// --- usage ------------------------------------------------------------------

// The union of the shapes the adapters return, flattened to one vocabulary.
//
// Two families, told apart by which key names the input side:
//
//   Anthropic (`input_tokens`)  — cache reads/writes are counted SEPARATELY
//                                 from input_tokens.
//   OpenAI    (`prompt_tokens`) — cached tokens are counted INSIDE
//                                 prompt_tokens, so they are subtracted out
//                                 here to give the same "uncached input"
//                                 meaning on both sides.
//
// `inputTokens` therefore always means tokens billed at the full input rate.
// Returns null when there is no usage at all — never a zeroed object, which
// would be indistinguishable from a call that genuinely used nothing.
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const openai = usage.prompt_tokens != null || usage.completion_tokens != null;

  const cachedInputTokens = openai
    ? n(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens)
    : n(usage.cache_read_input_tokens ?? usage.cached_input_tokens);
  const cacheWriteTokens = openai ? 0 : n(usage.cache_creation_input_tokens);
  const rawInput = openai
    ? n(usage.prompt_tokens)
    : n(usage.input_tokens ?? usage.inputTokens);
  // OpenAI counts cached tokens inside prompt_tokens; Anthropic doesn't.
  const inputTokens = openai ? Math.max(0, rawInput - cachedInputTokens) : rawInput;
  const outputTokens = openai
    ? n(usage.completion_tokens)
    : n(usage.output_tokens ?? usage.outputTokens);
  const reasoningTokens = n(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens
  );

  if (!inputTokens && !cachedInputTokens && !cacheWriteTokens && !outputTokens) {
    // Every field absent or zero AND no recognised key present: the provider
    // sent something, but nothing this function understands.
    const known = ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens']
      .some(k => usage[k] != null);
    if (!known) return null;
  }
  return {
    inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens,
    totalTokens: inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens
  };
}

// --- price lookup -------------------------------------------------------------

// The price record for a model id. `prices` is an optional { id: priceRecord }
// override map — electron/main.js builds one from the merged catalog so live
// OpenRouter pricing is used where the bundled file is stale, and so
// aggregator-only routes (which have no bundled record at all) are priceable.
// OpenRouter's namespaced ids fold onto their bundled record.
export function priceFor(model, prices = null) {
  const id = String(model ?? '');
  if (!id) return null;
  if (prices && prices[id]) return prices[id];
  const direct = resolveCatalogId(id);
  if (direct) return direct.price ?? null;
  const bundled = bundledIdForOpenRouterId(id);
  if (bundled) {
    if (prices && prices[bundled]) return prices[bundled];
    return resolveCatalogId(bundled)?.price ?? null;
  }
  return null;
}

// --- cost ---------------------------------------------------------------------

// Money is computed in floats and rounded here, once. Ten decimal places keeps
// a fraction of a cent on a single call exact while dropping the 1e-17 fuzz
// that would otherwise make two equal sums compare unequal.
const round = n => (n == null ? null : Math.round(n * 1e10) / 1e10);
const perMtok = (tokens, rate) => (tokens / 1_000_000) * rate;

// callCost({ usage, model, price?, prices? }) -> the record's `cost` field.
//
// Shape:
//   { input, cachedInput, cacheWrite, output, total, currency, estimated,
//     costKind: 'tokens' | 'plan', priceSource, reason? }
//
// `estimated: true` always means "do not add this to a spend total and call it
// exact". `reason` says why, in a phrase a UI can print.
export function callCost({ usage, model, price = undefined, prices = null } = {}) {
  const rec = price === undefined ? priceFor(model, prices) : price;
  const base = {
    input: null, cachedInput: null, cacheWrite: null, output: null, total: null,
    currency: CURRENCY, estimated: true, costKind: 'tokens', priceSource: PRICE_SOURCE
  };

  // Rule 3: a subscription costs plan capacity. Not estimated — precisely known
  // to be not-dollars.
  if (rec?.kind === 'plan') {
    return { ...base, estimated: false, costKind: 'plan', reason: 'plan', plan: rec.plan ?? null };
  }

  const u = normalizeUsage(usage);
  if (!u) return { ...base, reason: 'no-usage' };
  if (!rec) return { ...base, reason: 'no-price' };
  if (typeof rec.input !== 'number' || typeof rec.output !== 'number'
    || rec.input < 0 || rec.output < 0) {
    return { ...base, reason: 'no-price' };
  }

  // Rule 1, and open question §10.3's answer: when the catalog does not publish
  // a cached-input rate but the provider counted cached tokens, they are billed
  // at the FULL input rate and the record says `estimated: true`. Never
  // undercount, never guess a discount — say so instead.
  const cacheReadRate = typeof rec.cacheRead === 'number' && rec.cacheRead >= 0 ? rec.cacheRead : null;
  const cacheWriteRate = typeof rec.cacheWrite === 'number' && rec.cacheWrite >= 0 ? rec.cacheWrite : null;
  const unknownCacheRate =
    (u.cachedInputTokens > 0 && cacheReadRate == null) ||
    (u.cacheWriteTokens > 0 && cacheWriteRate == null);

  const input = perMtok(u.inputTokens, rec.input);
  const cachedInput = perMtok(u.cachedInputTokens, cacheReadRate ?? rec.input);
  const cacheWrite = perMtok(u.cacheWriteTokens, cacheWriteRate ?? rec.input);
  const output = perMtok(u.outputTokens, rec.output);

  return {
    input: round(input),
    cachedInput: round(cachedInput),
    cacheWrite: round(cacheWrite),
    output: round(output),
    total: round(input + cachedInput + cacheWrite + output),
    currency: CURRENCY,
    estimated: unknownCacheRate,
    costKind: 'tokens',
    priceSource: PRICE_SOURCE,
    ...(unknownCacheRate ? { reason: 'cache-rate-unknown' } : {})
  };
}

// Sum a set of call costs into one rollup (per node, per run, per model).
// Dollars only add up when every contributing call had a real price; a single
// unpriced call makes the total `estimated`, and a total of null when NOTHING
// was priceable. Plan-priced calls are skipped entirely rather than counted as
// zero — that is the whole point of rule 3.
export function sumCosts(costs) {
  let total = null;
  let estimated = false;
  let priced = 0;
  let plan = 0;
  let unpriced = 0;
  for (const c of costs ?? []) {
    if (!c) { unpriced++; continue; }
    if (c.costKind === 'plan') { plan++; continue; }
    if (typeof c.total !== 'number') { unpriced++; estimated = true; continue; }
    total = (total ?? 0) + c.total;
    priced++;
    if (c.estimated) estimated = true;
  }
  return { total: round(total), currency: CURRENCY, estimated, priced, plan, unpriced };
}

// Sum normalized usage objects. Unlike costs, tokens always add: a plan-priced
// call still burned tokens, and the token charts include it (rule 3).
export function sumUsage(usages) {
  const out = {
    inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0
  };
  let any = false;
  for (const u of usages ?? []) {
    if (!u) continue;
    any = true;
    for (const k of Object.keys(out)) out[k] += typeof u[k] === 'number' ? u[k] : 0;
  }
  return any ? out : null;
}

// "$0.0179", "<$0.0001", "—". Call-level money is small enough that the
// two-decimal formatting in src/modelCost.js (which prices a MILLION tokens)
// would round almost every real call to $0.00 — a printed zero, which is the
// one thing rule 2 exists to prevent.
export function formatCost(n, { plan = false } = {}) {
  if (plan) return 'plan';
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  if (n < 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toFixed(2)}`;
}
