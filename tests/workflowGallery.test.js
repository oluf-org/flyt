// Build's landing, and the one standard the modes on it follow.
//
// Two things are held here. The first is that Build is a destination with two
// views — every workflow, and one of them — and that New and Duplicate are the
// same act with a different starting point. The second is the modes rule, which
// is stated in three places that must not drift: the kernel (which the runner
// applies), the renderer (which the picker and Build read), and the shipped
// Pipeline stack that has to make sense under both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPresetId, parseStack } from '#kernel';
import { StackStore, serializeStack } from '../core/stackstore.js';
import { bootKernel } from '../core/v2.js';
import {
  createV2BuildController, rewriteStackIdentity, starterWorkflowSource, workflowIdFrom,
} from '../core/v2Host.js';
import { buildSurface } from '../src/v2/buildSurface.js';
import { BUILD, WORK, builderView, closeWorkflow, navigate, openWorkflow, state } from '../src/v2/shellRouting.js';
import { defaultModeId, workflowModes } from '../src/workflowModes.js';
import { initialModeId } from '../src/v2/dailyWorkModel.js';
import { changedLabel, galleryRows } from '../src/v2/workflowGalleryModel.js';

const src = p => fs.readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

const workspace = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('Build is two views, and which one is a property of the location', () => {
  // The gallery is what Build shows until a workflow is addressed, exactly as
  // Work shows no Trace until a run is. Keeping it in the location is what
  // makes leaving Build and coming back land on the same workflow.
  assert.equal(builderView({ dest: BUILD, run: null, workflow: null }), 'gallery');
  assert.equal(builderView({ dest: BUILD, run: null, workflow: 'pipeline' }), 'editor');

  const opened = openWorkflow({ dest: WORK, run: 'run-9', workflow: null }, 'pipeline');
  assert.deepEqual(opened, { dest: BUILD, run: 'run-9', workflow: 'pipeline' });
  // Walking away and back carries both addresses; only the back button drops
  // the workflow, and it drops nothing else.
  const away = navigate(opened, WORK);
  assert.equal(state(away).workflow, 'pipeline');
  assert.equal(state(navigate(away, BUILD)).builder, 'editor');
  assert.deepEqual(closeWorkflow(opened), { dest: BUILD, run: 'run-9', workflow: null });
});

test('the gallery lists newest first, searches modes, and dates only what it knows', () => {
  const rows = [
    { id: 'a', name: 'Alpha', description: '', updatedAt: '2026-01-01T00:00:00.000Z', presets: [] },
    { id: 'b', name: 'Beta', description: '', updatedAt: '2026-08-01T00:00:00.000Z', presets: [] },
    { id: 'c', name: 'Gamma', description: 'plan things', updatedAt: null, presets: [{ id: 'high', name: 'High' }] },
  ];
  assert.deepEqual(galleryRows(rows).map(row => row.id), ['b', 'a', 'c'],
    'a workflow edited a moment ago is the one being worked on');
  assert.deepEqual(galleryRows(rows, 'high').map(row => row.id), ['c'],
    'the thing somebody remembers is often the mode, not the workflow around it');
  assert.deepEqual(galleryRows(rows, 'nothing here'), []);
  assert.equal(changedLabel(null), '', 'no timestamp is not a date to invent');
  assert.equal(changedLabel(new Date(Date.now() - 3 * 60 * 1000).toISOString()), '3 min ago');
});

test('one rule about which mode is default, stated in the kernel and the renderer alike', () => {
  const source = `version: 2
id: shaped
name: Shaped
launchable: true
presets:
  low:
    name: Low
    overrides:
      work:
        effort: low
  medium:
    name: Medium
    default: true
    overrides:
      work:
        effort: medium
blocks:
  - id: work
    use: flyt-blocks-core:work
`;
  const stack = parseStack(source, 'shaped');
  assert.equal(defaultPresetId(stack), 'medium', 'the marked mode is the default');
  assert.equal(defaultModeId(stack), 'medium', 'and the renderer says the same about the same stack');
  // Over IPC the same modes arrive as a list. One rule, two shapes.
  assert.equal(defaultModeId({ presets: [{ id: 'low' }, { id: 'medium', default: true }] }), 'medium');

  const unmarked = parseStack(source.replace('    default: true\n', ''), 'shaped');
  assert.equal(defaultPresetId(unmarked), 'low', 'with none marked, the first one written is it');
  assert.equal(defaultModeId(unmarked), 'low');
  assert.equal(defaultPresetId({ presets: {} }), null, 'a workflow with no modes runs as authored');

  // Two claims is a file that does not say how it runs, so it is refused
  // rather than settled by declaration order.
  assert.throws(() => parseStack(source.replace('  low:\n    name: Low\n', '  low:\n    name: Low\n    default: true\n'), 'shaped'),
    /both claim "default"/);

  // And the default survives the round trip Build writes through.
  assert.match(serializeStack(stack), /^\s+default: true$/m);
  assert.equal(defaultPresetId(parseStack(serializeStack(stack), 'shaped')), 'medium');
  assert.equal((serializeStack(stack).match(/default:/g) ?? []).length, 1,
    'the modes that did not claim it stay silent about it');
});

test('a workflow with modes always runs in one of them', () => {
  const flow = {
    id: 'pipeline',
    presets: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium', default: true }],
  };
  // The composer opens on the default rather than on "no mode", because the
  // runner has no such way to run it.
  assert.equal(initialModeId([flow], 'pipeline', null), 'medium');
  assert.equal(initialModeId([flow], 'pipeline', 'low'), 'low', 'a saved choice is still a choice');
  assert.equal(initialModeId([flow], 'pipeline', 'renamed-away'), 'medium',
    'a mode that left the file must not leave the picker pointing at a refusal');
  assert.equal(initialModeId([{ id: 'research', presets: [] }], 'research', null), null,
    'a workflow with no modes has no mode to preselect');
  assert.deepEqual(workflowModes(flow).map(mode => mode.default), [false, true]);
});

test('the shipped Pipeline is one graph with three modes, and says which one runs', () => {
  const root = fileURLToPath(new URL('../stacks/pipeline.stack.yaml', import.meta.url));
  const stack = parseStack(fs.readFileSync(root, 'utf8'), 'pipeline');
  assert.deepEqual(Object.keys(stack.presets), ['low', 'medium', 'high']);
  assert.equal(defaultPresetId(stack), 'medium');
  for (const [id, preset] of Object.entries(stack.presets)) {
    // A mode may only reach settings of blocks that already exist. Anything
    // that needs another shape is another workflow.
    for (const blockId of Object.keys(preset.overrides)) {
      const target = [...stack.root.children].find(node => node.id === blockId);
      assert.ok(target && target.kind === 'block', `${id} overrides ${blockId}, which must be an authored block`);
    }
  }
});

test('New and Duplicate are one act, and neither writes over an existing workflow', async () => {
  const dir = workspace('flyt-gallery-host-');
  const stacks = new StackStore(path.join(dir, 'stacks'), { parseStack });
  stacks.save('pipeline', `version: 2
id: pipeline
name: Pipeline
description: The original
launchable: true
presets:
  medium:
    name: Medium
    default: true
    overrides:
      work:
        effort: medium
blocks:
  - id: work
    use: flyt-blocks-core:work
    config:
      instructions: |
        Keep this prose, and the shape of the file it is written in.
`);
  const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs') });
  const controller = await createV2BuildController(booted, { stacks });
  try {
    const created = controller.create({ name: 'Review a change', description: 'Read a diff.' });
    assert.equal(created.stackId, 'review-a-change', 'the id is derived from the name, never asked for twice');
    assert.equal(created.stack.id, 'review-a-change', 'and the new workflow is what Build now has open');
    assert.equal(created.validation.ok, true, 'a starter that does not parse is not a starter');
    assert.ok(created.stack.launchable, 'a workflow is made to be run');
    assert.equal(created.stack.root.children.length, 1, 'one step: the palette is right there');

    const copy = controller.create({ name: 'Pipeline', from: 'pipeline' });
    assert.equal(copy.stackId, 'pipeline-2', 'a name already taken gets a suffix, not an overwrite');
    assert.equal(copy.stack.name, 'Pipeline');
    assert.equal(defaultPresetId(copy.stack), 'medium', 'a copy carries its modes, default and all');
    const copied = stacks.loadSource('pipeline-2');
    assert.match(copied, /instructions: \|/,
      'a duplicate is a text copy: the prose block a person wrote comes back as they wrote it');
    assert.equal(stacks.loadSource('pipeline').includes('id: pipeline\n'), true, 'the original is untouched');

    assert.throws(() => stacks.create('pipeline', 'version: 2\nid: pipeline\nname: x\nblocks: []\n'),
      /already exists/, 'create refuses to be save');
    assert.throws(() => controller.create({ name: '   ' }), /needs a name/);

    // The whole list Build's gallery draws, from the same snapshot the editor
    // reads — including the mode rows the cards show.
    const rows = controller.snapshot().library.stacks;
    assert.deepEqual(rows.map(row => row.id).sort(), ['pipeline', 'pipeline-2', 'review-a-change']);
    const pipeline = rows.find(row => row.id === 'pipeline');
    assert.equal(pipeline.presets[0].default, true);
    assert.deepEqual(pipeline.presets[0].targets, ['work'], 'a card can say what a mode changes');
    assert.ok(pipeline.updatedAt, 'a gallery sorted by recency needs a date to sort by');
    assert.equal(pipeline.error, null);
  } finally {
    controller.dispose();
    await booted.dispose();
  }
});

test('a workflow the registry cannot read is listed with its reason, not hidden', async () => {
  const dir = workspace('flyt-gallery-broken-');
  const stacks = new StackStore(path.join(dir, 'stacks'), { parseStack });
  fs.writeFileSync(path.join(dir, 'stacks', 'broken.stack.yaml'), 'version: 2\nid: broken\nname: Broken\nblocks: nonsense\n');
  const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs') });
  const controller = await createV2BuildController(booted, { stacks });
  try {
    const row = controller.snapshot().library.stacks.find(item => item.id === 'broken');
    assert.ok(row, 'hiding it makes the file look deleted');
    assert.ok(row.error, 'and naming the reason is what lets somebody repair it');
    assert.equal(row.blockCount, null);
  } finally {
    controller.dispose();
    await booted.dispose();
  }
});

test('the gallery reaches the host through the same surface the editor does', async () => {
  const dir = workspace('flyt-gallery-bridge-');
  const stacks = new StackStore(path.join(dir, 'stacks'), { parseStack });
  stacks.save('pipeline', 'version: 2\nid: pipeline\nname: Pipeline\nlaunchable: true\nblocks:\n  - id: work\n    use: flyt-blocks-core:work\n');
  const booted = await bootKernel({ call: true, env: {}, profile: 'flyt-desktop', runsRoot: path.join(dir, 'runs') });
  const controller = await createV2BuildController(booted, { stacks });
  try {
    const surface = await buildSurface({
      v2Build: () => controller.snapshot(),
      v2OpenStack: (id, caller) => controller.open(id, caller),
      v2CreateStack: (input, caller) => controller.create(input, caller),
    });
    const made = await surface.createStack({ name: 'Second workflow' });
    assert.equal(made.stackId, 'second-workflow');
    // The live surface must move with it: a New button that leaves Build
    // editing the previous workflow has not finished what it started.
    assert.equal(surface.stack.id, 'second-workflow');
    assert.ok(surface.library.stacks.some(row => row.id === 'second-workflow'),
      'and the list the gallery draws comes from the same reply');
    await surface.onAct({ kind: 'stack', action: 'open', id: 'pipeline' });
    assert.equal(surface.stack.id, 'pipeline');
  } finally {
    controller.dispose();
    await booted.dispose();
  }
});

test('ids, starters and copies are derived rather than demanded', () => {
  assert.equal(workflowIdFrom('Review a change'), 'review-a-change');
  assert.equal(workflowIdFrom('  ***  '), 'workflow', 'a name with nothing filable in it still files');
  assert.equal(workflowIdFrom('Pipeline', ['pipeline', 'pipeline-2']), 'pipeline-3');

  const blocks = { resolve: use => use === 'flyt-blocks-core:work' ? { use, title: 'Work' } : null, list: () => [] };
  const starter = starterWorkflowSource({ id: 'new-one', name: 'New one', blocks });
  assert.match(starter, /use: flyt-blocks-core:work/);
  assert.match(starter, /launchable: true/);
  assert.throws(() => starterWorkflowSource({ id: 'x', name: 'X', blocks: { list: () => [] } }),
    /no blocks/, 'a starter naming a block this profile lacks would parse and never run');

  const rewritten = rewriteStackIdentity('version: 2\nid: pipeline\nname: "Pipeline"\nblocks:\n  - id: name\n    use: x\n',
    { id: 'copy', name: 'Pipeline copy' });
  assert.match(rewritten, /^id: copy$/m);
  assert.match(rewritten, /^name: "Pipeline copy"$/m);
  assert.match(rewritten, /^ {2}- id: name$/m, 'only the file\'s own identity lines move');
});

test('Build renders its gallery from the routing contract, not from its own memory', () => {
  const shell = src('v2/Shell.jsx');
  assert.match(shell, /builderView\(loc\) === 'gallery'/,
    'the view is asked of the location, so the rail and the back button cannot disagree');
  assert.match(shell, /<WorkflowGallery/);
  assert.match(shell, /onBack=\{\(\) => move\(closeWorkflow\(loc\)\)\}/);
  // Opening a workflow is two things — the host loads it, the location names
  // it — and doing only the first is how the editor used to disagree with the
  // list that was pressed.
  assert.match(shell, /await build\?\.onAct\?\.\(\{ kind: 'stack', action: 'open', id \}\);[\s\S]{0,80}openWorkflow\(loc, id\)/);
});
