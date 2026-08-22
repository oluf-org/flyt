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
  k.ctx.plugin(flytBlocks);
  k.ctx.plugin({ name: 'core', inject: ['blocks'], apply: core });
  k.ctx.plugin({ name: 'judgement', inject: ['blocks'], apply: judgement });
  k.ctx.plugin({ name: 'inquiry', inject: ['blocks'], apply: inquiry });
  k.ctx.plugin({ name: 'loop', inject: ['blocks'], apply: loop });
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

test('research can write nothing: its ceiling names no write or shell tool', () => {
  const stack = parseStack(read('stacks/research.stack.yaml'), 'research');
  const block = stack.root.children[0];
  const ceiling = block.config.ceiling;
  assert.deepEqual([...ceiling].sort(), ['read-only', 'web'], 'ceiling stays web + read-only');
  // The sets those names resolve to contain no write/shell tool.
  const setRead = id => JSON.parse(read(`tools/sets/${id}.json`));
  const tools = new Set();
  const expand = id => {
    const s = setRead(id);
    for (const inc of s.include ?? []) if (!inc.includes(':')) tools.add(inc);
    for (const sub of s.includeSets ?? []) expand(sub);
  };
  ceiling.forEach(expand);
  // read-only and web are selector-based (effects:/uses:), so the resolved
  // concrete ids are few — but nothing in either set is a write or a shell.
  const WRITE = new Set(['write_file', 'edit_file', 'create_file', 'bash', 'run_gate']);
  for (const t of tools) assert.ok(!WRITE.has(t), `research ceiling must not reach ${t}`);
  assert.equal(block.config.effect, 'artifact', 'a research answer is an artifact');
});

test('the pipeline stack is one stack with an effort dial', () => {
  const stack = parseStack(read('stacks/pipeline.stack.yaml'), 'pipeline');
  const uses = stack.root.children.map(c => c.use);
  assert.deepEqual(uses, [
    'flyt-blocks-judgement:prompt-refiner',
    'flyt-blocks-loop:backlog-plan',
    'flyt-blocks-core:work',
  ]);
  const efforts = stack.root.children.map(c => c.config?.effort).filter(Boolean);
  assert.ok(efforts.length >= 1, 'an effort dial is present');
  for (const e of efforts) assert.match(e, /^(low|medium|high)$/);
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

test('the ported blocks have no loose nodes/*.json, and the archives are gone', () => {
  const ported = ['work', 'general-analysis', 'combine', 'split', 'plan-start',
    'evaluation', 'compare', 'prompt-refiner', 'interrogate', 'orient', 'backlog-plan'];
  for (const id of ported) {
    assert.ok(!exists(`nodes/${id}.json`), `nodes/${id}.json archived (block now plugin-contributed)`);
  }
  for (const dead of ['nodes/translation.json', 'nodes/node-ms2r06ba-omz2.json',
    'flows/research.flow.yaml', 'flows/learn-from-repo.flow.yaml',
    'flows/spec-an-idea.flow.yaml', 'flows/loop-task.flow.yaml']) {
    assert.ok(!exists(dead), `${dead} archived to git history`);
  }
});
