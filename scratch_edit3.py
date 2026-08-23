import io
p = 'tests/blockRegistry.test.js'
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')

old = "import { createKernel, flytBlocks, missingBlocks, parseStack } from '#kernel';"
new = ("import { createKernel, flytBlocks, missingBlocks, parseStack } from '#kernel';\n"
       "import { apply as coreBlocks } from '../kernel/dist/plugins/blocks-core.js';\n"
       "import { apply as judgementBlocks } from '../kernel/dist/plugins/blocks-judgement.js';\n"
       "import { apply as inquiryBlocks } from '../kernel/dist/plugins/blocks-inquiry.js';\n"
       "import { apply as loopBlocks } from '../kernel/dist/plugins/blocks-loop.js';")
assert s.count(old) == 1
s = s.replace(old, new)

old_test = """test('a declared output agrees with what execute returns in `structured`', () =>
  withBlocks(async kernel => {
    kernel.ctx.blocks.register(block({
      outputs: [{ name: 'score', type: 'number' }],
      async execute() { return { status: 'done', output: 'ok', structured: { score: 7 } }; },
    }));
    const def = kernel.ctx.blocks.resolve('demo:work');
    const outcome = await def.execute({});
    assert.deepEqual(Object.keys(outcome.structured ?? {}), def.outputs.map(o => o.name));
  }));"""
new_test = """test('a declared output agrees with what execute returns in `structured`', () =>
  withBlocks(async kernel => {
    kernel.ctx.blocks.register(block({
      outputs: [{ name: 'score', type: 'number' }],
      async execute() { return { status: 'done', output: 'ok', structured: { score: 7 } }; },
    }));
    const def = kernel.ctx.blocks.resolve('demo:work');
    const outcome = await def.execute({});
    assert.deepEqual(Object.keys(outcome.structured ?? {}), def.outputs.map(o => o.name));
  }));

// The lint rules Phase 3 builds on this declaration only work if the blocks
// that ship actually declare — and keep — their side of it. Resolve every
// shipped core block, run its executor once, and hold the declaration against
// what came back: the declared names are exactly the keys of `structured`,
// and each declared type is what the value is.
test('every shipped block that returns `structured` declares exactly the fields it returns', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytBlocks);
  for (const [name, apply] of [['core', coreBlocks], ['judgement', judgementBlocks],
    ['inquiry', inquiryBlocks], ['loop', loopBlocks]]) {
    await kernel.ctx.plugin({ name, inject: ['blocks'], apply });
  }
  try {
    // What the run shape needs for a successful pass: a session to log to, a
    // model that answers without tools, and an input with items the list
    // blocks can name.
    const session = { async append() {}, messages: [] };
    kernel.ctx.set('sessions', { open: async () => session });
    kernel.ctx.set('models', { ask: async () => ({ content: 'alpha\\nbeta' }) });

    // `work` is the exception that proves the rule: its deliverable is the
    // workspace change itself, not a field, so it declares no output — and
    // stays legal, offering a predicate or roster nothing to name.
    assert.equal(kernel.ctx.blocks.resolve('flyt-blocks-core:work').outputs, undefined);

    const EXPECTED = {
      'flyt-blocks-core:general-analysis': { analysis: 'string' },
      'flyt-blocks-core:combine': { combined: 'string' },
      'flyt-blocks-core:split': { parts: 'list' },
      'flyt-blocks-core:plan-start': { tasks: 'list' },
      'flyt-blocks-judgement:evaluation': { verdict: 'string' },
      'flyt-blocks-judgement:compare': { comparison: 'string' },
      'flyt-blocks-judgement:prompt-refiner': { brief: 'string' },
      'flyt-blocks-inquiry:interrogate': { spec: 'string' },
      'flyt-blocks-inquiry:orient': { orientation: 'string' },
      'flyt-blocks-loop:backlog-plan': { tasks: 'list' },
      'flyt-blocks-loop:loop-handoff': { queued: 'list' },
    };
    const run = {
      ctx: kernel.ctx, runId: 'run-outputs', blockId: 'probe', config: {},
      input: 'alpha\\nbeta', ceiling: [],
    };
    const TYPE_OF = value => Array.isArray(value) ? 'list'
      : value === null ? 'null' : typeof value;
    for (const [use, fields] of Object.entries(EXPECTED)) {
      const def = kernel.ctx.blocks.require(use);
      assert.deepEqual(
        Object.fromEntries((def.outputs ?? []).map(o => [o.name, o.type])),
        fields, `${use} declares the fields its role produces`);
      const outcome = await def.execute({ ...run, blockId: use });
      assert.equal(outcome.status, 'done', `${use} answered`);
      assert.deepEqual(Object.keys(outcome.structured ?? {}), Object.keys(fields),
        `${use} returns exactly the fields it declares`);
      for (const [field, type] of Object.entries(fields)) {
        assert.equal(TYPE_OF(outcome.structured[field]), type,
          `${use}: declared ${field} as ${type} and returned one`);
      }
    }
  } finally { await kernel.dispose(); }
});"""
assert s.count(old_test) == 1
s = s.replace(old_test, new_test)
io.open(p, 'w', encoding='utf-8', newline='\r\n').write(s)
print('ok')
