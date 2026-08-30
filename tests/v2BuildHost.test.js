import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootKernel } from '../core/v2.js';
import { createV2BuildController, createV2HostBridge } from '../core/v2Host.js';
import { StackStore } from '../core/stackstore.js';
import { parseStack } from '#kernel';
import { buildSurface } from '../src/v2/buildSurface.js';

test('an in-process Build surface refreshes its live stack after a command', async () => {
  let stack = { id: 'preview', root: { id: 'root', kind: 'sequence', children: [] } };
  const subscribers = new Set();
  const raw = {
    get stack() { return stack; },
    commands: {
      async invoke(name, args, caller) {
        stack = { ...stack, name: args.name };
        const record = { command: name, args, caller };
        for (const listener of subscribers) listener(record);
      },
      subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    },
  };
  const surface = await buildSurface({ v2Build: async () => raw });
  const unsubscribe = surface.commands.subscribe(() => {});
  await surface.commands.invoke('stack:rename', { name: 'Updated preview' }, 'human');
  assert.equal(surface.stack.name, 'Updated preview');
  unsubscribe();
});

test('the desktop Build bridge opens, edits, and persists a real canonical stack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-build-'));
  const store = new StackStore(path.join(dir, 'stacks'), { parseStack });
  store.save('pipeline', `version: 2
id: pipeline
name: Pipeline
blocks:
  - id: work
    use: flyt-blocks-core:work
    config:
      effort: medium
`);
  const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs') });
  const controller = await createV2BuildController(booted, { stacks: store });
  const bridge = createV2HostBridge(booted, { build: () => controller.snapshot() });
  const subscribers = new Set();
  const detach = controller.subscribe(record => { for (const listener of subscribers) listener(record); });
  const host = {
    v2Build: () => bridge.build(),
    v2OpenStack: (id, caller) => controller.open(id, caller),
    v2InvokeCommand: (name, args, caller) => controller.invoke(name, args, caller),
    onV2Command(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };

  try {
    const raw = bridge.build();
    assert.doesNotThrow(() => structuredClone(raw), 'IPC payload contains data, never executors or handlers');
    assert.ok(Array.isArray(raw.blocks));
    assert.equal(raw.blocks.some(block => block.execute), false);

    const surface = await buildSurface(host);
    assert.equal(surface.stack.id, 'pipeline');
    assert.equal(surface.blocks.resolve('flyt-blocks-core:work').title, 'Work');
    assert.ok(surface.library.stacks.some(stack => stack.id === 'pipeline'));
    assert.ok(surface.library.plugins.some(plugin => plugin.id === 'blocks-core' && plugin.builtin),
      'the Library is projected from the managed profile that supplied its blocks');
    let event = null;
    const unsubscribe = surface.commands.subscribe(record => { event = record; });
    await surface.commands.invoke('stack:configure-block', {
      nodeId: 'work', config: { effort: 'high', instructions: 'Persist this.' },
    }, 'human');
    assert.equal(event.caller, 'human');
    assert.equal(surface.stack.root.children[0].config.effort, 'high', 'the pushed tree replaces the IPC snapshot');
    assert.equal(store.load('pipeline').root.children[0].config.instructions, 'Persist this.');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stacks')), ['pipeline.stack.yaml'], 'editing creates no layout state');
    unsubscribe();
  } finally {
    detach(); controller.dispose(); await booted.dispose();
  }
});

test('removing a step is allowed when an unrelated pre-existing config error remains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-repair-'));
  const store = new StackStore(path.join(dir, 'stacks'), { parseStack });
  store.save('pipeline', `version: 2
id: pipeline
name: Pipeline
blocks:
  - id: work
    use: flyt-blocks-core:work
    config:
      obsoleteSetting: old-runtime-value
  - id: remove-me
    use: flyt-blocks-judgement:human-checkpoint
`);
  const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs') });
  const controller = await createV2BuildController(booted, { stacks: store });

  try {
    assert.match(controller.snapshot().validation.errors[0].message, /obsoleteSetting: unknown property/);
    await controller.invoke('stack:remove-block', { nodeId: 'remove-me' }, 'human');
    const saved = store.load('pipeline');
    assert.deepEqual(saved.root.children.map(node => node.id), ['work']);
    assert.equal(saved.root.children[0].config.obsoleteSetting, 'old-runtime-value',
      'the repair command preserves, rather than silently deleting, unrelated authored config');
  } finally {
    controller.dispose();
    await booted.dispose();
  }
});

test('Build selects a coexisting legacy flow and retires it only on its first accepted edit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-select-migration-'));
  const stacks = path.join(dir, 'stacks');
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  const setup = new StackStore(stacks, { parseStack });
  setup.save('pipeline', `version: 2
id: pipeline
name: Shipped pipeline
blocks:
  - id: shipped
    use: flyt-blocks-core:general-analysis
`);
  const legacyFile = path.join(flows, 'old-project.flow.yaml');
  const canonicalFile = path.join(stacks, 'old-project.stack.yaml');
  fs.writeFileSync(legacyFile, `version: 1
id: old-project
name: Old project
nodes:
  work:
    use: work
    instructions: Keep this project.
flow:
  - input -> work -> output
`);
  const shippedBefore = fs.readFileSync(path.join(stacks, 'pipeline.stack.yaml'), 'utf8');
  const booted = await bootKernel({
    call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs'),
  });
  const controller = await createV2BuildController(booted, { stackRoot: stacks });
  const bridge = createV2HostBridge(booted, { build: () => controller.snapshot() });
  const subscribers = new Set();
  const detach = controller.subscribe(record => { for (const listener of subscribers) listener(record); });
  const host = {
    v2Build: () => bridge.build(),
    v2OpenStack: (id, caller) => controller.open(id, caller),
    v2InvokeCommand: (name, args, caller) => controller.invoke(name, args, caller),
    onV2Command(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };

  try {
    const surface = await buildSurface(host);
    assert.equal(surface.stack.id, 'pipeline', 'the shipped stack remains the initial selection');
    assert.ok(surface.library.stacks.some(row => row.id === 'old-project'));
    assert.ok(fs.existsSync(legacyFile));
    assert.ok(!fs.existsSync(canonicalFile), 'listing a legacy flow is read-only');

    let event = null;
    const unsubscribe = surface.commands.subscribe(record => { event = record; });
    await surface.onAct({ kind: 'stack', id: 'old-project', action: 'open' });
    assert.equal(event.name, 'stack:open');
    assert.equal(surface.stack.id, 'old-project');
    assert.ok(fs.existsSync(legacyFile), 'opening the selected legacy flow is still read-only');
    assert.ok(!fs.existsSync(canonicalFile));

    await surface.commands.invoke('stack:configure-block', {
      nodeId: 'work', config: { instructions: 'Persist the selected project.' },
    }, 'human');
    assert.equal(surface.stack.id, 'old-project', 'commands follow the active selection');
    assert.equal(surface.stack.root.children[0].config.instructions, 'Persist the selected project.');
    assert.equal(parseStack(fs.readFileSync(canonicalFile, 'utf8'), 'old-project').id, 'old-project');
    assert.ok(!fs.existsSync(legacyFile), 'legacy retires only after canonical persistence succeeds');
    assert.equal(fs.readFileSync(path.join(stacks, 'pipeline.stack.yaml'), 'utf8'), shippedBefore,
      'editing the selected legacy stack does not mutate the shipped pipeline');
    assert.deepEqual(fs.readdirSync(stacks).sort(), ['old-project.stack.yaml', 'pipeline.stack.yaml']);
    unsubscribe();
  } finally {
    detach(); controller.dispose(); await booted.dispose();
  }
});

test('the production Build controller refuses a legacy template absent from its installed registry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-v2-migration-'));
  const stacks = path.join(dir, 'stacks');
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  const legacy = path.join(flows, 'translate.flow.yaml');
  fs.writeFileSync(legacy, `version: 1
id: translate
name: Translate
nodes:
  translation: { use: translation }
flow:
  - input -> translation -> output
`);
  const booted = await bootKernel({
    call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs'),
  });

  try {
    await assert.rejects(
      createV2BuildController(booted, { stackRoot: stacks, preferredId: 'translate' }),
      /flyt-blocks-core:translation.*no installed plugin contributes/s,
    );
    assert.ok(fs.existsSync(legacy), 'production refusal preserves the only source');
    assert.ok(!fs.existsSync(path.join(stacks, 'translate.stack.yaml')));
  } finally {
    await booted.dispose();
  }
});
