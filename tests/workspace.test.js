// Workspace: run-time binding to a real project folder, .flyt/ config
// provisioning, and path confinement against the workspace root (D15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, configDirName, adoptConfigDir } from '../core/workspace.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-ws-'));

test('workspace: rejects a non-existent or non-directory path', () => {
  assert.throws(() => new Workspace(path.join(tmpDir(), 'nope')), /not an existing directory/);
  const file = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => new Workspace(file), /not an existing directory/);
});

test('workspace: ensure() creates .flyt/config.json once, idempotently', () => {
  const root = tmpDir();
  const ws = new Workspace(root).ensure();
  assert.ok(fs.existsSync(path.join(root, '.flyt', 'config.json')));
  assert.equal(ws.readConfig().version, 1);

  // A hand-edit survives a re-bind (ensure is idempotent, never clobbers).
  ws.writeConfig({ version: 1, custom: 'kept' });
  new Workspace(root).ensure();
  assert.equal(new Workspace(root).readConfig().custom, 'kept');
});

// --- D29: .llmflow/ → .flyt/, read-both then adopt on first write ----------

test('workspace: a project created before the rename keeps working, unadopted', () => {
  const root = tmpDir();
  const legacy = path.join(root, '.llmflow');
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ version: 1, mine: 'yes' }));

  // Reads resolve to the legacy directory — no rename has happened yet.
  assert.equal(configDirName(root), '.llmflow');
  assert.equal(new Workspace(root).readConfig().mine, 'yes');
  // ...and skills still resolve, because the path is built from the same name.
  assert.equal(new Workspace(root).configDirName, '.llmflow');
});

test('workspace: the first write adopts the legacy config directory, once', () => {
  const root = tmpDir();
  const legacy = path.join(root, '.llmflow');
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ version: 1, mine: 'yes' }));
  fs.writeFileSync(path.join(legacy, 'skills', 'house-style.md'), 'Tabs, never spaces.');

  const ws = new Workspace(root).ensure();

  assert.ok(!fs.existsSync(legacy), 'the legacy directory is renamed, not copied');
  assert.ok(fs.existsSync(path.join(root, '.flyt', 'config.json')));
  // Contents survive the rename: config is not reset to the default template,
  // and skills come along with it.
  assert.equal(ws.readConfig().mine, 'yes');
  assert.equal(
    fs.readFileSync(path.join(root, '.flyt', 'skills', 'house-style.md'), 'utf8'),
    'Tabs, never spaces.');
  assert.equal(configDirName(root), '.flyt');
});

test('workspace: adopt prefers an existing .flyt/ over a leftover legacy dir', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.llmflow'), { recursive: true });
  fs.mkdirSync(path.join(root, '.flyt'), { recursive: true });
  fs.writeFileSync(path.join(root, '.flyt', 'config.json'), JSON.stringify({ version: 1, keep: true }));

  assert.equal(adoptConfigDir(root), path.join(root, '.flyt'));
  assert.equal(new Workspace(root).ensure().readConfig().keep, true);
  assert.ok(fs.existsSync(path.join(root, '.llmflow')), 'the leftover is left alone, not merged');
});

test('workspace: resolve() confines paths to the root', () => {
  const ws = new Workspace(tmpDir()).ensure();
  assert.equal(ws.resolve('src/app.js'), path.join(ws.root, 'src', 'app.js'));
  assert.equal(ws.resolve('.'), ws.root);
  for (const bad of ['../escape', '../../etc/passwd', path.join(ws.root, '..', 'x')]) {
    assert.throws(() => ws.resolve(bad), /escapes the workspace root/);
  }
});
