// edit_file (LOOP-BOARD §A1): anchored replacement. The two failure modes it
// exists to close — an ambiguous anchor silently hitting the wrong place, and a
// missing anchor sending the next turn back with another guess — are what most
// of these assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { Workspace } from '../core/workspace.js';
import { closestLine, findAll } from '../core/tools/edit_file.js';
import { makeStore } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-edit-'));

function boundCtx(files = {}) {
  const store = makeStore();
  const runId = store.createRun('edit_file test');
  const proj = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const workspace = new Workspace(proj).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace, proj };
}

const read = (ctx, rel) => fs.readFileSync(path.join(ctx.proj, rel), 'utf8');

test('edit_file: a unique anchor is replaced and the rest of the file is untouched', async () => {
  const ctx = boundCtx({ 'a.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'const b = 2;', new: 'const b = 20;' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 1);
  assert.equal(rec.result.line, 2);
  assert.equal(read(ctx, 'a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
});

test('edit_file: the result shows the edit with surrounding context', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const ctx = boundCtx({ 'a.txt': lines });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'line 10', new: 'LINE TEN' }, ctx);
  assert.equal(rec.ok, true);
  // ±3 lines: the agent has to be able to SEE what it did without re-reading.
  assert.match(rec.result.after, /line 7/);
  assert.match(rec.result.after, /LINE TEN/);
  assert.match(rec.result.after, /line 13/);
  assert.match(rec.result.before, /line 10/);
});

test('edit_file: an ambiguous anchor is refused, and the error names every line', async () => {
  const ctx = boundCtx({ 'a.js': 'x = 1;\nfoo();\ny = 2;\nfoo();\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'foo();', new: 'bar();' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /matches 2 times/);
  assert.match(rec.error, /lines 2, 4/);
  assert.match(rec.error, /replaceAll/);
  // Nothing was written: an ambiguous edit must not half-apply.
  assert.equal(read(ctx, 'a.js'), 'x = 1;\nfoo();\ny = 2;\nfoo();\n');
});

test('edit_file: replaceAll takes every occurrence', async () => {
  const ctx = boundCtx({ 'a.js': 'foo();\nfoo();\nfoo();\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'foo()', new: 'bar()', replaceAll: true }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 3);
  assert.equal(read(ctx, 'a.js'), 'bar();\nbar();\nbar();\n');
});

test('edit_file: no match carries the closest line, so the next turn can correct itself', async () => {
  const ctx = boundCtx({ 'a.js': 'const timeout = 10 * MINUTE;\nconst other = 1;\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'const timeout = 10 * MINUTES;', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /was not found/);
  assert.match(rec.error, /closest line is 1/);
  assert.match(rec.error, /10 \* MINUTE/);
});

test('edit_file: no plausible near-line still gives an actionable message', async () => {
  const ctx = boundCtx({ 'a.js': 'zzz\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'completely different content here', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /Read the file first/);
});

test('edit_file: a missing file points at create_file rather than creating one', async () => {
  const ctx = boundCtx({});
  const rec = await executeTool('edit_file', { path: 'nope.js', old: 'a', new: 'b' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /not found/);
  assert.match(rec.error, /create_file/);
  assert.equal(fs.existsSync(path.join(ctx.proj, 'nope.js')), false);
});

test('edit_file: a CRLF file keeps its line endings everywhere it was not touched', async () => {
  const ctx = boundCtx({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'two', new: 'TWO' }, ctx);
  assert.equal(rec.ok, true);
  // Splicing a substring cannot rewrite line endings — which is the whole
  // point next to a whole-file write on a repo with .gitattributes.
  assert.equal(read(ctx, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
});

test('edit_file: an empty `old` is refused rather than prepending', async () => {
  const ctx = boundCtx({ 'a.txt': 'body\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: '', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /empty/);
  assert.equal(read(ctx, 'a.txt'), 'body\n');
});

test('edit_file: an identical replacement reports 0 rather than a false success', async () => {
  const ctx = boundCtx({ 'a.txt': 'same\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'same', new: 'same' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 0);
  assert.equal(rec.result.unchanged, true);
});

test('edit_file: a 100k-line file edits in reasonable time', async () => {
  const big = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join('\n');
  const ctx = boundCtx({ 'big.txt': big });
  const started = Date.now();
  const rec = await executeTool('edit_file', { path: 'big.txt', old: 'line 99999', new: 'LAST' }, ctx);
  const ms = Date.now() - started;
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 1);
  // Generous, because CI machines vary — the point is that it is linear, not
  // that it is fast. A quadratic implementation blows straight past this.
  assert.ok(ms < 5000, `edit took ${ms}ms`);
});

test('findAll / closestLine: the two primitives behave', () => {
  assert.deepEqual(findAll('aXbXc', 'X'), [1, 3]);
  assert.deepEqual(findAll('aaaa', 'aa'), [0, 2]); // non-overlapping
  assert.deepEqual(findAll('abc', 'z'), []);
  assert.equal(closestLine('hello world\nsomething else', 'hello wurld').line, 1);
  assert.equal(closestLine('totally unrelated', 'nothing alike at all xyz'), null);
});
