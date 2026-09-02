// Application-facing projections over the canonical session record.
//
// Everything in this file is a read or a rebuildable cache write. Execution
// and live process ownership live elsewhere; a historical run without
// session.jsonl is dispatched to RunStore's read-only compatibility reader.
import fs from 'node:fs';
import path from 'node:path';

async function eventsFor(ctx, id) {
  const session = await ctx.sessions.read(id);
  const events = [];
  for await (const event of session.read()) events.push(event);
  return events;
}

/** Fold generated task-graph children into the display-only resolved stack. */
export function stackWithGeneratedTasks(stack, events) {
  if (!stack || typeof stack !== 'object') return stack;
  const byParent = new Map();
  for (const event of events ?? []) {
    if (event?.type !== 'block.status') continue;
    const data = event.data ?? {};
    if (!data.parentId || !data.taskId || !data.blockId) continue;
    const rows = byParent.get(String(data.parentId)) ?? new Map();
    if (!rows.has(String(data.taskId))) rows.set(String(data.taskId), {
      kind: 'block', id: String(data.blockId), use: String(data.use ?? 'flyt-blocks-core:work'),
      title: String(data.title ?? data.taskId), config: {}, generated: true,
      dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn.map(String) : [],
    });
    byParent.set(String(data.parentId), rows);
  }
  if (!byParent.size) return stack;
  const visit = node => {
    if (!node || typeof node !== 'object') return node;
    if (node.kind === 'block') {
      const generated = byParent.get(String(node.id));
      return generated ? { ...node, generated: [...generated.values()] } : { ...node };
    }
    return {
      ...node,
      children: (node.children ?? []).map(visit),
      ...(node.else ? { else: node.else.map(visit) } : {}),
    };
  };
  return visit(stack);
}

/** Events that can change the Work projection rather than Trace alone. */
export const SNAPSHOT_UPDATE_EVENTS = new Set([
  'run.created', 'run.named', 'run.reconfigured', 'stack.resolved', 'run.stage', 'run.error',
  'block.status', 'block.output', 'llm.response', 'tool.result', 'message.user',
  'supervisor.summary',
  'sandbox.decision', 'sandbox.escalation', 'sandbox.failure',
]);

const PROJECTION_EVENTS = new Set([...SNAPSHOT_UPDATE_EVENTS, 'llm.request']);

function projectRunSnapshot(kernel, events, id, runsRoot, { materialise = true } = {}) {
  const relevant = events.filter(event => PROJECTION_EVENTS.has(event?.type));
  const projected = kernel.projectRun(relevant, id);
  projected.stack = stackWithGeneratedTasks(projected.stack, relevant);
  if (materialise) kernel.materialise(path.join(runsRoot, id), projected);

  const toolCalls = relevant.filter(event => event.type === 'tool.result').map(event => ({
    tool: event.data?.name ?? 'tool', ok: !event.data?.error,
    error: event.data?.error ?? null, at: event.at,
  }));
  const usage = projected.calls.reduce((total, call) => {
    for (const [key, value] of Object.entries(call.usage ?? {})) {
      if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
    }
    return total;
  }, {});
  const retrospectives = Object.fromEntries(Object.keys(projected.meta.blockStatus).map(blockId => [blockId, {
    status: projected.meta.blockStatus[blockId], toolCalls, usage,
  }]));
  const conversation = relevant.flatMap(event => {
    if (event.type === 'message.user') return [{ role: 'user', text: String(event.data?.content ?? ''), at: event.at }];
    if (event.type === 'supervisor.summary') return [{
      role: 'assistant', text: String(event.data?.content ?? ''), at: event.at,
      supervisor: true, degraded: Boolean(event.data?.degraded), reason: event.data?.reason ?? null,
    }];
    return [];
  });

  return {
    meta: {
      ...projected.meta,
      nodeStatus: { ...projected.meta.blockStatus },
      currentNodeId: projected.meta.currentBlockId,
    },
    prompt: projected.prompt,
    stack: projected.stack ? {
      version: 2,
      id: projected.meta.stackId ?? 'workflow-run',
      name: projected.meta.stackName ?? projected.meta.stackId ?? 'Workflow run',
      description: '', launchable: true, presets: {}, root: projected.stack,
    } : null,
    flow: null, tasks: null, retrospectives,
    nodeOutputs: { ...projected.blocks }, taskOutputs: {}, followups: [], summaries: [],
    conversation,
    session: { head: events.at(-1)?.seq ?? 0, canonical: true },
  };
}

export async function snapshotStackRun(ctx, id, kernelModule = null, options = {}) {
  const kernel = kernelModule ?? await import('#kernel');
  return projectRunSnapshot(kernel, await eventsFor(ctx, id), id, ctx.__flytRunsRoot, options);
}

/** Incremental stored-session reader used by UI snapshot pushes. */
export class StoredStackSnapshotReader {
  #files = new Map();
  #maxFiles;
  constructor({ maxFiles = 64 } = {}) { this.#maxFiles = Math.max(1, Number(maxFiles) || 64); }

  events(runsRoot, id) {
    const file = path.join(runsRoot, id, 'session.jsonl');
    if (!fs.existsSync(file)) throw new Error(`Run "${id}" has no canonical session log.`);
    const size = fs.statSync(file).size;
    let state = this.#files.get(file);
    if (!state || size < state.offset) state = { offset: 0, tail: '', events: [] };
    if (size > state.offset) {
      const buffer = Buffer.allocUnsafe(size - state.offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buffer, 0, buffer.length, state.offset); } finally { fs.closeSync(fd); }
      const text = state.tail + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      state.tail = text.endsWith('\n') ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { state.events.push(JSON.parse(line)); } catch { /* malformed evidence remains on disk */ }
      }
      state.offset = size;
    }
    this.#files.delete(file);
    this.#files.set(file, state);
    while (this.#files.size > this.#maxFiles) this.#files.delete(this.#files.keys().next().value);
    return state.events;
  }

  drop(runsRoot, id) { this.#files.delete(path.join(runsRoot, id, 'session.jsonl')); }

  async snapshot(runsRoot, id, kernelModule = null, options = {}) {
    const kernel = kernelModule ?? await import('#kernel');
    return projectRunSnapshot(kernel, this.events(runsRoot, id), id, runsRoot, options);
  }
}

export const storedSnapshots = new StoredStackSnapshotReader();

export async function snapshotStoredStackRun(runsRoot, id, kernelModule = null, options = {}) {
  return storedSnapshots.snapshot(runsRoot, id, kernelModule, options);
}

/** Fold reconstruction metadata, including later supported reconfiguration. */
export function storedStackRunMetadata(runsRoot, id) {
  const file = path.join(runsRoot, id, 'session.jsonl');
  if (!fs.existsSync(file)) return null;
  let metadata = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'run.created') metadata = { ...(event.data ?? {}) };
    if (event.type === 'run.reconfigured' && metadata) metadata = { ...metadata, ...(event.data ?? {}) };
  }
  return metadata;
}

export function isCanonicalRun(store, id) {
  return Boolean(store && fs.existsSync(path.join(store.runDir(id), 'session.jsonl')));
}

/** Append a canonical fact without requiring a live host, then rebuild it. */
export async function appendStoredRunEvent(runsRoot, id, event, kernelModule = null) {
  const kernel = kernelModule ?? await import('#kernel');
  const sessions = new kernel.JsonlSessionStore(runsRoot);
  const existing = await sessions.read(id); // refuse accidental session creation
  for await (const _event of existing.read()) { break; }
  const session = await sessions.open(id);
  const written = await session.append(event);
  await snapshotStoredStackRun(runsRoot, id, kernel, { materialise: true });
  return written;
}
