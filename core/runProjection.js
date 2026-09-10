// Application-facing projections over the canonical session record.
//
// Everything in this file is a read or a rebuildable cache write. Execution
// and live process ownership live elsewhere; a historical run without
// session.jsonl is dispatched to RunStore's read-only compatibility reader.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as canonicalKernel from '#kernel';
const { readSessionLogFile } = canonicalKernel;
import { fileFingerprint } from './fileFingerprint.js';

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
      title: String(data.title ?? data.taskId), config: {}, generated: true, taskId: String(data.taskId),
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

function projectRunSnapshot(kernel, events, id, runsRoot, { materialise = true, projected: supplied, head } = {}) {
  const relevant = events.filter(event => PROJECTION_EVENTS.has(event?.type));
  const projected = supplied ?? kernel.projectRun(relevant, id);
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
    session: { head: head ?? events.at(-1)?.seq ?? 0, canonical: true },
  };
}

export async function snapshotStackRun(ctx, id, kernelModule = null, options = {}) {
  const kernel = kernelModule ?? await import('#kernel');
  return projectRunSnapshot(kernel, await eventsFor(ctx, id), id, ctx.__flytRunsRoot, options);
}

// Only these fields enter the Work fold. Raw Trace events remain canonical.
function compactEvent(event) {
  if (!PROJECTION_EVENTS.has(event.type)) return null;
  const data = event.data ?? {};
  if (event.type === 'tool.result') return { ...event, data: { name: data.name, error: data.error } };
  if (event.type === 'llm.request') return { ...event, data: Object.fromEntries(
    ['callId', 'blockId', 'taskId', 'provider', 'model'].map(key => [key, data[key]])) };
  if (event.type === 'llm.response') return { ...event, data: Object.fromEntries(
    ['callId', 'blockId', 'taskId', 'provider', 'model', 'ok', 'error', 'ms', 'finishReason', 'usage', 'route'].map(key => [key, data[key]])) };
  return event;
}

/**
 * Read-only, bounded display cache. A changed file is never assumed appended:
 * SHA-256 verifies every previous byte before the suffix enters the same kernel
 * fold as full replay. Verification uses a fixed buffer, without parsing old
 * stream chunks/tool bodies. No sidecar or execution-owner hint is trusted.
 */
export class StoredStackSnapshotReader {
  #files = new Map();
  #raw = new Map();
  #maxFiles;
  #maxBytes;
  #maxProjectionBytes;
  constructor({ maxFiles = 64, maxBytes = 32 * 1024 * 1024, maxProjectionBytes = 8 * 1024 * 1024 } = {}) {
    this.#maxFiles = Math.max(1, Number(maxFiles) || 64);
    this.#maxBytes = Math.max(0, maxBytes);
    this.#maxProjectionBytes = Math.max(0, maxProjectionBytes);
  }

  #retain(cache, file, state, budget) {
    cache.delete(file);
    if (state.bytes > budget) return;
    cache.set(file, state);
    let bytes = [...cache.values()].reduce((total, item) => total + item.bytes, 0);
    while (cache.size > this.#maxFiles || bytes > budget) {
      const oldest = cache.keys().next().value;
      bytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
  }

  #newState(kernel, id) {
    return { projector: kernel.createRunProjector(id, { retainArtifacts: false }), displayEvents: [],
      generated: new Set(), bytes: 1024, head: 0, dense: true };
  }

  #append(state, event) {
    state.dense &&= event.seq === state.head + 1;
    state.head = event.seq;
    const compact = compactEvent(event);
    if (!compact) return;
    state.projector.append(compact);
    // Conservatively charge all folded input, including overwritten fields.
    // This bounds retained state without serializing the whole cache per tick.
    state.bytes += 128 + Buffer.byteLength(JSON.stringify(compact)) * 2;
    if (event.type === 'block.status') {
      const d = event.data ?? {};
      const key = JSON.stringify([String(d.parentId), String(d.taskId)]);
      if (!d.parentId || !d.taskId || !d.blockId || state.generated.has(key)) return;
      state.generated.add(key);
    } else if (!['tool.result', 'message.user', 'supervisor.summary'].includes(event.type)) return;
    state.displayEvents.push(compact);
  }

  #read(runsRoot, id, kernel, wantEvents) {
    const file = path.join(runsRoot, id, 'session.jsonl');
    // Retry a raced read once, then fail explicitly instead of caching mixed
    // generations. The next request resynchronizes from canonical bytes.
    for (let attempt = 0; attempt < 2; attempt++) {
      const fingerprint = fileFingerprint(file);
      if (!fingerprint) throw new Error(`Run "${id}" has no canonical session log.`);
      const size = fs.statSync(file).size;
      const cached = this.#files.get(file);
      const raw = this.#raw.get(file);
      if (cached?.fingerprint === fingerprint && (!wantEvents || raw?.fingerprint === fingerprint)) {
        this.#retain(this.#files, file, cached, this.#maxProjectionBytes);
        if (raw) this.#retain(this.#raw, file, raw, this.#maxBytes);
        return { state: cached, events: raw?.events };
      }
      if (wantEvents && cached?.fingerprint === fingerprint) {
        // An oversized Trace is deliberately not retained. Loading it again
        // does not invalidate the compact projection of the same generation.
        const events = readSessionLogFile(file).events;
        if (fingerprint !== fileFingerprint(file)) {
          this.#files.delete(file); this.#raw.delete(file);
          continue;
        }
        this.#retain(this.#files, file, cached, this.#maxProjectionBytes);
        this.#retain(this.#raw, file, { fingerprint, events, bytes: size }, this.#maxBytes);
        return { state: cached, events };
      }
      let state;
      let startOffset = 0;
      let hash = createHash('sha256');
      let previousSize = 0;
      // Full log requests need every event; an absent raw cache means replay.
      if (cached?.dense && cached.fingerprint && size > cached.size
        && fingerprint.split(':').slice(0, 2).join(':') === cached.fingerprint.split(':').slice(0, 2).join(':')
        && (!wantEvents || raw?.fingerprint === cached.fingerprint)) {
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        try {
          while (position < cached.size) {
            const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, cached.size - position), position);
            if (!n) break;
            hash.update(buffer.subarray(0, n));
            position += n;
          }
        } finally { fs.closeSync(fd); }
        if (position === cached.size && hash.copy().digest('hex') === cached.digest) {
          state = cached;
          startOffset = cached.completeBytes;
          previousSize = cached.size;
        } else hash = createHash('sha256');
      }
      // Never leave a partially folded state reachable after a failure/race.
      this.#files.delete(file); this.#raw.delete(file);
      state ??= this.#newState(kernel, id);
      const events = wantEvents || size <= this.#maxBytes ? (startOffset ? raw?.events ?? null : []) : null;
      const read = readSessionLogFile(file, {
        startOffset,
        onChunk: (chunk, position) => {
          const skip = Math.max(0, previousSize - position);
          if (skip < chunk.length) hash.update(chunk.subarray(skip));
        },
        onEvent: event => { this.#append(state, event); events?.push(event); },
      });
      if (fingerprint !== fileFingerprint(file)) continue;
      // Gaps, malformed records and oversized skipped events require canonical
      // replay, including when the suffix itself introduced the gap.
      if (startOffset && (!state.dense || read.problems.some(p => p.reason !== 'torn final line'))) {
        attempt--;
        continue;
      }
      state.dense &&= !read.problems.some(p => p.reason !== 'torn final line');
      Object.assign(state, { fingerprint, size, completeBytes: read.completeBytes, digest: hash.digest('hex'), snapshot: null });
      this.#retain(this.#files, file, state, this.#maxProjectionBytes);
      if (events) this.#retain(this.#raw, file, { fingerprint, events, bytes: size }, this.#maxBytes);
      return { state, events };
    }
    throw Object.assign(new Error('Session changed during snapshot read; retry to resynchronize.'), { code: 'session_read_changed' });
  }

  events(runsRoot, id, kernel = canonicalKernel) {
    const file = path.join(runsRoot, id, 'session.jsonl');
    if (fs.statSync(file).size > this.#maxBytes) {
      // A standalone oversized Trace needs the raw replay, not a second Work
      // fold. Keep the old compact generation available for the next verified
      // snapshot append. Work's combined read uses snapshotAndLog instead.
      this.#raw.delete(file);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = fileFingerprint(file);
        const events = readSessionLogFile(file).events;
        if (before && before === fileFingerprint(file)) return events;
      }
      throw Object.assign(new Error('Session changed during log read; retry to resynchronize.'), { code: 'session_read_changed' });
    }
    return this.#read(runsRoot, id, kernel, true).events;
  }

  drop(runsRoot, id) {
    const file = path.join(runsRoot, id, 'session.jsonl');
    this.#files.delete(file); this.#raw.delete(file);
  }

  async snapshot(runsRoot, id, kernelModule = null, options = {}) {
    const kernel = kernelModule ?? await import('#kernel');
    // Materialization must preserve complete tool artifacts and call files.
    if (options.materialise !== false) return projectRunSnapshot(kernel, this.events(runsRoot, id, kernel), id, runsRoot, options);
    const { state } = this.#read(runsRoot, id, kernel, false);
    return this.#snapshot(state, kernel, runsRoot, id);
  }

  #snapshot(state, kernel, runsRoot, id) {
    state.snapshot ??= projectRunSnapshot(kernel, state.displayEvents, id, runsRoot, {
      materialise: false, projected: state.projector.snapshot(), head: state.head,
    });
    // In-process callers may retain or mutate their result while the fold grows.
    return structuredClone(state.snapshot);
  }

  async snapshotAndLog(runsRoot, id, kernelModule = null) {
    const kernel = kernelModule ?? await import('#kernel');
    const { state, events } = this.#read(runsRoot, id, kernel, true);
    return { snapshot: this.#snapshot(state, kernel, runsRoot, id), log: events };
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
  for (const event of readSessionLogFile(file).events) {
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
