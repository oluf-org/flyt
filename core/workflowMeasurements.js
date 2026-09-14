import fs from 'node:fs';
import path from 'node:path';
import { readSessionLogFile } from '#kernel';

// Read only sessions reached through canonical child.session events. Never take
// run IDs, durations or costs from a candidate's returned artifact.
export function workflowMeasurements(store, runId, { rootSessionFile } = {}) {
  const visited = new Set(), all = [], evidence = [];
  function visit(id) {
    if (visited.has(id) || !/^[\w.-]+$/.test(id)) return;
    visited.add(id);
    const file = id === runId && rootSessionFile ? rootSessionFile : path.join(store.runDir(id), 'session.jsonl');
    if (!fs.existsSync(file)) return;
    const events = readSessionLogFile(file).events;
    // Canonical JSONL envelopes carry seq/at/type/data, not a top-level runId.
    // Attribute them to the file we actually opened, including child sessions.
    evidence.push({ runId: id, events: events.length }); all.push(...events.map(event => ({ ...event, runId: id })));
    for (const e of events) if (e.type === 'child.session' && e.data.parentRunId === id) visit(e.data.sessionId);
  }
  visit(runId);
  const root = all.filter(e => e.runId === runId);
  const ms = e => typeof e?.at === 'number' ? e.at : Date.parse(e?.at);
  const began = ms(root.find(e => e.type === 'run.created'));
  const ended = ms(root.filter(e => e.type === 'run.stage' && e.data.stage === 'done').at(-1));
  const recovered = root.some(e => e.type === 'run.stage' && ['paused', 'stopped', 'resumed'].includes(e.data.stage));
  const calls = all.filter(e => e.type === 'llm.request');
  const responses = all.filter(e => e.type === 'llm.response').map(e => e.data);
  const attempts = all.filter(e => e.type === 'llm.telemetry' && e.data.kind === 'call');
  const count = Math.max(calls.length, attempts.length), complete = responses.length === count && !attempts.some(e => !e.data.ok);
  const tasks = new Map(), intervals = [], delays = [], planning = [];
  for (const e of all) {
    const d = e.data;
    if (e.type !== 'block.status' || !d.taskId) continue;
    const key = `${e.runId}:${d.parentId}:${d.taskId}`;
    const task = tasks.get(key) ?? { dependencies: d.dependsOn ?? [], announced: ms(e) };
    if (d.status === 'active') { task.start = ms(e); intervals.push([ms(e), 1]); }
    if (['done', 'failed', 'blocked'].includes(d.status)) { task.end = ms(e); if (task.start != null) intervals.push([ms(e), -1]); }
    tasks.set(key, task);
  }
  for (const [key, task] of tasks) {
    const parent = key.slice(0, key.lastIndexOf(':'));
    const ready = Math.max(task.announced, ...task.dependencies.map(id => tasks.get(`${parent}:${id}`)?.end ?? task.announced));
    if (task.start != null) delays.push(Math.max(0, task.start - ready));
  }
  for (const e of root.filter(e => e.type === 'block.status' && e.data.use === 'flyt-blocks-core:task-graph' && e.data.status === 'active')) {
    const announced = root.find(x => x.type === 'block.status' && x.data.parentId === e.data.blockId && x.data.taskId);
    if (announced) planning.push(Math.max(0, ms(announced) - ms(e)));
  }
  let active = 0, peak = 0;
  for (const [, delta] of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) { active += delta; peak = Math.max(peak, active); }
  const warnings = all.filter(e => e.type === 'block.warning').map(e => e.data);
  const toolCalls = all.filter(e => e.type === 'tool.call');
  const reads = new Map();
  for (const e of toolCalls.filter(e => ['read_file', 'glob', 'search_files'].includes(e.data.name))) {
    const key = JSON.stringify([e.data.name, e.data.args]); reads.set(key, (reads.get(key) ?? 0) + 1);
  }
  return { runId, evidence, recovered, latencyMs: !recovered && Number.isFinite(ended - began) ? ended - began : null,
    planningMs: planning.length ? planning.reduce((a, b) => a + b, 0) : null,
    readyDelayMs: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    peakWorkers: tasks.size ? peak : null, modelCalls: count, attempted: true, responses: responses.length, completed: Number.isFinite(ended),
    tokens: complete && responses.every(r => r.usage?.promptTokens != null && r.usage?.completionTokens != null) ? responses.reduce((n, r) => n + r.usage.promptTokens + r.usage.completionTokens, 0) : null,
    knownUsd: complete && responses.every(r => r.usage?.costUsd != null) ? responses.reduce((n, r) => n + r.usage.costUsd, 0) : null,
    repairs: warnings.filter(w => w.code === 'invalid_task_graph').length, fallbacks: warnings.filter(w => w.code === 'task_graph_degraded').length,
    toolCalls: toolCalls.length, repeatedReads: [...reads.values()].reduce((n, count) => n + Math.max(0, count - 1), 0),
    correctionCalls: calls.filter(e => /(?:\.format|evidence-repair|spec-repair)/.test(e.data.blockId ?? '')).length,
    acceptedMilestones: root.filter(e => e.type === 'workflow.acceptance').map(e => e.data.milestone),
    unresolved: Number.isFinite(ended) ? 0 : 1, diagnostics: warnings,
    transformations: warnings.filter(w => w.transformations).map(w => w.transformations) };
}
