// Editing a stack means editing the tree, and nothing else.
//
// There is no edge list and no stored layout to keep in step (D59), so a block
// moves by moving in the tree. That is what lets one set of operations serve a
// person dragging and a model calling a command (D63) — and it is why the
// interesting tests here are the refusals: an edit may not produce a stack the
// parser would reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStack, insertNode, moveNode, removeNode, configureBlock, walk, isContainer,
} from '#kernel';

const stack = body => parseStack(`version: 2\nid: demo\n${body}`);

const FAN = () => stack(`blocks:
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
          - id: rb
            use: work
  - id: after
    use: work
`).root;

const block = id => ({ kind: 'block', id, use: 'work', title: null, config: {}, position: { line: 0, path: '' } });
const idsIn = (root, container) => [...walk(root)].find(n => n.id === container).children.map(c => c.id);
const elseIdsIn = (root, container) => ([...walk(root)].find(n => n.id === container).else ?? []).map(c => c.id);

function refusal(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected a refusal, and the edit went through');
}

test('an insert puts a block where it was asked for, and says so', () => {
  const root = FAN();
  const { root: next, change } = insertNode(root, block('extra'), { container: 'left', index: 1 });
  assert.deepEqual(idsIn(next, 'left'), ['la', 'extra', 'lb']);
  assert.deepEqual(change, { kind: 'insert', nodeId: 'extra', from: null, to: { container: 'left', index: 1 } });
  // Appending is an index of exactly the child count.
  assert.deepEqual(idsIn(insertNode(root, block('x'), { container: 'left', index: 2 }).root, 'left'),
    ['la', 'lb', 'x']);
});

test('the tree handed in is never touched', () => {
  // An edit that mutated its input would make undo a copy the caller had to
  // remember to take.
  const root = FAN();
  const before = JSON.stringify(root);
  insertNode(root, block('extra'), { container: 'left', index: 0 });
  removeNode(root, 'la');
  moveNode(root, 'la', { container: 'right', index: 0 });
  assert.equal(JSON.stringify(root), before);

  // ...so the same tree edited twice gives the same answer.
  assert.deepEqual(
    removeNode(root, 'la').root,
    removeNode(root, 'la').root);
});

test('an id already in the stack is refused, and so is a whole subtree carrying one', () => {
  const root = FAN();
  assert.match(refusal(() => insertNode(root, block('la'), { container: 'right', index: 0 })).message,
    /the id "la" is already in this stack/);

  const lane = { ...[...walk(root)].find(n => n.id === 'left') };
  assert.match(refusal(() => insertNode(root, lane, { container: 'right', index: 0 })).message,
    /the id "left" is already in this stack/);
});

test('a position that names nothing is refused, and nothing changes', () => {
  const root = FAN();
  assert.match(refusal(() => insertNode(root, block('x'), { container: 'nowhere', index: 0 })).message,
    /there is no "nowhere" in this stack/);
  assert.match(refusal(() => insertNode(root, block('x'), { container: 'before', index: 0 })).message,
    /"before" is a block, and a block holds nothing/);
  assert.match(refusal(() => insertNode(root, block('x'), { container: 'left', index: 3 })).message,
    /"left" has 2 children, so an index of 3 names no position/);
  assert.match(refusal(() => insertNode(root, block('x'), { container: 'left', index: -1 })).message,
    /names no position/);
});

test('a move reorders within a container, reading the index against what you were looking at', () => {
  const root = FAN();
  // [la, lb] with `la` dropped in the gap after `lb` — index 2 in the tree as
  // it stands, which is index 1 once `la` is lifted out.
  assert.deepEqual(idsIn(moveNode(root, 'la', { container: 'left', index: 2 }).root, 'left'), ['lb', 'la']);
  assert.deepEqual(idsIn(moveNode(root, 'lb', { container: 'left', index: 0 }).root, 'left'), ['lb', 'la']);
});

test('a move across containers takes the node with it', () => {
  const root = FAN();
  const { root: next, change } = moveNode(root, 'la', { container: 'right', index: 1 });
  assert.deepEqual(idsIn(next, 'left'), ['lb']);
  assert.deepEqual(idsIn(next, 'right'), ['ra', 'la', 'rb']);
  assert.deepEqual(change, {
    kind: 'move', nodeId: 'la',
    from: { container: 'left', index: 0 },
    to: { container: 'right', index: 1 },
  });
});

test('If alternate branches are first-class edit slots', () => {
  const root = stack(`blocks:
  - id: gate
    use: work
    outputs:
      - name: decision
        type: boolean
  - id: choose
    kind: if
    predicate:
      source: gate.decision
      operator: is
      literal: true
    body:
      - id: yes
        use: work
    else:
      - id: no-a
        use: work
      - id: no-b
        use: work
`).root;

  const inserted = insertNode(root, block('no-middle'), { container: 'choose', branch: 'else', index: 1 }).root;
  assert.deepEqual(elseIdsIn(inserted, 'choose'), ['no-a', 'no-middle', 'no-b']);
  const reordered = moveNode(inserted, 'no-b', { container: 'choose', branch: 'else', index: 0 }).root;
  assert.deepEqual(elseIdsIn(reordered, 'choose'), ['no-b', 'no-a', 'no-middle']);
  const configured = configureBlock(reordered, 'no-a', { effort: 'low' }).root;
  assert.deepEqual([...walk(configured)].find(node => node.id === 'no-a').config, { effort: 'low' });

  const withoutElse = removeNode(removeNode(reordered, 'no-a').root, 'no-middle').root;
  assert.deepEqual(elseIdsIn(removeNode(withoutElse, 'no-b').root, 'choose'), []);
  assert.match(refusal(() => moveNode(root, 'yes', { container: 'choose', branch: 'else', index: 0 })).message,
    /moving it out would leave a container that cannot run/);
});

test('a drop where it already was is not an error and not a change', () => {
  const root = FAN();
  for (const index of [0, 1]) {
    const { root: next } = moveNode(root, 'la', { container: 'left', index });
    assert.deepEqual(idsIn(next, 'left'), ['la', 'lb'], `index ${index} is where it already is`);
  }
});

test('moving a container into its own descendant is refused by name', () => {
  // The one way containment can be made to lie. A tree with a cycle in it has
  // no order to run in, so there is nothing to derive.
  const root = FAN();
  assert.match(refusal(() => moveNode(root, 'fan', { container: 'left', index: 0 })).message,
    /"left" is inside "fan", so moving it there would put "fan" inside itself/);
  assert.match(refusal(() => moveNode(root, 'fan', { container: 'fan', index: 0 })).message,
    /"fan" cannot be moved inside itself/);
  // A block is not a container, so it cannot contain its own destination.
  assert.deepEqual(idsIn(moveNode(root, 'before', { container: 'left', index: 0 }).root, 'left'),
    ['before', 'la', 'lb']);
});

test('an edit that would empty a container is refused, because the parser refuses one', () => {
  const root = stack(`blocks:
  - id: fan
    kind: parallel
    lanes:
      - id: solo
        kind: sequence
        blocks:
          - id: only
            use: work
      - id: other
        kind: sequence
        blocks:
          - id: another
            use: work
`).root;

  assert.match(refusal(() => removeNode(root, 'only')).message,
    /"only" is the only thing in "solo".*cannot run; remove the container instead/s);
  assert.match(refusal(() => moveNode(root, 'only', { container: 'other', index: 0 })).message,
    /moving it out would leave a container that cannot run/);

  // Removing the container itself is fine — it takes its children with it.
  assert.deepEqual(idsIn(removeNode(root, 'solo').root, 'fan'), ['other']);
});

test('the stack itself is not something an edit can move or remove', () => {
  const root = FAN();
  assert.match(refusal(() => removeNode(root, 'demo')).message, /is the stack itself/);
  assert.match(refusal(() => moveNode(root, 'demo', { container: 'left', index: 0 })).message,
    /is the stack itself/);
  assert.match(refusal(() => removeNode(root, 'ghost')).message, /there is no "ghost" in this stack/);
});

test('configuring replaces a block’s settings whole, and only a block has any', () => {
  const root = FAN();
  const { root: next, change } = configureBlock(root, 'la', { toolCeiling: 'loop', effort: 3 });
  const la = [...walk(next)].find(n => n.id === 'la');
  assert.deepEqual(la.config, { toolCeiling: 'loop', effort: 3 });
  assert.equal(change.kind, 'configure');
  assert.deepEqual(change.from, { container: 'left', index: 0 });

  assert.match(refusal(() => configureBlock(root, 'left', {})).message,
    /"left" is a sequence, and a container has no block settings/);
});

test('every edit leaves a tree the parser would accept', () => {
  // The promise the format is for: there is no arrangement that draws and does
  // not parse, so there must be no edit that produces one either. The check is
  // structural — the same rules parseStack enforces, applied to the result.
  const root = FAN();
  const results = [
    insertNode(root, block('extra'), { container: 'left', index: 1 }).root,
    moveNode(root, 'la', { container: 'right', index: 0 }).root,
    removeNode(root, 'la').root,
    configureBlock(root, 'la', { x: 1 }).root,
  ];
  for (const tree of results) {
    const ids = new Set();
    for (const node of walk(tree)) {
      assert.ok(!ids.has(node.id), `duplicate id ${node.id}`);
      ids.add(node.id);
      if (isContainer(node)) assert.ok(node.children.length > 0, `${node.id} is empty`);
    }
  }
});
