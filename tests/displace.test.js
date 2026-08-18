// Unit tests for the pure displacement math (src/displace.js) behind the
// canvas reader's local displacement (DESIGN-SPEC.md §7): minimal-
// translation pushes, the 24px gutter, cascade + depth cap, and exact `from`
// recording for collapse-restore. No React Flow anywhere — plain rects only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rectsOverlap, minTranslation, computeDisplacement,
  DISPLACE_GUTTER, MAX_CASCADE_DEPTH
} from '../src/displace.js';

const rect = (id, x, y, w = 100, h = 60) => ({ id, x, y, w, h });

test('rectsOverlap: strict overlap only — touching edges do not count', () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false, 'edge-adjacent');
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 11, w: 10, h: 10 }), false, 'vertically clear');
});

test('minTranslation: picks the smallest separating push and includes the gutter', () => {
  const obstacle = { x: 0, y: 0, w: 100, h: 100 };
  // Slightly overlapping from the left: a small right push is cheapest.
  const near = { x: 90, y: 10, w: 50, h: 50 };
  assert.deepEqual(minTranslation(near, obstacle), { dx: 100 + DISPLACE_GUTTER - 90, dy: 0 });
  // Mostly to the right, vertically centered: pushing DOWN is cheaper than
  // the long horizontal shove back out.
  const right = { x: 90, y: 95, w: 200, h: 50 };
  assert.deepEqual(minTranslation(right, obstacle), { dx: 0, dy: 100 + DISPLACE_GUTTER - 95 });
});

test('minTranslation: ties prefer right/down (natural canvas growth)', () => {
  const obstacle = { x: 0, y: 0, w: 100, h: 100 };
  // Dead-center overlap: every direction costs the same magnitude.
  const centered = { x: 25, y: 25, w: 50, h: 50 };
  const t = minTranslation(centered, obstacle);
  assert.ok(t.dx > 0 && t.dy === 0, 'pushes right on a tie');
});

test('computeDisplacement: no overlap, no moves', () => {
  const nodes = [rect('a', 400, 0), rect('b', 0, 400)];
  assert.deepEqual(computeDisplacement(nodes, { x: 0, y: 0, w: 200, h: 100 }), []);
});

test('computeDisplacement: one overlap moves once, by exactly MTV + gutter', () => {
  const nodes = [rect('a', 150, 10, 100, 60), rect('far', 800, 800)];
  const target = { x: 0, y: 0, w: 200, h: 100 };
  const moves = computeDisplacement(nodes, target);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].id, 'a');
  assert.deepEqual(moves[0].from, { x: 150, y: 10 });
  assert.deepEqual(moves[0].to, { x: 200 + DISPLACE_GUTTER, y: 10 });
  // And the result really is clear of the target.
  assert.equal(rectsOverlap({ x: moves[0].to.x, y: moves[0].to.y, w: 100, h: 60 }, target), false);
});

test('computeDisplacement: cascades — a shifted node clears what IT now overlaps', () => {
  // 'a' sits on the target; 'b' sits exactly where 'a' will land.
  const target = { x: 0, y: 0, w: 200, h: 100 };
  const aLanding = 200 + DISPLACE_GUTTER;
  const nodes = [
    rect('a', 150, 10, 100, 60),
    rect('b', aLanding, 10, 100, 60),
    rect('c', 900, 900)
  ];
  const moves = computeDisplacement(nodes, target);
  assert.deepEqual(moves.map(m => m.id), ['a', 'b'], 'a first, then b in cascade');
  // b's landing spot is clear of a's landing spot (with the gutter).
  const aTo = moves[0].to, bTo = moves[1].to;
  assert.equal(rectsOverlap({ ...aTo, w: 100, h: 60 }, { ...bTo, w: 100, h: 60 }), false);
  assert.equal(rectsOverlap({ ...bTo, w: 100, h: 60 }, target), false);
});

test('computeDisplacement: records original `from` for exact collapse-restore', () => {
  const target = { x: 0, y: 0, w: 200, h: 100 };
  const nodes = [rect('a', 50, 10), rect('b', 50, 200)];
  // 'b' is clear of the target but in the cascade path of nothing — only 'a' moves.
  const moves = computeDisplacement(nodes, target);
  const a = moves.find(m => m.id === 'a');
  assert.deepEqual(a.from, { x: 50, y: 10 }, 'restore set can put it back exactly');
  assert.equal(moves.some(m => m.id === 'b'), false);
});

test('computeDisplacement: depth cap falls back to plain overlap beyond it', () => {
  // A strict horizontal chain: each node overlaps only its predecessor's
  // landing spot, so each cascade round moves exactly ONE node. Nodes are
  // tall so a vertical push is always the expensive direction.
  const count = MAX_CASCADE_DEPTH + 3;
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push(rect(`n${i}`, 150 + i * 110, 0, 100, 400));
  const target = { x: 0, y: 0, w: 200, h: 400 };
  const moves = computeDisplacement(nodes, target);
  // One wave per depth level (the target round + maxDepth cascade rounds).
  assert.equal(moves.length, MAX_CASCADE_DEPTH + 1,
    `capped: ${moves.length} moves for a ${count}-deep chain`);
  assert.ok(moves.length < count, 'the tail of the chain is left overlapping');
  assert.deepEqual(moves.map(m => m.id), nodes.slice(0, MAX_CASCADE_DEPTH + 1).map(n => n.id));
});

test('computeDisplacement: moved nodes clear BOTH the target and earlier movers', () => {
  // 'a' and 'b' both overlap the target at the same y; after 'a' is pushed
  // right, 'b' must not land on 'a'.
  const target = { x: 0, y: 0, w: 200, h: 100 };
  const nodes = [rect('a', 100, 10, 100, 60), rect('b', 100, 80, 100, 60)];
  const moves = computeDisplacement(nodes, target);
  assert.equal(moves.length, 2);
  const [a, b] = moves;
  assert.equal(rectsOverlap({ ...a.to, w: 100, h: 60 }, { ...b.to, w: 100, h: 60 }), false);
  assert.equal(rectsOverlap({ ...b.to, w: 100, h: 60 }, target), false);
});

test('computeDisplacement: custom gutter and zero-maxDepth are honored', () => {
  const target = { x: 0, y: 0, w: 100, h: 100 };
  const nodes = [rect('a', 50, 10, 100, 60)];
  const moves = computeDisplacement(nodes, target, { gutter: 8 });
  // Cheapest push is right: dx = 100 + 8 - 50 = 58, landing at x = 108.
  assert.deepEqual(moves[0].to, { x: 108, y: 10 });
  const capped = computeDisplacement(
    [rect('a', 50, 10), rect('b', 168, 10)], target, { maxDepth: 0 });
  assert.equal(capped.length, 1, 'no cascade rounds at depth 0');
});
