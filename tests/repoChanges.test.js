import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureRepoFiles, changedRepoFiles, createRepoChangeTracker, readRepoChanges, resolveChangedRepoPath } from '../core/repoChanges.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-repo-changes-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const store = { runDir: id => path.join(root, 'runs', id) };
  const write = (name, content) => fs.writeFileSync(path.join(workspace, name), content);
  return { root, workspace, store, write };
}

test('tracks edits to already-dirty files, creates/deletes, spaces and binary without staging', async t => {
  const { workspace, write } = fixture(t);
  const git = args => execFileSync('git', args, { cwd: workspace, windowsHide: true, stdio: 'pipe' });
  git(['init']);
  write('dirty.txt', 'old\nkeep\n'); write('removed.txt', 'delete\nme\n');
  git(['add', '.']);
  write('dirty.txt', 'already dirty\nkeep\n');
  const before = await captureRepoFiles(workspace);
  write('dirty.txt', 'new\nkeep\nextra\n');
  write('new file.txt', 'created\n'); write('image.bin', Buffer.from([0, 1, 2]));
  fs.unlinkSync(path.join(workspace, 'removed.txt'));
  const rows = await changedRepoFiles(before, await captureRepoFiles(workspace));
  assert.deepEqual(rows.find(row => row.path === 'dirty.txt'), { path: 'dirty.txt', status: 'modified', added: 2, deleted: 1, binary: false });
  assert.equal(rows.find(row => row.path === 'removed.txt').deleted, 2);
  assert.equal(rows.find(row => row.path === 'new file.txt').status, 'created');
  assert.equal(rows.find(row => row.path === 'image.bin').binary, true);
  assert.equal(git(['show', ':dirty.txt']).toString(), 'old\nkeep\n', 'index remains untouched');
});

test('generated workers share persistent history; failed tools and successive edits remain visible', async t => {
  const { workspace, store, write } = fixture(t);
  write('preexisting.txt', 'untouched\n');
  const tracker = createRepoChangeTracker(store, workspace);
  tracker.initialize('parent');
  await tracker.observe('parent--child-one', 'create_file', 'worker', async () => write('new.txt', 'one\n'));
  await assert.rejects(tracker.observe('parent--child-two', 'bash', 'worker', async () => {
    write('new.txt', 'one\ntwo\n'); throw new Error('command failed after writing');
  }), /command failed/);
  const report = readRepoChanges(store, 'parent');
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].status, 'created');
  assert.equal(report.files[0].added, 2);
  assert.deepEqual(report.files[0].tools, ['create_file', 'bash']);
  assert.equal(resolveChangedRepoPath(store, 'parent', 'new.txt'), fs.realpathSync(path.join(workspace, 'new.txt')));
  assert.throws(() => resolveChangedRepoPath(store, 'parent', '../outside.txt'), /not recorded/);
  await tracker.observe('parent', 'delete_file', 'worker', async () => fs.unlinkSync(path.join(workspace, 'new.txt')));
  assert.equal(readRepoChanges(store, 'parent').files[0].status, 'created then deleted');
  assert.throws(() => resolveChangedRepoPath(store, 'parent', 'new.txt'), /ENOENT/);
});

test('concurrent hosts do not double count each other; no-op tools exclude pre-existing edits', async t => {
  const { workspace, store, write } = fixture(t);
  write('preexisting.txt', 'dirty before either tool\n');
  const a = createRepoChangeTracker(store, workspace), b = createRepoChangeTracker(store, workspace);
  await Promise.all([
    a.observe('parent--child-a', 'create_file', 'a', async () => write('a.txt', 'a\n')),
    b.observe('parent--child-b', 'create_file', 'b', async () => write('b.txt', 'b\n')),
  ]);
  await a.observe('parent', 'bash', 'check', async () => {});
  const report = readRepoChanges(store, 'parent');
  assert.deepEqual(report.files.map(row => [row.path, row.added]), [['a.txt', 1], ['b.txt', 1]]);
});

test('oversized files report unavailable counts and older runs report unavailable history', async t => {
  const { workspace, store, write } = fixture(t);
  const before = await captureRepoFiles(workspace);
  write('large.txt', Buffer.alloc(3 * 1024 * 1024, 65));
  const after = await captureRepoFiles(workspace);
  assert.equal(after.partial, true);
  assert.equal((await changedRepoFiles(before, after))[0].added, null);
  assert.deepEqual(readRepoChanges(store, 'old'), { available: false, files: [] });
});

test('opening rejects a recorded path redirected outside the workspace', async t => {
  const { root, workspace, store, write } = fixture(t);
  fs.mkdirSync(path.join(workspace, 'dir'));
  const tracker = createRepoChangeTracker(store, workspace);
  await tracker.observe('run', 'create_file', 'worker', async () => write('dir/file.txt', 'inside'));
  fs.renameSync(path.join(workspace, 'dir'), path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'dir'), 'junction');
  assert.throws(() => resolveChangedRepoPath(store, 'run', 'dir/file.txt'), /escapes/);
});
