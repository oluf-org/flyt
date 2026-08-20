// The settings profile: reading it, and — the part that bit — not destroying it.
//
// Every front door boots an engine, and every boot persists settings to seal
// the migration. That is fine while the read succeeds. It was not fine when the
// read failed: "there is no profile" and "I could not read the profile" shared
// one catch that returned defaults, and the next line wrote those defaults over
// the file. An unreadable settings.json cost the user every key, every pinned
// model and every worker assignment, silently, on the next launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-settings-'));

const boot = (userDataDir, warns = []) => createEngine({
  projectRoot, dataRoot: tmp(), userDataDir, warn: m => warns.push(String(m))
});

const configured = {
  providers: { openrouter: { apiKey: 'sk-or-v1-not-a-real-key' } },
  workers: { executor: { provider: 'auto', model: 'some/model' } },
  activeModels: [{ id: 'some/model', source: 'openrouter', enabled: true, pinned: true }],
  approvalMode: 'smart'
};

test('a profile that exists is read, and survives the boot that seals it', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(configured));

  const engine = boot(dir);
  assert.equal(engine.settings.workers.executor.model, 'some/model');
  assert.equal(engine.settings.approvalMode, 'smart');

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.workers.executor.model, 'some/model', 'the boot must not flatten what it just read');
  assert.equal(after.providers.openrouter.apiKey, 'sk-or-v1-not-a-real-key');
  assert.equal(after.activeModels.length, 1);
});

test('no profile at all is a fresh install, written without complaint', () => {
  const dir = tmp();
  const warns = [];
  boot(dir, warns);
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')), 'a fresh profile is created');
  assert.deepEqual(warns.filter(w => /settings/i.test(w)), [], 'a new install is not a warning');
});

// The one that mattered. A file that will not parse is the single moment where
// overwriting it is the worst available move.
test('a corrupt profile is moved aside and reported, never overwritten in place', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"providers": {"openrouter": {"apiKey": "sk-or-v1-half-writ');

  const warns = [];
  const engine = boot(dir, warns);
  assert.equal(engine.settings.workers?.executor?.model, undefined, 'it starts from defaults');

  const kept = fs.readdirSync(dir).filter(n => n.endsWith('.corrupt'));
  assert.equal(kept.length, 1, 'the original must still be on disk');
  assert.match(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), /sk-or-v1-half-writ/,
    'what the user configured is what has to survive');
  assert.ok(warns.some(w => /not valid JSON/.test(w) && /corrupt/.test(w)),
    'silent data loss is the failure mode; saying so is the fix');
});

// A directory where settings.json should be is an unreadable profile, not an
// absent one — and this process has nothing worth writing over it.
test('a profile that cannot be read is not written over', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'settings.json'));

  const warns = [];
  const engine = boot(dir, warns);
  assert.ok(warns.some(w => /NOT overwriting/.test(w)));
  assert.equal(engine.persistSettings(), false, 'later saves must refuse too, for the same reason');
  assert.ok(fs.statSync(path.join(dir, 'settings.json')).isDirectory(), 'still there, untouched');
});

// Several `flyt` invocations at once each overwrite this file. A non-atomic
// 90 KB write is how a reader catches the middle of one and decides the profile
// is corrupt.
test('a save is atomic: a reader sees the old file or the new one, never half', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(configured));
  const engine = boot(dir);

  engine.settings.modelFacts = Object.fromEntries(
    Array.from({ length: 4000 }, (_, i) => [`vendor/model-${i}`, { name: `Model ${i}`, contextLength: 128000 }]));
  assert.equal(engine.persistSettings(), true);

  const written = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(written), 'the file a reader sees is always parseable');
  assert.equal(Object.keys(JSON.parse(written).modelFacts).length, 4000);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('.tmp')), [], 'no temp file is left behind');
});
