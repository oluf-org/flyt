// Layout is derived from containment, never stored (D59).
//
// The v1 canvas kept a `.layout.json` beside the flow: presentation state that
// could disagree with the graph, and did. The v2 answer is that there is
// nothing to keep — geometry is a function of the tree, so the only way to
// move a block is to move it in the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStack, layout, hits, walk, isContainer, METRICS } from '#kernel';

const stack = body => parseStack(`version: 2\nid: demo\n${body}`);

const SEQUENCE = stack(`blocks:
  - id: first
    use: work
  - id: second
    use: work
  - id: third
    use: work
`);

const FAN = stack(`blocks:
  - id: before
    use: work
  - id: fan
    kind: parallel
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: work
          - id: lb
            use: work
      - id: right
        kind: sequence
        blocks:
          - id: ra
            use: work
`);

test('the same tree laid out twice is the same geometry', () => {
  // The whole reason there is no file to store: a layout that is a function of
  // the tree cannot drift from it, and cannot need migrating.
  assert.deepEqual(layout(FAN.root), layout(FAN.root));
  // And a second parse of the same source lays out identically too.
  assert.deepEqual(
    layout(parseStack(`version: 2\nid: demo\nblocks:\n  - id: a\n    use: work\n`).root),
    layout(parseStack(`version: 2\nid: demo\nblocks:\n  - id: a\n    use: work\n`).root));
});

test('a sequence stacks its children in order, top to bottom', () => {
  const { boxes } = layout(SEQUENCE.root);
  const ys = ['first', 'second', 'third'].map(id => boxes[id].y);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `in order down the page: ${ys.join(', ')}`);
  // And they do not overlap: each starts below where the last one ended.
  assert.ok(boxes.first.y + boxes.first.height <= boxes.second.y);
  assert.ok(boxes.second.y + boxes.second.height <= boxes.third.y);
});

test('a parallel puts its lanes side by side', () => {
  const { boxes } = layout(FAN.root);
  assert.ok(boxes.left.x + boxes.left.width <= boxes.right.x, 'left ends before right begins');
  assert.equal(boxes.left.y, boxes.right.y, 'and they start level, because they start together');

  // The lanes are isolated in the language (D37); the layout says the same
  // thing in geometry — nothing in one lane shares a column with the other.
  assert.ok(boxes.la.x + boxes.la.width <= boxes.ra.x);
});

test('every node has a box, containers included', () => {
  const { boxes } = layout(FAN.root);
  const ids = [...walk(FAN.root)].map(n => n.id);
  assert.deepEqual(Object.keys(boxes).sort(), [...ids].sort());
  // The editor addresses a lane, so a lane needs a rectangle of its own.
  assert.ok(boxes.left.width > 0 && boxes.left.height > 0);
  assert.ok(boxes.demo.width > 0, 'the root is a node too');
});

test('a container encloses every one of its children', () => {
  const { boxes } = layout(FAN.root);
  const encloses = (outer, inner) =>
    inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;

  for (const node of walk(FAN.root)) {
    if (!isContainer(node)) continue;
    for (const child of node.children) {
      assert.ok(encloses(boxes[node.id], boxes[child.id]),
        `${node.id} should enclose ${child.id}: ${JSON.stringify(boxes[node.id])} vs ${JSON.stringify(boxes[child.id])}`);
    }
  }
});

test('the extent is the root box, so a renderer needs nothing else', () => {
  const at = layout(FAN.root);
  assert.equal(at.width, at.boxes.demo.width);
  assert.equal(at.height, at.boxes.demo.height);
  assert.equal(at.boxes.demo.x, 0);
  assert.equal(at.boxes.demo.y, 0);
});

test('a deeper stack is a taller one, and nothing has to be told so', () => {
  const one = layout(stack('blocks:\n  - id: a\n    use: work\n').root);
  const two = layout(stack('blocks:\n  - id: a\n    use: work\n  - id: b\n    use: work\n').root);
  assert.ok(two.height > one.height, 'adding a block makes the stack taller');
  assert.equal(two.width, one.width, 'and not wider');

  const wide = layout(FAN.root);
  assert.ok(wide.width > one.width, 'adding a lane makes it wider');
});

test('metrics are inputs, so a compact view is the same layout at a different scale', () => {
  const normal = layout(SEQUENCE.root);
  const tight = layout(SEQUENCE.root, { gap: 0 });
  assert.ok(tight.height < normal.height);
  assert.equal(tight.boxes.first.height, METRICS.blockHeight, 'the blocks themselves are unchanged');
});

test('a point resolves to the innermost node under it', () => {
  const at = layout(FAN.root);
  const box = at.boxes.la;
  const under = hits(at, box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(under[0], 'la', 'the block, not the lane that holds it');
  assert.deepEqual(under, ['la', 'left', 'fan', 'demo'], 'and its ancestry, outward');

  // A drop in a lane's padding is a drop into the lane.
  assert.equal(hits(at, at.boxes.left.x + 1, at.boxes.left.y + 1)[0], 'left');
  assert.deepEqual(hits(at, -10, -10), [], 'and outside everything is nothing');
});

test('nothing here stores or reads a layout', () => {
  // The point of D59 stated as a check: if a path to a layout file ever
  // appears in this module, the file it names can disagree with the tree.
  const dir = fileURLToPath(new URL('../kernel/src/stack/', import.meta.url));
  for (const name of fs.readdirSync(dir)) {
    // Comments stripped first: these files talk ABOUT the layout file they
    // replaced, and the rule is about what the code does.
    const code = fs.readFileSync(`${dir}${name}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/layout\.json/.test(code), `${name} names a layout file`);
    assert.ok(!/node:fs|readFile|writeFile/.test(code),
      `${name} touches the filesystem; a layout is computed, not loaded`);
  }
});
