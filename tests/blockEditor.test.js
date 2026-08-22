// The block editor (t-0074): a stack drawn from the derived layout, read-only.
//
// The geometry contract lives in src/v2/blockGeometry.js as pure functions so
// it is testable without a browser; BlockEditor.jsx is the thin renderer over
// them. These tests hold that renderer to the contract: boxes come from
// layout() and never from stored position, containment renders as containment,
// a block that names nothing installed draws as missing naming what is
// missing, and an empty stack draws as an empty stack rather than as nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStack, layout, walk, isContainer, MAX_DEPTH, METRICS } from '#kernel';
import {
  LAYOUT_SCALE, renderBox, editorGeometry, blockLabel, blockView,
} from '../src/v2/blockGeometry.js';

// A registry with just enough of BlocksService for the editor: resolve returns
// a definition for what is installed and undefined otherwise.
function registry(installed) {
  const set = new Set(installed);
  return { resolve: use => (set.has(use) ? { use } : undefined) };
}

const stack = body => parseStack(`version: 2\nid: demo\nname: A demo\n${body}`);

const SIMPLE = stack(`blocks:
  - id: gather
    use: work
    title: Gather it
  - id: judge
    use: evaluation
`);

const FAN = stack(`blocks:
  - id: fan
    kind: parallel
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: work
      - id: right
        kind: sequence
        blocks:
          - id: ra
            use: work
`);

test('geometry comes from the derived layout and nothing is stored', () => {
  const at = layout(FAN.root);
  const view = editorGeometry(FAN.root, null);

  // The view is the layout, box for box: same ids, same numbers at scale 1.
  assert.deepEqual(Object.keys(view.boxes).sort(), Object.keys(at.boxes).sort());
  for (const id of Object.keys(at.boxes)) {
    assert.deepEqual(view.boxes[id].box, renderBox(at.boxes[id]));
  }
  // The renderer needs nothing else: the footprint is the root box.
  assert.equal(view.width, at.width);
  assert.equal(view.height, at.height);

  // And the same tree laid out twice is the same geometry (D59): there is no
  // stored layout to drift, so nothing the editor keeps could disagree.
  assert.deepEqual(editorGeometry(FAN.root, null), editorGeometry(FAN.root, null));
});

test('every node has a rendered box, containers included', () => {
  const view = editorGeometry(FAN.root, null);
  const ids = [...walk(FAN.root)].map(n => n.id);
  assert.deepEqual(Object.keys(view.boxes).sort(), [...ids].sort());
  // The editor addresses a lane, so a lane needs a rectangle of its own.
  assert.ok(view.boxes.left.box.width > 0 && view.boxes.left.box.height > 0);
  assert.ok(view.boxes.fan.box.width > 0, 'the root is a node too');
  // Nothing in the view model is a plain store of positions: every box is a
  // function of the tree, so the only way to move a block is to move it in
  // the tree (t-0075, which this phase deliberately does not have).
  for (const box of Object.values(view.boxes)) assert.equal(typeof box.node.id, 'string');
});

test('containment renders as containment, with no edges anywhere', () => {
  const view = editorGeometry(FAN.root, null);
  const encloses = (outer, inner) =>
    inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;

  for (const node of walk(FAN.root)) {
    if (!isContainer(node)) continue;
    for (const child of node.children) {
      assert.ok(encloses(view.boxes[node.id].box, view.boxes[child.id].box),
        `${node.id} should enclose ${child.id}`);
    }
  }
  // A sequence is its children stacked (top to bottom); a parallel is its
  // lanes side by side — the geometry the editor draws is the geometry the
  // kernel lays out, asserted here as one function.
  const at = layout(FAN.root);
  assert.ok(at.boxes.left.x + at.boxes.left.width <= at.boxes.right.x);
  assert.equal(at.boxes.left.y, at.boxes.right.y);
});

test('nesting reads as nesting at every depth the parser allows', () => {
  // MAX_DEPTH counts the root, so MAX_DEPTH - 1 nested containers fit, and the
  // editor draws every one of them as a box that encloses its child.
  const build = containers => {
    let yaml = '';
    for (let i = 0; i < containers; i++) {
      const pad = '  '.repeat(i * 2);
      yaml += `${pad}  - id: c${i}\n${pad}    kind: sequence\n${pad}    blocks:\n`;
    }
    const pad = '  '.repeat(containers * 2);
    yaml += `${pad}  - id: leaf\n${pad}    use: work\n`;
    return stack(`blocks:\n${yaml}`);
  };

  const deepest = build(MAX_DEPTH - 1);
  const view = editorGeometry(deepest.root, null);
  assert.deepEqual(Object.keys(view.boxes).sort(),
    [...walk(deepest.root)].map(n => n.id).sort());

  const encloses = (outer, inner) =>
    inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
  for (const node of walk(deepest.root)) {
    if (!isContainer(node)) continue;
    for (const child of node.children) {
      assert.ok(encloses(view.boxes[node.id].box, view.boxes[child.id].box),
        `depth holds: ${node.id} should enclose ${child.id}`);
    }
  }
});

test('a block naming an uninstalled type draws as missing, naming what is missing', () => {
  const parsed = stack(`blocks:
  - id: gather
    use: work
    title: Gather it
  - id: ghost
    use: never-installed
  - id: judge
    use: evaluation
`);
  const installed = registry(['work', 'evaluation']);
  const view = editorGeometry(parsed.root, installed);

  // Missing is per-block, read from the registry through missingBlocks().
  assert.equal(view.boxes.gather.missing, false);
  assert.equal(view.boxes.judge.missing, false);
  assert.equal(view.boxes.ghost.missing, true);

  // And it says which use is missing — the label that names the absent block.
  assert.deepEqual(blockLabel(parsed.root.children[1]), { title: 'never-installed', use: 'never-installed' });
  assert.deepEqual(blockView(parsed.root.children[1], installed.resolve),
    { title: 'never-installed', use: 'never-installed', missing: true });
  // A missing block never draws as a normal block: the view distinguishes them.
  assert.equal(view.boxes.ghost.missing, true);
  assert.equal(view.boxes.gather.missing, false);

  // With no registry at all, every block draws as missing — it cannot vanish
  // into "looks normal", and it cannot vanish outright (t-0074's promise).
  const noRegistry = editorGeometry(parsed.root, null);
  assert.equal(noRegistry.boxes.gather.missing, true);
  assert.equal(noRegistry.boxes.ghost.missing, true);
  assert.ok(view.boxes.ghost.box.width > 0 && view.boxes.ghost.box.height > 0);
});

test('an empty stack draws as an empty stack rather than as nothing', () => {
  // The parser refuses an empty stack outright, so the editor's other caller —
  // a launcher transitioning to a fresh stack — has no root to lay out. The
  // renderer answers with an explicit empty state, not nothing. The component
  // owns that branch, and the test holds it to the promise by reading the
  // source: at least one visible element is rendered for an absent root.
  const file = fileURLToPath(new URL('../src/v2/BlockEditor.jsx', import.meta.url));
  const srcText = fs.readFileSync(file, 'utf8');
  assert.match(srcText, /if \(!stack\?\.root\)/,
    'an absent root is handled, not rendered as nothing');
  assert.match(srcText, /block-editor-empty/,
    'and the empty stack is a visible element, not an empty fragment');
});

test('nothing about position is stored or read', () => {
  // The point of D59 stated as a check: if a path to a layout file ever
  // appears in this view, the file it names can disagree with the tree.
  const dir = fileURLToPath(new URL('../src/v2/', import.meta.url));
  for (const name of ['BlockEditor.jsx', 'blockGeometry.js', 'blockEditorStyles.css']) {
    const code = fs.readFileSync(`${dir}${name}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/layout\.json/.test(code), `${name} names a layout file`);
  }
  // And the editor never ships its own position: the only boxes in the view
  // come from the kernel's layout function, asserted by construction above.
});

test('the editor draws the root as the container the parser made it', () => {
  // The root is a sequence whatever else the stack holds, so the editor has
  // one shape to lay out rather than two.
  const view = editorGeometry(SIMPLE.root, registry(['work', 'evaluation']));
  assert.equal(view.boxes.demo.node.kind, 'sequence');
  assert.ok(view.boxes.demo.box.width > 0 && view.boxes.demo.box.height > 0);
  // Its children are stacked in order, top to bottom.
  const ys = ['gather', 'judge'].map(id => view.boxes[id].box.y);
  assert.ok(ys[0] < ys[1]);
});

test('scale is a renderer choice, not a second layout', () => {
  // Metrics are inputs to layout(); scale maps the result to pixels. A compact
  // view or a zoomed one is the same geometry at a different scale, so there
  // is still nothing to store.
  const at = layout(SIMPLE.root);
  const view = editorGeometry(SIMPLE.root, null, 2);
  assert.equal(view.width, at.width * 2);
  assert.equal(view.boxes.gather.box.x, at.boxes.gather.x * 2);
  assert.equal(view.boxes.gather.box.height, METRICS.blockHeight * 2);
  // A derived layout at scale 1 is what the editor draws by default.
  assert.equal(LAYOUT_SCALE, 1);
  assert.deepEqual(renderBox(at.boxes.gather), renderBox(at.boxes.gather, 1));
  assert.deepEqual(renderBox(at.boxes.gather, 2), view.boxes.gather.box);
});