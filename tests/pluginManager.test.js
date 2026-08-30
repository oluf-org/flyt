// The plugin manager's judgements, held to what they claim.
//
// The manager is a screen with three destructive-ish verbs on it, and which
// verbs a row gets is the whole safety story: Flyt's own services are the block
// registry, the tool gate and the approval policy, and every one of them is
// reachable from the same list as a package somebody installed yesterday. These
// tests are about the line between them, not about React.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configChanged, configDraft, filterPlugins, parseConfigDraft, pluginActions,
  pluginConfigurable, pluginProvenance, pluginRemovable, pluginShelves, pluginStatus,
  pluginTree, removalConsequence,
} from '../src/v2/pluginManager.js';
import {
  persistPluginConfig, persistPluginRemoval, persistPluginRestore, readPluginPatch,
  serializePluginPatch,
} from '../core/pluginPatch.js';

const row = (patch = {}) => ({
  id: 'acme', name: 'Acme', specifier: '@acme/flyt', description: 'Does a thing.',
  source: 'home', contributes: ['tools'], inject: [], builtin: false, group: false,
  parentId: null, installed: true, state: 'active', ...patch,
});

const verbs = plugin => pluginActions(plugin).map(action => action.id);

test('Flyt’s own services get no lifecycle verbs at all', () => {
  const service = row({ id: 'tools', name: 'Tool registry', specifier: 'flyt:tools', builtin: true });
  assert.deepEqual(verbs(service), [],
    'restarting the tool gate disposes the check every running block goes through');
  assert.equal(pluginRemovable(service).ok, false);
  assert.equal(pluginConfigurable(service).ok, false);
  assert.match(pluginRemovable(service).reason, /part of Flyt/);
});

test('a group is answered as a group, not as a built-in', () => {
  // The host marks every group `builtin` because there is no module behind it,
  // not because Flyt ships it. Asking about `builtin` first told a person their
  // own group was part of the app.
  const group = row({ id: 'research', specifier: 'cordis:group', builtin: true, group: true });
  assert.match(pluginRemovable(group).reason, /rows inside it/);
  assert.match(pluginConfigurable(group).reason, /rows inside it/);
  assert.deepEqual(verbs(group), []);
});

test('an installed plugin gets the three verbs, and a failed one leads with the retry', () => {
  assert.deepEqual(verbs(row()), ['configure', 'restart', 'uninstall']);
  const broken = row({ state: 'failed', error: 'ENOTFOUND' });
  assert.deepEqual(verbs(broken), ['restart', 'configure', 'uninstall']);
  assert.equal(pluginActions(broken)[0].label, 'Retry');
});

test('status says what a state means, and pending names what it is waiting for', () => {
  assert.equal(pluginStatus(row()).tone, 'ok');
  const waiting = pluginStatus(row({ state: 'pending', inject: ['tools', 'http'] }));
  assert.equal(waiting.tone, 'warn');
  assert.match(waiting.detail, /tools, http/,
    'a spinner says wait; naming the missing service says what to go and do');
  const failed = pluginStatus(row({ state: 'failed', error: 'the notebook host did not resolve' }));
  assert.equal(failed.tone, 'err');
  assert.match(failed.detail, /notebook host/);
  // A failed row with no message still has to say something a person can read.
  assert.match(pluginStatus(row({ state: 'failed' })).detail, /gave no reason/);
  // An unknown state is read as active rather than crashing the pane.
  assert.equal(pluginStatus(row({ state: 'somethingelse' })).state, 'active');
});

test('provenance answers "why is this plugin here" from the composition layer', () => {
  assert.equal(pluginProvenance(row({ source: 'home' })).label, 'This machine');
  assert.equal(pluginProvenance(row({ source: 'bundle:@acme/pack' })).label, '@acme/pack');
  assert.equal(pluginProvenance(row({ source: 'profile:flyt-desktop' })).label, 'flyt-desktop');
  assert.equal(pluginProvenance(row({ source: 'cli' })).label, 'Command line');
});

test('the removal sentence names what stops working and where it is written down', () => {
  const rows = [
    row({ id: 'research', group: true, builtin: true, contributes: [] }),
    row({ id: 'web', name: 'Web search', parentId: 'research' }),
  ];
  const group = removalConsequence(rows[0], rows);
  assert.match(group, /1 plugin inside it \(Web search\) goes with it/);
  assert.match(group, /deleted from/, 'a row this machine added is deleted, not disabled');

  const bundled = removalConsequence(row({ source: 'bundle:@acme/pack' }), []);
  assert.match(bundled, /switched off/,
    'this layer cannot delete a row a bundle composed — it can only patch it');
  assert.match(bundled, /Its tools stop being available/);
});

test('the tree keeps composition order and only adds depth', () => {
  const rows = pluginTree([
    row({ id: 'a' }), row({ id: 'g', group: true }), row({ id: 'b', parentId: 'g' }), row({ id: 'c' }),
  ]);
  assert.deepEqual(rows.map(r => r.id), ['a', 'g', 'b', 'c'], 'order carries what was composed inside what');
  assert.deepEqual(rows.map(r => r.depth), [0, 0, 1, 0]);
});

test('a group shelves with its children, not with the services it is marked like', () => {
  const [installed, builtin] = pluginShelves([
    row({ id: 'tools', builtin: true }),
    row({ id: 'research', builtin: true, group: true }),
    row({ id: 'web', parentId: 'research' }),
  ]);
  assert.deepEqual(installed.rows.map(r => r.id), ['research', 'web'],
    'a child indented under a parent on the other shelf points at nothing');
  assert.deepEqual(builtin.rows.map(r => r.id), ['tools']);
});

test('search covers what a person actually has in hand', () => {
  const rows = [
    row({ id: 'a', name: 'Web search', specifier: '@acme/flyt-web-search' }),
    row({ id: 'b', name: 'Notes', specifier: 'flyt:notes' }),
  ];
  assert.deepEqual(filterPlugins(rows, '@acme').map(r => r.id), ['a'], 'the package name, not only the display name');
  assert.deepEqual(filterPlugins(rows, 'NOTES').map(r => r.id), ['b']);
  assert.deepEqual(filterPlugins(rows, '').map(r => r.id), ['a', 'b']);
});

test('the configuration editor refuses anything the composition cannot merge', () => {
  assert.equal(configDraft(row({ config: undefined })), '{}',
    'an empty box cannot tell "mounted with nothing" apart from "failed to load"');
  assert.equal(configDraft(row({ config: { a: 1 } })), '{\n  "a": 1\n}');

  assert.equal(parseConfigDraft('{"a":1}').ok, true);
  assert.equal(parseConfigDraft('   ').ok, true, 'blank is "no configuration", which is a real answer');
  assert.equal(parseConfigDraft('{ nope').ok, false);
  assert.match(parseConfigDraft('[1,2]').error, /mapping of settings/,
    'every layer of the composition merges mappings; a list is not one');
  assert.match(parseConfigDraft('"just a string"').error, /mapping of settings/);

  assert.equal(configChanged(row({ config: { a: 1 } }), '{"a":1}'), false);
  assert.equal(configChanged(row({ config: { a: 1 } }), '{"a":2}'), true);
  assert.equal(configChanged(row({ config: undefined }), ''), false);
  assert.equal(configChanged(row({ config: { a: 1 } }), 'broken'), true,
    'an unparseable draft is a change, so Save is never enabled by a syntax error');
});

// --- the other half: a change that does not survive a restart is not a change ---

const withPatch = fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-patch-'));
  try { return fn(path.join(dir, 'nested', 'cordis.patch.yml')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('the home patch round-trips through the loader’s own parser', () => {
  withPatch(file => {
    assert.deepEqual(readPluginPatch(file), [], 'a machine nobody configured is not an error');
    const rows = [
      { id: 'blocks-core', name: 'flyt:blocks-core', disabled: true },
      { id: 'x', name: '@acme/x', config: { key: 'yes', n: '007', deep: { list: [1, 'two', { c: true }] } } },
      { id: 'empty', name: 'flyt:none', config: {} },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializePluginPatch(rows), 'utf8');
    assert.deepEqual(readPluginPatch(file), rows,
      'what the manager writes is what the next boot composes, exactly');
  });
});

test('configuring writes the row; removing deletes ours and disables theirs', () => {
  withPatch(file => {
    persistPluginConfig(file, { id: 'x', name: '@acme/x', source: 'home' }, { key: 'v' });
    assert.deepEqual(readPluginPatch(file), [{ id: 'x', name: '@acme/x', config: { key: 'v' } }]);

    // A second edit amends the row rather than appending a second one with the
    // same id — the loader refuses a file with two rows sharing an id.
    persistPluginConfig(file, { id: 'x', name: '@acme/x', source: 'home' }, { key: 'w' });
    assert.deepEqual(readPluginPatch(file), [{ id: 'x', name: '@acme/x', config: { key: 'w' } }]);

    // Ours: deleting the row restores the state before anybody added it.
    persistPluginRemoval(file, { id: 'x', name: '@acme/x', source: 'home' });
    assert.deepEqual(readPluginPatch(file), []);

    // Theirs: this layer cannot delete what a bundle composed, so it switches
    // it off — and the row survives a restart switched off, which is the whole
    // point of doing this at all.
    persistPluginRemoval(file, { id: 'core', name: 'flyt:blocks-core', source: 'profile:flyt-desktop' });
    assert.deepEqual(readPluginPatch(file), [{ id: 'core', name: 'flyt:blocks-core', disabled: true }]);
    persistPluginRestore(file, { id: 'core', name: 'flyt:blocks-core', source: 'profile:flyt-desktop' });
    assert.deepEqual(readPluginPatch(file), [{ id: 'core', name: 'flyt:blocks-core' }]);
  });
});

test('a patch nobody can parse is refused rather than quietly replaced', () => {
  withPatch(file => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'id: not-a-list\n', 'utf8');
    assert.throws(() => readPluginPatch(file), /list of entries/,
      'starting from an empty list would throw away what somebody wrote by hand');
    fs.writeFileSync(file, '- name: nameless\n', 'utf8');
    assert.throws(() => readPluginPatch(file), /needs an id/);
  });
});

// --- and the wiring, so the manager's verbs are not four dead buttons ---

test('every plugin verb crosses IPC and works in the browser harness', () => {
  const read = relative => fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
  const preload = read('electron/preload.cjs');
  const mock = read('src/devMock.js');
  const main = read('electron/main.js');
  for (const method of ['v2Plugins', 'v2ConfigurePlugin', 'v2RestartPlugin', 'v2UninstallPlugin']) {
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} must cross Electron IPC`);
    assert.match(mock, new RegExp(`\\b${method}:`), `${method} must work in the browser harness`);
  }
  for (const channel of ['v2:plugins', 'v2:plugin-configure', 'v2:plugin-restart', 'v2:plugin-uninstall']) {
    assert.match(main, new RegExp(`'${channel}'`), `${channel} needs a handler on the other side`);
  }
  // Both halves of every change, or the button expires at the next restart.
  assert.match(main, /persistPluginConfig\(pluginPatchFile\(\)/);
  assert.match(main, /persistPluginRemoval\(pluginPatchFile\(\)/);
  // And the boundary draws the same line the buttons do, rather than trusting
  // that the only caller is a screen that already checked.
  assert.match(main, /pluginRow\(id, \{ mutable: true \}\)/);
});

test('the trust review is at the shell root, where an install can always find it', () => {
  const shell = fs.readFileSync(fileURLToPath(new URL('../src/v2/Shell.jsx', import.meta.url)), 'utf8');
  assert.match(shell, /<PluginTrustReview/);
  // Rendered inside Build, an installation that published a review while
  // somebody was on Work or Models parked with nothing on screen asking about
  // it. The panel — which is every destination there is — has to close first.
  assert.ok(shell.indexOf('<PluginTrustReview') > shell.lastIndexOf('</section>'),
    'a modal that only exists on one surface is a modal an install can miss');
});
