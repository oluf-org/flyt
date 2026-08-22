// Editing is containment (t-0075): a drag is a command, and an agent's edit is
// the same edit.
//
// The claim in D63 is "one code path, two callers", and the test that means it
// is the last one here: drive the same move as a person and as a model, and
// assert the two are indistinguishable — same tree, same record, same event.
// Everything above it is the drag arithmetic that has to be right first, and it
// is all pure, so none of it needs a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKernel, flytApi, flytBlocks, registerStackCommands, parseStack, layout, walk,
} from '#kernel';
import { editorGeometry } from '../src/v2/blockGeometry.js';
import {
  axisOf, containerAt, slotAt, slotOfNode, isNoop, isAncestor, inverseOf, dragTo,
} from '../src/v2/stackEditing.js';

const SOURCE = `version: 2
id: demo
blocks:
  - id: first
    use: demo:work
  - id: second
    use: demo:work
  - id: fan
    kind: parallel
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: demo:work
      - id: right
        kind: sequence
        blocks:
          - id: ra
            use: demo:work
`;

const block = use => ({
  use, title: 'Work', description: '', category: 'work',
  settings: { type: 'object' }, ceiling: null,
  async execute() { return { status: 'done', output: '' }; },
});

/** The middle of a node's box, in the px space the editor drops into. */
const centre = (geometry, id) => {
  const { box } = geometry.boxes[id];
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

async function bootEditing() {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin({
    name: 'demo-blocks', inject: ['blocks'],
    apply(ctx) { ctx.blocks.register(block('demo:work')); },
  });

  let root = parseStack(SOURCE).root;
  const seen = [];
  kernel.ctx.on('commands/invoke', record => seen.push(record));
  registerStackCommands(kernel.ctx, { get: () => root, set: next => { root = next; } });

  return {
    kernel, seen,
    get stack() { return { id: 'demo', root }; },
    get geometry() { return editorGeometry(root, kernel.ctx.blocks); },
  };
}

test('a container lays its children out along one axis, and the editor knows which', () => {
  const stack = parseStack(SOURCE);
  const geometry = editorGeometry(stack.root, null);
  assert.equal(axisOf(geometry.boxes[stack.root.id].node), 'y', 'a sequence stacks');
  assert.equal(axisOf(geometry.boxes.fan.node), 'x', 'a parallel runs across');
});

test('the container under a point is the innermost one', () => {
  const stack = parseStack(SOURCE);
  const geometry = editorGeometry(stack.root, null);
  // A point on a lane's block is inside that lane, inside the parallel, inside
  // the root. The lane is the one you meant.
  assert.equal(containerAt(geometry, centre(geometry, 'la')), 'left');
  assert.equal(containerAt(geometry, centre(geometry, 'ra')), 'right');
  assert.equal(containerAt(geometry, centre(geometry, 'first')), stack.root.id);
  assert.equal(containerAt(geometry, { x: -50, y: -50 }), null, 'outside the stack is nowhere');
});

test('a drop picks a slot, and the index comes from the midpoints', () => {
  const stack = parseStack(SOURCE);
  const geometry = editorGeometry(stack.root, null);
  const rootId = stack.root.id;
  const firstBox = geometry.boxes.first.box;

  // Above the first block's midpoint: before it.
  assert.deepEqual(slotAt(geometry, { x: firstBox.x + 10, y: firstBox.y + 2 }),
    { container: rootId, index: 0 });
  // Below it: after it.
  assert.deepEqual(slotAt(geometry, { x: firstBox.x + 10, y: firstBox.y + firstBox.height - 2 }),
    { container: rootId, index: 1 });
});

test('the node being dragged does not count itself when the index is worked out', () => {
  const stack = parseStack(SOURCE);
  const geometry = editorGeometry(stack.root, null);
  const rootId = stack.root.id;
  const secondBox = geometry.boxes.second.box;
  const belowSecond = { x: secondBox.x + 10, y: secondBox.y + secondBox.height - 2 };

  assert.deepEqual(slotAt(geometry, belowSecond), { container: rootId, index: 2 });
  assert.deepEqual(slotAt(geometry, belowSecond, 'first'), { container: rootId, index: 1 },
    'with `first` lifted out, the same point is one place earlier');
});

test('a drop where the node already is changes nothing', () => {
  const from = { container: 'root', index: 1 };
  assert.equal(isNoop(from, { container: 'root', index: 1 }), true);
  assert.equal(isNoop(from, { container: 'root', index: 2 }), true,
    'the gap it is occupying, entered from above, is the same position');
  assert.equal(isNoop(from, { container: 'root', index: 0 }), false);
  assert.equal(isNoop(from, { container: 'left', index: 1 }), false);
});

test('a container cannot be dropped inside itself, and the drag says so', async () => {
  const boot = await bootEditing();
  const geometry = boot.geometry;
  assert.equal(isAncestor(geometry, 'fan', 'left'), true);
  assert.equal(isAncestor(geometry, 'fan', 'fan'), true);
  assert.equal(isAncestor(geometry, 'left', 'fan'), false);

  const drag = dragTo(boot.stack, boot.kernel.ctx.blocks, 'fan', centre(geometry, 'la'));
  assert.equal(drag.command, null);
  assert.match(drag.refusal, /cannot be moved inside itself/);
  await boot.kernel.dispose();
});

test('a drag produces the command, and the command produces a tree the parser accepts', async () => {
  const boot = await bootEditing();
  const before = boot.geometry;
  // Drag `first` into the left lane.
  const drag = dragTo(boot.stack, boot.kernel.ctx.blocks, 'first', centre(before, 'la'));
  assert.deepEqual(drag.command.name, 'stack:move-block');
  assert.equal(drag.command.args.to.container, 'left');

  await boot.kernel.ctx.commands.invoke(drag.command.name, drag.command.args, 'human');

  const after = boot.geometry;
  assert.deepEqual(after.boxes.left.node.children.map(c => c.id).sort(), ['first', 'la']);
  // And what the editor would save is what the parser reads back.
  const ids = [...walk(boot.stack.root)].map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'no id appeared twice');
  assert.ok(layout(boot.stack.root).boxes.first, 'the moved block still has geometry');
  await boot.kernel.dispose();
});

test('an edit refused by the tree reads as a refusal and leaves the stack as it was', async () => {
  const boot = await bootEditing();
  const beforeIds = [...walk(boot.stack.root)].map(n => n.id);
  await assert.rejects(
    () => boot.kernel.ctx.commands.invoke('stack:move-block',
      { nodeId: 'fan', to: { container: 'left', index: 0 } }, 'human'));
  assert.deepEqual([...walk(boot.stack.root)].map(n => n.id), beforeIds,
    'a refused edit is not a partial one');
  // And the refusal is on the event, which is what the editor renders.
  assert.match(boot.seen.at(-1).error, /descendant|itself/i);
  await boot.kernel.dispose();
});

test('undo is the inverse command, not a saved copy of the tree', async () => {
  const boot = await bootEditing();
  const from = slotOfNode(boot.geometry, 'first');
  await boot.kernel.ctx.commands.invoke('stack:move-block',
    { nodeId: 'first', to: { container: 'left', index: 0 } }, 'human');
  assert.equal(slotOfNode(boot.geometry, 'first').container, 'left');

  const undo = inverseOf(boot.seen.at(-1).result);
  assert.equal(undo.name, 'stack:move-block');
  await boot.kernel.ctx.commands.invoke(undo.name, undo.args, 'human');
  assert.deepEqual(slotOfNode(boot.geometry, 'first'), from, 'back where it started');

  // A remove offers no inverse rather than a wrong one: the subtree it took is
  // not in the record, so nothing here could put it back.
  assert.equal(inverseOf({ kind: 'remove', nodeId: 'x', from: { container: 'r', index: 0 }, to: null }), null);
  assert.equal(inverseOf({ kind: 'insert', nodeId: 'x', from: null, to: { container: 'r', index: 0 } }).name,
    'stack:remove-block');
  await boot.kernel.dispose();
});

test('an agent’s edit and a person’s are indistinguishable, except for who did it', async () => {
  // D63, as an assertion. Same command, same arguments, same resulting tree,
  // same event shape — and the only difference is the field that exists to
  // record the difference.
  const byHuman = await bootEditing();
  const byAgent = await bootEditing();
  const args = { nodeId: 'first', to: { container: 'left', index: 0 } };

  await byHuman.kernel.ctx.commands.invoke('stack:move-block', args, 'human');
  await byAgent.kernel.ctx.commands.invoke('stack:move-block', args, 'agent');

  const shape = boot => [...walk(boot.stack.root)].map(n => `${n.kind}:${n.id}`);
  assert.deepEqual(shape(byHuman), shape(byAgent), 'the same tree, arrived at two ways');

  const h = byHuman.seen.at(-1);
  const a = byAgent.seen.at(-1);
  assert.deepEqual(h.result, a.result, 'the same record, which is what the editor animates');
  assert.deepEqual(h.args, a.args);
  assert.equal(h.caller, 'human');
  assert.equal(a.caller, 'agent');
  assert.notEqual(h.caller, a.caller, 'recorded, never inferred');

  await byHuman.kernel.dispose();
  await byAgent.kernel.dispose();
});
