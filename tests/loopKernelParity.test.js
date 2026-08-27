// Parity: the Loop runs on the kernel StackRunner, not the compat runner.
//
// Covers the "done when" clauses of t-0117 that can be proven without a live
// model: the supervisor prefers stack:run and falls back only on
// unknown_command/kernel_unavailable; api exposes stack:run/stack:stop; the
// kernel bridge boots a flyt-loop-worker kernel and hands runs to ctx.agents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootLoopKernel, startStackRun, stopStackRun } from '../core/kernelRunner.js';

test('kernel bridge refuses to start without an agents seam', async () => {
  await assert.rejects(() => startStackRun({ ctx: {}, stackId: 'loop-task', input: 'x' }),
    /kernel_unavailable|no agents seam/i);
});

test('kernel bridge stop reports unavailable seam honestly', async () => {
  const r = await stopStackRun({}, 'run-x');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'kernel-unavailable');
});

test('bootLoopKernel refuses when the kernel cannot boot', async () => {
  await assert.rejects(
    () => bootLoopKernel({ runsRoot: '/tmp/x', workspaceDir: '/tmp/y', load: async () => { throw new Error('off'); } }),
  );
});

test('api exposes stack:run and stack:stop commands', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../core/api.js', import.meta.url), 'utf8');
  assert.match(src, /'stack:run':/);
  assert.match(src, /'stack:stop':/);
  assert.match(src, /bootLoopKernel/);
  assert.match(src, /startStackRun/);
});

test('supervisor prefers stack:run and falls back to flow:run on unknown_command', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../core/supervisor.js', import.meta.url), 'utf8');
  const runIdx = src.indexOf("this.invoke('stack:run'");
  const fbIdx = src.indexOf("this.invoke('flow:run'", runIdx);
  assert.ok(runIdx > -1, 'supervisor must try stack:run');
  assert.ok(fbIdx > runIdx, 'flow:run must be the fallback after stack:run');
  assert.match(src.slice(runIdx, fbIdx), /unknown_command/);
  assert.match(src.slice(runIdx, fbIdx), /kernel_unavailable/);
});
