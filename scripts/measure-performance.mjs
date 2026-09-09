// Measures the actual API paths, not a substitute implementation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { seedPerformanceRuns } from './performance-fixture.mjs';
import { measure, distribution, checkPerformance } from './performance-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.FLYT_PERF_OUTPUT || path.join(root, '.flyt', 'performance', 'core.json'));
const counts = (process.env.FLYT_PERF_COUNTS || '10,100,500').split(',').map(Number);
assert(counts.every(n => Number.isInteger(n) && n > 0 && n <= 2000), 'Counts must be 1–2000');
const budgetMs = process.env.FLYT_PERF_MAX_HISTORY_MS == null ? null : Number(process.env.FLYT_PERF_MAX_HISTORY_MS);
assert(budgetMs == null || Number.isFinite(budgetMs) && budgetMs > 0, 'History budget must be positive');
const repeats = Number(process.env.FLYT_PERF_REPEATS || 5);
const chunks = Number(process.env.FLYT_PERF_CHUNKS || 200);
const toolBytes = Number(process.env.FLYT_PERF_TOOL_BYTES || 0);
assert(Number.isInteger(repeats) && repeats >= 2 && repeats <= 100, 'Repeats must be 2–100');
assert(Number.isInteger(chunks) && chunks >= 0 && chunks <= 10000, 'Chunks must be 0–10000');
assert(Number.isInteger(toolBytes) && toolBytes >= 0 && toolBytes <= 16 * 1024 * 1024, 'Tool bytes must be 0–16 MiB');
const checkReads = process.argv.includes('--check');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-perf-core-'));
const report = { schemaVersion: 2, at: new Date().toISOString(), versions: process.versions, platform: process.platform, cpu: os.cpus()[0]?.model, budgetMs, checkReads, repeats, fixtures: [], note: 'Synthetic settled runs; warm filesystem; cold means empty process caches. Timings include instrumentation. Not renderer latency. syncReadBytes counts explicit fs.readSync calls, not all filesystem I/O. summaryReadCalls counts meta.json/prompt.md readFileSync calls.' };
report.note += ' Worker reads are reported separately as workerReadBytes and workerSummaryReadCalls; warm read gates include both processes. Cold duration includes worker startup.';

try {
  for (const count of counts) {
    const home = path.join(temp, String(count));
    const engine = createEngine({ projectRoot: root, dataRoot: path.join(home, 'data'), userDataDir: path.join(home, 'profile'), log: () => {}, warn: () => {} });
    try {
      const api = createApi(engine);
      const { project } = engine.registry.createAppdata('Performance fixture');
      const fixture = seedPerformanceRuns(project.store.rootDir, count, chunks, { toolBytes });
      const samples = [];
      const cold = await measure('run:list', () => api.invoke('run:list', { projectId: project.id }));
      assert.equal(cold.sample.rows, count);
      samples.push({ phase: 'cold', ...cold.sample });
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const name of ['run:list', 'history:activity']) {
          const { sample } = await measure(name, () => api.invoke(name, { projectId: project.id }));
          assert.equal(sample.rows, count);
          samples.push({ phase: 'warm', repeat, ...sample });
        }
      }
      const last = fixture.ids.at(-1);
      samples.push((await measure('run:snapshot', () => api.invoke('run:snapshot', { projectId: project.id, runId: last }))).sample);
      samples.push((await measure('run:log', () => api.invoke('run:log', { projectId: project.id, runId: last }))).sample);
      const distributions = Object.fromEntries(['run:list', 'history:activity'].map(name => [name, distribution(samples.filter(s => s.phase === 'warm' && s.name === name).map(s => s.durationMs))]));
      report.fixtures.push({ count, chunks: fixture.chunks, toolBytes, sessionBytes: fixture.sessionBytes, distributions, samples });
      console.log(JSON.stringify(report.fixtures.at(-1)));
    } finally { await engine.runController?.shutdown(); engine.telemetry.close(); }
  }
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  report.failures = checkPerformance(report, { checkReads, historyMs: budgetMs });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  // Only delete the exact temporary directory minted above.
  assert(path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('flyt-perf-core-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`Performance report: ${output}`);
assert.equal(report.failures.length, 0, `${report.failures.length} performance checks failed; see ${output}`);
