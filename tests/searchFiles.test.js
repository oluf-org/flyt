// search_files: the workspace grep.
//
// Why it exists is in the tool's own header — a Loop task spent forty rounds
// reading three large files in windows, wrote nothing, and named the missing
// tool in its failure report. These tests pin the parts of it that decide
// whether it actually replaces that behaviour: it must find a line in a file
// nobody named, it must not drown the answer in one noisy file or in
// node_modules, and a zero-hit search must not read as "this project does not
// do that".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool, getTools } from '../core/tools/index.js';
import { Workspace } from '../core/workspace.js';
import { WORK_TOOLS } from '../src/flowTypes.js';

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-search-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  return { dir, ctx: { workspace: new Workspace(dir).ensure() } };
}

const run = (ctx, args) => executeTool('search_files', args, ctx);

test('it finds a symbol in a file nobody named, with the line to read next', async () => {
  const { ctx } = project({
    'core/api.js': "const commands = {\n  'run:explain': ({ runId }) => explain(runId),\n  'run:stop': stop\n};\n",
    'README.md': 'Nothing to see.\n'
  });
  const r = await run(ctx, { pattern: "run:explain" });
  assert.equal(r.ok, true);
  assert.equal(r.result.hits, 1);
  assert.equal(r.result.results[0].path, 'core/api.js');
  assert.equal(r.result.results[0].line, 2, 'the line number is what makes the next read cheap');
  assert.match(r.result.results[0].text, /run:explain/);
});

test('canonical search success never mutates the legacy run log', async () => {
  const { ctx } = project({ 'a.js': 'const target = true;\n' });
  ctx.canonicalSession = true;
  ctx.runId = 'canonical-run';
  ctx.store = { appendLog() { throw new Error('legacy mutation rejected'); } };
  const result = await run(ctx, { pattern: 'target' });
  assert.equal(result.ok, true);
  assert.equal(result.result.hits, 1);
});

test('search excludes its own run history while retaining authored Flyt configuration', async () => {
  const files = {
    '.flyt/runs/chat/session.jsonl': 'cloud sync claim from the model',
    '.flyt/config.json': 'cloud sync disabled',
    'src/storage.js': 'cloud sync is absent',
  };
  const { ctx } = project(files);
  for (const seam of [false, true]) {
    if (seam) ctx.fs = {
      list: async () => Object.keys(files).map(path => ({ path, kind: 'file' })),
      read: async path => files[path],
    };
    const result = await run(ctx, { pattern: 'cloud sync' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.results.map(x => x.path).sort(), ['.flyt/config.json', 'src/storage.js']);
  }
});

test('a glob narrows it to the files worth searching', async () => {
  const { ctx } = project({
    'src/a.jsx': 'const stage = "awaiting_input";\n',
    'core/b.js': 'const stage = "awaiting_input";\n'
  });
  const r = await run(ctx, { pattern: 'awaiting_input', glob: 'src/**/*.jsx' });
  assert.deepEqual(r.result.results.map(x => x.path), ['src/a.jsx']);
});

test('context lines come back when asked for, and not otherwise', async () => {
  const { ctx } = project({ 'a.js': 'one\ntwo\nTARGET\nfour\nfive\n' });
  const bare = await run(ctx, { pattern: 'TARGET' });
  assert.equal(bare.result.results[0].before, undefined);

  const withCtx = await run(ctx, { pattern: 'TARGET', context: 1 });
  assert.deepEqual(withCtx.result.results[0].before, ['two']);
  assert.deepEqual(withCtx.result.results[0].after, ['four']);
});

test('one noisy file cannot hide the file that answers the question', async () => {
  const { ctx } = project({
    'noisy.js': Array.from({ length: 50 }, (_, i) => `// thing ${i}`).join('\n'),
    'answer.js': '// thing that matters\n'
  });
  const r = await run(ctx, { pattern: 'thing', maxPerFile: 2 });
  const perFile = r.result.results.filter(x => x.path === 'noisy.js').length;
  assert.equal(perFile, 2);
  assert.ok(r.result.results.some(x => x.path === 'answer.js'),
    'the quiet file is still reachable');
});

test('build output and dependencies are not the project', async () => {
  const { ctx } = project({
    'node_modules/dep/index.js': 'export const needle = 1;\n',
    'dist/bundle.js': 'var needle = 1;\n',
    'src/real.js': 'const needle = 1;\n'
  });
  const r = await run(ctx, { pattern: 'needle' });
  assert.deepEqual(r.result.results.map(x => x.path), ['src/real.js']);
});

test('zero hits says what was searched instead of implying absence', async () => {
  const { ctx } = project({ 'a.js': 'nothing here\n' });
  const r = await run(ctx, { pattern: 'definitelyNotPresent' });
  assert.equal(r.result.hits, 0);
  assert.match(r.result.note, /No line matched in \d+ file\(s\)/);
  assert.match(r.result.note, /before concluding it is absent/);
});

test('a bad regular expression is the model\'s to fix, not a crash', async () => {
  const { ctx } = project({ 'a.js': 'x\n' });
  const r = await run(ctx, { pattern: '([unclosed' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a valid regular expression/);
});

test('case sensitivity is opt-in, because "Runner" and "runner" are the same question', async () => {
  const { ctx } = project({ 'a.js': 'class StackRunner {}\n' });
  assert.equal((await run(ctx, { pattern: 'stackrunner' })).result.hits, 1);
  assert.equal((await run(ctx, { pattern: 'stackrunner', caseSensitive: true })).result.hits, 0);
});

test('it is read-effect, workspace-scoped, and reaches every work node', async () => {
  const def = getTools().find(t => t.name === 'search_files');
  assert.ok(def, 'the tool is in the registry');
  assert.deepEqual(def.effects, ['read']);
  assert.equal(def.scope, 'workspace');
  assert.equal(def.risk, 'safe');
  // Being in the registry is not being GRANTED. glob shipped and was granted to
  // nobody once; this pins that this one is not repeating it.
  for (const grant of Object.values(WORK_TOOLS)) {
    assert.ok(grant.includes('search_files'), 'every work task type can search the project it edits');
  }
});
