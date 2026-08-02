// Published-price formatting (src/modelCost.js). Pure functions, no DOM.
//
// SETTINGS-MODELS-PLAN §8 flags cost as "the claim in this plan most likely to
// be quietly wrong", so the failure modes that would read as a lie get their
// own assertions: a plan-priced model must never blend to a dollar figure, and
// an unpublished price must never collapse to $0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_RATIO, blendedPrice, formatPerMtok, priceRange, formatPriceRange } from '../src/modelCost.js';

test('the blend is 3 input : 1 output', () => {
  assert.equal(BLEND_RATIO, 3);
  // (3*3 + 15) / 4 = 6
  assert.equal(blendedPrice({ input: 3, output: 15 }), 6);
  // a symmetric price blends to itself
  assert.equal(blendedPrice({ input: 2, output: 2 }), 2);
});

test('subscription and unpublished prices blend to null, never to zero', () => {
  assert.equal(blendedPrice({ kind: 'plan', plan: 'Claude Pro / Max' }), null);
  assert.equal(blendedPrice(null), null);
  assert.equal(blendedPrice({ input: 3 }), null);
  assert.equal(blendedPrice({ input: 3, output: -1 }), null);
});

test('blended price orders models the way the catalog does', () => {
  const cheap = blendedPrice({ input: 0.25, output: 1.25 });
  const mid = blendedPrice({ input: 3, output: 15 });
  const dear = blendedPrice({ input: 15, output: 75 });
  assert.ok(cheap < mid && mid < dear);
  assert.equal(cheap, 0.5);
  assert.equal(dear, 30);
});

test('prices format without inventing precision', () => {
  assert.equal(formatPerMtok(3), '$3');
  assert.equal(formatPerMtok(15), '$15');
  assert.equal(formatPerMtok(1.25), '$1.25');
  assert.equal(formatPerMtok(0.25), '$0.25');
  assert.equal(formatPerMtok(0), '$0');
  assert.equal(formatPerMtok(0.004), '<$0.01');
  assert.equal(formatPerMtok(null), '—');
  assert.equal(formatPerMtok(undefined), '—');
  assert.equal(formatPerMtok(NaN), '—');
});

test('a range spans cheapest input to dearest output', () => {
  const r = priceRange([
    { price: { input: 3, output: 15 } },
    { price: { input: 0.25, output: 1.25 } }
  ]);
  assert.deepEqual({ min: r.min, max: r.max, priced: r.priced }, { min: 0.25, max: 15, priced: 2 });
  assert.equal(formatPriceRange(r), '$0.25–$15 /Mtok');
});

test('a single price collapses the range instead of printing "$3–$3"', () => {
  const r = priceRange([{ price: { input: 3, output: 3 } }]);
  assert.equal(formatPriceRange(r), '$3 /Mtok');
});

test('plan-priced and unpriced models are counted, not folded into the span', () => {
  const r = priceRange([
    { price: { kind: 'plan', plan: 'Claude Pro / Max' } },
    { price: null },
    { price: { input: 2, output: 8 } }
  ]);
  assert.equal(r.plan, 1);
  assert.equal(r.unpriced, 1);
  assert.equal(r.priced, 1);
  assert.equal(r.min, 2);
  assert.equal(r.max, 8);
});

test('a set with no published price has no range at all', () => {
  assert.equal(formatPriceRange(priceRange([{ price: { kind: 'plan' } }])), null);
  assert.equal(formatPriceRange(priceRange([])), null);
  assert.equal(formatPriceRange(null), null);
});
