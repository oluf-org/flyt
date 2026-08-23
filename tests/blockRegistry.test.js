// `ctx.blocks`: what a stack's `use` resolves to.
//
// The parser turns `use: flyt-blocks-core:work` into a string and stops there,
// because a stack may name a block that is not installed and the parser is not
// the library. This is the other half — and the half that has to refuse well,
// since "no installed plugin contributes that" is a sentence somebody reads at
// the moment a stack they wrote will not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytBlocks, missingBlocks, parseStack } from '#kernel';

const block = (over = {}) => ({
  use: 'demo:work',
  title: 'Work',
  description: 'Does the work.',
  category: 'work',
  settings: { type: 'object', properties: { prompt: { type: 'string' } } },
  ceiling: null,
  async execute() { return { status: 'done', output: 'done' }; },
  ...over,
});

async function withBlocks(fn) {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytBlocks);
  try { return await fn(kernel); } finally { await kernel.dispose(); }
}

test('a plugin contributes a block, and a stack’s use resolves to it', () => withBlocks(async kernel => {
  await kernel.ctx.plugin({
    name: 'demo-blocks',
    // Declared, because cordis makes a plugin wait for the service it needs
    // rather than hand it a half-built context.
    inject: ['blocks'],
    apply(ctx) { ctx.blocks.register(block()); },
  });
  const found = kernel.ctx.blocks.resolve('demo:work');
  assert.equal(found?.title, 'Work');
  assert.equal(found?.category, 'work');
  assert.deepEqual(kernel.ctx.blocks.list().map(b => b.use), ['demo:work']);
}));

test('a block goes when the plugin that contributed it unloads', () => withBlocks(async kernel => {
  const fiber = await kernel.ctx.plugin({
    name: 'demo-blocks',
    // Declared, because cordis makes a plugin wait for the service it needs
    // rather than hand it a half-built context.
    inject: ['blocks'],
    apply(ctx) { ctx.blocks.register(block()); },
  });
  assert.ok(kernel.ctx.blocks.resolve('demo:work'));
  await fiber.dispose();
  assert.equal(kernel.ctx.blocks.resolve('demo:work'), undefined,
    'a block that outlives its plugin is a block whose execute closes over a torn-down world');
}));

test('the installed set announces that it changed', () => withBlocks(async kernel => {
  let changes = 0;
  kernel.ctx.on('blocks/change', () => { changes += 1; });
  const fiber = await kernel.ctx.plugin({
    name: 'demo-blocks',
    // Declared, because cordis makes a plugin wait for the service it needs
    // rather than hand it a half-built context.
    inject: ['blocks'],
    apply(ctx) { ctx.blocks.register(block()); },
  });
  assert.equal(changes, 1);
  await fiber.dispose();
  assert.equal(changes, 2, 'the library has to hear it go, not only arrive');
}));

test('a use nobody installed resolves to nothing, and require names what there is', () =>
  withBlocks(async kernel => {
    await kernel.ctx.plugin({ name: 'demo-blocks', inject: ['blocks'], apply(ctx) { ctx.blocks.register(block()); } });
    assert.equal(kernel.ctx.blocks.resolve('demo:absent'), undefined);
    assert.throws(
      () => kernel.ctx.blocks.require('demo:absent', 'stack "pipeline", block "step-2"'),
      /No installed plugin contributes a block named "demo:absent".*stack "pipeline".*Installed: demo:work/s,
    );
  }));

test('with nothing installed, the refusal says so rather than listing an empty set', () =>
  withBlocks(async kernel => {
    assert.throws(() => kernel.ctx.blocks.require('demo:work'), /no blocks are installed at all/);
  }));

test('a block without an id, an execute or a category is refused at registration', () =>
  withBlocks(async kernel => {
    const blocks = kernel.ctx.blocks;
    assert.throws(() => blocks.register(block({ use: '' })), /needs a "use"/);
    assert.throws(() => blocks.register(block({ use: 'Demo Work' })), /not a usable block id/);
    assert.throws(() => blocks.register(block({ execute: undefined })), /has no execute/);
    assert.throws(() => blocks.register(block({ category: 'invented' })), /has no category/);
  }));

test('a declared output is a name plus one type from a closed set, and an unknown type is refused', () =>
  withBlocks(async kernel => {
    const blocks = kernel.ctx.blocks;
    assert.throws(() => blocks.register(block({ outputs: [{ type: 'string' }] })), /without a "name"/);
    assert.throws(() => blocks.register(block({ outputs: [{ name: '', type: 'string' }] })), /without a "name"/);
    assert.throws(
      () => blocks.register(block({ outputs: [{ name: 'score', type: 'invented' }] })),
      /unknown type "invented"/,
    );
    blocks.register(block({ outputs: [{ name: 'score', type: 'number' }] }));
    assert.deepEqual(kernel.ctx.blocks.resolve('demo:work').outputs, [{ name: 'score', type: 'number' }]);
  }));

test('a block that declares no outputs stays legal and offers no field to name', () =>
  withBlocks(async kernel => {
    kernel.ctx.blocks.register(block());
    const found = kernel.ctx.blocks.resolve('demo:work');
    assert.ok(found);
    assert.equal(found.outputs, undefined);
  }));

test('a declared output agrees with what execute returns in `structured`', () =>
  withBlocks(async kernel => {
    kernel.ctx.blocks.register(block({
      outputs: [{ name: 'score', type: 'number' }],
      async execute() { return { status: 'done', output: 'ok', structured: { score: 7 } }; },
    }));
    const def = kernel.ctx.blocks.resolve('demo:work');
    const outcome = await def.execute({});
    assert.deepEqual(Object.keys(outcome.structured ?? {}), def.outputs.map(o => o.name));
  }));

test('two plugins claiming one id is named, never silently resolved', () => withBlocks(async kernel => {
  await kernel.ctx.plugin({ name: 'first', inject: ['blocks'], apply(ctx) { ctx.blocks.register(block()); } });
  await assert.rejects(
    async () => kernel.ctx.plugin({
      name: 'second', inject: ['blocks'], apply(ctx) { ctx.blocks.register(block({ title: 'Other' })); },
    }),
    /already installed/,
  );
  assert.equal(kernel.ctx.blocks.resolve('demo:work').title, 'Work', 'the first one is still the one');
}));

test('a stack still parses when it names a block nobody installed', () => withBlocks(async kernel => {
  await kernel.ctx.plugin({ name: 'demo-blocks', inject: ['blocks'], apply(ctx) { ctx.blocks.register(block()); } });
  const stack = parseStack(`version: 2
id: demo
blocks:
  - id: one
    use: demo:work
  - id: two
    use: demo:absent
`);
  assert.deepEqual(missingBlocks(kernel.ctx.blocks, stack.root), [{ id: 'two', use: 'demo:absent' }]);
}));

test('missing blocks are found at every depth, in tree order', () => withBlocks(async kernel => {
  await kernel.ctx.plugin({ name: 'demo-blocks', inject: ['blocks'], apply(ctx) { ctx.blocks.register(block()); } });
  const stack = parseStack(`version: 2
id: demo
blocks:
  - id: fan
    kind: parallel
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: demo:gone
      - id: right
        kind: sequence
        blocks:
          - id: rb
            use: demo:work
          - id: rc
            use: demo:also-gone
`);
  assert.deepEqual(missingBlocks(kernel.ctx.blocks, stack.root),
    [{ id: 'la', use: 'demo:gone' }, { id: 'rc', use: 'demo:also-gone' }]);
}));
