// A tool contributed by a plugin reaches execution through the same gate a
// built-in one does — or it does not reach it at all (D57).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools, flytApprovals } from '#kernel';

const CLASSIFIED_READ = { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' };
const CLASSIFIED_WRITE = { effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed' };
const CLASSIFIED_SHELL = { effect: 'shell', destructive: true, untrustedInput: false, source: 'confirmed' };

// The trivial hand-written plugin the phase is measured by: it contributes a
// tool and nothing else.
function aPluginContributing(tool, ran) {
  return {
    name: 'a-third-party-plugin',
    inject: ['tools'],
    apply(ctx) {
      return ctx.tools.register({
        name: tool.name,
        description: tool.description ?? 'contributed by a plugin',
        parameters: { type: 'object', properties: {} },
        ...(tool.classification ? { classification: tool.classification } : {}),
        async execute(args, exec) {
          ran.push([tool.name, args, exec.blockId]);
          return { content: `${tool.name} ran` };
        },
      });
    },
  };
}

async function aKernel({ mode = 'always', ask, tool, ran = [] } = {}) {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(flytApprovals, { mode, ...(ask ? { ask } : {}) });
  if (tool) await kernel.ctx.plugin(aPluginContributing(tool, ran));
  return { kernel, ctx: kernel.ctx, ran };
}

const aCall = (name, ceiling, args = {}) => ({
  runId: 'r1', blockId: 'work', step: 1,
  call: { id: 'c1', name, args },
  ceiling,
});

test('a plugin tool runs when a ceiling names it', async () => {
  const { kernel, ctx, ran } = await aKernel({
    tool: { name: 'count_files', classification: CLASSIFIED_READ },
  });
  try {
    const result = await ctx.tools.execute(aCall('count_files', ['count_files'], { glob: '*' }));
    assert.equal(result.content, 'count_files ran');
    assert.equal(result.error, undefined);
    assert.deepEqual(ran, [['count_files', { glob: '*' }, 'work']]);
  } finally { await kernel.dispose(); }
});

test('...and is refused until one does', async () => {
  const { kernel, ctx, ran } = await aKernel({
    tool: { name: 'count_files', classification: CLASSIFIED_READ },
  });
  try {
    const result = await ctx.tools.execute(aCall('count_files', ['read_file']));
    assert.match(result.error, /not in this block's ceiling/);
    assert.match(result.content, /^Refused: /);
    assert.deepEqual(ran, [], 'the body never ran');
  } finally { await kernel.dispose(); }
});

test('an unclassified tool is unreachable, whatever the ceiling says', async () => {
  const { kernel, ctx, ran } = await aKernel({
    tool: { name: 'mystery' },     // registered, never classified
  });
  try {
    assert.ok(ctx.tools.get('mystery'), 'it is registered');
    const result = await ctx.tools.execute(aCall('mystery', ['mystery']));
    assert.match(result.error, /unclassified, so it is in no toolset/);
    assert.deepEqual(ran, []);
  } finally { await kernel.dispose(); }
});

test('classification is not a grant', async () => {
  // The install screen confirmed what it does. Nothing about that says it may run.
  const { kernel, ctx, ran } = await aKernel({
    tool: { name: 'write_notes', classification: CLASSIFIED_WRITE },
  });
  try {
    const result = await ctx.tools.execute(aCall('write_notes', []));
    assert.match(result.error, /not in this block's ceiling/);
    assert.deepEqual(ran, []);
  } finally { await kernel.dispose(); }
});

test('ask, smart and always behave the same for a plugin tool as for a built-in one', async () => {
  for (const [name, classification] of [['a_builtin', CLASSIFIED_WRITE], ['a_plugin_tool', CLASSIFIED_WRITE]]) {
    const asked = [];
    const { kernel, ctx, ran } = await aKernel({
      mode: 'ask', tool: { name, classification },
      ask: async (_exec, reason) => { asked.push(reason); return false; },
    });
    try {
      const refused = await ctx.tools.execute(aCall(name, [name]));
      assert.match(refused.error, /refused/, `${name} under ask`);
      assert.equal(asked.length, 1, `${name} was put to a person`);
      assert.deepEqual(ran, []);
    } finally { await kernel.dispose(); }
  }
});

test('smart clears a read and stops at a write', async () => {
  const asked = [];
  const kernel = createKernel();
  const ran = [];
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, {
      mode: 'smart',
      ask: async (_exec, reason) => { asked.push(reason); return true; },
    });
    await kernel.ctx.plugin(aPluginContributing({ name: 'read_it', classification: CLASSIFIED_READ }, ran));
    await kernel.ctx.plugin(aPluginContributing({ name: 'write_it', classification: CLASSIFIED_WRITE }, ran));
    await kernel.ctx.plugin(aPluginContributing({ name: 'shell_it', classification: CLASSIFIED_SHELL }, ran));

    await kernel.ctx.tools.execute(aCall('read_it', ['read_it', 'write_it', 'shell_it']));
    assert.deepEqual(asked, [], 'reading did not wake anybody');

    await kernel.ctx.tools.execute(aCall('write_it', ['read_it', 'write_it', 'shell_it']));
    assert.match(asked[0], /write_it: it writes to the workspace/);

    await kernel.ctx.tools.execute(aCall('shell_it', ['read_it', 'write_it', 'shell_it']));
    assert.match(asked[1], /shell_it: it can run shell commands/);
    assert.equal(ran.length, 3, 'all three ran, because this person said yes');
  } finally { await kernel.dispose(); }
});

test('ask with nobody to ask is a denial, not a pass', async () => {
  const { kernel, ctx, ran } = await aKernel({
    mode: 'ask', tool: { name: 'write_notes', classification: CLASSIFIED_WRITE },
    // No `ask` handler: an unattended surface with no way to reach a person.
  });
  try {
    const result = await ctx.tools.execute(aCall('write_notes', ['write_notes']));
    assert.match(result.error, /nobody was available to approve it/);
    assert.deepEqual(ran, [], 'silence is not consent');
  } finally { await kernel.dispose(); }
});

test('unattended runs the call the ceiling already allowed', async () => {
  const { kernel, ctx, ran } = await aKernel({
    mode: 'always', tool: { name: 'write_notes', classification: CLASSIFIED_WRITE },
  });
  try {
    const result = await ctx.tools.execute(aCall('write_notes', ['write_notes']));
    assert.equal(result.content, 'write_notes ran');
    assert.equal(ran.length, 1);
  } finally { await kernel.dispose(); }
});

test('a tool that throws is a failed call, not a failed run', async () => {
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await kernel.ctx.plugin({
      name: 'a-broken-plugin',
      inject: ['tools'],
      apply(ctx) {
        return ctx.tools.register({
          name: 'breaks', description: '', parameters: {}, classification: CLASSIFIED_READ,
          async execute() { throw new Error('the disk is on fire'); },
        });
      },
    });

    const result = await kernel.ctx.tools.execute(aCall('breaks', ['breaks']));
    assert.match(result.error, /the disk is on fire/);
    assert.match(result.content, /the disk is on fire/, 'and the model is told');
  } finally { await kernel.dispose(); }
});

test('a post-execute listener can block a result the tool already produced', async () => {
  const kernel = createKernel();
  const ran = [];
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await kernel.ctx.plugin(aPluginContributing({ name: 'reads_the_web', classification: CLASSIFIED_READ }, ran));
    kernel.ctx.on('tools/post-execute', async () => ({ decision: 'block', reason: 'it leaked a secret' }));

    const result = await kernel.ctx.tools.execute(aCall('reads_the_web', ['reads_the_web']));
    assert.match(result.error, /it leaked a secret/);
    assert.equal(ran.length, 1, 'it ran — blocking a result is not preventing a call');
  } finally { await kernel.dispose(); }
});

test('registering announces itself, and unregistering takes the tool with it', async () => {
  const kernel = createKernel();
  const changes = [];
  try {
    await kernel.ctx.plugin(flytTools);
    kernel.ctx.on('tools/change', () => changes.push(kernel.ctx.tools.list().map(t => t.name)));

    const fiber = await kernel.ctx.plugin(aPluginContributing({ name: 'one', classification: CLASSIFIED_READ }, []));
    assert.deepEqual(changes, [['one']]);

    await fiber.dispose();
    assert.deepEqual(changes[1], [], 'the tool left with the plugin that contributed it');
    assert.equal(kernel.ctx.tools.get('one'), undefined);
  } finally { await kernel.dispose(); }
});

test('a plugin that forgets to return its disposer is still cleaned up after', async () => {
  // What real plugins do: register and move on. The published dsh-skill-badge
  // does exactly this with its own registry, so a tool outliving the plugin
  // that contributed it is not a hypothetical.
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytTools);
    const fiber = await kernel.ctx.plugin({
      name: 'a-forgetful-plugin',
      inject: ['tools'],
      apply(ctx) {
        ctx.tools.register({
          name: 'forgotten', description: '', parameters: {}, classification: CLASSIFIED_READ,
          async execute() { return { content: 'ran' }; },
        });
        // ...and returns nothing.
      },
    });
    assert.ok(kernel.ctx.tools.get('forgotten'));

    await fiber.dispose();
    assert.equal(kernel.ctx.tools.get('forgotten'), undefined,
      'the registration was owned by the fiber, not by the plugin remembering to say so');
  } finally { await kernel.dispose(); }
});

test('two plugins cannot claim the same tool name', async () => {
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(aPluginContributing({ name: 'clash', classification: CLASSIFIED_READ }, []));
    await assert.rejects(
      async () => { await kernel.ctx.plugin(aPluginContributing({ name: 'clash', classification: CLASSIFIED_READ }, [])); },
      /already registered/,
    );
  } finally { await kernel.dispose(); }
});

test('a call for a tool nobody registered is refused, not crashed on', async () => {
  const { kernel, ctx } = await aKernel({});
  try {
    const result = await ctx.tools.execute(aCall('nothing_like_this', ['nothing_like_this']));
    assert.match(result.error, /there is no tool named "nothing_like_this"/);
  } finally { await kernel.dispose(); }
});
