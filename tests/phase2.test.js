// Phase 2 (t-0037): the canonical set ported to plugins and stacks.
//
// The contract, asserted rather than assumed:
//  - five stacks exist and parse on the v2 grammar, and every block each names
//    resolves to a block a PLUGIN contributes (no loose nodes/*.json);
//  - research's ceiling is web + read-only and it can write nothing;
//  - the tool plugins are deliveries and the six sets are ceilings on top,
//    and the two are not conflated;
//  - the ported nodes and flows are archived out of the working tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, parseStack, flytBlocks } from '#kernel';
import * as flytBlocksCore from '#kernel';
import { apply as core } from '../kernel/dist/plugins/blocks-core.js';
import { apply as judgement } from '../kernel/dist/plugins/blocks-judgement.js';
import { apply as inquiry } from '../kernel/dist/plugins/blocks-inquiry.js';
import { apply as loop } from '../kernel/dist/plugins/blocks-loop.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

/** A registry with every block plugin installed, the way a profile composes them. */
async function registryWithAll() {
  const k = createKernel();
  await k.ctx.plugin(flytBlocks);
  await k.ctx.plugin({ name: 'core', inject: ['blocks'], apply: core });
  await k.ctx.plugin({ name: 'judgement', inject: ['blocks'], apply: judgement });
  await k.ctx.plugin({ name: 'inquiry', inject: ['blocks'], apply: inquiry });
  await k.ctx.plugin({ name: 'loop', inject: ['blocks'], apply: loop });
  // sessions is injected but unused by register; provide a stub so apply runs.
  return k;
}

const FIVE = ['loop-task', 'research', 'learn-from-repo', 'spec-an-idea', 'pipeline'];

test('five stacks exist in the new world and each parses', () => {
  for (const id of FIVE) {
    const file = `stacks/${id}.stack.yaml`;
    assert.ok(exists(file), `${file} exists`);
    const stack = parseStack(read(file), id);
    assert.equal(stack.version, 2);
    assert.equal(stack.id, id);
    assert.ok(stack.root.children.length >= 1, `${id} has blocks`);
  }
});

test('every block every stack names resolves through a plugin, not loose JSON', async () => {
  const k = await registryWithAll();
  for (const id of FIVE) {
    const stack = parseStack(read(`stacks/${id}.stack.yaml`), id);
    const walk = n => [n, ...(n.children ?? []).flatMap(walk)];
    for (const node of walk(stack.root)) {
      if (node.kind !== 'block') continue;
      const def = k.ctx.blocks.resolve(node.use);
      assert.ok(def, `${id}: block "${node.id}" use "${node.use}" is contributed by an installed plugin`);
      assert.match(node.use, /^flyt-blocks-(core|judgement|inquiry|loop):/,
        `${id}: "${node.use}" comes from a plugin namespace`);
    }
  }
  await k.dispose();
});

test('research reaches every web reader and no write, shell, destructive, or queue capability', async () => {
  const stack = parseStack(read('stacks/research.stack.yaml'), 'research');
  const block = stack.root.children[0];
  assert.equal(block.use, 'flyt-blocks-core:research');
  const k = await registryWithAll();
  const ceiling = new Set(k.ctx.blocks.resolve(block.use).ceiling);
  for (const required of [
    'web_search', 'web_fetch', 'scrape_page', 'extract_page',
    'read_file', 'glob', 'search_files', 'search_references', 'read_tool_result',
  ]) assert.ok(ceiling.has(required), `research must reach ${required}`);
  for (const forbidden of [
    'write_file', 'edit_file', 'create_file', 'bash', 'run_gate',
    'create_task', 'enqueue_task', 'update_task', 'write_task_md',
  ]) assert.ok(!ceiling.has(forbidden), `untrusted web content must not reach ${forbidden}`);
  assert.equal(block.config.effect, 'artifact', 'a research answer is an artifact');
  await k.dispose();
});

test('learn-from-repo keeps its canonical orientation, parallel reading, combination, synthesis, planning, and handoff', () => {
  const stack = parseStack(read('stacks/learn-from-repo.stack.yaml'), 'learn-from-repo');
  const [orient, readers, combine, synthesise, plan, handoff] = stack.root.children;
  assert.deepEqual(stack.root.children.map(node => node.id), [
    'orient', 'read', 'combine', 'synthesise', 'plan', 'handoff',
  ]);
  assert.equal(orient.use, 'flyt-blocks-inquiry:orient');
  assert.equal(orient.config.effort, 'high');
  assert.match(orient.config.instructions, /bounded survey/i);
  assert.equal(readers.kind, 'parallel');
  assert.deepEqual(readers.children.map(node => node.id), [
    'read-architecture', 'read-practices', 'read-adversarial',
  ]);
  for (const reader of readers.children) {
    assert.equal(reader.use, 'flyt-blocks-core:general-analysis');
    assert.match(reader.config.instructions, /file and a line you actually opened/);
  }
  assert.equal(combine.use, 'flyt-blocks-core:combine');
  assert.equal(synthesise.use, 'flyt-blocks-core:general-analysis');
  assert.match(synthesise.config.instructions, /Where two lanes disagree/);
  assert.match(synthesise.config.instructions, /what is relevant here/);
  assert.equal(plan.use, 'flyt-blocks-loop:backlog-plan');
  assert.match(plan.config.instructions, /Confirm every path in blastRadius/);
  assert.match(plan.config.instructions, /reference:<name>\/<path>/);
  assert.equal(handoff.use, 'flyt-blocks-loop:loop-handoff');
});

test('the pipeline stack has explicit tier choices and an optional human boundary', () => {
  const stack = parseStack(read('stacks/pipeline.stack.yaml'), 'pipeline');
  const uses = stack.root.children.map(c => c.use);
  assert.deepEqual(uses, [
    'flyt-blocks-judgement:prompt-refiner',
    'flyt-blocks-judgement:human-checkpoint',
    'flyt-blocks-loop:backlog-plan',
    'flyt-blocks-core:work',
  ]);
  assert.deepEqual(stack.root.children.map(c => c.config?.modelTier ?? null), [
    'free', null, 'frontier', 'standard',
  ]);
  assert.equal(stack.root.children[1].config.enabled, true);
  const efforts = stack.root.children.map(c => c.config?.effort).filter(Boolean);
  assert.ok(efforts.length >= 1, 'an effort dial is present');
  for (const e of efforts) assert.match(e, /^(low|medium|high)$/);
});

test('every shipped model-backed block has an authored model tier', async () => {
  const k = await registryWithAll();
  for (const id of FIVE) {
    const stack = parseStack(read(`stacks/${id}.stack.yaml`), id);
    const walk = node => [node, ...(node.children ?? []).flatMap(walk), ...(node.else ?? []).flatMap(walk)];
    for (const node of walk(stack.root)) {
      if (node.kind !== 'block') continue;
      const definition = k.ctx.blocks.require(node.use);
      const modelBacked = Boolean(definition.settings?.properties?.model);
      if (modelBacked) assert.match(node.config.modelTier, /^(free|economy|standard|frontier)$/,
        `${id}:${node.id} has an explicit stable tier`);
    }
  }
  await k.dispose();
});

test('tool plugins are deliveries and the sets are ceilings, not conflated', () => {
  const index = JSON.parse(read('plugins/index.json'));
  for (const name of index.plugins.filter(p => p.startsWith('flyt-tools-'))) {
    const manifest = read(`plugins/${name}/plugin.yaml`);
    assert.match(manifest, /kind: tool-plugin/);
    // A delivery lists tools; a grant lists ceilings. Both present, kept apart.
    assert.match(manifest, /tools:/, `${name} delivers tools`);
    assert.match(manifest, /ceilings:/, `${name} names the ceilings on top`);
  }
  // The six sets survive as ceilings.
  for (const set of ['none', 'read-only', 'repo-write', 'repo-full', 'web', 'loop']) {
    assert.ok(exists(`tools/sets/${set}.json`), `set ${set} survives`);
  }
});

test('the cutover archives v1 file assets while retaining the canonical plugin set', () => {
  const looseNodes = exists('nodes')
    ? fs.readdirSync(path.join(ROOT, 'nodes'), { recursive: true }).filter(file => String(file).endsWith('.json'))
    : [];
  assert.deepEqual(looseNodes, [], 'blocks resolve from plugins, not loose nodes/*.json');
  assert.equal(exists('flows'), false, 'v1 flow assets retire to git history');
  for (const id of FIVE) assert.ok(exists(`stacks/${id}.stack.yaml`), `${id} remains canonical`);
  for (const file of fs.readdirSync(path.join(ROOT, 'stacks'))) {
    assert.ok(!file.endsWith('.layout.json'), `stacks/${file}: layout is derived`);
  }
});
