// `ctx.commands`: one code path, two callers (D63).
//
// Every Build operation is available to an agent here, and every agent
// operation renders in the editor as it happens. A command only a human can
// reach, or only an agent can reach, is a bug in this seam — so the test that
// matters most is the one that drives the same edit both ways and asserts the
// results are indistinguishable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKernel, flytApi, registerStackCommands, parseStack, moveNode, walk,
} from '#kernel';

const SOURCE = `version: 2
id: demo
blocks:
  - id: first
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
`;

/** A kernel with the command surface up, and a stack for the edits to act on. */
async function withStack() {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);
  let root = parseStack(SOURCE).root;
  const handle = { get: () => root, set: next => { root = next; } };
  const dispose = registerStackCommands(kernel.ctx, handle);
  const seen = [];
  kernel.ctx.on('commands/invoke', record => seen.push(record));
  return { kernel, ctx: kernel.ctx, handle, seen, dispose, current: () => root };
}

const idsIn = (root, container) => [...walk(root)].find(n => n.id === container).children.map(c => c.id);

test('a registered command is listed and invokable, and its disposer removes it', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);

  const remove = kernel.ctx.commands.register({
    name: 'demo:echo',
    description: 'Say it back.',
    async handler(args) { return args; },
  });
  assert.deepEqual(kernel.ctx.commands.list().map(c => c.name), ['demo:echo']);
  assert.deepEqual(await kernel.ctx.commands.invoke('demo:echo', { a: 1 }), { a: 1 });

  remove();
  assert.deepEqual(kernel.ctx.commands.list(), []);
  await assert.rejects(() => kernel.ctx.commands.invoke('demo:echo'), /There is no command "demo:echo"/);
  await kernel.dispose();
});

test('a command that is not registered fails naming the ones that are', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);
  await assert.rejects(() => kernel.ctx.commands.invoke('stack:insert-block'),
    /There is no command "stack:insert-block", and none are registered/);

  kernel.ctx.commands.register({ name: 'a:one', description: '', async handler() { return null; } });
  kernel.ctx.commands.register({ name: 'a:two', description: '', async handler() { return null; } });
  await assert.rejects(() => kernel.ctx.commands.invoke('a:three'), /There is: a:one, a:two\./);
  await kernel.dispose();
});

test('a command registered by a plugin goes when the plugin unloads', async () => {
  // Phase 0's lesson: a registration made without ctx.effect() outlives the
  // plugin that made it, and its handler closes over a torn-down world.
  const kernel = createKernel();
  await kernel.ctx.plugin(flytApi);
  const fork = await kernel.ctx.plugin({
    name: 'a-contributor',
    // Declared, because cordis makes a plugin wait for the service it needs
    // rather than hand it a half-built context.
    inject: ['commands'],
    apply(ctx) {
      ctx.commands.register({ name: 'plugin:thing', description: '', async handler() { return 'ok'; } });
    },
  });
  assert.equal(await kernel.ctx.commands.invoke('plugin:thing'), 'ok');

  await fork.dispose();
  assert.deepEqual(kernel.ctx.commands.list().map(c => c.name), []);
  await kernel.dispose();
});

test('the caller is recorded, not inferred', async () => {
  // "An agent did this" is the first question anyone asks about a change they
  // did not make, and a surface that has to guess will guess wrong exactly
  // when it matters.
  const { ctx, seen, kernel } = await withStack();
  await ctx.commands.invoke('stack:move-block', { nodeId: 'la', to: { container: 'right', index: 0 } }, 'agent');
  await ctx.commands.invoke('stack:move-block', { nodeId: 'la', to: { container: 'left', index: 0 } }, 'human');

  assert.deepEqual(seen.map(r => r.caller), ['agent', 'human']);
  // And a caller nobody stated is a person, because that is who is at a keyboard.
  await ctx.commands.invoke('stack:remove-block', { nodeId: 'lb' });
  assert.equal(seen[2].caller, 'human');
  await kernel.dispose();
});

test('the same edit, from either caller, produces the same tree', async () => {
  // The whole of D63 in one assertion.
  const byAgent = await withStack();
  const byHuman = await withStack();
  const args = { nodeId: 'la', to: { container: 'right', index: 1 } };
  await byAgent.ctx.commands.invoke('stack:move-block', args, 'agent');
  await byHuman.ctx.commands.invoke('stack:move-block', args, 'human');

  assert.deepEqual(byAgent.current(), byHuman.current());
  assert.deepEqual(byAgent.seen[0].result, byHuman.seen[0].result);
  // ...and the same tree calling the edit directly, with no seam in the way.
  assert.deepEqual(byAgent.current(), moveNode(parseStack(SOURCE).root, 'la', args.to).root);
  await byAgent.kernel.dispose();
  await byHuman.kernel.dispose();
});

test('every invocation announces itself, carrying what changed', async () => {
  const { ctx, seen, current, kernel } = await withStack();
  await ctx.commands.invoke('stack:insert-block',
    { block: { id: 'extra', use: 'evaluation' }, at: { container: 'left', index: 1 } }, 'agent');

  assert.equal(seen.length, 1, 'one edit, one event');
  assert.equal(seen[0].name, 'stack:insert-block');
  assert.deepEqual(seen[0].result, {
    kind: 'insert', nodeId: 'extra', from: null, to: { container: 'left', index: 1 },
  });
  assert.deepEqual(idsIn(current(), 'left'), ['la', 'extra', 'lb']);
  assert.ok(Date.parse(seen[0].at) > 0, 'and when');
  await kernel.dispose();
});

test('a refused edit is announced too, and changes nothing', async () => {
  // An edit that was attempted and refused is a thing the editor has to stop
  // animating, and a thing a person watching an agent work needs to see.
  const { ctx, seen, current, kernel } = await withStack();
  const before = JSON.stringify(current());

  await assert.rejects(
    () => ctx.commands.invoke('stack:move-block', { nodeId: 'fan', to: { container: 'left', index: 0 } }, 'agent'),
    /would put "fan" inside itself/);

  assert.equal(seen.length, 1);
  assert.match(seen[0].error, /would put "fan" inside itself/);
  assert.equal(seen[0].result, undefined);
  assert.equal(JSON.stringify(current()), before, 'and the stack is where it was');
  await kernel.dispose();
});

test('the tree a command produced becomes the tree, or the command did not settle', async () => {
  // An edit that returned a record the editor animated while the stack stayed
  // as it was is the exact disagreement containment exists to make impossible.
  const { ctx, current, kernel } = await withStack();
  await ctx.commands.invoke('stack:remove-block', { nodeId: 'lb' }, 'agent');
  assert.deepEqual(idsIn(current(), 'left'), ['la']);

  await ctx.commands.invoke('stack:configure-block',
    { nodeId: 'la', config: { toolCeiling: 'loop' } }, 'agent');
  assert.deepEqual([...walk(current())].find(n => n.id === 'la').config, { toolCeiling: 'loop' });
  await kernel.dispose();
});

test('every stack command describes its arguments, so a model can call it', async () => {
  const { ctx, kernel } = await withStack();
  const commands = ctx.commands.list();
  assert.deepEqual(commands.map(c => c.name).sort(), [
    'stack:configure-block', 'stack:configure-container', 'stack:insert-block',
    'stack:move-block', 'stack:remove-block', 'stack:unwrap-container', 'stack:wrap-block',
  ]);
  for (const command of commands) {
    assert.ok(command.description, `${command.name} has no description`);
    assert.equal(command.parameters.type, 'object', `${command.name} has no argument schema`);
    assert.ok(command.parameters.required.length, `${command.name} requires nothing`);
  }
  await kernel.dispose();
});

test('nonsense arguments are refused before the tree is touched', async () => {
  const { ctx, current, kernel } = await withStack();
  const before = JSON.stringify(current());
  for (const [name, args, message] of [
    ['stack:move-block', { nodeId: 'la' }, /"to" needs a container id and an index/],
    ['stack:move-block', { to: { container: 'left', index: 0 } }, /"nodeId" names the block/],
    ['stack:insert-block', { block: { id: 'x' }, at: { container: 'left', index: 0 } }, /a block needs an "id" and a "use"/],
    ['stack:remove-block', 'not a mapping', /this command takes a mapping of arguments/],
  ]) {
    await assert.rejects(() => ctx.commands.invoke(name, args, 'agent'), message, `${name} accepted ${JSON.stringify(args)}`);
  }
  assert.equal(JSON.stringify(current()), before);
  await kernel.dispose();
});
