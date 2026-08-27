// A per-project config file that says what it owns (t-0110).
//
// `.flyt/config.json` is created on first bind and its own first line says
// "Per-project configuration (version-controllable). Created on first bind;
// safe to commit and hand-edit." That invitation was mostly false. The engine
// reads its base configuration from `config.json` at the REPOSITORY ROOT
// (core/engine.js), and only `readProjectGateConfig` in core/gates.js and the
// home seed read this one. So a person who opened the file it told them to
// hand-edit and set `loop.minLevel`, `loop.caps`, `workers.reviewer` or
// `approvalMode` got no error, no warning, and no effect.
//
// Watched exactly that on 2026-08-26: `loop.minLevel: high` written here, the
// loop started, and it picked a task at the medium band on a free model as
// though nothing had been set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Workspace, PROJECT_CONFIG_KEYS, unreadProjectConfigKeys, whereItIsReadFrom
} from '../core/workspace.js';
import { readProjectGateConfig } from '../core/gates.js';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-projcfg-'));

test('the keys it owns are the keys something reads', () => {
  // Not a copy of the list — the actual reader, handed a config that sets
  // every owned key and one that is not owned.
  const root = project();
  const ws = new Workspace(root).ensure();
  ws.writeConfig({
    gates: ['npm test'], gateTimeoutMs: 60000,
    loop: { minLevel: 'high' }
  });

  const read = readProjectGateConfig(root);
  assert.deepEqual(read.gates, ['npm test']);
  assert.equal(read.gateTimeoutMs, 60000);
  assert.deepEqual(Object.keys(read).sort(), [...PROJECT_CONFIG_KEYS].sort(),
    'the gate reader takes these and nothing else');
});

test('a key nothing reads is named, and so is where it should have gone', () => {
  assert.deepEqual(unreadProjectConfigKeys({ comment: 'x', version: 1, gates: [] }), [],
    'the file as created is quiet');

  const unread = unreadProjectConfigKeys({
    version: 1, gates: ['npm test'], loop: { minLevel: 'high' }, workers: {}, approvalMode: 'always'
  });
  assert.deepEqual(unread, ['approvalMode', 'loop', 'workers']);

  assert.match(whereItIsReadFrom('loop'), /config\.json at the repository root|flyt loop start/);
  assert.match(whereItIsReadFrom('approvalMode'), /Settings/);
  assert.match(whereItIsReadFrom('providers'), /may not name providers or hold keys/);
  assert.match(whereItIsReadFrom('somethingNobodyHasHeardOf'), /Settings/,
    'an unknown key still gets an answer rather than nothing');
});

test('the list is short because a repository must not widen what a machine may do', () => {
  // The reason this is not simply "make .flyt/config.json work". A per-project
  // file is part of a repository, and a repository is something you clone. If
  // binding one could set approvalMode, name providers or raise a spend cap,
  // then cloning a repository would be enough to widen this machine's
  // authority — and a convenience may narrow authority, never widen it.
  //
  // Gates are the exception that proves it: "run these commands before anything
  // of mine lands" only ever ADDS a check.
  for (const dangerous of ['approvalMode', 'providers', 'providerPriority', 'workers', 'loop']) {
    assert.ok(!PROJECT_CONFIG_KEYS.includes(dangerous),
      `${dangerous} must not be settable by a repository`);
  }
  assert.deepEqual(PROJECT_CONFIG_KEYS, ['gates', 'gateTimeoutMs']);
});

test('the file created on first bind describes what it actually controls', () => {
  // The comment is the only documentation most people will ever read for this
  // file, and it was the thing that lied.
  const ws = new Workspace(project()).ensure();
  const { comment } = ws.readConfig();
  for (const key of PROJECT_CONFIG_KEYS) {
    assert.ok(comment.includes(key), `the comment names "${key}"`);
  }
  assert.match(comment, /IGNORED/, 'and says plainly that anything else is');
  assert.match(comment, /never widen|can never widen|widen what it is allowed to do/,
    'and why, because "ignored" without a reason reads as an oversight');
});

test('re-binding never rewrites a config somebody has edited', () => {
  const root = project();
  new Workspace(root).ensure();
  const ws = new Workspace(root);
  ws.writeConfig({ ...ws.readConfig(), gates: ['npm run check'] });

  new Workspace(root).ensure();
  assert.deepEqual(new Workspace(root).readConfig().gates, ['npm run check'],
    'ensure() is idempotent and does not clobber');
});
