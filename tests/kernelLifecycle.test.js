import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileStoredStackRuns } from '../core/kernelRunner.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-kernel-lifecycle-'));

function writeRun(root, id, events, meta = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    runId: id, stage: 'execution', currentBlockId: 'work', blockStatus: { work: 'active' }, ...meta,
  }, null, 2));
}

const unfinished = id => [
  { seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'run.created', data: { runId: id, stackId: 'demo' } },
  { seq: 2, at: '2026-01-01T00:00:01.000Z', type: 'run.stage', data: { stage: 'execution' } },
  { seq: 3, at: '2026-01-01T00:00:02.000Z', type: 'block.status', data: { blockId: 'work', status: 'active' } },
];

test('startup reconciliation closes a dead kernel run and removes stale active state', () => {
  const root = tmp();
  writeRun(root, 'dead-run', unfinished('dead-run'));
  fs.writeFileSync(path.join(root, 'dead-run', 'live.json'), JSON.stringify({
    pid: 0x7ffffff0, host: os.hostname(), beatAt: Date.now(),
  }));

  assert.deepEqual(reconcileStoredStackRuns(root), ['dead-run']);
  const events = fs.readFileSync(path.join(root, 'dead-run', 'session.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).data.stage, 'interrupted');
  assert.ok(events.some(event => event.type === 'block.status'
    && event.data.blockId === 'work' && event.data.status === 'pending'));
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'dead-run', 'meta.json')));
  assert.equal(meta.stage, 'interrupted');
  assert.equal(meta.blockStatus.work, 'pending');
  assert.equal(meta.currentBlockId, null);
  assert.equal(fs.existsSync(path.join(root, 'dead-run', 'live.json')), false);
  assert.deepEqual(reconcileStoredStackRuns(root), [], 'reconciliation is idempotent');
});

test('startup reconciliation does not interrupt a run owned by a live process', () => {
  const root = tmp();
  writeRun(root, 'live-run', unfinished('live-run'));
  fs.writeFileSync(path.join(root, 'live-run', 'live.json'), JSON.stringify({
    pid: process.pid, host: os.hostname(), beatAt: Date.now(),
  }));
  assert.deepEqual(reconcileStoredStackRuns(root), []);
  const events = fs.readFileSync(path.join(root, 'live-run', 'session.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).data.status, 'active');
});
