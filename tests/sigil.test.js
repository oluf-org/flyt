// Run sigils: deterministic "burst" glyphs from a run id (src/sigil.js). Pure
// string builder, so it tests without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sigil } from '../src/sigil.js';

test('same id + size always yields the identical sigil', () => {
  const a = sigil('run-20260716-142200', 26);
  const b = sigil('run-20260716-142200', 26);
  assert.equal(a, b);
});

test('different ids produce different sigils', () => {
  assert.notEqual(sigil('run-a', 26), sigil('run-b', 26));
});

test('the gradient id is unique per run id (no cross-row <defs> collision)', () => {
  const idOf = svg => svg.match(/id="(sg[0-9a-z]+)"/)[1];
  assert.notEqual(idOf(sigil('run-a', 26)), idOf(sigil('run-b', 26)));
  // the referenced url(#id) matches the defined id
  const svg = sigil('run-a', 26);
  assert.ok(svg.includes(`url(#${idOf(svg)})`));
});

test('respects the requested size and uses only currentColor', () => {
  const svg = sigil('x', 34);
  assert.match(svg, /width="34" height="34"/);
  assert.match(svg, /viewBox="0 0 34 34"/);
  // no literal colours / theme hues leak in — currentColor only
  assert.ok(!/#[0-9a-fA-F]{3,6}|oklch|var\(/.test(svg), 'sigil must not hard-code colour');
  assert.ok(svg.includes('currentColor'));
});

test('ray count stays in the burst range (8–14), fewer at small sizes', () => {
  const rays = svg => (svg.match(/<line /g) || []).length;
  for (const id of ['a', 'bb', 'ccc', 'run-xyz', 'run-20260101-000000']) {
    const big = rays(sigil(id, 34));
    assert.ok(big >= 8 && big <= 14, `big ${id}: ${big}`);
    const small = rays(sigil(id, 20));
    assert.ok(small >= 8 && small <= 12, `small ${id}: ${small}`);
  }
});
