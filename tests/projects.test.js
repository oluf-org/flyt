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

test('projects: closing the last tab leaves the projectless state (L6)', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  registry.open(folder);
  registry.close(projectIdFor(folder));
  assert.deepEqual(registry.openIds, []); // no scratch fallback — the lander takes over
  assert.equal(registry.activeId, null);
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
  registry.open(f1);
  registry.open(f2);
  registry.activate(projectIdFor(f1));
  registry.setTabState(projectIdFor(f1), { activeActivity: 'runs', activeRunId: 'r-1' });
  const saved = registry.serialize();

  const { registry: fresh } = makeRegistry();
  const { dropped } = fresh.restore(saved);
  assert.deepEqual(dropped, []);
  assert.deepEqual(fresh.openIds, [projectIdFor(f1), projectIdFor(f2)]);
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

test('projects: restore of an empty session lands projectless (L6)', () => {
  const { registry } = makeRegistry();
  const { dropped } = registry.restore({});
  assert.deepEqual(dropped, []);
  assert.deepEqual(registry.openIds, []);
  assert.equal(registry.activeId, null);
});

test('projects: legacy scratch descriptors are ignored on restore (L6)', () => {
  const { registry } = makeRegistry();
  const f1 = tmp();
  // A pre-L6 settings.json: scratch (null) plus a real folder.
  const { dropped } = registry.restore({ open: [null, f1], active: null });
  assert.deepEqual(dropped, []);
  assert.deepEqual(registry.openIds, [projectIdFor(f1)]); // scratch dropped, folder kept
  assert.equal(registry.activeId, projectIdFor(f1));
});

test('projects: createAppdata lays down runs/ + workspace/ and opens the tab (L5)', () => {
  const { registry, root } = makeRegistry();
  const { project, focused } = registry.createAppdata('Fix the auth flow');
  assert.equal(focused, false);
  assert.equal(project.kind, 'appdata');
  assert.equal(project.id, 'appdata:fix-auth-flow');
  assert.equal(project.name, 'fix-auth-flow');
  assert.equal(registry.activeId, project.id);
  const appDir = path.join(root, 'appdata', 'projects', 'fix-auth-flow');
  assert.ok(fs.existsSync(path.join(appDir, 'runs')));
  assert.ok(fs.existsSync(path.join(appDir, 'workspace')));
  assert.equal(project.workspaceRoot, path.join(appDir, 'workspace'));
});

test('projects: appdata slugs dedupe against existing project dirs (Q-L4)', () => {
  const { registry } = makeRegistry();
  const a = registry.createAppdata('Add search');
  const b = registry.createAppdata('Add search'); // same prompt, distinct project
  assert.equal(a.project.id, 'appdata:add-search');
  assert.equal(b.project.id, 'appdata:add-search-2');
});

test('projects: appdata projects round-trip through serialize/restore (L5)', () => {
  const { registry, root } = makeRegistry();
  registry.createAppdata('Build a snake game');
  registry.rename('appdata:build-snake-game', 'Snake');
  const saved = registry.serialize();
  assert.deepEqual(saved.open, [{ appdata: 'build-snake-game' }]);

  // A second registry over the same appDataDir restores the project + its name.
  const fresh = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() })
  });
  const { dropped } = fresh.restore(saved);
  assert.deepEqual(dropped, []);
  assert.deepEqual(fresh.openIds, ['appdata:build-snake-game']);
  assert.equal(fresh.get('appdata:build-snake-game').name, 'Snake');
});

test('projects: restore drops an appdata tab whose dir is gone (L5)', () => {
  const { registry, root } = makeRegistry();
  registry.createAppdata('Add search');
  const saved = registry.serialize();
  fs.rmSync(path.join(root, 'appdata', 'projects', 'add-search'), { recursive: true, force: true });

  const fresh = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() })
  });
  const { dropped } = fresh.restore(saved);
  assert.deepEqual(dropped, ['add-search']);
  assert.deepEqual(fresh.openIds, []);
  assert.equal(fresh.activeId, null);
});

test('projects: adopt migrates an appdata project into a folder (Phase 6)', () => {
  const { registry, root } = makeRegistry();
  const { project } = registry.createAppdata('Fix the auth flow');
  registry.rename(project.id, 'Auth work');
  registry.setTabState(project.id, { activeActivity: 'runs' });
  const appDir = path.join(root, 'appdata', 'projects', 'fix-auth-flow');
  // Seed a run and a workspace file to prove the files migrate.
  fs.mkdirSync(path.join(appDir, 'runs', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'runs', 'run-1', 'meta.json'), '{}');
  fs.writeFileSync(path.join(appDir, 'workspace', 'index.js'), 'console.log(1)\n');

  const target = tmp();
  const { oldId, newId } = registry.adoptAppdata(project.id, target);

  assert.equal(oldId, project.id);
  assert.equal(newId, projectIdFor(target));
  // The tab converted in place: same position, bound kind, custom name + state.
  assert.deepEqual(registry.openIds, [newId]);
  assert.equal(registry.activeId, newId);
  assert.equal(registry.get(newId).kind, 'folder');
  assert.equal(registry.get(newId).name, 'Auth work');
  assert.deepEqual(registry.tabState[newId], { activeActivity: 'runs' });
  assert.ok(!registry.has(oldId), 'the appdata entry is gone');
  // Files landed in the repo; the appdata home is removed.
  assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'console.log(1)\n');
  assert.ok(fs.existsSync(path.join(target, '.llmflow', 'runs', 'run-1', 'meta.json')));
  assert.ok(!fs.existsSync(appDir), 'the appdata directory is migrated away');
  assert.ok(registry.recents.includes(path.resolve(target)));
});

test('projects: adopt never clobbers an existing file in the target folder', () => {
  const { registry, root } = makeRegistry();
  const { project } = registry.createAppdata('Add search');
  const appDir = path.join(root, 'appdata', 'projects', 'add-search');
  fs.writeFileSync(path.join(appDir, 'workspace', 'README.md'), 'from appdata\n');
  const target = tmp();
  fs.writeFileSync(path.join(target, 'README.md'), 'already here\n'); // must survive

  registry.adoptAppdata(project.id, target);
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'already here\n');
});

test('projects: adopt refuses a live run, a non-folder, and a non-appdata id', () => {
  const { registry } = makeRegistry({ createRunner: () => ({ live: new Set(['run-x']) }) });
  const { project } = registry.createAppdata('Busy work');
  assert.throws(() => registry.adoptAppdata(project.id, tmp()), /in progress/);

  const { registry: r2 } = makeRegistry();
  const { project: p2 } = r2.createAppdata('Idle work');
  assert.throws(() => r2.adoptAppdata(p2.id, path.join(tmp(), 'does-not-exist')), /not an existing directory/);
  const folder = tmp();
  r2.open(folder);
  assert.throws(() => r2.adoptAppdata(projectIdFor(folder), tmp()), /app-managed/);
});

test('projects: rename overrides the display name for a bound folder too', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  registry.open(folder);
  registry.rename(projectIdFor(folder), 'My Repo');
  assert.equal(registry.get(projectIdFor(folder)).name, 'My Repo');
  assert.equal(registry.listOpen()[0].name, 'My Repo');
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
