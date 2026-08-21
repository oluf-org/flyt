// The loop's account of the night, on disk (HT-02).
//
// The point is not that the lines are written. It is that they are readable
// after the process that wrote them is gone, which is when somebody asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoopLog } from '../core/loopLog.js';
import { renderReport } from '../core/supervisor.js';
import { Backlog } from '../core/backlog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-looplog-'));
const repo = fileURLToPath(new URL('..', import.meta.url));

test('a line is written under the day it happened, and read back', () => {
  const dir = tmp();
  try {
    const log = new LoopLog(dir);
    assert.equal(log.append({ at: '2026-08-21T09:00:00.000Z', line: '▶ t-0014 started', taskId: 't-0014' }), true);
    log.append({ at: '2026-08-21T09:11:00.000Z', line: '✖ t-0014 review: the cache is never invalidated', taskId: 't-0014' });
    log.append({ at: '2026-08-22T02:00:00.000Z', line: '▶ t-0015 started', taskId: 't-0015' });

    assert.deepEqual(log.days(), ['2026-08-21', '2026-08-22']);
    assert.deepEqual(log.read({ date: '2026-08-21' }).map(e => e.taskId), ['t-0014', 't-0014']);
    assert.deepEqual(log.read({ taskId: 't-0015' }).map(e => e.line), ['▶ t-0015 started']);
    assert.deepEqual(log.read({ tail: 1 }).map(e => e.line), ['▶ t-0015 started']);
    assert.equal(log.read().length, 3, 'every day, oldest first, when nothing is asked for');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the morning question has an answer after the process is gone', () => {
  const dir = tmp();
  try {
    // A loop, in its own process, that writes and then dies.
    const script = path.join(dir, 'a-loop.mjs');
    fs.writeFileSync(script, `
const { LoopLog } = await import(process.argv[3]);
const log = new LoopLog(process.argv[2]);
log.append({ line: '▶ t-0014 "cache the backlog read" on a-model (band medium)', taskId: 't-0014' });
log.append({ line: '  t-0014 run done, $0.0635 across 41 call(s)', taskId: 't-0014' });
log.append({ line: '⏸ t-0014 parked: gates were red', taskId: 't-0014' });
process.kill(process.pid, 'SIGKILL');
`, 'utf8');

    const child = spawnSync(process.execPath,
      [script, dir, new URL('../core/loopLog.js', import.meta.url).href],
      { cwd: repo, encoding: 'utf8' });
    assert.notEqual(child.status, 0, `it was supposed to die: ${child.stderr}`);

    const lines = new LoopLog(dir).read({ taskId: 't-0014' }).map(e => e.line);
    assert.equal(lines.length, 3);
    assert.match(lines[2], /parked: gates were red/, 'why it stopped outlived the process that stopped it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a day that runs away is capped, and says so in the file', () => {
  const dir = tmp();
  try {
    const log = new LoopLog(dir, { maxBytes: 400 });
    for (let i = 0; i < 50; i++) log.append({ at: '2026-08-21T09:00:00.000Z', line: `line ${i}` });

    const entries = log.read({ date: '2026-08-21' });
    assert.ok(entries.length < 50, 'it stopped');
    assert.match(entries[entries.length - 1].line, /further lines are not recorded/);
    assert.equal(
      entries.filter(e => /further lines are not recorded/.test(e.line)).length, 1,
      'the notice is written once, not on every line after the cap');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable path is the old behaviour, not a failure', () => {
  const log = new LoopLog(path.join(os.tmpdir(), 'flyt-looplog-nope', '\0invalid'));
  assert.equal(log.append({ line: 'anything' }), false, 'it reports that it did not land');
  assert.deepEqual(log.read(), [], 'and reading is empty rather than throwing');
  assert.deepEqual(log.days(), []);
});

test('a torn last line is skipped, not a crash', () => {
  const dir = tmp();
  try {
    const log = new LoopLog(dir);
    log.append({ at: '2026-08-21T09:00:00.000Z', line: 'complete' });
    fs.appendFileSync(path.join(dir, '2026-08-21.jsonl'), '{"at":"2026-08-21T09:01');
    assert.deepEqual(log.read().map(e => e.line), ['complete']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the report carries what the loop said, so it stands on its own', () => {
  const dir = tmp();
  try {
    const backlog = new Backlog(path.join(dir, 'backlog'));
    const task = backlog.add({ title: 'cache the backlog read', goal: 'g' });
    backlog.update(task.id, { status: 'parked', blockedReason: 'gates were red' });

    const loopLog = new LoopLog(path.join(dir, 'loop'));
    loopLog.append({ line: `⏸ ${task.id} parked: gates were red`, taskId: task.id });

    const report = renderReport({
      status: { running: false, stopping: 'backlog empty', inFlight: [], landed: 0, completed: 1 },
      backlog, ledger: null, loopLog
    });
    assert.match(report, /## What the loop said/);
    assert.match(report, /parked: gates were red/);

    // And a report with no log is exactly the report it was before.
    const without = renderReport({
      status: { running: false, stopping: 'backlog empty', inFlight: [], landed: 0, completed: 1 },
      backlog, ledger: null
    });
    assert.ok(!/What the loop said/.test(without));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
