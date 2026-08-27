import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const run = args => spawnSync(process.execPath, ['core/stacklint.js', ...args], {
  cwd: ROOT, encoding: 'utf8',
});

test('the shipped linter parses every canonical stack', () => {
  const result = run(['lint', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.files.map(file => file.file), [
    'stacks/learn-from-repo.stack.yaml',
    'stacks/loop-task.stack.yaml',
    'stacks/pipeline.stack.yaml',
    'stacks/research.stack.yaml',
    'stacks/spec-an-idea.stack.yaml',
  ]);
  assert.ok(report.files.every(file => file.ok && file.id));
});

test('the linter exits red and names a malformed stack', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-stacklint-'));
  const file = path.join(dir, 'broken.stack.yaml');
  fs.writeFileSync(file, 'version: 2\nid: broken\nname: Broken\nblocks:\n  - id: nope\n');
  const result = run(['lint', file, '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.files[0].error, /use/);
});
