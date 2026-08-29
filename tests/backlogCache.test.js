// list()'s mtime short-circuit (core/backlog.js): a second call with nothing
// changed must read no task files, and an in-second rewrite must still be
// re-read. The correctness edge is mtime's one-second granularity on some
// filesystems: same mtime + same size can hide changed content, so the cache
// only trusts that combination once the mtime is at least a second old — and
// fresh mtimes always force a re-read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backlog } from '../core/backlog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-backlog-cache-'));
const newBacklog = () => new Backlog(path.join(tmp(), '.flyt', 'backlog'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a second list() with nothing changed does no file reads', async () => {
  const backlog = newBacklog();
  backlog.add({ title: 'one', goal: 'g' });
  backlog.add({ title: 'two', goal: 'g' });
  // list() re-reads a file while its mtime is younger than a second (the
  // rounding window), so let that window pass before the first call.
  await sleep(1500);

  const real = fs.readFileSync;
  let reads = 0;
  const under = p => typeof p === 'string' && p.includes(backlog.rootDir);
  fs.readFileSync = (p, ...rest) => {
    if (under(p)) reads += 1;
    return real(p, ...rest);
  };
  try {
    backlog.list();
    const first = reads;
    assert.ok(first >= 2, 'the first list reads the task files');
    reads = 0;
    backlog.list();
    assert.equal(reads, 0, 'a second list with nothing changed reads no files');
  } finally {
    fs.readFileSync = real;
  }
});

test('a task rewritten within the same second as its previous write is still re-read', () => {
  const backlog = newBacklog();
  const task = backlog.add({ title: 'keep me', goal: 'g' });
  const file = path.join(backlog.rootDir, `${task.id}.task.md`);

  // Preserve the filesystem's own representation of this timestamp. APFS can
  // report the Date we set a fraction of a millisecond lower, so comparing it
  // with our requested integer made the fixture itself platform-sensitive.
  const pinned = fs.statSync(file);
  fs.utimesSync(file, pinned.atime, pinned.mtime);
  const baseline = fs.statSync(file);
  const mtime = baseline.mtimeMs;
  const size = baseline.size;

  backlog.list(); // populate the cache with the original parse, keyed on mtime/size

  // Rewrite the task within the same second, forcing the SAME mtime and the
  // SAME size back onto the file — the exact state a one-second-granularity
  // filesystem presents to a reader. The cache must not trust it.
  const rewritten = fs.readFileSync(file, 'utf8').replace('keep me', 'KEEP ME');
  fs.writeFileSync(file, rewritten);
  fs.utimesSync(file, pinned.atime, pinned.mtime);

  assert.equal(fs.statSync(file).mtimeMs, mtime, 'test setup: same mtime');
  assert.equal(fs.statSync(file).size, size, 'test setup: same size');

  // The file is still within the rounding window, so list() has to fall
  // through to a read rather than serve the stale parse.
  const tasks = backlog.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'KEEP ME', 'an in-second rewrite is re-read, not served stale');
});
