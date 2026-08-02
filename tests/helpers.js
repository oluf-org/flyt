// Shared test scaffolding: a temp-dir RunStore, a scriptable provider the
// tests can point at any canned behavior, and polling helpers for the async
// flow runner (start() returns immediately; state lives in run files).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../core/state.js';
import { registerProvider } from '../core/adapters/index.js';

// A store over a fresh temp dir, or over `dir` when a test needs two stores to
// share one directory (what a relaunch looks like from the store's side).
export function makeStore(dir = null) {
  return new RunStore(dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-test-')));
}

// 'script' provider: each test assigns a handler ({ system, prompt }) that
// returns the model text (or a full { text, usage } result).
let scriptHandler = () => { throw new Error('script provider: no handler set (call setScript first)'); };
registerProvider('script', async call => {
  const out = await scriptHandler(call);
  return typeof out === 'string' ? { text: out, usage: null } : out;
});
export function setScript(fn) { scriptHandler = fn; }

export function roleOf(system) {
  return (String(system).match(/ROLE:\s*([\w-]+)/) ?? [])[1] ?? 'custom';
}

export function testConfig(overrides = {}) {
  return {
    workers: { executor: { provider: 'script', model: 'test-model' } },
    categoryWorkers: {},
    providerKeys: {},
    ...overrides
  };
}

export async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Resolves with the stage name once the run reaches any of the given stages.
export function waitForStage(store, runId, stages, opts = {}) {
  const want = new Set([].concat(stages));
  return waitFor(() => {
    const stage = store.readMeta(runId).stage;
    return want.has(stage) ? stage : null;
  }, { label: `stage in [${[...want]}]`, ...opts });
}

let flowN = 0;
export function makeFlow(nodes, edges) {
  flowN += 1;
  return { id: `test-flow-${flowN}`, name: `Test flow ${flowN}`, nodes, edges };
}
export const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
export const edge = (source, target) => ({ id: `e-${source}-${target}`, source, target });
