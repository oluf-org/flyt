import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { blockHistoryRows } from '../core/blockHistory.js';
import { seedPerformanceRuns } from './performance-fixture.mjs';
const mode = process.argv[2] ?? 'before';
const repo = path.resolve('.');
fs.mkdirSync(path.join(repo, '.flyt/performance'), { recursive: true });
const temp = fs.mkdtempSync(path.join(repo, '.flyt/performance/build-history-'));
const engine = createEngine({ projectRoot: repo, dataRoot: path.join(temp, 'data'), userDataDir: path.join(temp, 'profile'), log() {}, warn() {} });
const api = createApi(engine);
const { project } = engine.registry.createAppdata('Build history benchmark');
try {
  seedPerformanceRuns(project.store.rootDir, 10, 2000, { toolBytes: 2 * 1024 * 1024 });
  const runs = await api.invoke('run:list', { projectId: project.id });
  const samples = [];
  let visibleRows;
  let calls = 0, bytes = 0;
  const read = async (projectId, runIds) => {
    if (mode === 'before') return (await Promise.all(runIds.map(async id => {
      calls++;
      const snapshot = await api.invoke('run:snapshot', { projectId, runId: id });
      bytes += Buffer.byteLength(JSON.stringify(snapshot));
      return blockHistoryRows(snapshot, runs.find(row => row.id === id));
    }))).flat();
    calls++;
    const rows = await api.invoke('run:block-history', { projectId, runIds });
    bytes += Buffer.byteLength(JSON.stringify(rows));
    return rows;
  };
  const reader = mode === 'before' ? { read: ({ projectId, runs }) => read(projectId, runs.map(row => row.id)) }
    : (await import('../src/v2/buildHistory.js')).createBuildHistoryReader(read);
  for (const visible of [false, true, true, false, true]) {
    const startCalls = calls, startBytes = bytes, at = performance.now();
    const rows = await reader.read({ projectId: project.id, workflowId: 'performance-fixture', runs, visible });
    if (visible) { assert.equal(rows.length, 10); visibleRows = rows; }
    samples.push({ visible, durationMs: performance.now() - at, calls: calls - startCalls, responseBytes: bytes - startBytes });
  }
  const expected = (await Promise.all(runs.map(async run => blockHistoryRows(await api.invoke('run:snapshot', { projectId: project.id, runId: run.id }), run)))).flat();
  assert.deepEqual(visibleRows, expected);
  const report = { mode, contentEquivalent: true, at: new Date().toISOString(), cpu: os.cpus()[0].model, node: process.version, samples };
  const output = process.env.FLYT_PERF_OUTPUT || `.flyt/performance/build-history-${mode}.json`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await api.shutdown(); engine.telemetry.close(); }
