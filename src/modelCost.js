// Published-price maths for the model catalog (SETTINGS-MODELS-PLAN §4, G5).
//
// Scope discipline: these functions format *published prices*. They never see
// a token count, a run, or a total — spend accounting stays a GOALS.md
// non-goal. Everything here is pure so the numbers can be tested without a
// DOM (tests/modelCost.test.js); P6's cost bars build on the same helpers so
// the bar and the printed figure can never disagree.
//
// Prices throughout are USD per 1,000,000 tokens, matching the catalog record.

// The blend used whenever one number has to stand in for a model's cost:
// 3 input tokens per output token, the realistic agent-workload ratio. Fixed
// and documented rather than user-adjustable (§10 Q3) — a printed assumption
// beats a slider nobody moves.
export const BLEND_RATIO = 3;

// A single comparable price for a model, or null when there is nothing honest
// to compare: subscription entries (`{ kind: 'plan' }`) cost plan capacity,
// not dollars, and an unpublished price must never collapse to 0.
export function blendedPrice(price, ratio = BLEND_RATIO) {
  if (!price || price.kind === 'plan') return null;
  const { input, output } = price;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (input < 0 || output < 0) return null;
  return (input * ratio + output) / (ratio + 1);
}

// "$3", "$0.25", "<$0.01", "—". Trailing zeros are trimmed because a column of
// "$3.00" reads as more precision than the catalog actually claims.
export function formatPerMtok(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  const s = n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `$${s}`;
}

// The price span of a set of models, as the cheapest token you can buy from
// them (lowest input) to the dearest (highest output). That framing is what a
// collapsed provider card has to answer: "what does buying here cost?".
//
// Returns counts alongside the span so a caller can distinguish "no prices"
// from "plan-priced" without re-walking the list.
export function priceRange(models) {
  let min = null;
  let max = null;
  let priced = 0;
  let plan = 0;
  let unpriced = 0;
  for (const m of models ?? []) {
    const price = m?.price;
    if (price?.kind === 'plan') { plan++; continue; }
    const input = typeof price?.input === 'number' && price.input >= 0 ? price.input : null;
    const output = typeof price?.output === 'number' && price.output >= 0 ? price.output : null;
    if (input == null && output == null) { unpriced++; continue; }
    priced++;
    for (const v of [input, output]) {
      if (v == null) continue;
      if (min == null || v < min) min = v;
      if (max == null || v > max) max = v;
    }
  }
  return { min, max, priced, plan, unpriced };
}

// "$0.25–$15 /Mtok", or "$3 /Mtok" when the span collapses. null when nothing
// in the set publishes a price — the caller decides what to say instead
// (a plan label, or nothing at all), because "$0" would be a lie.
export function formatPriceRange(range) {
  if (!range || range.priced === 0 || range.min == null || range.max == null) return null;
  if (range.min === range.max) return `${formatPerMtok(range.min)} /Mtok`;
  return `${formatPerMtok(range.min)}–${formatPerMtok(range.max)} /Mtok`;
}
