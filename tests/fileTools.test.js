// Real file tools (V1 task 2): read_file / create_file / write_file act on the
// run's bound workspace, enforce path confinement, and log every call. Falls
// back to the run's own workspace sandbox when no project is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { runExecutorTask } from '../core/nodes/executor.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript, testConfig } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-ft-'));

// A ctx bound to a real project workspace, plus a run so tool calls can log.
function boundCtx() {
  const store = makeStore();
  const runId = store.createRun('file tools test');
  const proj = tmpDir();
  fs.writeFileSync(path.join(proj, 'existing.txt'), 'original contents\n');
  const workspace = new Workspace(proj).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace, proj };
}

const logEvents = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);

test('read_file: reads an existing repo file from the bound workspace', async () => {
  const ctx = boundCtx();
  const activity = [];
  ctx.onToolState = state => activity.push(state);
  const rec = await executeTool('read_file', { path: 'existing.txt' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.content, 'original contents\n');
  assert.equal(rec.result.target, 'workspace');
  assert.deepEqual(activity, [
    { tool: 'read_file', active: true },
    { tool: 'read_file', active: false }
  ]);
});

test('read_file: missing file returns a self-correctable error, and is logged', async () => {
  const ctx = boundCtx();
  const rec = await executeTool('read_file', { path: 'nope.txt' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /not found/);
  const calls = logEvents(ctx.store, ctx.runId).filter(e => e.event === 'tool_call' && e.tool === 'read_file');
  assert.equal(calls.length, 1); // every call is logged, success or failure
});

test('create_file: creates a new file, refuses to clobber an existing one', async () => {
  const ctx = boundCtx();
  const ok = await executeTool('create_file', { path: 'src/new.js', content: 'export const x = 1;\n' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(ctx.proj, 'src', 'new.js'), 'utf8'), 'export const x = 1;\n');

  const clash = await executeTool('create_file', { path: 'existing.txt', content: 'nope' }, ctx);
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already exists/);
  // The original file is untouched.
  assert.equal(fs.readFileSync(path.join(ctx.proj, 'existing.txt'), 'utf8'), 'original contents\n');
});

test('write_file: edits (overwrites) an existing repo file', async () => {
  const ctx = boundCtx();
  const rec = await executeTool('write_file', { path: 'existing.txt', content: 'edited!\n' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(fs.readFileSync(path.join(ctx.proj, 'existing.txt'), 'utf8'), 'edited!\n');
});

test('path confinement: no write or read escapes the workspace root', async () => {
  const ctx = boundCtx();
  const canaryParent = path.dirname(ctx.proj);
  for (const bad of ['../escape.txt', '../../oops.txt']) {
    const w = await executeTool('write_file', { path: bad, content: 'x' }, ctx);
    assert.equal(w.ok, false, `write to ${bad} should be rejected`);
    assert.match(w.error, /escapes the workspace/);
  }
  // Nothing leaked outside the workspace.
  assert.equal(fs.existsSync(path.join(canaryParent, 'escape.txt')), false);
  const r = await executeTool('read_file', { path: '../../etc/passwd' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes the workspace/);
});

test('executor: an agentTask reads, creates, and edits real workspace files', async () => {
  const store = makeStore();
  const runId = store.createRun('build a feature');
  const proj = tmpDir();
  fs.writeFileSync(path.join(proj, 'existing.txt'), 'v1\n');
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: new Workspace(proj).ensure().root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Edit the repo', goal: 'Read, create, and edit files.',
    inputs: ['prompt.md'], constraints: [], tools: ['read_file', 'create_file', 'write_file'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });

  // Drive the text tool protocol: read existing → create new → edit existing → done.
  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT'))
      return '```tool\n{"tool":"read_file","args":{"path":"existing.txt"}}\n```';
    if (!prompt.includes('TOOL RESULT (create_file)'))
      return '```tool\n{"tool":"create_file","args":{"path":"src/new.js","content":"export const x = 1;\\n"}}\n```';
    if (!prompt.includes('TOOL RESULT (write_file)'))
      return '```tool\n{"tool":"write_file","args":{"path":"existing.txt","content":"v2 (edited)\\n"}}\n```';
    return '## Done\nRead existing.txt, created src/new.js, edited existing.txt.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  // The real repo was mutated: new file created, existing file edited.
  assert.equal(fs.readFileSync(path.join(proj, 'src', 'new.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(fs.readFileSync(path.join(proj, 'existing.txt'), 'utf8'), 'v2 (edited)\n');

  const tools = logEvents(store, runId).filter(e => e.event === 'tool_call').map(e => e.tool);
  assert.deepEqual(tools, ['read_file', 'create_file', 'write_file']); // all logged, in order
});

test('fallback: with no bound workspace, file tools use the run sandbox', async () => {
  const store = makeStore();
  const runId = store.createRun('no workspace');
  const ctx = { store, runId, taskId: 'task-1', workspace: null };
  const rec = await executeTool('write_file', { path: 'notes.md', content: '# hi\n' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.target, 'run-workspace');
  assert.equal(rec.result.written, 'workspace/notes.md'); // relative to the run dir, as before
  assert.equal(store.readWorkspaceFile(runId, 'notes.md'), '# hi\n');
});

// --- search answers the same question every other file tool does -----------
//
// A search that says "not here" about code that IS here is worse than one that
// errors, because nobody goes looking for a bug in a negative result. Read
// blindly as UTF-8, every line of a CRLF file ended with a carriage return, so
// any pattern anchored to end-of-line matched nothing, in silence.

test('search_files: an end-of-line anchor matches in a CRLF file', async () => {
  const CR = String.fromCharCode(13);
  const ctx = boundCtx();
  fs.writeFileSync(path.join(ctx.proj, 'crlf.js'),
    Buffer.from('const foo = 1;' + CR + '\n' + 'const bar = 2;' + CR + '\n', 'utf8'));

  const rec = await executeTool('search_files', { pattern: 'foo = 1;$' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.result.results.length, 1, 'the line is there, so it must be found');
  assert.ok(!rec.result.results[0].text.endsWith(CR),
    'and the hit is not reported with a stray carriage return on it');
});

test('search_files: a UTF-16 file is searched as text, not as mojibake', async () => {
  const ctx = boundCtx();
  fs.writeFileSync(path.join(ctx.proj, 'wide.js'), Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from('const needle = 1;\n', 'utf16le'),
  ]));

  const rec = await executeTool('search_files', { pattern: 'needle' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.result.results.length, 1, 'a NUL between every letter matched nothing before');
});

test('search_files: a binary file is skipped rather than searched as text', async () => {
  const ctx = boundCtx();
  fs.writeFileSync(path.join(ctx.proj, 'logo.png'), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(64, 0x00),
  ]));

  const rec = await executeTool('search_files', { pattern: 'PNG' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.result.results.length, 0, 'its bytes are not lines of text');
});
