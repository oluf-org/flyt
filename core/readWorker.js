// Read-only background projections. No hosts, claims, leases or recovery writes.
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlSessionStore, readSessionLogFile } from '#kernel';
import { RunStore } from './state.js';
import { StoredStackSnapshotReader } from './runProjection.js';
import { fileFingerprint } from './fileFingerprint.js';
import { blockHistoryRows } from './blockHistory.js';
import { HistoryDirectoryIndex } from './historyDirectoryIndex.js';

const terminalStages = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected']);
const terminal = new Map();
const stores = new Map();
const histories = new Map();
const snapshots = new StoredStackSnapshotReader({ maxFiles: 4, maxBytes: 32 * 1024 * 1024 });
const batchSize = 32;

function summaryStore(root) {
  let store = stores.get(root);
  if (!store) store = new RunStore(root, { readonly: true });
  stores.delete(root); stores.set(root, store);
  if (stores.size > 8) stores.delete(stores.keys().next().value);
  return store;
}

parentPort.on('message', async ({ id, kind, root, runId, runIds }) => {
  const metrics = { syncReadBytes: 0, summaryReadCalls: 0 };
  const read = fs.readSync, readFile = fs.readFileSync;
  fs.readSync = (...args) => { const n = read(...args); metrics.syncReadBytes += n; return n; };
  fs.readFileSync = (...args) => {
    if (typeof args[0] === 'string' && ['meta.json', 'prompt.md'].includes(path.basename(args[0]))) metrics.summaryReadCalls++;
    return readFile(...args);
  };
  try {
    if (kind === 'inspect' || kind === 'history') {
      const sessions = new JsonlSessionStore(root);
      let history;
      let changed;
      if (kind === 'history') {
        history = histories.get(root) ?? new HistoryDirectoryIndex(root);
        histories.delete(root); histories.set(root, history);
        if (histories.size > 8) { const oldest = histories.keys().next().value; histories.get(oldest).close(); histories.delete(oldest); }
        changed = await history.changes();
      }
      const ids = (changed ?? runIds)?.filter(value => fs.existsSync(sessions.fileFor(value))) ?? await sessions.list();
      const observations = [];
      const send = batch => kind === 'history' ? observations.push(...batch) : parentPort.postMessage({ id, batch });
      let batch = [];
      for (const value of ids) {
        const file = sessions.fileFor(value);
        const before = fileFingerprint(file);
        if (!runIds && before && terminal.get(file) === before) {
          batch.push({ runId: value, terminal: true, fingerprint: before });
          if (batch.length === batchSize) { send(batch); batch = []; }
          continue;
        }
        // Presence is only a scheduling hint. Let the controller check liveness
        // before requesting a targeted read; never parse a large live log on
        // every history poll. The worker makes no ownership decision.
        if (!runIds && (fs.existsSync(path.join(root, value, 'execution-owner.json')) || fs.existsSync(path.join(root, value, 'live.json')))) {
          batch.push({ runId: value, terminal: false, fingerprint: null });
          if (batch.length === batchSize) { send(batch); batch = []; }
          continue;
        }
        let isTerminal = false;
        let error;
        terminal.delete(file);
        try {
          const events = readSessionLogFile(file).events;
          isTerminal = terminalStages.has(String(events.findLast(event => event.type === 'run.stage')?.data?.stage ?? ''));
        } catch (failure) { error = { message: failure.message, code: failure.code }; }
        const fingerprint = before && before === fileFingerprint(file) ? before : null;
        if (isTerminal && fingerprint) terminal.set(file, fingerprint);
        if (terminal.size > 10000) terminal.delete(terminal.keys().next().value);
        batch.push({ runId: value, terminal: Boolean(isTerminal), fingerprint, ...(error ? { error } : {}) });
        if (batch.length === batchSize) { send(batch); batch = []; }
      }
      if (batch.length) send(batch);
      if (kind === 'history') {
        // Discovery and fingerprint checks stay in the worker. Only unfinished
        // or unstable canonical sessions need controller recovery on a list read.
        const byId = new Map(observations.map(row => [row.runId, row]));
        const store = summaryStore(root);
        const rows = store.runSummaries(changed.filter(value => fs.existsSync(path.join(root, value, 'meta.json'))));
        const summaries = new Map(rows.map(row => [row.id, row]));
        for (const value of changed) {
          const dir = path.join(root, value);
          const owner = fileFingerprint(path.join(dir, 'execution-owner.json'));
          const lease = fileFingerprint(path.join(dir, 'live.json'));
          const lifecycle = fileFingerprint(path.join(dir, 'lifecycle.json'));
          history.rows.set(value, { summary: summaries.get(value) ?? null, inspection: byId.get(value) ?? null,
            runId: value, hasOwner: Boolean(owner || lease), lifecycleStamp: [owner, lease, lifecycle].join('|') });
        }
        let output = [];
        for (const row of history.rows.values()) {
          if (!row.summary && !row.inspection) continue;
          output.push(row);
          if (output.length === batchSize) { parentPort.postMessage({ id, batch: output }); output = []; }
        }
        if (output.length) parentPort.postMessage({ id, batch: output });
        if (history.rows.size > 10000) { history.close(); histories.delete(root); }
      }
      parentPort.postMessage({ id, batched: true, metrics });
    } else if (kind === 'summaries') {
      const store = summaryStore(root);
      for (const batch of store.runSummaryBatches(batchSize)) parentPort.postMessage({ id, batch });
      parentPort.postMessage({ id, batched: true, metrics });
    } else if (kind === 'blockHistory') {
      const store = new RunStore(root, { readonly: true });
      const rows = [];
      for (const run of runIds) {
        new JsonlSessionStore(root).fileFor(run.id);
        try {
          const snapshot = fs.existsSync(path.join(root, run.id, 'session.jsonl'))
            ? await snapshots.snapshot(root, run.id, null, { materialise: false }) : store.snapshot(run.id);
          rows.push(...blockHistoryRows(snapshot, run));
        } catch { /* A deleted/unreadable run does not hide the other histories. */ }
      }
      parentPort.postMessage({ id, value: rows, metrics });
    } else if (kind === 'snapshot' || kind === 'log') {
      // Use the canonical store's confinement check before opening any file.
      new JsonlSessionStore(root).fileFor(runId);
      const value = kind === 'log' ? snapshots.events(root, runId)
        : await snapshots.snapshot(root, runId, null, { materialise: false });
      parentPort.postMessage({ id, value, metrics });
    } else throw new Error(`Unknown read operation: ${kind}`);
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, name: error.name, code: error.code }, metrics });
  } finally {
    fs.readSync = read; fs.readFileSync = readFile;
  }
});
