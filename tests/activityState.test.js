import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore } from './helpers.js';

test('tool edges live in existing meta, are ordered, argument-free, and lifecycle-cleared', () => {
  const store = makeStore();
  const runId = store.createRun('activity state');

  store.writeToolActivity(runId, 'node-b', { tool: 'bash', active: true, args: { command: 'PRIVATE' } });
  store.writeToolActivity(runId, 'node-a', { tool: 'read_file', subject: 'src/safe.txt', active: true, args: { path: 'secret.txt' } });
  store.writeToolActivity(runId, 'node-b', { tool: 'bash', active: false });

  let activity = store.snapshot(runId).meta.toolActivity;
  assert.equal(activity['node-a'].active, true);
  assert.equal(activity['node-a'].sequence, 2);
  assert.equal(activity['node-b'].sequence, 3, 'a revisited node receives the newest ordering edge');
  assert.equal(activity['node-a'].subject, 'src/safe.txt');
  assert.deepEqual(Object.keys(activity['node-a']).sort(), ['active', 'at', 'sequence', 'subject', 'tool']);

  const persisted = fs.readFileSync(path.join(store.runDir(runId), 'meta.json'), 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE|secret\.txt/);

  // This is the crash/resume contract: any lifecycle transition clears an
  // edge left active by an interrupted process before resumed work is shown.
  store.writeMeta(runId, { ...store.readMeta(runId), interrupted: true });
  activity = store.readMeta(runId).toolActivity;
  assert.equal(activity['node-a'].active, false);
  store.writeMeta(runId, { ...store.readMeta(runId), interrupted: false, stage: 'execution' });
  assert.equal(store.readMeta(runId).toolActivity['node-a'].active, false);
});

test('activity projection is a no-op when a standalone tool has no run metadata', () => {
  const store = makeStore();
  assert.equal(store.writeToolActivity('not-a-run', 'node', { tool: 'glob', active: true }), null);
});
