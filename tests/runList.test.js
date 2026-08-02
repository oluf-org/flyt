// The runs list: what a run is called (core/state.js deriveRunName +
// RunStore.runSummaries/setRunName/deleteRun) and how the list files it
// (src/runList.js). Both sides are pure/file-only, so they test without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveRunName, UNTITLED_RUN } from '../core/state.js';
import { groupRuns, runStatus, runTimeLabel } from '../src/runList.js';
import { makeStore } from './helpers.js';

// --- naming: a run is called what it was asked to do ---

test('a run is named by the first meaningful line of its prompt', () => {
  assert.equal(deriveRunName('Crash and resume'), 'Crash and resume');
  assert.equal(deriveRunName('\n\n  Refactor the auth module  \nand then some'), 'Refactor the auth module');
});

test('naming strips Markdown decoration rather than showing it', () => {
  assert.equal(deriveRunName('## Ship the release'), 'Ship the release');
  assert.equal(deriveRunName('- **Fix** the `parser` bug'), 'Fix the parser bug');
  assert.equal(deriveRunName('1. Write the docs'), 'Write the docs');
  assert.equal(deriveRunName('> Summarize this thread'), 'Summarize this thread');
});

test('a long prompt is cut at a word boundary, a long token is cut hard', () => {
  const name = deriveRunName('Please go through the entire repository and write a detailed report about every single module you find');
  assert.ok(name.length <= 81, `got ${name.length}: ${name}`);
  assert.ok(name.endsWith('…'));
  assert.ok(!/\s…$/.test(name), 'no dangling space before the ellipsis');
  assert.ok(name.startsWith('Please go through the entire repository'));
  // A single unbroken token has no word boundary worth honouring.
  assert.equal(deriveRunName('x'.repeat(120)), 'x'.repeat(80) + '…');
});

test('an empty or whitespace-only prompt still yields a name', () => {
  assert.equal(deriveRunName(''), UNTITLED_RUN);
  assert.equal(deriveRunName('   \n\n  '), UNTITLED_RUN);
  assert.equal(deriveRunName(null), UNTITLED_RUN);
});

// --- store: summaries, rename, delete ---

test('summaries name every run and come back newest first', () => {
  const store = makeStore();
  const a = store.createRun('First request');
  const b = store.createRun('Second request');
  store.setStage(b, 'done', { flowName: 'Default pipeline' });

  const list = store.runSummaries();
  assert.deepEqual(list.map(r => r.id), [b, a]);
  assert.deepEqual(list.map(r => r.name), ['Second request', 'First request']);
  assert.equal(list[0].stage, 'done');
  assert.equal(list[0].flowName, 'Default pipeline');
  assert.equal(list[0].named, false); // derived, not user-set
});

// Runs created inside one millisecond used to get equal `createdAt` values, and
// equal sort keys left the order to readdir — i.e. to the random id suffix. The
// assertion above passed about four times in five. Creation stamps are now
// strictly increasing, so a tight burst has a defined order.
test('runs created in the same millisecond still order by creation', () => {
  const store = makeStore();
  const ids = Array.from({ length: 25 }, (_, i) => store.createRun(`Request ${i}`));

  assert.deepEqual([...new Set(ids)].length, ids.length, 'ids are unique');
  const stamps = ids.map(id => Date.parse(id.slice(0, 24).replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z')));
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] > stamps[i - 1], `stamp ${i} did not advance`);
  }
  assert.deepEqual(store.runSummaries().map(r => r.id), [...ids].reverse());
});

test('a fresh store keeps stamping forward from the runs already on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-runs-'));
  const a = makeStore(dir).createRun('Before restart');
  // A second store over the same directory is what a relaunch looks like: it
  // must not reissue a millisecond the previous instance already used.
  const b = makeStore(dir).createRun('After restart');
  assert.ok(b > a, `${b} should sort after ${a}`);
  assert.deepEqual(makeStore(dir).runSummaries().map(r => r.id), [b, a]);
});

test('renaming overrides the derived name; blanking it restores the derived one', () => {
  const store = makeStore();
  const id = store.createRun('Crash and resume');

  assert.equal(store.setRunName(id, '  Nightly   smoke test  '), 'Nightly smoke test'); // whitespace collapsed
  let summary = store.runSummaries()[0];
  assert.equal(summary.name, 'Nightly smoke test');
  assert.equal(summary.named, true);

  assert.equal(store.setRunName(id, '   '), 'Crash and resume');
  summary = store.runSummaries()[0];
  assert.equal(summary.name, 'Crash and resume');
  assert.equal(summary.named, false);
  assert.equal('name' in store.readMeta(id), false, 'a blank name is cleared, not stored empty');
});

test('a run with no createdAt in meta still dates itself from its id', () => {
  const store = makeStore();
  const id = store.createRun('Old run');
  const { createdAt, ...withoutCreatedAt } = store.readMeta(id);
  store.writeMeta(id, withoutCreatedAt);

  const summary = store.runSummaries()[0];
  assert.equal(summary.createdAt, createdAt); // the id carries the same instant
});

test('deleting a run removes its folder and drops it from the list', () => {
  const store = makeStore();
  const keep = store.createRun('Keep me');
  const drop = store.createRun('Delete me');

  store.deleteRun(drop);
  assert.equal(fs.existsSync(store.runDir(drop)), false);
  assert.deepEqual(store.runSummaries().map(r => r.id), [keep]);
});

test('delete refuses ids that escape the runs directory', () => {
  const store = makeStore();
  const outside = path.join(store.rootDir, '..', 'not-a-run');
  fs.mkdirSync(outside, { recursive: true });

  // The renderer supplies runId over IPC, so a traversal must not delete a
  // folder that isn't a run in this store.
  assert.throws(() => store.deleteRun('../not-a-run'), /Not a run in this store/);
  assert.throws(() => store.deleteRun('nope'), /Not a run in this store/);
  assert.equal(fs.existsSync(outside), true);
});

// --- grouping: when it happened, in the reader's own calendar ---

const NOW = new Date(2026, 6, 17, 12, 0, 0).getTime(); // Fri 17 Jul 2026, 12:00 local
const at = (days, hours = 12) => new Date(2026, 6, 17 - days, hours, 0, 0).toISOString();
const run = (id, createdAt, extra = {}) => ({ id, name: id, createdAt, stage: 'done', ...extra });
const labels = groups => groups.map(g => g.label);

test('runs are filed into relative date sections', () => {
  const groups = groupRuns([
    run('a', at(0)), run('b', at(1)), run('c', at(3)), run('d', at(20)), run('e', at(60))
  ], NOW);
  assert.deepEqual(labels(groups), ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'May']);
  assert.deepEqual(groups.map(g => g.runs.map(r => r.id)), [['a'], ['b'], ['c'], ['d'], ['e']]);
});

test('section boundaries land on the day, not on 24-hour blocks', () => {
  // 01:00 today is still Today even though it is <24h from 12:00 yesterday.
  assert.deepEqual(labels(groupRuns([run('a', at(0, 1))], NOW)), ['Today']);
  assert.deepEqual(labels(groupRuns([run('a', at(1, 23))], NOW)), ['Yesterday']);
  assert.deepEqual(labels(groupRuns([run('a', at(6))], NOW)), ['Previous 7 days']);
  assert.deepEqual(labels(groupRuns([run('a', at(7))], NOW)), ['Previous 30 days']);
  assert.deepEqual(labels(groupRuns([run('a', at(29))], NOW)), ['Previous 30 days']);
  assert.deepEqual(labels(groupRuns([run('a', at(30))], NOW)), ['June']);
});

test('older years are named with their year; this year is not', () => {
  const groups = groupRuns([run('a', at(60)), run('b', at(400))], NOW);
  assert.deepEqual(labels(groups), ['May', 'June 2025']);
});

test('grouping sorts its own input newest-first and files undated runs last', () => {
  const groups = groupRuns([
    run('old', at(3)), run('bad', 'not-a-date'), run('new', at(0)), run('mid', at(1))
  ], NOW);
  assert.deepEqual(labels(groups), ['Today', 'Yesterday', 'Previous 7 days', 'Undated']);
  assert.deepEqual(groups.at(-1).runs.map(r => r.id), ['bad']);
});

test('runs on the same day share one section, newest first', () => {
  const groups = groupRuns([run('morning', at(0, 9)), run('evening', at(0, 20)), run('noon', at(0, 12))], NOW);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].runs.map(r => r.id), ['evening', 'noon', 'morning']);
});

test('the time label says what the section header does not', () => {
  assert.equal(runTimeLabel(run('a', at(0, 14)), NOW), '14:00');   // Today: time of day
  assert.equal(runTimeLabel(run('a', at(1, 9)), NOW), '09:00');    // Yesterday: still time of day
  assert.equal(runTimeLabel(run('a', at(3)), NOW), 'Jul 14');      // older: the date
  assert.equal(runTimeLabel(run('a', at(400)), NOW), 'Jun 12, 2025');
  assert.equal(runTimeLabel(run('a', 'not-a-date'), NOW), '');
});

// --- status: what the dot and the one word mean ---

test('stage becomes a status the list can show', () => {
  assert.deepEqual(runStatus({ stage: 'done' }), { kind: 'done', label: 'Done' });
  assert.deepEqual(runStatus({ stage: 'failed' }), { kind: 'failed', label: 'Failed' });
  assert.deepEqual(runStatus({ stage: 'rejected' }), { kind: 'rejected', label: 'Rejected' });
  assert.deepEqual(runStatus({ stage: 'awaiting_approval' }), { kind: 'waiting', label: 'Needs approval' });
  assert.deepEqual(runStatus({ stage: 'execution' }), { kind: 'running', label: 'Running' });
  assert.deepEqual(runStatus({ stage: 'planning' }), { kind: 'running', label: 'Planning' });
  assert.equal(runStatus({ stage: 'unknown' }).kind, 'running');
});

test('interrupted describes runs that never finished, not ones that resumed to the end', () => {
  assert.equal(runStatus({ stage: 'execution', interrupted: true }).kind, 'interrupted');
  // A run interrupted, then resumed to completion, is simply Done.
  assert.equal(runStatus({ stage: 'done', interrupted: true }).kind, 'done');
});
