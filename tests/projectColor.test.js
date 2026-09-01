// Per-project color persistence and auto-assignment (project-color theming,
// phase 2). The color is a field on the project record: picked at creation from
// a template preset no other project uses, stored in settings.json beside the
// rest of the registry state, editable through one write path (setColor /
// project:color) that presets and custom picker colors share.
//
// The four points the task pins down:
//   1. auto-assignment avoids in-use presets whenever unused ones remain,
//   2. the fallback works when all (or nearly all) presets are taken,
//   3. the stored value survives a reload,
//   4. existing project CRUD behavior is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProjectRegistry, projectIdFor, DEFAULT_PROJECT_ID
} from '../core/projects.js';
import { PRESET_PROJECT_COLORS, normalizeHexColor } from '../src/lib/projectTheme.js';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-color-'));

const PRESET_HEXES = PRESET_PROJECT_COLORS.map(p => p.hex);

function makeRegistry(overrides = {}) {
  const root = tmp();
  const registry = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() }),
    // The engine's persist hook: every mutation lands in settings.json, so the
    // on-disk half of persistence can be asserted without booting an engine.
    onPersist: () => fs.writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({ projects: registry.serialize() }, null, 2)),
    ...overrides
  });
  return { registry, root };
}

// --- 1. Auto-assignment avoids in-use presets --------------------------------

test('color: creation assigns distinct unused presets to consecutive projects', () => {
  const { registry } = makeRegistry();
  const a = registry.createAppdata('Fix the auth flow');
  const b = registry.createAppdata('Add search');
  const c = registry.createAppdata('Build a snake game');
  const picks = [a, b, c].map(({ project }) => registry.colorOf(project.id));
  for (const hex of picks) {
    assert.ok(PRESET_HEXES.includes(hex), `${hex} is one of the 9 presets`);
  }
  assert.equal(new Set(picks).size, picks.length, 'no two creations shared a color while presets were free');
});

test('color: a folder opened fresh gets a preset no other project uses', () => {
  const { registry } = makeRegistry();
  const { project: appdata } = registry.createAppdata('first');
  const folder = tmp();
  const { project: bound } = registry.open(folder);
  assert.notEqual(registry.colorOf(bound.id), registry.colorOf(appdata.id));
  assert.ok(PRESET_HEXES.includes(registry.colorOf(bound.id)));
});

test('color: assignment happens at create and is not churned by reopen/rename', () => {
  const { registry } = makeRegistry();
  const { project } = registry.createAppdata('Add search');
  const first = registry.colorOf(project.id);
  registry.close(project.id);
  registry.open(null);
  assert.equal(registry.colorOf(project.id), first, 'reopen keeps the color');
  registry.rename(project.id, 'Search work');
  assert.equal(registry.colorOf(project.id), first, 'rename keeps the color');
});

test('color: the default scratch project gets a color too, on first open', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  registry.open(folder);
  registry.open(null); // the legacy default entry
  const color = registry.colorOf(DEFAULT_PROJECT_ID);
  assert.ok(PRESET_HEXES.includes(color));
  assert.notEqual(color, registry.colorOf(projectIdFor(folder)), 'the two projects differ while presets remain');
});

// --- 2. Fallback when all (or nearly all) presets are taken -------------------

test('color: with all 9 taken, the fallback draws over the full template', () => {
  const { registry } = makeRegistry();
  // Nine folders cover every preset…
  const folders = Array.from({ length: PRESET_HEXES.length }, () => tmp());
  for (const folder of folders) registry.open(folder);
  assert.deepEqual(
    [...new Set(registry.listOpen().map(t => t.colorHex))].sort(),
    [...PRESET_HEXES].sort(),
    'avoidance assigned every preset exactly once');
  // …the tenth project must still get one — drawn from the full template.
  const tenth = registry.open(tmp());
  const color = registry.colorOf(tenth.project.id);
  assert.ok(PRESET_HEXES.includes(color), 'fallback still assigns a valid preset');
});

test('color: with all taken, the fallback eventually reuses a color (rng-driven)', () => {
  const calls = [];
  const { registry } = makeRegistry({
    pickColor: used => { calls.push([...used]); return PRESET_HEXES[used.length % PRESET_HEXES.length]; }
  });
  for (let i = 0; i < PRESET_HEXES.length + 1; i++) registry.open(tmp());
  assert.equal(calls.at(-1).length, PRESET_HEXES.length, 'the picker saw every preset as used');
  assert.ok(registry.colorOf(registry.openIds.at(-1)));
});

// --- 3. Persistence: the stored value survives a reload ----------------------

test('color: serialize/restore round-trips the color map', () => {
  const { registry, root } = makeRegistry();
  registry.createAppdata('Build a snake game');
  registry.rename('appdata:build-snake-game', 'Snake');
  const saved = registry.serialize();

  const fresh = new ProjectRegistry({
    defaultRunsDir: path.join(root, 'runs'),
    appDataDir: path.join(root, 'appdata'),
    getStorage: () => 'workspace',
    createRunner: () => ({ live: new Set() })
  });
  fresh.restore(saved);
  assert.deepEqual(fresh.colors, registry.colors, 'colors survive the round trip');
  assert.equal(fresh.colorOf('appdata:build-snake-game'), registry.colorOf('appdata:build-snake-game'));
});

test('color: a closed tab keeps its color; the value lands in settings.json on disk', () => {
  const { registry, root } = makeRegistry();
  const { project } = registry.createAppdata('Add search');
  const color = registry.colorOf(project.id);
  registry.close(project.id); // off the tab strip, still a project record
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(saved.projects.colors[project.id], color, 'persisted to settings.json');
  assert.equal(registry.colorOf(project.id), color, 'and still on the live record');
});

test('color: an engine reload reads the same color back from settings.json', () => {
  const dataRoot = tmp();
  const mk = () => createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  const first = mk();
  const api = createApi(first);
  const folder = tmp();
  api.invoke('project:open', { folder });
  const id = projectIdFor(folder);
  const written = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8'));
  const stored = written.projects.colors[id];
  assert.ok(PRESET_HEXES.includes(stored), 'assigned value persisted to disk');

  const second = mk(); // a fresh process over the same profile
  second.registry.restore(second.settings.projects ?? {});
  assert.equal(second.registry.colorOf(id), stored, 'reload restores the stored color');
  // The engine's one-time backfill must not have second-guessed a stored value.
  assert.equal(second.settings.projects.colors[id], stored);
});

test('color: setColor persists immediately and survives a reload', () => {
  const dataRoot = tmp();
  const mk = () => createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  const first = mk();
  const api = createApi(first);
  const folder = tmp();
  api.invoke('project:open', { folder });
  const id = projectIdFor(folder);
  api.invoke('project:color', { projectId: id, hex: '#123ABC' });
  const written = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8'));
  assert.equal(written.projects.colors[id], '#123abc', 'normalized and persisted');
  const second = mk();
  second.registry.restore(second.settings.projects ?? {});
  assert.equal(second.registry.colorOf(id), '#123abc', 'survives a reload');
});

// --- The service/API surface ---------------------------------------------------

test('color: project:color reads, writes, normalizes and refuses junk', async () => {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  const api = createApi(engine);
  const folder = tmp();
  api.invoke('project:open', { folder });
  const id = projectIdFor(folder);

  const read = await api.invoke('project:color', { projectId: id });
  assert.equal(read.id, id);
  assert.ok(PRESET_HEXES.includes(read.colorHex), 'a fresh project already has its color');

  const set = await api.invoke('project:color', { projectId: id, hex: 'ABCDEF' });
  assert.equal(set.colorHex, '#abcdef', 'custom picker values normalize to #rrggbb');
  assert.equal((await api.invoke('project:color', { projectId: id })).colorHex, '#abcdef');

  await assert.rejects(() => api.invoke('project:color', { projectId: id, hex: 'not-a-color' }),
    err => err instanceof ApiError && err.code === 'bad_color');
  assert.equal((await api.invoke('project:color', { projectId: id })).colorHex, '#abcdef',
    'a refused value changed nothing');
});

test('color: listOpen carries colorHex; adopt keeps the project\u2019s color under its new id', () => {
  const { registry, root } = makeRegistry();
  const { project } = registry.createAppdata('Fix the auth flow');
  const tab = registry.listOpen().find(t => t.id === project.id);
  assert.equal(tab.colorHex, registry.colorOf(project.id));
  for (const key of ['id', 'folder', 'name', 'kind', 'live', 'state']) {
    assert.ok(key in tab, `listOpen still carries "${key}"`);
  }

  registry.setColor(project.id, '#dc4a3a');
  const target = tmp();
  const { newId } = registry.adoptAppdata(project.id, target);
  assert.equal(registry.colorOf(newId), '#dc4a3a', 'the color followed the project');
  assert.ok(!Object.hasOwn(registry.colors, project.id), 'no stale entry under the old id');
});

// --- 4. Existing CRUD behavior is unchanged -----------------------------------

test('color: restore of a pre-color settings.json assigns colors without dropping anything', () => {
  const { registry } = makeRegistry();
  const f1 = tmp(), f2 = tmp();
  fs.mkdirSync(path.join(f1), { recursive: true });
  // A settings.json from before the field existed: no `colors` key at all. The
  // appdata dir must exist, exactly as the real launcher's restore expects.
  fs.mkdirSync(path.join(registry.appDataDir, 'projects', 'legacy'), { recursive: true });
  const { dropped } = registry.restore({
    open: [f1, { appdata: 'legacy' }, null], active: projectIdFor(f1),
    recents: [f1], tabState: { [projectIdFor(f1)]: { activeActivity: 'runs' } },
    names: { [projectIdFor(f1)]: 'My Repo' }
  });
  assert.deepEqual(dropped, []);
  assert.deepEqual(registry.openIds, [projectIdFor(f1), 'appdata:legacy']);
  assert.ok(PRESET_HEXES.includes(registry.colorOf(projectIdFor(f1))));
  assert.ok(PRESET_HEXES.includes(registry.colorOf('appdata:legacy')));
  assert.notEqual(registry.colorOf(projectIdFor(f1)), registry.colorOf('appdata:legacy'),
    'backfill still avoids a used preset');
  assert.deepEqual(registry.tabState[projectIdFor(f1)], { activeActivity: 'runs' }, 'tab state untouched');
  assert.equal(registry.get(projectIdFor(f1)).name, 'My Repo', 'names untouched');
});

test('color: restore ignores a malformed colors map instead of poisoning the record', () => {
  const { registry } = makeRegistry();
  registry.restore({ open: [], colors: { 'appdata:x': 'junk', 'appdata:y': 42, 'appdata:z': '#34b0a6' } });
  assert.deepEqual(registry.colors, { 'appdata:z': '#34b0a6' });
});

test('color: setColor rejects junk; the legacy round-trip tests\u2019 shapes still hold', () => {
  const { registry } = makeRegistry();
  const folder = tmp();
  registry.open(folder);
  const id = projectIdFor(folder);
  assert.throws(() => registry.setColor(id, 'red'), /not a hex color/);
  assert.throws(() => registry.setColor(id, '#12345'), /not a hex color/);
  assert.equal(registry.setColor(id, '#ABCDEF'), registry.get(id));
  // The serialize payload is a superset of the pre-color shape.
  const saved = registry.serialize();
  for (const key of ['open', 'active', 'recents', 'tabState', 'names']) assert.ok(key in saved);
  assert.deepEqual(Object.keys(saved.colors), [id]);
});

test('color: the browser harness and the preload bridge expose the same seam', () => {
  const read = relative => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const preload = read('../electron/preload.cjs');
  const mock = read('../src/devMock.js');
  for (const where of [preload, mock]) {
    assert.match(where, /\bprojectColor:/, 'projectColor must cross the bridge and the mock');
  }
});
