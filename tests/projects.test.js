// Project registry (D22): tab lifecycle (open/focus/close/reorder), storage
// location resolution (T2a), persistence round-trip and browser-style restore
// with missing folders dropped (T17). The runner is injected as a stub — the
// registry's job is bookkeeping, not execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectRegistry, DEFAULT_PROJECT_ID,
  projectIdFor, runsDirFor, appDataKey, ensureLlmflowGitignore
} from '../core/projects.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-proj-'));

function makeRegistry(overrides = {}) {
  const root = tmp();
  const registry = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() }),
    ...overrides
  });
  return { registry, root };
}

test('projects: identity is the absolute path; null is the default project', () => {
  assert.equal(projectIdFor(null), DEFAULT_PROJECT_ID);
  const dir = tmp();
  assert.equal(projectIdFor(dir), path.resolve(dir));
});

test('projects: runs dir per storage mode (T2a)', () => {
  const folder = tmp();
  const common = { appDataDir: 'C:/appdata', defaultRunsDir: 'C:/app/runs' };
  assert.equal(runsDirFor(null, { storage: 'workspace', ...common }), 'C:/app/runs');
  assert.equal(
    runsDirFor(folder, { storage: 'workspace', ...common }),
    path.join(folder, '.llmflow', 'runs'));
  const appdata = runsDirFor(folder, { storage: 'appdata', ...common });
  assert.ok(appdata.startsWith(path.join('C:/appdata', 'projects')));
  assert.ok(appdata.endsWith('runs'));
  // Same path, same key — different paths with the same basename diverge.
  assert.equal(appDataKey(folder), appDataKey(folder));
  const twin = tmp();
  assert.notEqual(appDataKey(folder), appDataKey(twin));
});

test('projects: workspace storage writes .llmflow/.gitignore once', () => {
  const folder = tmp();
  ensureLlmflowGitignore(folder);
  const p = path.join(folder, '.llmflow', '.gitignore');
  assert.ok(fs.readFileSync(p, 'utf8').includes('runs/'));
  fs.writeFileSync(p, 'mine\n');
  ensureLlmflowGitignore(folder); // a hand-edited file is left alone
  assert.equal(fs.readFileSync(p, 'utf8'), 'mine\n');
});

test('projects: open creates the entry; same folder twice focuses (T5)', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  const a = registry.open(folder);
  assert.equal(a.focused, false);
  assert.equal(registry.activeId, projectIdFor(folder));
  registry.open(null);
  const b = registry.open(folder); // second open of the same folder
  assert.equal(b.focused, true);
  assert.equal(b.project, a.project); // the SAME store/runner entry
  assert.equal(registry.openIds.length, 2);
});

test('projects: close keeps the entry alive (T13) and picks the right neighbour', () => {
  const { registry } = makeRegistry();
  const f1 = tmp(), f2 = tmp();
  registry.open(null);
  registry.open(f1);
  registry.open(f2);
  const id1 = projectIdFor(f1);
  registry.activate(id1);
  registry.close(id1); // closing the middle, active tab → right neighbour
  assert.equal(registry.activeId, projectIdFor(f2));
  assert.ok(registry.has(id1), 'entry survives the tab (runner keeps executing)');
  // Reopening finds the same entry again.
  const again = registry.open(f1);
  assert.equal(again.focused, false);
  assert.ok(registry.openIds.includes(id1));
});

test('projects: the last tab never leaves the strip empty', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  registry.open(folder);
  registry.close(projectIdFor(folder));
  assert.deepEqual(registry.openIds, [DEFAULT_PROJECT_ID]); // falls back to scratch
  registry.close(DEFAULT_PROJECT_ID); // refusing: nothing to fall back to
  assert.deepEqual(registry.openIds, [DEFAULT_PROJECT_ID]);
});

test('projects: reorder accepts only a permutation of the open tabs', () => {
  const { registry } = makeRegistry();
  const f1 = tmp();
  registry.open(null);
  registry.open(f1);
  const [a, b] = registry.openIds;
  registry.reorder([b, a]);
  assert.deepEqual(registry.openIds, [b, a]);
  registry.reorder([a]); // stale renderer list: dropped a tab — refused
  assert.deepEqual(registry.openIds, [b, a]);
  registry.reorder([a, 'bogus']); // invented a tab — refused
  assert.deepEqual(registry.openIds, [b, a]);
});

test('projects: serialize/restore round-trips tabs, active, recents, tab state (T17)', () => {
  const { registry } = makeRegistry();
  const f1 = tmp(), f2 = tmp();
  registry.open(null);
  registry.open(f1);
  registry.open(f2);
  registry.activate(projectIdFor(f1));
  registry.setTabState(projectIdFor(f1), { activeActivity: 'runs', activeRunId: 'r-1' });
  const saved = registry.serialize();

  const { registry: fresh } = makeRegistry();
  const { dropped } = fresh.restore(saved);
  assert.deepEqual(dropped, []);
  assert.deepEqual(fresh.openIds, [DEFAULT_PROJECT_ID, projectIdFor(f1), projectIdFor(f2)]);
  assert.equal(fresh.activeId, projectIdFor(f1));
  assert.deepEqual(fresh.tabState[projectIdFor(f1)], { activeActivity: 'runs', activeRunId: 'r-1' });
  assert.deepEqual(fresh.recents, [f2, f1].map(f => path.resolve(f)));
});

test('projects: restore drops tabs whose folder is gone, keeps their recents (T17)', () => {
  const { registry } = makeRegistry();
  const f1 = tmp(), f2 = tmp();
  registry.open(f1);
  registry.open(f2);
  const saved = registry.serialize();
  fs.rmSync(f2, { recursive: true, force: true });

  const { registry: fresh } = makeRegistry();
  const { dropped } = fresh.restore(saved);
  assert.deepEqual(dropped, [path.resolve(f2)]);
  assert.deepEqual(fresh.openIds, [projectIdFor(f1)]);
  assert.equal(fresh.activeId, projectIdFor(f1)); // saved active was f2 — falls back
  assert.ok(fresh.recents.includes(path.resolve(f2)), 'recents entry survives for a manual reopen');
});

test('projects: restore of an empty session opens the scratch tab', () => {
  const { registry } = makeRegistry();
  const { dropped } = registry.restore({});
  assert.deepEqual(dropped, []);
  assert.deepEqual(registry.openIds, [DEFAULT_PROJECT_ID]);
  assert.equal(registry.activeId, DEFAULT_PROJECT_ID);
});

test('projects: workspace storage creates .llmflow on open; runners are per project', () => {
  const runners = [];
  const { registry } = makeRegistry({
    createRunner: (store, projectId) => {
      const r = { live: new Set(), store, projectId };
      runners.push(r);
      return r;
    }
  });
  const folder = tmp();
  registry.open(null);
  registry.open(folder);
  assert.ok(fs.existsSync(path.join(folder, '.llmflow', '.gitignore')));
  assert.ok(fs.existsSync(path.join(folder, '.llmflow', 'runs')));
  assert.equal(runners.length, 2);
  assert.equal(runners[1].projectId, projectIdFor(folder));
  assert.notEqual(runners[0].store.rootDir, runners[1].store.rootDir);
});
