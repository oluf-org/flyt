// The walk: a sequence in order, a parallel under its bound, lanes isolated
// (t-0066).
//
// The containment already says all three of those things. What is tested here
// is that the scheduler HONOURS the structure rather than reimplementing it —
// most of all lane isolation, which is not a rule the runner enforces but a
// consequence of every lane being handed what entered the parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytBlocks, flytStackRunner, sessionJsonl, parseStack,
} from '#kernel';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-walk-'));

/**
 * A kernel with a stack, a block type, and a runner over them.
 *
 * `record` collects `{ blockId, input }` in the order blocks STARTED, and
 * `finished` in the order they ended — a parallel is the one case where those
 * two orders differ, and that difference is the assertion.
 */
async function bootWalk(source, { execute, ceiling = [], blockCeiling = null } = {}) {
  const root = tmp();
  const kernel = createKernel();
  const record = [];
  const finished = [];

  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({
    name: 'demo-blocks',
    inject: ['blocks'],
    apply(ctx) {
      ctx.blocks.register({
        use: 'demo:work',
        title: 'Work',
        description: 'Records what it was given and answers.',
        category: 'work',
        settings: { type: 'object' },
        ceiling: blockCeiling,
        async execute(run) {
          record.push({ blockId: run.blockId, input: run.input, ceiling: [...run.ceiling] });
          const outcome = execute
            ? await execute(run)
            : { status: 'done', output: `${run.blockId} saw "${run.input}"` };
          finished.push(run.blockId);
          return outcome;
        },
      });
    },
  });

  const stack = parseStack(source);
  await kernel.ctx.plugin(flytStackRunner, {
    stacks: { resolve: id => (id === stack.id ? stack.root : null) },
    ceiling,
  });

  return { kernel, record, finished, stack, root };
}

const typesIn = async (kernel, runId) => {
  const session = await kernel.ctx.sessions.read(runId);
  const out = [];
  for await (const e of session.read()) out.push(e);
  return out;
};

const SEQUENCE = `version: 2
id: demo
blocks:
  - id: first
    use: demo:work
  - id: second
    use: demo:work
`;

const PARALLEL = `version: 2
id: demo
blocks:
  - id: before
    use: demo:work
  - id: fan
    kind: parallel
    maxParallel: 2
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: demo:work
      - id: middle
        kind: sequence
        blocks:
          - id: ma
            use: demo:work
      - id: right
        kind: sequence
        blocks:
          - id: ra
            use: demo:work
`;

test('a two-block sequence runs in order, each fed what the one before produced', async () => {
  const boot = await bootWalk(SEQUENCE);
  const run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'the input');
  const outcome = await run.settled();

  assert.equal(outcome.status, 'done');
  assert.deepEqual(boot.record.map(r => r.blockId), ['first', 'second']);
  assert.equal(boot.record[0].input, 'the input');
  assert.equal(boot.record[1].input, 'first saw "the input"', 'the carry is the previous output');

  const events = await typesIn(boot.kernel, 'run-1');
  assert.deepEqual(
    events.filter(e => e.type === 'block.status' && e.data.status === 'done').map(e => e.data.blockId),
    ['first', 'second'],
    'and the log holds both, in the order they ran');
  await boot.kernel.dispose();
});

test('start returns before the walk finishes, and settled is what you await', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const boot = await bootWalk(SEQUENCE, {
    async execute(run) {
      if (run.blockId === 'first') await held;
      return { status: 'done', output: 'ok' };
    },
  });

  const run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  assert.equal(boot.finished.length, 0, 'nothing has finished, and start already returned');
  assert.equal(boot.kernel.ctx.agents.get('run-1'), run, 'and the run is findable while it goes');
  release();
  assert.equal((await run.settled()).status, 'done');
  await boot.kernel.dispose();
});

test('a parallel runs its lanes together and never more than maxParallel at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const boot = await bootWalk(PARALLEL, {
    async execute() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 15));
      inFlight -= 1;
      return { status: 'done', output: 'lane done' };
    },
  });

  assert.equal((await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled()).status, 'done');
  assert.equal(peak, 2, 'maxParallel: 2 means two, not three and not one');
  assert.equal(boot.record.length, 4, 'the block before the fan, and all three lanes');
  await boot.kernel.dispose();
});

test('a lane cannot see what a sibling lane produced', async () => {
  // Not a rule the scheduler enforces — a consequence of every lane being
  // handed what entered the PARALLEL. There is no shared carry for one lane's
  // output to leak into (D37).
  const boot = await bootWalk(PARALLEL, {
    async execute(run) {
      return { status: 'done', output: `${run.blockId} produced something` };
    },
  });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'the input')).settled();

  const lanes = boot.record.filter(r => r.blockId !== 'before');
  assert.equal(lanes.length, 3);
  for (const lane of lanes) {
    assert.equal(lane.input, 'before produced something',
      `lane ${lane.blockId} saw what entered the parallel`);
  }
  await boot.kernel.dispose();
});

test('a block that fails ends the run as failed, naming the block', async () => {
  const boot = await bootWalk(SEQUENCE, {
    async execute(run) {
      if (run.blockId === 'first') return { status: 'failed', output: '', error: 'the file was not there' };
      return { status: 'done', output: 'never reached' };
    },
  });
  const outcome = await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Block "first" failed: the file was not there/);
  assert.deepEqual(boot.record.map(r => r.blockId), ['first'], 'and the second block never ran');
  const events = await typesIn(boot.kernel, 'run-1');
  assert.equal(events.at(-1).data.stage, 'failed');
  await boot.kernel.dispose();
});

test('a block that throws is a failed block, not a crashed run', async () => {
  const boot = await bootWalk(SEQUENCE, {
    async execute() { throw new Error('it exploded'); },
  });
  const outcome = await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Block "first" failed: it exploded/);
  await boot.kernel.dispose();
});

test('a block narrows the run’s ceiling and cannot widen it', async () => {
  const boot = await bootWalk(SEQUENCE, {
    ceiling: ['read_file', 'bash'],
    blockCeiling: ['read_file', 'rm_rf'],
  });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  assert.deepEqual(boot.record[0].ceiling, ['read_file'],
    'the intersection: what the block asked for AND the run allowed');
  await boot.kernel.dispose();
});

test('a stack naming a block nobody installed fails before anything is spent', async () => {
  const boot = await bootWalk(`version: 2
id: demo
blocks:
  - id: first
    use: demo:work
  - id: second
    use: demo:absent
`);
  await assert.rejects(
    () => boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in'),
    /names 1 block type\(s\) nothing contributes: second \(demo:absent\)/);
  assert.equal(boot.record.length, 0, 'block 1 did not run, so block 1 was not paid for');
  await boot.kernel.dispose();
});

test('starting a stack that does not exist says so', async () => {
  const boot = await bootWalk(SEQUENCE);
  await assert.rejects(
    () => boot.kernel.ctx.agents.start({ id: 'nope', runId: 'run-1' }, 'in'),
    /There is no stack "nope"/);
  await boot.kernel.dispose();
});

// --- If: one branch, chosen by the predicate (t-0095) ----------------------
//
// The parser has already refused anything whose source is not a declared field,
// so what the runner has to get right is narrower and sharper: exactly one
// branch runs, the other is never entered, and an if that chooses nothing
// changes nothing — its input carries on to whatever follows.

const ifStack = (predicate, withElse) => `version: 2
id: demo
blocks:
  - id: judge
    use: demo:work
    outputs:
      - name: score
        type: number
  - id: gate
    kind: if
    predicate:
${predicate.split('\n').map(l => `      ${l}`).join('\n')}
    body:
      - id: then-branch
        use: demo:work
${withElse ? `    else:
      - id: else-branch
        use: demo:work
` : ''}  - id: after
    use: demo:work
`;

// `judge` answers with a score; everything else answers plainly.
const scoring = score => async run => (run.blockId === 'judge'
  ? { status: 'done', output: 'judged', structured: { score } }
  : { status: 'done', output: `${run.blockId} saw "${run.input}"` });

test('an if whose predicate holds runs the body, and never the else', async () => {
  const boot = await bootWalk(ifStack('source: judge.score\noperator: "<"\nliteral: 7', true),
    { execute: scoring(3) });
  const outcome = await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.equal(outcome.status, 'done');
  assert.deepEqual(boot.record.map(r => r.blockId), ['judge', 'then-branch', 'after']);
  assert.ok(!boot.finished.includes('else-branch'), 'the untaken branch never ran');
  await boot.kernel.dispose();
});

test('an if whose predicate does not hold runs the else, and never the body', async () => {
  const boot = await bootWalk(ifStack('source: judge.score\noperator: "<"\nliteral: 7', true),
    { execute: scoring(9) });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.deepEqual(boot.record.map(r => r.blockId), ['judge', 'else-branch', 'after']);
  assert.ok(!boot.finished.includes('then-branch'));
  await boot.kernel.dispose();
});

test('an if with no else and a predicate that fails passes its input through unchanged', async () => {
  const boot = await bootWalk(ifStack('source: judge.score\noperator: "<"\nliteral: 7', false),
    { execute: scoring(9) });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.deepEqual(boot.record.map(r => r.blockId), ['judge', 'after'], 'nothing ran inside the if');
  const after = boot.record.find(r => r.blockId === 'after');
  assert.equal(after.input, 'judged',
    'and what reaches the next block is what entered the if, not an empty string');
  await boot.kernel.dispose();
});

test('a field the block never set is empty rather than an error at run time', async () => {
  // The parser guarantees the field was DECLARED. It cannot guarantee the block
  // put it there on the day, so the runner has to decide truthfully instead of
  // throwing: absent is empty.
  const boot = await bootWalk(ifStack('source: judge.score\noperator: is empty', true),
    { execute: async run => ({ status: 'done', output: 'judged' }) });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.deepEqual(boot.record.map(r => r.blockId), ['judge', 'then-branch', 'after']);
  await boot.kernel.dispose();
});

test('a lane cannot read what a sibling lane produced, even through a predicate', async () => {
  // Lane isolation (D37) is not a rule the runner enforces, it is a consequence
  // of every lane being handed what entered the parallel. A predicate is the one
  // thing that could have reached around it, so it is the one thing worth
  // asserting: `right` names a field `left`'s block really does declare, and
  // still must not see it.
  const boot = await bootWalk(`version: 2
id: demo
blocks:
  - id: fan
    kind: parallel
    maxParallel: 1
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: judge
            use: demo:work
            outputs:
              - name: score
                type: number
      - id: right
        kind: sequence
        blocks:
          - id: gate
            kind: if
            predicate:
              source: judge.score
              operator: is not empty
            body:
              - id: leaked
                use: demo:work
            else:
              - id: isolated
                use: demo:work
`, {
    execute: async run => (run.blockId === 'judge'
      ? { status: 'done', output: 'judged', structured: { score: 3 } }
      : { status: 'done', output: `${run.blockId} ran` }),
  });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.ok(boot.finished.includes('isolated'), 'the sibling lane is invisible, so the field reads empty');
  assert.ok(!boot.finished.includes('leaked'), 'and nothing crossed between lanes');
  await boot.kernel.dispose();
});

// --- For each: once per element, and never over prose (t-0096) -------------

const forEachStack = (max = 8) => `version: 2
id: demo
blocks:
  - id: plan
    use: demo:work
    outputs:
      - name: tasks
        type: list
  - id: each
    kind: foreach
    roster: plan.tasks
    max: ${max}
    body:
      - id: do-one
        use: demo:work
  - id: after
    use: demo:work
`;

const planning = tasks => async run => (run.blockId === 'plan'
  ? { status: 'done', output: 'planned', structured: { tasks } }
  : { status: 'done', output: `${run.blockId} saw "${run.input}"` });

test('a for-each runs its body once per roster element, each fed its own element', async () => {
  const boot = await bootWalk(forEachStack(), { execute: planning(['alpha', 'beta', 'gamma']) });
  const outcome = await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.equal(outcome.status, 'done');
  assert.deepEqual(boot.record.map(r => r.blockId), ['plan', 'do-one', 'do-one', 'do-one', 'after']);
  assert.deepEqual(
    boot.record.filter(r => r.blockId === 'do-one').map(r => r.input),
    ['alpha', 'beta', 'gamma'],
    'each pass gets its own element, not the pass before it');
  await boot.kernel.dispose();
});

test('a roster longer than the authored max is cut, and the log says by how much', async () => {
  const boot = await bootWalk(forEachStack(2), { execute: planning(['a', 'b', 'c', 'd', 'e']) });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.equal(boot.record.filter(r => r.blockId === 'do-one').length, 2, 'the bound is honoured');
  const events = await typesIn(boot.kernel, 'run-1');
  const announced = events.find(e => e.type === 'block.status' && e.data.blockId === 'each');
  assert.equal(announced.data.elements, 2);
  assert.equal(announced.data.cut, 3, 'and it is not quietly cut');
  await boot.kernel.dispose();
});

test('a block that declared a list and returned a string iterates nothing', async () => {
  // The one thing this container must never do, checked where the promise can
  // still be broken: the parser guaranteed the field was declared a list, not
  // that the block put a list there on the day.
  const boot = await bootWalk(forEachStack(), { execute: planning('alpha\nbeta\ngamma') });
  await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.deepEqual(boot.record.map(r => r.blockId), ['plan', 'after'],
    'a string is not a roster, at run time either — no split, no fallback');
  await boot.kernel.dispose();
});

test('an empty roster runs the body no times and does not fail the run', async () => {
  const boot = await bootWalk(forEachStack(), { execute: planning([]) });
  const outcome = await (await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();

  assert.equal(outcome.status, 'done');
  assert.deepEqual(boot.record.map(r => r.blockId), ['plan', 'after']);
  await boot.kernel.dispose();
});
