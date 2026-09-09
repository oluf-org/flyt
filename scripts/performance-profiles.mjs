import inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const now = () => performance.timeOrigin + performance.now();

// Each CPU profile has its own monotonic clock. Retain the start-command
// bracket so epoch alignment is explicit, with a measured uncertainty.
export async function startCpuProfile(send) {
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  const before = now();
  await send('Profiler.start');
  const after = now();
  return async () => {
    const { profile } = await send('Profiler.stop');
    return { profile, epochStartMs: (before + after) / 2, alignmentUncertaintyMs: (after - before) / 2 };
  };
}

export async function startMainProfile() {
  const session = new inspector.Session();
  session.connect();
  const send = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  const stop = await startCpuProfile(send);
  return async () => { try { return await stop(); } finally { session.disconnect(); } };
}

export function summarizeCpu({ profile, epochStartMs }, at, durationMs) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])));
  const totals = new Map();
  let elapsed = 0;
  for (let i = 0; i < (profile.samples ?? []).length; i++) {
    const delta = profile.timeDeltas[i] / 1000;
    const start = epochStartMs + elapsed;
    elapsed += delta;
    const weight = Math.max(0, Math.min(start + delta, at + durationMs) - Math.max(start, at));
    if (!weight) continue;
    let id = profile.samples[i], leaf = true;
    const seen = new Set();
    while (id != null) {
      const frame = nodes.get(id)?.callFrame;
      if (!frame) break;
      const key = `${frame.functionName}|${frame.url}|${frame.lineNumber}|${frame.columnNumber}`;
      const row = totals.get(key) ?? { function: frame.functionName || '(anonymous)', url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1, selfMs: 0, totalMs: 0 };
      if (!seen.has(key)) row.totalMs += weight;
      if (leaf) row.selfMs += weight;
      totals.set(key, row);
      seen.add(key);
      leaf = false; id = parents.get(id);
    }
  }
  const rows = [...totals.values()];
  const selected = new Set([...rows.sort((a, b) => b.selfMs - a.selfMs).slice(0, 40), ...rows.sort((a, b) => b.totalMs - a.totalMs).slice(0, 20)]);
  return [...selected].map(row => ({ ...row, selfMs: +row.selfMs.toFixed(2), totalMs: +row.totalMs.toFixed(2) }));
}

export function saveCpuProfile(output, name, recording, phases) {
  const file = output.replace(/\.json$/, '') + `-${name}.cpuprofile`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(recording.profile));
  const maps = new Map();
  const mapped = row => {
    if (!row.url.startsWith('file:') || row.line < 1) return row;
    if (!maps.has(row.url)) {
      const file = fileURLToPath(row.url) + '.map';
      maps.set(row.url, fs.existsSync(file) ? new TraceMap(JSON.parse(fs.readFileSync(file, 'utf8'))) : null);
    }
    const map = maps.get(row.url);
    if (!map) return row;
    const source = originalPositionFor(map, { line: row.line, column: row.column - 1 });
    return source.source ? { ...row, original: source } : row;
  };
  return { file: path.basename(file), epochStartMs: recording.epochStartMs, alignmentUncertaintyMs: recording.alignmentUncertaintyMs,
    phases: phases.filter(phase => phase.at != null).map(phase => ({ name: phase.name, at: phase.at, durationMs: phase.durationMs, functions: summarizeCpu(recording, phase.at, phase.durationMs).map(mapped) })) };
}

export function summarizeChromiumTrace(file, phases) {
  const { traceEvents } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const marker = traceEvents.find(row => row.name.startsWith('flyt-perf-clock:'));
  if (!marker) throw new Error('Chromium trace has no renderer clock marker');
  const offset = Number(marker.name.slice('flyt-perf-clock:'.length)) - marker.ts / 1000;
  const threads = new Map(traceEvents.filter(row => row.ph === 'M' && row.name === 'thread_name').map(row => [`${row.pid}:${row.tid}`, row.args.name]));
  const spans = traceEvents.filter(row => row.ph === 'X' && row.dur > 0);
  return { epochOffsetMs: offset, rendererPid: marker.pid, phases: phases.map(phase => {
    const totals = new Map();
    for (const row of spans) {
      const at = row.ts / 1000 + offset, end = at + row.dur / 1000;
      const duration = Math.max(0, Math.min(end, phase.at + phase.durationMs) - Math.max(at, phase.at));
      if (!duration) continue;
      const thread = threads.get(`${row.pid}:${row.tid}`) ?? String(row.tid);
      const key = `${row.pid}:${thread}:${row.name}`;
      const value = totals.get(key) ?? { name: row.name, pid: row.pid, thread, count: 0, totalMs: 0, maxMs: 0 };
      value.count++; value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration);
      totals.set(key, value);
    }
    return { name: phase.name, events: [...totals.values()].sort((a, b) => b.maxMs - a.maxMs).slice(0, 50).map(row => ({ ...row, totalMs: +row.totalMs.toFixed(2), maxMs: +row.maxMs.toFixed(2) })) };
  }) };
}

// Event Timing is quantized to 8 ms and omits events below the 16 ms
// threshold. Group by interaction before reporting tails; never call this INP.
export function interactionMetrics(samples, phase) {
  const groups = new Map();
  for (const row of samples) {
    if (row.type !== 'event' || !row.interactionId || row.at < phase.at || row.at >= phase.at + phase.durationMs) continue;
    const previous = groups.get(row.interactionId);
    if (!previous || previous.durationMs < row.durationMs) groups.set(row.interactionId, row);
  }
  return [...groups.values()];
}
