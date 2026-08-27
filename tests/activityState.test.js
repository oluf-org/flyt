import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore } from './helpers.js';

test('tool activity is file-backed, argument-free, ordered, and included in snapshots', () => {
  const store = makeStore();
  const runId = store.createRun('activity state');

  store.writeActivity(runId, 'node-b', { tool: 'bash', active: true, args: { command: 'PRIVATE' } });
  store.writeActivity(runId, 'node-a', { tool: 'read_file', active: true, args: { path: 'secret.txt' } });
  store.writeActivity(runId, 'node-b', { tool: 'bash', active: false });

  const activity = store.snapshot(runId).activity;
  assert.equal(activity['node-a'].active, true);
  assert.equal(activity['node-a'].sequence, 2);
  assert.equal(activity['node-b'].active, false);
  assert.equal(activity['node-b'].sequence, 3, 'a revisited node receives the newest ordering edge');
  assert.deepEqual(Object.keys(activity['node-a']).sort(), ['active', 'at', 'sequence', 'tool']);

  const persisted = fs.readFileSync(path.join(store.runDir(runId), 'activity.json'), 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE|secret\.txt/);
});
