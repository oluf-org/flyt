// The Python sidecar (core/python.js) and the one-shot tool door (tool:run).
//
// Both exist for the same reason: a capability that cannot be TRIED cannot be
// authored. Before these, adding a tool meant writing a module, writing a
// definition, and then paying for a whole run to discover the first typo — and
// a tool that borrows a Python library had no way to say "the library is not
// installed" other than a traceback from inside a spawn.
//
// Nothing here reaches the network or needs a real Python: the interpreter is
// resolved from paths under a temp directory, and the one place a real spawn is
// asserted is skipped when the machine has no Python at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';
import {
  resolvePython, managedVenvDir, venvPython, runPythonScript, pythonStatus, NO_PYTHON_REMEDY
} from '../core/python.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-py-'));

function makeApi() {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  return { engine, api: createApi(engine), dataRoot };
}

// A file that exists and is executable enough for fs.existsSync, which is all
// resolution asks: whether it RUNS is the spawn's problem and is reported.
function fakeInterpreter(dir, name = 'python') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
  fs.writeFileSync(file, '');
  return file;
}

// --- resolution -------------------------------------------------------------

test('the interpreter is resolved in declared order: env, settings, managed venv, PATH', () => {
  const root = tmp();
  const declared = fakeInterpreter(path.join(root, 'declared'));
  const configured = fakeInterpreter(path.join(root, 'configured'));

  const managedDir = managedVenvDir(root);
  fs.mkdirSync(path.dirname(venvPython(managedDir)), { recursive: true });
  fs.writeFileSync(venvPython(managedDir), '');

  assert.equal(
    resolvePython({ userDataDir: root, settings: { python: { bin: configured } }, env: { FLYT_PYTHON: declared } }).source,
    'FLYT_PYTHON', 'saying it out loud for this process must win');

  assert.equal(
    resolvePython({ userDataDir: root, settings: { python: { bin: configured } }, env: {} }).source,
    'settings', 'a setting must beat the managed venv');

  const managed = resolvePython({ userDataDir: root, settings: null, env: {} });
  assert.equal(managed.source, 'managed');
  assert.equal(managed.bin, venvPython(managedDir));
  assert.equal(managed.managed, true);
});

// A declared interpreter that is not there must not silently fall through to
// PATH: that is how a run ends up using a different Python from the one the
// packages were installed into, and reports ModuleNotFoundError forever.
test('a declared interpreter that does not exist reports itself rather than falling back', () => {
  const resolved = resolvePython({ userDataDir: null, settings: null, env: { FLYT_PYTHON: 'C:/nope/python.exe' } });
  assert.equal(resolved.bin, null);
  assert.equal(resolved.source, 'FLYT_PYTHON');
  assert.equal(resolved.declared, 'C:/nope/python.exe');
});

test('no interpreter at all is a status with a remedy, never a throw', async () => {
  const status = await pythonStatus({ userDataDir: null, settings: null, packages: ['scrapling'], env: { FLYT_PYTHON: '/nope/python' } });
  assert.equal(status.ok, false);
  assert.equal(status.remedy, NO_PYTHON_REMEDY);
  assert.deepEqual(status.missing, ['scrapling'], 'a package cannot be present on an interpreter that is not there');
});

// --- the bridge -------------------------------------------------------------

test('a run with no interpreter is a result, not a rejected promise', async () => {
  const result = await runPythonScript('print(1)', {}, { bin: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /no Python interpreter/);
  assert.equal(result.remedy, NO_PYTHON_REMEDY);
});

test('a script that is not JSON on stdout fails with what it actually printed', async () => {
  const real = resolvePython({ env: process.env });
  if (!real.bin) return; // no Python on this machine: nothing to assert against
  const result = await runPythonScript('print("hello, not json")', {}, { bin: real.bin, timeoutMs: 20_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return JSON/);
  assert.match(String(result.stderr), /hello, not json/);
});

test('the payload travels on stdin, and the script owns its own verdict', async () => {
  const real = resolvePython({ env: process.env });
  if (!real.bin) return;
  const echo = [
    'import json, sys',
    'd = json.load(sys.stdin)',
    'print(json.dumps({"ok": d["fine"], "seen": d["url"]}))'
  ].join('\n');

  const good = await runPythonScript(echo, { fine: true, url: 'https://example.com/a b&c' }, { bin: real.bin, timeoutMs: 20_000 });
  assert.equal(good.ok, true);
  // Whatever the shell would have done to that URL as an argv element, stdin
  // does not do.
  assert.equal(good.seen, 'https://example.com/a b&c');

  const refused = await runPythonScript(echo, { fine: false, url: 'x' }, { bin: real.bin, timeoutMs: 20_000 });
  assert.equal(refused.ok, false, 'ok:false from the script must survive exit code 0');
});

test('a script that will not finish is killed at the timeout', async () => {
  const real = resolvePython({ env: process.env });
  if (!real.bin) return;
  const started = Date.now();
  const result = await runPythonScript('import time\ntime.sleep(30)', {}, { bin: real.bin, timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.ok(Date.now() - started < 20_000, 'the timeout must actually kill the process');
});

// --- the one-shot tool door -------------------------------------------------

test('tool:show returns the schema, and an unknown id names what exists', async () => {
  const { api } = makeApi();
  const shown = await api.invoke('tool:show', { id: 'read_file' });
  assert.equal(shown.id, 'read_file');
  assert.ok(shown.parameters?.properties, 'the schema is the reason this command exists');
  assert.equal(shown.bound, true);
  await assert.rejects(() => api.invoke('tool:show', { id: 'read_fil' }), err =>
    err instanceof ApiError && err.status === 404 && /read_file/.test(err.message));
});

test('tool:run calls a read-only tool straight through', async () => {
  const { api, dataRoot } = makeApi();
  const folder = path.join(dataRoot, 'work');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'hello.txt'), 'from the workspace');
  const { id: projectId } = await api.invoke('project:open', { folder });

  const record = await api.invoke('tool:run', { projectId, id: 'read_file', args: { path: 'hello.txt' } });
  assert.equal(record.ok, true, record.error);
  assert.match(JSON.stringify(record.result), /from the workspace/);
  assert.equal(typeof record.ms, 'number');
});

// The convenience must narrow authority, never widen it (CLAUDE.md standing
// rules). A door that runs `bash` with no gate and no approval mode would be a
// strictly larger authority than the run loop has.
test('tool:run refuses a write or a shell call until the caller says so', async () => {
  const { api, dataRoot } = makeApi();
  const folder = path.join(dataRoot, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const { id: projectId } = await api.invoke('project:open', { folder });

  await assert.rejects(
    () => api.invoke('tool:run', { projectId, id: 'write_file', args: { path: 'x.txt', content: 'hi' } }),
    err => err instanceof ApiError && err.code === 'needs_confirm');
  assert.equal(fs.existsSync(path.join(folder, 'x.txt')), false, 'a refused call must not have run');

  const record = await api.invoke('tool:run', {
    projectId, id: 'write_file', args: { path: 'x.txt', content: 'hi' }, confirm: true
  });
  assert.equal(record.ok, true, record.error);
  assert.equal(fs.readFileSync(path.join(folder, 'x.txt'), 'utf8'), 'hi');
});

test('a failing tool call comes back as a record, not a rejection', async () => {
  const { api, dataRoot } = makeApi();
  const folder = path.join(dataRoot, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const { id: projectId } = await api.invoke('project:open', { folder });
  const record = await api.invoke('tool:run', { projectId, id: 'read_file', args: { path: 'nope.txt' } });
  assert.equal(record.ok, false);
  assert.ok(record.error, 'the reason is what the caller is here for');
});

test('tool:problems reports definitions the library holds but cannot bind', async () => {
  const { api, dataRoot } = makeApi();
  const before = await api.invoke('tool:problems', {});
  assert.deepEqual(before.unbound, [], 'a healthy library binds everything it ships');

  // A definition naming a built-in module this build does not ship: listed,
  // looks healthy, cannot run. That is exactly the silent failure this reports.
  fs.writeFileSync(path.join(dataRoot, 'tools', 'ghost_tool.json'), JSON.stringify({
    id: 'ghost_tool', title: 'Ghost', description: 'names a module that is not here',
    provider: 'builtin', enabled: true, effects: ['read'],
    parameters: { type: 'object', properties: {} }
  }));
  const after = await api.invoke('tool:problems', {});
  assert.ok(after.unbound.some(u => u.id === 'ghost_tool' && /does not ship/.test(u.reason)));
});

// --- what the model actually receives --------------------------------------
//
// The full result is archived and the model gets a bounded preview (§5). The
// bound is per tool, and a tool that declares none takes the 2,000-char
// default — which for read_file, after the per-string share, is about a
// thousand characters of file. Every real source file came back as a stub, so
// an agent read files with `bash sed` instead: a dozen calls over one 194-line
// test, each resending the whole growing conversation.

import { previewResult } from '../core/tools/preview.js';
import { getTools } from '../core/tools/index.js';

const budgetOf = id => getTools([id])[0]?.result ?? {};

test('read_file returns an ordinary source file whole, not as a stub', () => {
  // ~7 KB: smaller than most modules in this repository.
  const content = Array.from({ length: 200 }, (_, i) => `  const line${i} = doSomething(${i}); // a comment of ordinary length`).join('\n');
  const result = { path: 'core/tools/example.js', content, bytes: Buffer.byteLength(content), target: 'workspace' };

  const { value, truncated } = previewResult(result, budgetOf('read_file'));
  assert.equal(truncated, false, 'a 7 KB file must not need a handle to be read');
  assert.equal(value.content, content);

  // And the old default is what it used to get, so this stays a regression test
  // rather than an assertion about a number nobody chose.
  assert.equal(previewResult(result, {}).truncated, true);
});

// The tool whose entire job is to read MORE than a preview must not be cut back
// to a preview on its way out.
test('read_tool_result is not re-truncated by the bound it exists to escape', () => {
  const budget = budgetOf('read_tool_result');
  const value = { handle: '@tool:1', tool: 'bash', value: 'x'.repeat(20_000) };
  assert.equal(previewResult(value, budget).truncated, false,
    'a caller asking for 20,000 characters and getting 1,000 abandons the mechanism');
});

test('every read tool declares what it is willing to show', () => {
  for (const id of ['read_file', 'search_files', 'search_references', 'glob', 'read_tool_result']) {
    const budget = budgetOf(id);
    assert.ok(budget.maxPreviewChars > 2000,
      `${id} takes the default preview budget, which is too small for what it returns`);
  }
});
