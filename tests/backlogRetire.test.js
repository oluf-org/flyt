// Retirement: a task that is never going to be worked as written, moved out of
// the queue WITH its evidence rather than deleted (t-0079 - t-0082).
//
// `remove()` already existed and destroys; `parked` already existed and lingers
// in the live directory forever. Retirement is the third thing: the task file,
// the run folders it spent, and a written reason move into
// `.flyt/archive/retired/<id>/`, and the task is absent from the live backlog —
// which is what makes it disappear from list(), ready(), score() and stats()
// without any of them being touched.
//
// The location is load-bearing and is the first thing asserted here. It is
// `<state>/archive/retired/<id>`, the same archive root `archive:write`,
// `archive:list` and `trend` are handed — not `<state>/retired/<id>` beside it,
// where nothing that reads the archive would ever find it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backlog } from '../core/backlog.js';
import { listArchive, readRetirement, retiredDir } from '../core/archive.js';

// A project state root with a backlog and a runs directory under it, the same
// shape `.flyt/` has on disk.
function project() {
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-retire-')), '.flyt');
  const backlog = new Backlog(path.join(state, 'backlog'));
  const runs = path.join(state, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  return { state, backlog, runs, archive: path.join(state, 'archive') };
}

// A run folder with something in it, so a MOVE is distinguishable from a
// deletion followed by an empty directory.
function seedRun(runs, runId, marker) {
  const dir = path.join(runs, runId);
  fs.mkdirSync(path.join(dir, 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ runId }));
  fs.writeFileSync(path.join(dir, 'nodes', 'work.md'), marker);
  return dir;
}

test('a retired task lands inside the archive, not beside it', () => {
  const { backlog, archive, state } = project();
  const task = backlog.add({ title: 'Never going to happen', goal: 'x' });

  const out = backlog.retire(task.id, { reason: 'superseded by the v2 rebuild', by: 'olav' });

  assert.equal(out.retired.dir, retiredDir(archive, task.id));
  assert.ok(fs.existsSync(path.join(archive, 'retired', task.id)),
    'the retirement belongs under <state>/archive/retired/<id>');
  assert.ok(!fs.existsSync(path.join(state, 'retired')),
    'nothing may be written to <state>/retired — that is outside the archive');
});

test('retirement keeps the reason, the frontmatter and the work', () => {
  const { backlog, runs, archive } = project();
  const task = backlog.add({
    title: 'Add a search-provider key field',
    goal: 'web_search ships disabled and nothing can switch it on.',
    value: 4, effort: 3, blastRadius: ['src/Settings.jsx']
  });
  backlog.update(task.id, { status: 'parked', attempts: 7, runIds: ['r-one', 'r-two'] });
  seedRun(runs, 'r-one', 'first attempt');
  seedRun(runs, 'r-two', 'seventh attempt');

  backlog.retire(task.id, { reason: 'seven attempts, the ladder is spent', by: 'olav' });

  const record = readRetirement(archive, task.id);
  assert.equal(record.reason, 'seven attempts, the ladder is spent');
  assert.equal(record.retiredBy, 'olav');
  assert.deepEqual(record.movedRunIds, ['r-one', 'r-two']);
  assert.match(record.retiredAt, /^\d{4}-\d{2}-\d{2}T/);

  // The task file is kept verbatim, so the same parser reads it back.
  const archived = fs.readFileSync(
    path.join(retiredDir(archive, task.id), `${task.id}.task.md`), 'utf8');
  assert.match(archived, /attempts: 7/);
  assert.match(archived, /Add a search-provider key field/);

  // The work moved rather than being copied or dropped.
  assert.equal(
    fs.readFileSync(path.join(retiredDir(archive, task.id), 'runs', 'r-two', 'nodes', 'work.md'), 'utf8'),
    'seventh attempt');
  assert.ok(!fs.statSync(path.join(runs, 'r-one')).isDirectory(),
    'the live run folder must not survive a move');
});

test('the run readers can still find a retired run', () => {
  const { backlog, runs } = project();
  const task = backlog.add({ title: 'Gone', goal: 'x' });
  backlog.update(task.id, { runIds: ['r-gone'] });
  seedRun(runs, 'r-gone', 'evidence');

  backlog.retire(task.id, { reason: 'obsolete' });

  // A pointer stub stands where the folder was, so a vanished run reads as
  // relocated rather than as lost.
  const stub = JSON.parse(fs.readFileSync(path.join(runs, 'r-gone'), 'utf8'));
  assert.equal(stub.taskId, task.id);
  assert.ok(fs.existsSync(path.join(stub.archivePath, 'nodes', 'work.md')));
});

test('the live backlog forgets a retired task completely', () => {
  const { backlog } = project();
  const keep = backlog.add({ title: 'Still wanted', goal: 'x' });
  const drop = backlog.add({ title: 'Not wanted', goal: 'x' });

  backlog.retire(drop.id, { reason: 'duplicate of ' + keep.id });

  assert.deepEqual(backlog.list().map(t => t.id), [keep.id]);
  assert.equal(backlog.get(drop.id), null);
  assert.equal(backlog.stats().open, 1);
});

test('a retirement without a reason is refused', () => {
  const { backlog } = project();
  const task = backlog.add({ title: 'Whatever', goal: 'x' });

  assert.throws(() => backlog.retire(task.id, { reason: '' }), /reason/i);
  assert.throws(() => backlog.retire(task.id, { reason: '   ' }), /reason/i);
  assert.ok(backlog.get(task.id), 'a refused retirement leaves the task alone');
});

test('landed work is archived, never retired', () => {
  const { backlog } = project();
  const task = backlog.add({ title: 'Shipped', goal: 'x' });
  backlog.update(task.id, { status: 'landed' });

  assert.throws(() => backlog.retire(task.id, { reason: 'tidying up' }), /landed/);
  assert.ok(backlog.get(task.id));
});

test('retiring reports who it strands, the way removing does', () => {
  const { backlog } = project();
  const base = backlog.add({ title: 'The base', goal: 'x' });
  const dependent = backlog.add({ title: 'Waits on it', goal: 'x', dependsOn: [base.id] });

  const out = backlog.retire(base.id, { reason: 'wrong approach' });

  assert.deepEqual(out.stranded.map(s => s.id), [dependent.id]);
});

test('a revived task comes back under its own id, starting over', () => {
  const { backlog, archive } = project();
  const task = backlog.add({ title: 'Worth another look', goal: 'x', value: 5, effort: 2 });
  backlog.update(task.id, {
    status: 'parked', attempts: 3, resumeFrom: 'deadbeef', resumeStage: 'gates'
  });

  backlog.retire(task.id, { reason: 'blocked on a model that could not do it' });
  const revived = backlog.revive(task.id);

  assert.equal(revived.id, task.id, 'the same id: a dependent naming it must resolve again');
  assert.equal(revived.status, 'queued');
  assert.equal(revived.attempts, 3, 'the history is the point');
  assert.equal(revived.value, 5);
  // A stale sha must never be resumed from, and a revived task starts over.
  assert.equal(revived.resumeFrom, null);
  assert.equal(revived.resumeStage, null);
  // A revival is a second life, not an erasure.
  assert.ok(readRetirement(archive, task.id));
});

test('reviving a task that is already in the queue is refused', () => {
  const { backlog } = project();
  const task = backlog.add({ title: 'Back already', goal: 'x' });
  backlog.retire(task.id, { reason: 'mistake' });
  backlog.revive(task.id);

  assert.throws(() => backlog.revive(task.id), /already/);
});

test('reviving something that was never retired says so rather than inventing it', () => {
  const { backlog } = project();
  assert.equal(backlog.revive('t-9999'), null);
});

test('the retired pile never appears in the day archive', () => {
  const { backlog, archive } = project();
  const task = backlog.add({ title: 'Out', goal: 'x' });
  backlog.retire(task.id, { reason: 'out of scope' });

  // listArchive() is keyed on YYYY-MM-DD, so the `retired/` sibling must not
  // read as a day — the trend is a series of days and this is not one.
  assert.deepEqual(listArchive(archive), []);
});

// --- moving a run folder that cannot be renamed ----------------------------
//
// This is not hypothetical: on Windows a directory with an open handle beneath
// it cannot be renamed, Flyt watches `.flyt/runs` to stream a run into the
// canvas, and retiring t-0033's eleven run folders failed EPERM on the first
// one. The tmpdir these tests use has no watcher on it, so the fallback would
// never be exercised by accident — renameSync is stubbed to fail the way the
// real filesystem did.
test('a run folder that refuses to be renamed is still moved', () => {
  const { backlog, runs, archive } = project();
  const task = backlog.add({ title: 'Held open', goal: 'x' });
  backlog.update(task.id, { runIds: ['r-held'] });
  seedRun(runs, 'r-held', 'the evidence');

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try {
    backlog.retire(task.id, { reason: 'the watcher had it open' });
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(
    fs.readFileSync(path.join(retiredDir(archive, task.id), 'runs', 'r-held', 'nodes', 'work.md'), 'utf8'),
    'the evidence', 'the copy carries the run, not just its shell');
  assert.ok(fs.statSync(path.join(runs, 'r-held')).isFile(), 'and a pointer stands where it was');
  assert.deepEqual(readRetirement(archive, task.id).movedRunIds, ['r-held']);
});

test('a failure partway leaves an archive that names what it holds', () => {
  const { backlog, runs, archive } = project();
  const task = backlog.add({ title: 'Two runs, one problem', goal: 'x' });
  backlog.update(task.id, { runIds: ['r-first', 'r-second'] });
  seedRun(runs, 'r-first', 'moved');
  seedRun(runs, 'r-second', 'stuck');

  // The second move fails outright, the way a disk error would.
  const realRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (...args) => {
    if (++n > 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return realRename(...args);
  };
  try {
    assert.throws(() => backlog.retire(task.id, { reason: 'testing the unhappy path' }), /EIO/);
  } finally {
    fs.renameSync = realRename;
  }

  // What moved is recorded, so the archive is not a pile of folders nothing
  // points at — and the task is still in the queue, because it never finished
  // being retired.
  assert.deepEqual(readRetirement(archive, task.id).movedRunIds, ['r-first']);
  assert.ok(backlog.get(task.id), 'a retirement that threw must not have removed the task');
});

test('retiring again after a partial failure finishes the job', () => {
  const { backlog, runs, archive } = project();
  const task = backlog.add({ title: 'Resumed', goal: 'x' });
  backlog.update(task.id, { runIds: ['r-a', 'r-b'] });
  seedRun(runs, 'r-a', 'a');
  seedRun(runs, 'r-b', 'b');

  const realRename = fs.renameSync;
  let n = 0;
  fs.renameSync = (...args) => {
    if (++n > 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return realRename(...args);
  };
  try { backlog.retire(task.id, { reason: 'first go' }); } catch { /* expected */ }
  finally { fs.renameSync = realRename; }

  backlog.retire(task.id, { reason: 'second go' });

  // Both runs are named, not just the one this pass happened to move.
  assert.deepEqual(readRetirement(archive, task.id).movedRunIds.sort(), ['r-a', 'r-b']);
  assert.equal(backlog.get(task.id), null);
});
