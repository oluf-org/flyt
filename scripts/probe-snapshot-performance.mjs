import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ReadWorkerClient } from '../core/readWorkerClient.js';
import { seedPerformanceRuns } from './performance-fixture.mjs';
import { measure, distribution } from './performance-metrics.mjs';

const output = process.argv[2] || '.flyt/performance/snapshot-current.json';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-snapshot-probe-'));
const baselineWorker = process.env.FLYT_PROBE_WORKER;
const makeWorker = () => new ReadWorkerClient(baselineWorker
  ? { workerURL: new URL(baselineWorker, import.meta.url) } : {});
const phases = ['cold', 'unchanged', 'append', 'combined', ...(baselineWorker ? [] : ['paired']), 'queue', 'log-queue', 'cold-open'];
const report = {
  at: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, fixtures: [],
  limitations: 'Synthetic warm-filesystem worker measurements, five samples per action (one initial cold snapshot). Memory is post-request process RSS and worker heap/external, not peak or retained heap. Queue probes put an unrelated small snapshot behind an appended long snapshot or log. Cold-open includes worker startup. No renderer/provider latency.',
};
const fixtures = [
  ['small', 100, 16384, 1],
  ['23MB', 10000, 16 * 1024 * 1024, 1],
  ['40MB', 10000, 32 * 1024 * 1024, 1],
  ['many-tools', 10000, 16384, 2000],
];
try {
  for (const [name, chunks, toolBytes, calls] of fixtures) {
    const dir = path.join(root, name);
    const { ids: [runId] } = seedPerformanceRuns(dir, 1, chunks, { toolBytes });
    const file = path.join(dir, runId, 'session.jsonl');
    let seq = chunks + 15;
    const add = (type, data) => fs.appendFileSync(file,
      JSON.stringify({ seq: ++seq, at: '2026-09-10T12:00:00Z', type, data }) + '\n');
    for (let i = 1; i < calls; i++) {
      add('tool.call', { callId: `tool-${i}`, name: 'read_file', args: { path: `src/file-${i}.js` } });
      add('tool.result', { callId: `tool-${i}`, name: 'read_file', content: 'source line\n'.repeat(Math.ceil(toolBytes / 12)) });
      add('llm.response', { callId: `call-${i}`, usage: { prompt_tokens: 100, completion_tokens: 10 }, content: 'Working' });
    }
    const small = path.join(root, 'queue');
    seedPerformanceRuns(small, 1, 2);
    const worker = makeWorker();
    const samples = [];
    try {
      for (const phase of phases) {
        for (let i = 0; i < (phase === 'cold' ? 1 : 5); i++) {
          if (['append', 'queue', 'log-queue'].includes(phase)) add('block.output', { blockId: 'work', content: `Update ${i}` });
          const metrics = [];
          const lane = phase === 'cold-open' ? makeWorker() : worker;
          const request = (kind, root = dir, id = runId) => lane.request(kind, { root, runId: id }, {
            onMetrics: metric => metrics.push({ kind, ...metric }),
          });
          const action = () => {
            if (phase === 'paired' || (phase === 'cold-open' && !baselineWorker)) return request('snapshotAndLog');
            if (phase === 'combined' || phase === 'cold-open') return Promise.all([request('snapshot'), request('log')]);
            if (['queue', 'log-queue'].includes(phase)) return Promise.all([
              request(phase === 'log-queue' ? 'log' : 'snapshot'), request('snapshot', small, 'perf-00000'),
            ]);
            return request('snapshot');
          };
          try {
            const { value, sample } = await measure(phase, action);
            if (phase === 'append') assert.equal(value.nodeOutputs.work, `Update ${i}`);
            samples.push({ ...sample, metrics, mainMemory: process.memoryUsage() });
          } finally {
            if (phase === 'cold-open') await lane.close();
          }
        }
      }
    } finally {
      await worker.close();
    }
    report.fixtures.push({
      name, chunks, toolBytes, calls, bytes: fs.statSync(file).size, samples,
      medians: Object.fromEntries(phases.map(phase => [phase,
        distribution(samples.filter(sample => sample.name === phase).map(sample => sample.durationMs)).p50])),
    });
    console.log(name, report.fixtures.at(-1).medians);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('flyt-snapshot-probe-'));
  fs.rmSync(root, { recursive: true, force: true });
}
