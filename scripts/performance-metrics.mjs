import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readWorkerMetrics } from '../core/readWorkerClient.js';

export const round = n => Math.round(n * 100) / 100;
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]) : null;
  return { count: sorted.length, min: percentile(0), p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: percentile(1) };
}

// Process-local instrumentation: run measurements serially in an isolated probe
// or node:test file. Counts explicit reads, not OS cache misses or all Node I/O.
let measuring = false;
export async function measure(name, action) {
  if (measuring) throw new Error('Performance measurements must not overlap');
  measuring = true;
  const workerBefore = { ...readWorkerMetrics };
  let bytes = 0, reads = 0, summaryReads = 0;
  const originalRead = fs.readSync, originalFile = fs.readFileSync;
  let lastBeat = performance.now(), maxGap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastBeat);
    lastBeat = now;
  }, 5);
  fs.readSync = (...args) => { const size = originalRead(...args); bytes += size; reads++; return size; };
  fs.readFileSync = (...args) => {
    if (typeof args[0] === 'string' && ['meta.json', 'prompt.md'].includes(path.basename(args[0]))) summaryReads++;
    return originalFile(...args);
  };
  const start = performance.now();
  let value, duration;
  try { value = await action(); duration = performance.now() - start; }
  finally {
    fs.readSync = originalRead; fs.readFileSync = originalFile;
    await new Promise(resolve => setTimeout(resolve, 25));
    clearInterval(heartbeat); measuring = false;
  }
  return { value, sample: { name, durationMs: round(duration), heartbeatMaxGapMs: round(maxGap), syncReadBytes: bytes, syncReadCalls: reads, summaryReadCalls: summaryReads,
    workerReadBytes: readWorkerMetrics.syncReadBytes - workerBefore.syncReadBytes,
    workerSummaryReadCalls: readWorkerMetrics.summaryReadCalls - workerBefore.summaryReadCalls,
    rows: Array.isArray(value) ? value.length : null } };
}

export function checkPerformance(report, { checkReads = false, historyMs = null } = {}) {
  return report.fixtures.flatMap(fixture => fixture.samples.flatMap(sample => {
    if (sample.phase !== 'warm') return [];
    const failures = [];
    if (checkReads && (sample.syncReadBytes > 0 || sample.summaryReadCalls > 0 || sample.workerReadBytes > 0 || sample.workerSummaryReadCalls > 0)) failures.push('unchanged history reread session/summary bodies');
    if (historyMs != null && sample.name === 'history:activity' && sample.durationMs > historyMs) failures.push(`history exceeded ${historyMs}ms`);
    return failures.map(reason => ({ count: fixture.count, repeat: sample.repeat, name: sample.name, reason }));
  }));
}
