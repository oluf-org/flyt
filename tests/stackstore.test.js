import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, parseStack } from '#kernel';
import { apply as coreBlocks } from '../kernel/dist/plugins/blocks-core.js';
import { apply as judgementBlocks } from '../kernel/dist/plugins/blocks-judgement.js';
import { apply as inquiryBlocks } from '../kernel/dist/plugins/blocks-inquiry.js';
import { apply as loopBlocks } from '../kernel/dist/plugins/blocks-loop.js';
import { StackStore, serializeStack } from '../core/stackstore.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-stackstore-'));
const knownUses = new Set([
  'flyt-blocks-core:work', 'flyt-blocks-core:general-analysis',
  'flyt-blocks-judgement:evaluation', 'flyt-blocks-inquiry:orient',
  'flyt-blocks-loop:backlog-plan', 'flyt-blocks-loop:loop-handoff',
]);
const migrationOptions = {
  parseStack,
  resolveBlock: use => knownUses.has(use) ? { use } : null,
};
const allBlocks = async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin({ name: 'migration-core', inject: ['blocks'], apply: coreBlocks });
  await kernel.ctx.plugin({ name: 'migration-judgement', inject: ['blocks'], apply: judgementBlocks });
  await kernel.ctx.plugin({ name: 'migration-inquiry', inject: ['blocks'], apply: inquiryBlocks });
  await kernel.ctx.plugin({ name: 'migration-loop', inject: ['blocks'], apply: loopBlocks });
  return kernel;
};
const legacy = `version: 1
id: old-project
name: Old project
nodes:
  work:
    use: work
    title: Do the work
    instructions: Keep the useful part.
flow:
  - input -> work -> output
`;

test('a legacy flow opens read-only, then retires only after a validated first stack write', () => {
  const dir = root();
  const stacks = path.join(dir, 'stacks');
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  const oldFile = path.join(flows, 'old-project.flow.yaml');
  fs.writeFileSync(oldFile, legacy);
  const store = new StackStore(stacks, migrationOptions);

  assert.deepEqual(store.list(), [{ id: 'old-project', legacy: true }]);
  const opened = store.load('old-project');
  assert.equal(opened.id, 'old-project');
  assert.equal(opened.root.children[0].use, 'flyt-blocks-core:work');
  assert.ok(fs.existsSync(oldFile), 'opening is a read and does not mutate the project');

  const target = store.save('old-project');
  assert.equal(target, path.join(stacks, 'old-project.stack.yaml'));
  assert.ok(!fs.existsSync(oldFile), 'the old source retires only after the new source parsed and wrote');
  assert.equal(parseStack(fs.readFileSync(target, 'utf8'), 'old-project').id, 'old-project');
  assert.deepEqual(store.list(), [{ id: 'old-project', legacy: false }]);
});

test('a canonical stack wins over a same-id legacy flow', () => {
  const dir = root();
  const stacks = path.join(dir, 'stacks');
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(stacks); fs.mkdirSync(flows);
  fs.writeFileSync(path.join(flows, 'same.flow.yaml'), legacy.replaceAll('old-project', 'same'));
  fs.writeFileSync(path.join(stacks, 'same.stack.yaml'), `version: 2\nid: same\nname: Canonical\nblocks:\n  - id: work\n    use: flyt-blocks-core:work\n`);
  const store = new StackStore(stacks, { parseStack });
  assert.deepEqual(store.list(), [{ id: 'same', legacy: false }]);
  assert.equal(store.load('same').name, 'Canonical');
});

test('legacy edge order, not YAML declaration order, becomes the canonical sequence', () => {
  const dir = root();
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  fs.writeFileSync(path.join(flows, 'ordered.flow.yaml'), `version: 1
id: ordered
name: Ordered
nodes:
  second:
    use: general-analysis
  first:
    use: orient
flow:
  - input -> first -> second -> output
`);
  const store = new StackStore(path.join(dir, 'stacks'), migrationOptions);
  const opened = store.load('ordered');
  assert.deepEqual(opened.root.children.map(node => node.id), ['first', 'second']);
});

test('a branching legacy graph is refused rather than silently flattened', () => {
  const dir = root();
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  const oldFile = path.join(flows, 'branched.flow.yaml');
  fs.writeFileSync(oldFile, `version: 1
id: branched
name: Branched
nodes:
  left: { use: general-analysis }
  right: { use: general-analysis }
  merge: { use: combine }
flow:
  - input -> left -> merge -> output
  - input -> right -> merge
`);
  const store = new StackStore(path.join(dir, 'stacks'), migrationOptions);
  assert.throws(() => store.load('branched'), /cannot be flattened safely/);
  assert.ok(fs.existsSync(oldFile), 'a migration refusal never retires the only source');
  assert.ok(!fs.existsSync(path.join(dir, 'stacks', 'branched.stack.yaml')));
});

test('the legacy Loop structural node maps to the registered handoff block', () => {
  const dir = root();
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  fs.writeFileSync(path.join(flows, 'handoff.flow.yaml'), `version: 1
id: handoff
name: Handoff
nodes:
  queue:
    type: loop
    maxTasks: 6
    requireEvidence: true
    waitFor: none
flow:
  - input -> queue -> output
`);
  const store = new StackStore(path.join(dir, 'stacks'), migrationOptions);
  const queue = store.load('handoff').root.children[0];
  assert.equal(queue.use, 'flyt-blocks-loop:loop-handoff');
  assert.equal(queue.config.maxTasks, 6);
  assert.equal(queue.config.requireEvidence, true);
});

test('every use produced by a supported legacy migration resolves through installed plugins', async () => {
  const dir = root();
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  fs.writeFileSync(path.join(flows, 'resolves.flow.yaml'), `version: 1
id: resolves
name: Resolves
nodes:
  orient: { use: orient }
  analyse: { use: general-analysis }
  judge: { use: evaluation }
  plan: { use: backlog-plan }
  handoff: { type: loop }
flow:
  - input -> orient -> analyse -> judge -> plan -> handoff -> output
`);
  const kernel = await allBlocks();
  const store = new StackStore(path.join(dir, 'stacks'), {
    parseStack,
    resolveBlock: use => kernel.ctx.blocks.resolve(use),
  });
  const stack = store.load('resolves');
  for (const node of stack.root.children) {
    assert.ok(kernel.ctx.blocks.resolve(node.use), `${node.id}: ${node.use} must resolve`);
  }
  await kernel.dispose();
});

test('an unknown retired template cannot become a dead canonical stack', () => {
  const dir = root();
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  const oldFile = path.join(flows, 'translate.flow.yaml');
  fs.writeFileSync(oldFile, `version: 1
id: translate
name: Translate
nodes:
  translation:
    use: translation
flow:
  - input -> translation -> output
`);
  const stackFile = path.join(dir, 'stacks', 'translate.stack.yaml');
  const store = new StackStore(path.join(dir, 'stacks'), migrationOptions);

  assert.throws(
    () => store.load('translate'),
    /translation.*flyt-blocks-core:translation.*no installed plugin contributes/s,
  );
  assert.ok(fs.existsSync(oldFile), 'the only source survives a missing block');
  assert.ok(!fs.existsSync(stackFile), 'no dead canonical stack is written');
  assert.throws(() => store.save('translate'), /no installed plugin contributes/);
  assert.ok(fs.existsSync(oldFile), 'a failed first save also preserves the legacy source');
  assert.ok(!fs.existsSync(stackFile));
});

test('saving an edited containment tree stays parseable and stores no layout sidecar', () => {
  const dir = root();
  const store = new StackStore(path.join(dir, 'stacks'), { parseStack });
  const parsed = parseStack(`version: 2
id: nested
name: Nested
blocks:
  - id: parallel
    kind: parallel
    maxParallel: 2
    lanes:
      - id: first
        use: flyt-blocks-core:work
        config:
          tools:
            - read_file
          strict: true
`, 'nested');
  parsed.root.children[0].children[0].config.note = 'line one\nline two';
  const source = serializeStack(parsed);
  store.saveStack(parsed);
  const reopened = store.load('nested');
  assert.deepEqual(reopened.root.children[0].children[0].config, {
    tools: ['read_file'], strict: true, note: 'line one\nline two',
  });
  assert.equal(source, fs.readFileSync(path.join(dir, 'stacks', 'nested.stack.yaml'), 'utf8'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'stacks')), ['nested.stack.yaml']);
});
