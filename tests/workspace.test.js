// Workspace: run-time binding to a real project folder, .llmflow/ config
// provisioning, and path confinement against the workspace root (D15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../core/workspace.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-ws-'));

test('workspace: rejects a non-existent or non-directory path', () => {
  assert.throws(() => new Workspace(path.join(tmpDir(), 'nope')), /not an existing directory/);
  const file = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => new Workspace(file), /not an existing directory/);
});

test('workspace: ensure() creates .llmflow/config.json once, idempotently', () => {
  const root = tmpDir();
  const ws = new Workspace(root).ensure();
  assert.ok(fs.existsSync(path.join(root, '.llmflow', 'config.json')));
  assert.equal(ws.readConfig().version, 1);

  // A hand-edit survives a re-bind (ensure is idempotent, never clobbers).
  ws.writeConfig({ version: 1, custom: 'kept' });
  new Workspace(root).ensure();
  assert.equal(new Workspace(root).readConfig().custom, 'kept');
});

test('workspace: resolve() confines paths to the root', () => {
  const ws = new Workspace(tmpDir()).ensure();
  assert.equal(ws.resolve('src/app.js'), path.join(ws.root, 'src', 'app.js'));
  assert.equal(ws.resolve('.'), ws.root);
  for (const bad of ['../escape', '../../etc/passwd', path.join(ws.root, '..', 'x')]) {
    assert.throws(() => ws.resolve(bad), /escapes the workspace root/);
  }
});
