// The stack format: containment parsed, Sequence, Parallel and Repeat.
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
import { parseStack, MAX_DEPTH, MAX_EXPANSION, MAX_FOR_EACH, MAX_REPEAT, MAX_UNTIL, PLANNED_KINDS, CONTAINER_KINDS, IF_OPERATORS, boundStack, walk, isContainer } from '#kernel';

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

test('a repeat parses into a repeat node with a literal count and a body', () => {
  const parsed = parseStack(stack(`blocks:
  - id: loop
    kind: repeat
    count: 3
    body:
      - id: a
        use: work
`));
  const loop = parsed.root.children[0];
  assert.equal(loop.kind, 'repeat');
  assert.equal(loop.count, 3);
  assert.deepEqual(loop.children.map(c => c.id), ['a']);
});

test('a repeat count must be a literal whole number within the cap, and a missing body is a refusal', () => {
  const cases = [
    // missing count
    'blocks:\n  - id: loop\n    kind: repeat\n    body:\n      - id: a\n        use: work\n',
    // non-literal count
    'blocks:\n  - id: loop\n    kind: repeat\n    count: later\n    body:\n      - id: a\n        use: work\n',
    // non-positive count
    'blocks:\n  - id: loop\n    kind: repeat\n    count: 0\n    body:\n      - id: a\n        use: work\n',
    // non-integer count
    'blocks:\n  - id: loop\n    kind: repeat\n    count: 1.5\n    body:\n      - id: a\n        use: work\n',
    // over the cap
    'blocks:\n  - id: loop\n    kind: repeat\n    count: 65\n    body:\n      - id: a\n        use: work\n',
    // missing body
    'blocks:\n  - id: loop\n    kind: repeat\n    count: 2\n',
  ];
  for (const body of cases) {
    const err = refusal(() => parseStack(stack(body)));
    assert.match(err.message, /repeat/, 'names the container');
    assert.equal(err.path, 'blocks[0]', 'the refusal carries the path');
  }
});

test('nothing is left in the planned register, and the mechanism still stands', () => {
  // Phase 3 built all four containers it held, so PLANNED_KINDS is empty. The
  // mechanism is what mattered and is kept: a kind that is named but not built
  // is refused BY NAME with the phase that brings it, so somebody hand-writing
  // a stack learns the boundary from the error rather than from a plan.
  assert.deepEqual(Object.keys(PLANNED_KINDS), []);
  const err = refusal(() => parseStack(stack(`blocks:
  - id: weird
    kind: fanout
    body:
      - id: a
        use: demo:work
`)));
  assert.match(err.message, /"fanout" is not a container/);
  assert.match(err.message, /sequence and parallel and repeat and if and foreach and until/,
    'and every kind there now is');
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
    'blocks:\n  - id: empty\n    kind: repeat\n    count: 2\n    body: []\n',
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
  assert.match(err.message, /a container needs "kind: sequence", "kind: parallel", "kind: repeat", "kind: if", "kind: foreach" or "kind: until"/);
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

test('total block count and worst-case expansion are computed over the whole tree', () => {
  // A repeat body of two blocks run twice: 2 authored blocks, 4 executions.
  const parsed = parseStack(stack(`blocks:
  - id: loop
    kind: repeat
    count: 2
    body:
      - id: a
        use: work
      - id: b
        use: work
`));
  assert.deepEqual(boundStack(parsed.root), { blocks: 2, expansion: 4 });

  // A parallel lane beside the repeat counts every lane in the expansion.
  const both = parseStack(stack(`blocks:
  - id: loop
    kind: repeat
    count: 2
    body:
      - id: a
        use: work
  - id: fan
    kind: parallel
    lanes:
      - id: la
        use: work
      - id: lb
        use: work
`));
  assert.deepEqual(boundStack(both.root), { blocks: 3, expansion: 4 });
});

test('a stack over the expansion cap is refused with the cap and its own worst case', () => {
  // One repeat of 2 blocks run 300 times: 2 authored blocks, 600 executions.
  const err = refusal(() => parseStack(stack(`blocks:
  - id: loop
    kind: repeat
    count: 300
    body:
      - id: a
        use: work
      - id: b
        use: work
`)));
  assert.match(err.message, new RegExp(String(MAX_EXPANSION)), 'names the cap');
  assert.match(err.message, /600/, 'names its own worst case');
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

// --- If: a predicate that is not an expression (t-0095) --------------------
//
// The refusals ARE the feature. D56 widened the GOALS boundary exactly as far
// as source / operator / literal over declared fields and no further, so what
// matters most here is what will not parse: a combination inside a combination,
// an operator nobody chose, and a source naming a field no upstream block
// promised. The last is deliberate leverage — adding a conditional forces the
// block above it to have a real output contract, which is the point of the rule
// rather than a side effect of it.

const IF_STACK = `blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
      - name: verdict
        type: string
  - id: gate
    kind: if
    predicate:
      source: judge.score
      operator: "<"
      literal: 7
    body:
      - id: redo
        use: demo:work
    else:
      - id: ship
        use: demo:work
`;

test('an if parses with a body, an else, and a flat predicate', () => {
  const gate = parseStack(stack(IF_STACK)).root.children[1];
  assert.equal(gate.kind, 'if');
  assert.deepEqual(gate.predicate, { source: 'judge.score', operator: '<', literal: 7 });
  assert.deepEqual(gate.children.map(c => c.id), ['redo']);
  assert.deepEqual(gate.else.map(c => c.id), ['ship']);
});

test('an if with no else says so, rather than pretending to an empty branch', () => {
  const gate = parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: verdict
        type: string
  - id: gate
    kind: if
    predicate:
      source: judge.verdict
      operator: is
      literal: failed
    body:
      - id: redo
        use: demo:work
`)).root.children[1];
  assert.equal(gate.else, null, 'null is "pass through", which is not the same as an empty branch');
});

test('a predicate naming a field the block never declared says which field, which block, and what it does declare', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
  - id: gate
    kind: if
    predicate:
      source: judge.confidence
      operator: is
      literal: high
    body:
      - id: redo
        use: demo:work
`)));
  assert.match(err.message, /field "confidence" on block "judge"/);
  assert.match(err.message, /"judge" declares score/);
  assert.match(err.message, /predicate/, 'and where in the file to look');
});

test('a predicate naming a block that declares nothing points at the blocks that do', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
  - id: plain
    use: demo:work
  - id: gate
    kind: if
    predicate:
      source: plain.anything
      operator: is
      literal: x
    body:
      - id: redo
        use: demo:work
`)));
  assert.match(err.message, /"plain" declares no output/);
  assert.match(err.message, /judge \(score\)/, 'the one that does, and what it has');
});

test('a predicate may not read a block that has not run yet', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: gate
    kind: if
    predicate:
      source: later.score
      operator: is
      literal: 1
    body:
      - id: redo
        use: demo:work
  - id: later
    use: demo:evaluate
    outputs:
      - name: score
        type: number
`)));
  assert.match(err.message, /"later" declares no output/,
    'a field declared below the predicate is not upstream of it');
});

test('an operator outside the closed set is refused, and the whole set is named', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
  - id: gate
    kind: if
    predicate:
      source: judge.score
      operator: matches
      literal: a
    body:
      - id: redo
        use: demo:work
`)));
  assert.match(err.message, /"matches" is not a predicate operator/);
  assert.match(err.message, /is not empty/, 'the closed set is in the message, not in a document');
});

test('a source that is not exactly block.field is refused', () => {
  for (const source of ['judge', 'judge.score.inner', '.score', 'judge.']) {
    const err = refusal(() => parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
  - id: gate
    kind: if
    predicate:
      source: ${JSON.stringify(source)}
      operator: is
      literal: 1
    body:
      - id: redo
        use: demo:work
`)));
    assert.ok(err, `"${source}" is not a predicate source`);
  }
});

test('a combination inside a combination is refused: flat, or it is an expression', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
      - name: verdict
        type: string
  - id: gate
    kind: if
    predicate:
      allOf:
        - source: judge.score
          operator: "<"
          literal: 7
        - anyOf:
            - source: judge.verdict
              operator: is
              literal: failed
    body:
      - id: redo
        use: demo:work
`)));
  assert.ok(err, 'a predicate inside a predicate is the expression grammar D56 keeps out');
});

test('an if counts as a container, and its worst case is one branch not both', () => {
  const gate = parseStack(stack(`blocks:
  - id: judge
    use: demo:evaluate
    outputs:
      - name: score
        type: number
  - id: gate
    kind: if
    predicate:
      source: judge.score
      operator: is not empty
    body:
      - id: a
        use: demo:work
      - id: b
        use: demo:work
    else:
      - id: c
        use: demo:work
`)).root.children[1];
  assert.ok(isContainer(gate));
  assert.deepEqual([...walk(gate)].map(n => n.id), ['gate', 'a', 'b', 'c'],
    'both branches are in the tree, though only one ever runs');
  assert.equal(boundStack(gate).expansion, 2, 'the heavier branch, not the sum');
  assert.equal(boundStack(gate).blocks, 3, 'but all three are authored blocks');
});

// --- For each: a declared list, and nothing else (t-0096) ------------------
//
// The restriction IS the container. A plan for this phase proposed defining
// for-each as splitting the previous block's text on newlines, which is exactly
// the "roster from prose" D56 forbids, and it proposed it because typed outputs
// did not exist yet. They do. So most of what is tested here is the absence of
// a route from a string to a roster — in the file, and at run time.

const FOREACH = `blocks:
  - id: plan
    use: demo:plan
    outputs:
      - name: tasks
        type: list
      - name: summary
        type: string
  - id: each
    kind: foreach
    roster: plan.tasks
    max: 8
    body:
      - id: do-one
        use: demo:work
`;

test('a for-each parses with a roster and an authored max', () => {
  const each = parseStack(stack(FOREACH)).root.children[1];
  assert.equal(each.kind, 'foreach');
  assert.equal(each.roster, 'plan.tasks');
  assert.equal(each.max, 8);
  assert.deepEqual(each.children.map(c => c.id), ['do-one']);
});

test('for-each and foreach are one kind, either spelling', () => {
  const each = parseStack(stack(FOREACH.replace('kind: foreach', 'kind: for-each'))).root.children[1];
  assert.equal(each.kind, 'foreach', 'normalised, so nothing downstream has to know about both');
});

test('a roster naming a text field is refused, and says what it is instead', () => {
  const err = refusal(() => parseStack(stack(FOREACH.replace('roster: plan.tasks', 'roster: plan.summary'))));
  assert.match(err.message, /"plan.summary", which "plan" declares as string/);
  assert.match(err.message, /never text split into pieces/, 'and why there is no fallback');
});

test('a roster naming a field nobody declared is refused', () => {
  const err = refusal(() => parseStack(stack(FOREACH.replace('roster: plan.tasks', 'roster: plan.items'))));
  assert.match(err.message, /field "items" on block "plan"/);
  assert.match(err.message, /"plan" declares summary, tasks/);
});

test('a roster may not read a block that has not run yet', () => {
  const err = refusal(() => parseStack(stack(`blocks:
  - id: each
    kind: foreach
    roster: later.tasks
    max: 4
    body:
      - id: do-one
        use: demo:work
  - id: later
    use: demo:plan
    outputs:
      - name: tasks
        type: list
`)));
  assert.match(err.message, /"later" declares no output/);
});

test('a for-each without a max is refused: the roster is not a bound', () => {
  const err = refusal(() => parseStack(stack(FOREACH.replace('    max: 8\n', ''))));
  assert.match(err.message, /a for-each needs "max"/);
  assert.match(err.message, /not known until the block above has run/,
    'and says why the roster itself cannot be the bound');
});

test('a for-each max beyond the cap is refused, with the cap and the number', () => {
  const err = refusal(() => parseStack(stack(FOREACH.replace('max: 8', `max: ${MAX_FOR_EACH + 1}`))));
  assert.match(err.message, new RegExp(`at most ${MAX_FOR_EACH} roster elements`));
  assert.match(err.message, new RegExp(`says ${MAX_FOR_EACH + 1}`));
});

test('an output type outside the closed set is refused', () => {
  const err = refusal(() => parseStack(stack(FOREACH.replace('type: list', 'type: array'))));
  assert.match(err.message, /an output "type" is one of string, number, boolean, list/);
});

test('worst-case expansion multiplies by the authored max, not by the roster', () => {
  const each = parseStack(stack(FOREACH)).root.children[1];
  assert.equal(boundStack(each).blocks, 1, 'one authored block in the body');
  assert.equal(boundStack(each).expansion, 8, 'and eight of it in the worst case');
});

test('a for-each nested in a repeat multiplies both bounds', () => {
  const s = parseStack(stack(`blocks:
  - id: plan
    use: demo:plan
    outputs:
      - name: tasks
        type: list
  - id: twice
    kind: repeat
    count: 3
    body:
      - id: each
        kind: foreach
        roster: plan.tasks
        max: 4
        body:
          - id: do-one
            use: demo:work
`));
  assert.equal(boundStack(s.root).expansion, 1 + 3 * 4, 'the plan block, then three passes of four');
});

// --- Until: bounded by an authored maximum (t-0097) ------------------------
//
// "A body plus a named gate" in the plan means a condition somebody declared,
// and v2 has exactly one vocabulary for that — the structured predicate an `If`
// takes. A second gate concept beside it would be two things meaning one thing.
// What is specific to Until is the bound: an until without a maximum is the
// unbounded container this format exists to make impossible.

const UNTIL = `blocks:
  - id: gate
    kind: until
    max: 5
    condition:
      source: check.verdict
      operator: is
      literal: passed
    body:
      - id: attempt
        use: demo:work
      - id: check
        use: demo:evaluate
        outputs:
          - name: verdict
            type: string
`;

test('an until parses with a body, a condition and an authored max', () => {
  const until = parseStack(stack(UNTIL)).root.children[0];
  assert.equal(until.kind, 'until');
  assert.equal(until.max, 5);
  assert.deepEqual(until.condition, { source: 'check.verdict', operator: 'is', literal: 'passed' });
  assert.deepEqual(until.children.map(c => c.id), ['attempt', 'check']);
});

test('an until may ask about its own body, which is the whole point of it', () => {
  // The body is read before the condition, so a block inside it has declared
  // its outputs by the time the condition names one. Without that ordering an
  // until could only ever ask about something outside itself.
  assert.ok(parseStack(stack(UNTIL)).root.children[0]);
});

test('an until with no max is refused, and says why', () => {
  const err = refusal(() => parseStack(stack(UNTIL.replace('    max: 5\n', ''))));
  assert.match(err.message, /an until needs "max"/);
  assert.match(err.message, /unbounded container this format exists to make impossible/);
});

test('an until max beyond the cap is refused, with the cap and the number', () => {
  const err = refusal(() => parseStack(stack(UNTIL.replace('max: 5', `max: ${MAX_UNTIL + 1}`))));
  assert.match(err.message, new RegExp(`at most ${MAX_UNTIL} passes`));
  assert.match(err.message, new RegExp(`says ${MAX_UNTIL + 1}`));
});

test('an until condition naming an undeclared field is refused like any predicate', () => {
  const err = refusal(() => parseStack(stack(UNTIL.replace('source: check.verdict', 'source: check.score'))));
  assert.match(err.message, /field "score" on block "check"/);
  assert.match(err.message, /"check" declares verdict/);
});

test('worst-case expansion multiplies the body by the authored max', () => {
  const until = parseStack(stack(UNTIL)).root.children[0];
  assert.equal(boundStack(until).blocks, 2, 'two authored blocks in the body');
  assert.equal(boundStack(until).expansion, 10, 'and five passes of them');
});

// --- STACK_LANG.md says what the parser does (t-0098) ----------------------
//
// A document that describes a refusal the code does not make is worse than no
// document, because the next person builds against it. These are the claims
// cheap enough to check mechanically; the rest is prose, and prose drifts, so
// the bounds table and the operator list — the two places a number or a name
// gets stale silently — are held against the code.

test('the documented bounds are the bounds', () => {
  const doc = fs.readFileSync(new URL('../STACK_LANG.md', import.meta.url), 'utf8');
  // The table rows, read as data: `| `MAX_DEPTH` | 6 | ... |`
  const rows = new Map(doc.split('\n')
    .map(line => line.match(/^\| `(MAX_[A-Z_]+)` \| (\d+) \|/))
    .filter(Boolean)
    .map(m => [m[1], Number(m[2])]));
  const code = {
    MAX_DEPTH, MAX_REPEAT, MAX_FOR_EACH, MAX_UNTIL, MAX_EXPANSION,
  };
  assert.deepEqual([...rows.keys()].sort(), Object.keys(code).sort(),
    'every bound the parser enforces has a row, and no row names one it does not');
  for (const [name, value] of Object.entries(code)) {
    assert.equal(rows.get(name), value, `${name} in the document matches the code`);
  }
});

test('the documented operators are the operators', () => {
  const doc = fs.readFileSync(new URL('../STACK_LANG.md', import.meta.url), 'utf8');
  for (const op of IF_OPERATORS) {
    assert.ok(doc.includes('`' + op + '`'), `STACK_LANG.md lists the "${op}" operator`);
  }
  // And nothing that is not one: a reader who finds `matches` here will write it.
  for (const invented of ['matches', 'contains', 'starts with']) {
    assert.ok(!doc.includes('`' + invented + '`'),
      `STACK_LANG.md must not name "${invented}" as an operator`);
  }
});

test('every container kind the parser has is documented, and no others', () => {
  const doc = fs.readFileSync(new URL('../STACK_LANG.md', import.meta.url), 'utf8');
  // The table under "## Containers", read as data rather than searched for.
  const after = doc.slice(doc.indexOf('## Containers'));
  const table = after.slice(0, after.indexOf('\n\n', after.indexOf('|')));
  const rows = table.split('\n')
    .map(line => line.match(/^\| `([a-z-]+)` \|/))
    .filter(Boolean).map(m => m[1]);
  assert.deepEqual(rows.sort(), [...CONTAINER_KINDS].sort(),
    'a row for every kind, and a row for nothing else');
});

test('the v1 DSL is still pointed at, and not renamed', () => {
  const doc = fs.readFileSync(new URL('../STACK_LANG.md', import.meta.url), 'utf8');
  assert.match(doc, /FLOW_LANG\.md/, 'v1 keeps v1 names until the cutover');
});
