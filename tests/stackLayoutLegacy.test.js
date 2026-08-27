// Unit tests for the shared layout/validation helpers (src/stackLayout.js):
// cycle detection used by the editor's connection validation, and the layered
// auto-layout used by the editor button and the runner's materializer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wouldCreateCycle, layoutPositions, arrangeForCanvas, fitOrchBox, shrinkOrchBox } from '../src/stackLayout.js';
import { makeFlow, node, edge } from './helpers.js';

test('wouldCreateCycle: rejects self-loops and closing edges, allows forward edges', () => {
  const edges = [edge('a', 'b'), edge('b', 'c')];
  assert.equal(wouldCreateCycle(edges, 'a', 'a'), true);
  assert.equal(wouldCreateCycle(edges, 'c', 'a'), true);  // would close a->b->c->a
  assert.equal(wouldCreateCycle(edges, 'b', 'a'), true);
  assert.equal(wouldCreateCycle(edges, 'a', 'c'), false); // parallel shortcut is fine
  assert.equal(wouldCreateCycle(edges, 'c', 'd'), false);
});

test('layoutPositions: one row per dependency depth, no overlapping positions', () => {
  const flow = makeFlow(
    [node('in', 'input'), node('a', 'aiStep'), node('b', 'aiStep'), node('out', 'output')],
    [edge('in', 'a'), edge('in', 'b'), edge('a', 'out'), edge('b', 'out')]);
  const pos = layoutPositions(flow);
  assert.equal(pos.size, 4);
  assert.ok(pos.get('a').y > pos.get('in').y);
  assert.equal(pos.get('a').y, pos.get('b').y, 'siblings share a row');
  assert.notEqual(pos.get('a').x, pos.get('b').x, 'siblings do not overlap');
  assert.ok(pos.get('out').y > pos.get('a').y);
  const keys = [...pos.values()].map(p => `${p.x},${p.y}`);
  assert.equal(new Set(keys).size, keys.length, 'all positions distinct');
});

test('layoutPositions: depth follows the longest chain, cycles do not hang it', () => {
  const chain = makeFlow(
    [node('a', 'aiStep'), node('b', 'aiStep'), node('c', 'aiStep')],
    [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')]);
  const pos = layoutPositions(chain);
  assert.ok(pos.get('c').y > pos.get('b').y, 'c sits below b despite the a->c shortcut');

  const cyclic = makeFlow(
    [node('x', 'aiStep'), node('y', 'aiStep')],
    [edge('x', 'y'), edge('y', 'x')]);
  const cpos = layoutPositions(cyclic); // must terminate
  assert.equal(cpos.size, 2);
});

test('arrangeForCanvas: parents precede children, boxes paint below free nodes', () => {
  const f = makeFlow(
    [node('free-b', 'aiStep'),
     { id: 'kid', type: 'aiStep', parentId: 'orch', position: { x: 22, y: 58 }, data: {} },
     node('orch', 'orchestrator'),
     node('free-a', 'aiStep')],
    []);
  const ordered = arrangeForCanvas(f.nodes);
  assert.deepEqual(ordered.map(n => n.id), ['orch', 'kid', 'free-b', 'free-a']);
  assert.ok(ordered.findIndex(n => n.id === 'orch') < ordered.findIndex(n => n.id === 'kid'),
    'React Flow requires the parent first');
  assert.ok(ordered.findIndex(n => n.id === 'kid') < ordered.findIndex(n => n.id === 'free-a'),
    'children still paint above free nodes later in the array');
  // A child with a missing parent degrades to top level, not a vanished node.
  const orphan = arrangeForCanvas([{ id: 'o', type: 'aiStep', parentId: 'ghost', position: { x: 0, y: 0 }, data: {} }]);
  assert.equal(orphan.length, 1);
});

test('fitOrchBox / shrinkOrchBox: boxes fit their children, never below default', () => {
  assert.deepEqual(fitOrchBox([]), { w: 360, h: 200 });
  const kids = [
    { id: 'a', position: { x: 22, y: 58 } },
    { id: 'b', position: { x: 500, y: 300 } }
  ];
  const box = fitOrchBox(kids);
  assert.ok(box.w >= 500 + 230 + 22, 'wide enough for the rightmost child + card + padding');
  assert.ok(box.h >= 300 + 76 + 62, 'tall enough for the lowest child + card + ports row');
  // fit never shrinks below the current box; shrink does.
  const grown = fitOrchBox(kids, { w: 900, h: 700 });
  assert.equal(grown.w, 900);
  const shrunk = shrinkOrchBox([{ id: 'a', position: { x: 22, y: 58 } }]);
  assert.deepEqual(shrunk, { w: 360, h: 200 });
});
