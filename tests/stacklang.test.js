// The stack format: containment parsed, Sequence and Parallel only.
//
// Containment replaces edges, so this tree IS the graph — there is no edge
// list to disagree with the nodes and no layout file to disagree with both
// (D59). What this file mostly tests is the second half of that promise: that
// an arrangement which parses is one that can run, and one that cannot is
// refused with somewhere to look.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStack, MAX_DEPTH, walk, isContainer } from '#kernel';

const stack = body => `version: 2\nid: demo\nname: A demo\n${body}`;

// `assert.throws` returns undefined, and every refusal here is judged by what
// it SAYS. A refusal with nowhere to look is the defect this format exists to
// remove, so the message is the assertion.
function refusal(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected a refusal, and the stack parsed instead');
}

const SIMPLE = stack(`blocks:
  - id: gather
    use: work
    title: Gather it
    config:
      toolCeiling: read-only
  - id: judge
    use: evaluation
`);

test('a nested blocks tree parses, and the tree is the graph', () => {
  const parsed = parseStack(SIMPLE);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.id, 'demo');
  assert.equal(parsed.name, 'A demo');

  // The root is a sequence whatever else the stack holds, so there is one
  // shape to lay out rather than two.
  assert.equal(parsed.root.kind, 'sequence');
  assert.deepEqual(parsed.root.children.map(c => c.id), ['gather', 'judge']);
  assert.equal(parsed.root.children[0].kind, 'block');
  assert.equal(parsed.root.children[0].use, 'work');
  assert.equal(parsed.root.children[0].title, 'Gather it');
  assert.deepEqual(parsed.root.children[0].config, { toolCeiling: 'read-only' });

  // And nothing else: no edge list, and nowhere for a layout to be stored.
  assert.equal(parsed.flow, undefined);
  assert.equal(parsed.edges, undefined);
  assert.equal(parsed.layout, undefined);
});

test('a parallel holds lanes side by side, bounded', () => {
  const parsed = parseStack(stack(`blocks:
  - id: fan
    kind: parallel
    maxParallel: 2
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: a
            use: work
      - id: right
        kind: sequence
        blocks:
          - id: b
            use: work
`));
  const fan = parsed.root.children[0];
  assert.equal(fan.kind, 'parallel');
  assert.equal(fan.maxParallel, 2);
  assert.deepEqual(fan.children.map(c => c.id), ['left', 'right']);
  assert.deepEqual([...walk(parsed.root)].map(n => n.id), ['demo', 'fan', 'left', 'a', 'right', 'b']);
});

test('a parallel with no bound says so, rather than defaulting quietly', () => {
  const parsed = parseStack(stack(`blocks:
  - id: fan
    kind: parallel
    lanes:
      - id: only
        use: work
`));
  assert.equal(parsed.root.children[0].maxParallel, null);

  const err = refusal(() => parseStack(stack(`blocks:
  - id: fan
    kind: parallel
    maxParallel: 0
    lanes:
      - id: only
        use: work
`)));
  assert.match(err.message, /"maxParallel" must be a whole number of at least 1/);
});

test('a container this phase has not built is refused by name, with the phase that brings it', () => {
  for (const [kind, called] of [['repeat', 'Repeat N'], ['for-each', 'For each'], ['until', 'Until'], ['if', 'If']]) {
    const err = refusal(() => parseStack(stack(`blocks:
  - id: loop
    kind: ${kind}
    blocks:
      - id: a
        use: work
`)));
    assert.match(err.message, new RegExp(`"${called}" is not built yet`),
      `${kind} should be refused by the name a person knows it by`);
    assert.match(err.message, /Phase 3 \(t-0038\)/, 'and should say where it went');
    assert.match(err.message, /sequence and parallel/, 'and what there is instead');
  }
});

test('a container nobody planned is refused too, without pretending to know it', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: weird
    kind: fanout
    blocks:
      - id: a
        use: work
`)));
  assert.match(err.message, /"fanout" is not a container/);
  assert.ok(!/Phase 3/.test(err.message), 'nothing invented about where it is coming from');
});

test('a duplicate id is refused, naming where the first one is', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: work
    use: work
  - id: work
    use: evaluation
`)));
  assert.match(err.message, /the id "work" is used twice/);
  assert.match(err.message, /once at blocks\[0\]/, 'the first is named');
  assert.match(err.message, /line 5/, 'and pointed at');
  assert.equal(err.path, 'blocks[1]', 'the path is the second');
});

test('an id that collides with the stack itself is caught, because the root is a node too', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: demo
    use: work
`)));
  assert.match(err.message, /the id "demo" is used twice/);
});

test('a node with no id is refused, and says so without inventing a line', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - use: work
`)));
  assert.match(err.message, /this node has no id/);
  assert.equal(err.line, 0, 'there is nothing to point at when the identity is what is missing');
  assert.equal(err.path, 'blocks[0]');
});

test('an id nothing can address is refused', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: "a block"
    use: work
`)));
  assert.match(err.message, /is not a usable id/);
});

test('a container with nothing in it cannot run, and does not parse', () => {
  for (const body of [
    'blocks:\n  - id: empty\n    kind: sequence\n    blocks: []\n',
    'blocks:\n  - id: empty\n    kind: parallel\n    lanes: []\n',
  ]) {
    assert.match(refusal(() => parseStack(stack(body))).message,
      /a container with nothing in it cannot run/);
  }
  assert.match(refusal(() => parseStack(stack('blocks: []\n'))).message,
    /a stack needs a "blocks" list with something in it/);
});

test('a container without a kind is refused rather than guessed at', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: maybe
    blocks:
      - id: a
        use: work
`)));
  assert.match(err.message, /a container needs "kind: sequence" or "kind: parallel"/);
});

test('a block needs a use, and does not take a kind', () => {
  assert.match(refusal(() => parseStack(stack('blocks:\n  - id: a\n'))).message,
    /a block needs "use"/);
  assert.match(
    refusal(() => parseStack(stack('blocks:\n  - id: a\n    kind: block\n    use: work\n'))).message,
    /a block is written without a "kind"/);
});

test('a misspelled key is a typo, and is told which keys there are', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: a
    use: work
    instructions: do the thing
`)));
  assert.match(err.message, /a block does not take "instructions"/);
  assert.match(err.message, /it takes id, use, title, config/,
    'block settings go in config, and the error should be enough to work that out');
});

test('nesting past the cap is refused, and the error states the cap', () => {
  // MAX_DEPTH counts the root, so MAX_DEPTH - 1 nested containers fit under it
  // and one more does not.
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

  assert.ok(parseStack(build(MAX_DEPTH - 1)), `${MAX_DEPTH - 1} containers under the root fit`);
  const err = refusal(() => parseStack(build(MAX_DEPTH)));
  assert.match(err.message, new RegExp(`containers nest at most ${MAX_DEPTH} deep`));
});

test('a version 1 flow is not read here, and says where it is read', () => {
  const err = refusal(() => parseStack('version: 1\nid: x\nnodes:\n  a:\n    use: work\n'));
  assert.match(err.message, /version 1 flow, not a stack/);
  assert.match(err.message, /migration path/);
});

test('a stack takes its id from the filename when the document does not name one', () => {
  assert.equal(parseStack('version: 2\nblocks:\n  - id: a\n    use: work\n', 'from-the-file').id, 'from-the-file');
  assert.match(
    refusal(() => parseStack('version: 2\nblocks:\n  - id: a\n    use: work\n')).message,
    /a stack needs an "id"/);
});

test('a block config is carried, not interpreted', () => {
  // What a block's settings mean is the block's business. A parser that
  // validated them would have to be taught every plugin ever installed.
  const parsed = parseStack(stack(`blocks:
  - id: a
    use: whatever-a-plugin-called-it
    config:
      anything: true
      nested:
        deeper: 3
`));
  assert.deepEqual(parsed.root.children[0].config, { anything: true, nested: { deeper: 3 } });
});

test('every node reports where it came from', () => {
  const parsed = parseStack(SIMPLE);
  const gather = parsed.root.children[0];
  assert.equal(gather.position.path, 'blocks[0]');
  assert.equal(gather.position.line, 5, 'the line `id: gather` is on');
});

test('walk yields parents before children, and isContainer tells them apart', () => {
  const parsed = parseStack(SIMPLE);
  const nodes = [...walk(parsed.root)];
  assert.deepEqual(nodes.filter(isContainer).map(n => n.id), ['demo']);
  assert.deepEqual(nodes.filter(n => !isContainer(n)).map(n => n.id), ['gather', 'judge']);
});

test('nothing under core/ imports the stack parser', () => {
  // core/v2.js is the only door into the v2 tree and bootKernel() is the only
  // import of it (D62). A static reach for the parser from core/ would load
  // v2 on startup whatever the flag says.
  const dir = fileURLToPath(new URL('../core/', import.meta.url));
  const offenders = [];
  const scan = at => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = `${at}${entry.name}`;
      if (entry.isDirectory()) { scan(`${full}/`); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/from\s+['"]#kernel/.test(source) || /parseStack/.test(source)) offenders.push(full);
    }
  };
  scan(dir);
  assert.deepEqual(offenders, []);
});
