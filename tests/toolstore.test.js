// ToolStore: tools are files (TOOLS-PLAN §4.1). These pin the properties the
// rest of the plan leans on — the built-ins seed themselves and stay in step
// with the modules that actually run, a malformed definition is disabled with
// a reason instead of crashing the library, and the runtime registry is built
// FROM the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolStore } from '../core/toolstore.js';
import { BUILTIN_MODULES } from '../core/tools/builtins.js';
import { loadLibrary, getTools, isDestructive, registerBuiltins, toolNames, executeTool } from '../core/tools/index.js';
import { normalizeTool, isDestructive as effectsDestructive } from '../src/toolTypes.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-tools-'));
const BUILTIN_IDS = BUILTIN_MODULES.map(t => t.name);

// The registry is process-global; a test that replaces it must put the
// built-ins back or it changes the meaning of every test that follows.
const restoreRegistry = () => registerBuiltins();

test('seeds one file per built-in, and seeding twice writes nothing new', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  assert.deepEqual(files, BUILTIN_IDS.map(id => `${id}.json`).sort());
  assert.deepEqual(store.seedBuiltins(), [], 'a second pass must be a no-op');

  const bash = store.load('bash');
  assert.equal(bash.provider, 'builtin');
  assert.equal(bash.trust, 'trusted');
  assert.deepEqual(bash.effects, ['shell']);
  assert.equal(bash.source.kind, 'builtin');
  assert.ok(bash.parameters.properties.command, 'the module schema reaches the file');
});

test('a released change to a built-in refreshes the file but keeps the user\'s fields', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  const file = path.join(dir, 'read_file.json');
  // What an install looks like after the user disables a tool and curates its
  // keywords, plus a stale description from an older release.
  const stale = { ...JSON.parse(fs.readFileSync(file, 'utf8')), description: 'old text', enabled: false, keywords: ['mine'] };
  fs.writeFileSync(file, JSON.stringify(stale, null, 2));

  const relaunched = new ToolStore(dir); // the constructor reseeds
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(relaunched.seedBuiltins(), [], 'the refresh converges in one pass');
  assert.equal(after.description, BUILTIN_MODULES.find(t => t.name === 'read_file').description);
  assert.equal(after.enabled, false, 'the user disabled it; a refresh must not switch it back on');
  assert.deepEqual(after.keywords, ['mine']);
});

test('a malformed definition is skipped, and the rest of the library still loads', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'no_id.json'), JSON.stringify({ title: 'nameless' }));

  const all = store.listFull();
  assert.equal(all.length, BUILTIN_IDS.length);
  assert.equal(store.problems.length, 2);
  assert.ok(store.problems.every(p => p.error));
});

test('a tool whose schema cannot be validated is stored DISABLED with the reason', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  store.save({
    id: 'remote_schema', description: 'imported', provider: 'http', effects: ['network'],
    parameters: { type: 'object', properties: { q: { $ref: 'https://evil.example/schema.json' } } }
  });
  const tool = store.load('remote_schema');
  assert.equal(tool.enabled, false);
  assert.match(tool.disabledReason, /external \$ref/);
  // ...and it never reaches the registry.
  const { skipped } = loadLibrary(store.listFull());
  assert.ok(skipped.some(s => s.id === 'remote_schema'));
  restoreRegistry();
});

test('the runtime registry is built from the files', async () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  store.setEnabled('bash', false);

  const { loaded, skipped } = loadLibrary(store.listFull());
  assert.deepEqual(loaded.sort(), BUILTIN_IDS.filter(id => id !== 'bash').sort());
  assert.deepEqual(skipped, [{ id: 'bash', reason: 'disabled' }]);
  assert.deepEqual(getTools(['bash']), [], 'a disabled tool resolves as missing, not as an error');

  const record = await executeTool('bash', { command: 'echo hi' }, {});
  assert.equal(record.ok, false);
  assert.match(record.error, /Unknown tool/);

  restoreRegistry();
  assert.deepEqual(toolNames().sort(), BUILTIN_IDS.slice().sort());
});

test('a definition naming a provider this build cannot run fails with a reason, not a crash', () => {
  const dir = tmp();
  const store = new ToolStore(dir);
  store.save({ id: 'jira_issue', description: 'later', provider: 'http', effects: ['network'], http: { url: 'https://example.test' }, parameters: { type: 'object', properties: {} } });
  const { skipped } = loadLibrary(store.listFull());
  assert.match(skipped.find(s => s.id === 'jira_issue').reason, /not available yet/);
  restoreRegistry();
});

test('the approval gate reads effects, and reproduces the pre-P1 destructive set', () => {
  // The literal Set that used to be hardcoded in core/tools/index.js.
  for (const id of ['write_file', 'create_file', 'bash']) {
    assert.equal(isDestructive(id), true, `${id} must still gate`);
  }
  for (const id of ['read_file', 'create_task', 'write_task_md']) {
    assert.equal(isDestructive(id), false, `${id} must still run ungated`);
  }
  // Unknown tools gate: fail-closed is the house rule.
  assert.equal(isDestructive('some_imported_thing'), true);
  // A run-scoped write is not the gate's business; a workspace write is.
  assert.equal(effectsDestructive({ effects: ['write'], scope: 'run' }), false);
  assert.equal(effectsDestructive({ effects: ['write'] }), true);
});

test('normalizeTool defaults, clamps and refuses to let an untrusted tool promote itself', () => {
  const t = normalizeTool({
    id: 'github__create_pr', description: 'open a PR', provider: 'mcp',
    effects: ['network', 'write', 'nonsense'], risk: 'safe', autoExecute: true,
    source: { kind: 'mcp', server: 'github' },
    parameters: { type: 'object', properties: {} }
  });
  assert.equal(t.trust, 'untrusted', 'trust follows the source, not the definition');
  assert.deepEqual(t.effects, ['write', 'network'], 'unknown effects are dropped');
  assert.equal(t.autoExecute, false, 'an untrusted tool cannot auto-execute itself');
  assert.deepEqual(t.result, { preview: 'json', maxPreviewChars: 2000, artifact: true });
  assert.throws(() => normalizeTool({ id: 'Bad Id' }), /Invalid tool id/);
});
