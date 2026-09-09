// Isolate the single-file stall that yielding between history files cannot fix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ReadWorkerClient } from '../core/readWorkerClient.js';
import { StoredStackSnapshotReader } from '../core/runProjection.js';
import { seedPerformanceRuns } from './performance-fixture.mjs';
import { measure, distribution } from './performance-metrics.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-worker-probe-'));
const output = path.resolve(process.env.FLYT_PERF_OUTPUT || '.flyt/performance/worker-parsing.json');
const worker = new ReadWorkerClient();
const report = { at: new Date().toISOString(), versions: process.versions, cpu: os.cpus()[0]?.model,
  note: 'Same synthetic files and projection, serial measurements, warm filesystem, empty event caches. Worker startup excluded. IPC to a renderer and paint are not measured.', samples: [] };
try {
  report.fixture = seedPerformanceRuns(root, 3, 10000, { toolBytes: 16 * 1024 * 1024 });
  await worker.request('summaries', { root }); // boot separately from parsing
  for (const runId of report.fixture.ids) {
    const before = await measure('main-process-projection', () => new StoredStackSnapshotReader().snapshot(root, runId, null, { materialise: false }));
    const after = await measure('worker-projection', () => worker.request('snapshot', { root, runId }));
    assert.deepEqual(after.value, before.value);
    assert.equal(after.sample.syncReadBytes, 0);
    report.samples.push({ runId, ...before.sample }, { runId, ...after.sample });
  }
  report.distributions = Object.fromEntries(['main-process-projection', 'worker-projection'].map(name => [name, {
    durationMs: distribution(report.samples.filter(row => row.name === name).map(row => row.durationMs)),
    heartbeatGapMs: distribution(report.samples.filter(row => row.name === name).map(row => row.heartbeatMaxGapMs)),
  }]));
  console.log(JSON.stringify(report.distributions));
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await worker.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('flyt-worker-probe-'));
  fs.rmSync(root, { recursive: true, force: true });
}
