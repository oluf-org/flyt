// Edge weighting: how many context bytes map to how thick a line, plus the
// tooltip text. Pure functions, so they test without a DOM (src/edgeWeight.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeWidth, edgeOpacity, formatBytes } from '../src/edgeWeight.js';

test('unmeasured edges keep the 2px authoring default', () => {
  assert.equal(edgeWidth(null), 2);
  assert.equal(edgeWidth(undefined), 2);
  assert.equal(edgeOpacity(null), 1);
});

test('a measured-empty edge is the faint 1px hairline', () => {
  assert.equal(edgeWidth(0), 1);
  assert.equal(edgeOpacity(0), 0.5);
  // negative is nonsensical but must not fall through to a thick bucket
  assert.equal(edgeWidth(-10), 1);
});

test('payload buckets climb 2.5 -> 4 -> 6 at the boundaries', () => {
  assert.equal(edgeWidth(1), 2.5);
  assert.equal(edgeWidth(1499), 2.5);
  assert.equal(edgeWidth(1500), 4);
  assert.equal(edgeWidth(5999), 4);
  assert.equal(edgeWidth(6000), 6);
  assert.equal(edgeWidth(500000), 6);
  // every measured-payload edge stays full strength
  assert.equal(edgeOpacity(1500), 1);
  assert.equal(edgeOpacity(6000), 1);
});

test('formatBytes reads for the tooltip, and is null when unmeasured', () => {
  assert.equal(formatBytes(null), null);
  assert.equal(formatBytes(0), 'no context carried');
  assert.equal(formatBytes(512), '512 B of context');
  assert.equal(formatBytes(2048), '2.0 KB of context');
});
