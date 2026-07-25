// The D29 userData migration. This is the one piece of the rename that can
// destroy user data, and it fails silently when it fails — the app starts with
// an empty profile and the user's settings look deleted. Every guard gets a
// test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateUserDataDir } from '../core/migrate.js';

const LEGACY = ['LLM Flow', 'llm-flow'];

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-migrate-'));
}
function seed(root, name, files = { 'settings.json': '{"providers":{}}' }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

test('migrate: moves the packaged legacy directory onto the new userData path', () => {
  const root = tmpRoot();
  seed(root, 'LLM Flow');
  const userDataDir = path.join(root, 'Flyt');

  const res = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(res.migrated, true);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'), '{"providers":{}}');
  assert.ok(!fs.existsSync(path.join(root, 'LLM Flow')), 'the legacy directory is gone, not copied');
});

// Dev and packaged builds disagreed about the directory name, so both are
// candidates; the packaged one is checked first.
test('migrate: falls through to the dev-build directory name', () => {
  const root = tmpRoot();
  seed(root, 'llm-flow', { 'settings.json': '{"dev":true}' });
  const userDataDir = path.join(root, 'Flyt');

  const res = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(res.migrated, true);
  assert.equal(res.from, path.join(root, 'llm-flow'));
  assert.equal(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'), '{"dev":true}');
});

// The guard that matters most: an install that already ran post-rename has real
// state at the new path. A stale legacy directory must never overwrite it.
test('migrate: refuses to clobber a userData directory that has content', () => {
  const root = tmpRoot();
  seed(root, 'LLM Flow', { 'settings.json': '{"old":true}' });
  const userDataDir = seed(root, 'Flyt', { 'settings.json': '{"current":true}' });

  const logged = [];
  const res = migrateUserDataDir({
    appDataRoot: root, userDataDir, legacyNames: LEGACY, log: m => logged.push(m)
  });

  assert.equal(res.migrated, false);
  assert.match(res.reason, /not empty/);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'), '{"current":true}');
  assert.ok(fs.existsSync(path.join(root, 'LLM Flow')), 'the legacy directory is left alone, not deleted');
  // Refusing silently is how a user concludes their settings were deleted.
  assert.equal(logged.length, 1);
  assert.match(logged[0], /pre-rename profile/);
  assert.ok(logged[0].includes(path.join(root, 'LLM Flow')), 'names the old directory');
  assert.ok(logged[0].includes(userDataDir), 'names the directory actually in use');
});

// Electron can create userData empty before any of our code runs, so "the
// directory exists" is not evidence that the app has state there.
test('migrate: an empty userData directory does not block the migration', () => {
  const root = tmpRoot();
  seed(root, 'LLM Flow');
  const userDataDir = path.join(root, 'Flyt');
  fs.mkdirSync(userDataDir, { recursive: true });

  const res = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(res.migrated, true);
  assert.ok(fs.existsSync(path.join(userDataDir, 'settings.json')));
});

test('migrate: a clean install with no legacy directory is a no-op', () => {
  const root = tmpRoot();
  const userDataDir = path.join(root, 'Flyt');

  const res = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(res.migrated, false);
  assert.ok(!fs.existsSync(userDataDir), 'nothing is created just by looking');
});

// Running twice must be safe: the second pass finds nothing to do rather than
// finding the just-migrated directory and moving it again.
test('migrate: is idempotent across restarts', () => {
  const root = tmpRoot();
  seed(root, 'LLM Flow');
  const userDataDir = path.join(root, 'Flyt');

  migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });
  const second = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(second.migrated, false);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'), '{"providers":{}}');
});

// If the app is ever renamed back to a name in the legacy list, legacy and
// current resolve to the same path — renaming a directory onto itself is at
// best a no-op and at worst a way to lose it.
test('migrate: skips a legacy name that IS the current directory', () => {
  const root = tmpRoot();
  const userDataDir = seed(root, 'llm-flow', { 'settings.json': '{"same":true}' });

  const res = migrateUserDataDir({ appDataRoot: root, userDataDir, legacyNames: LEGACY });

  assert.equal(res.migrated, false);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'), '{"same":true}');
});
