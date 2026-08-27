import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseStack } from '#kernel';
import { StackStore, serializeStack } from '../core/stackstore.js';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-stackstore-'));
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
  const store = new StackStore(stacks, { parseStack });

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
