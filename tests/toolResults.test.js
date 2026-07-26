// Tool results as artifacts (TOOLS-PLAN P2/§13): every call writes its full,
// untruncated result to runs/<id>/tools/<seq>-<tool>.json, the model gets a
// bounded preview plus a handle, and read_tool_result redeems the handle.
//
// The assertions are on the FILES, because that is what "file-based state is
// the single source of truth" means when it is tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { previewResult } from '../core/tools/preview.js';
import { redactArgs, REDACTED } from '../core/tools/redact.js';
import { Workspace } from '../core/workspace.js';
import { makeStore } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-toolres-'));
const NODE = JSON.stringify(process.execPath);

function boundCtx() {
  const store = makeStore();
  const runId = store.createRun('tool results test');
  const workspace = new Workspace(tmpDir()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace };
}

const artifactsOf = ctx =>
  fs.readdirSync(ctx.store.toolResultsDir(ctx.runId)).sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
const readArtifact = (ctx, file) =>
  JSON.parse(fs.readFileSync(path.join(ctx.store.toolResultsDir(ctx.runId), file), 'utf8'));
const logEvents = ctx => ctx.store.readLog(ctx.runId);

test('a 200 KB command output survives in full on disk with a bounded preview in context', async () => {
  const ctx = boundCtx();
  // 200_000 characters of stdout — well past anything that belongs in a prompt.
  const rec = await executeTool('bash',
    { command: `${NODE} -e "process.stdout.write('x'.repeat(200000)); console.log('DONE-MARKER')"` }, ctx);

  assert.equal(rec.ok, true);
  assert.equal(rec.truncated, true);
  assert.ok(rec.result.stdout.length < 5000, `preview should be small, got ${rec.result.stdout.length}`);
  assert.equal(rec.result.exitCode, 0, 'the json preview keeps the structure around the cut string');
  assert.match(rec.result.stdout, /DONE-MARKER/, 'head AND tail: the verdict at the bottom survives');
  assert.match(rec.note, /read_tool_result/);
  assert.equal(rec.handle, '@tool:1');
  assert.equal(rec.artifact, 'tools/1-bash.json');

  const full = readArtifact(ctx, '1-bash.json');
  assert.equal(full.seq, 1);
  assert.ok(full.result.stdout.length >= 200_000, 'the artifact holds every byte');
  assert.ok(full.result.stdout.startsWith('x'.repeat(1000)) && full.result.stdout.includes('DONE-MARKER'));
  assert.equal(full.node, 'executor:task-1');
  // The log carries the preview, not 200 KB of stdout.
  const logged = logEvents(ctx).find(e => e.event === 'tool_call');
  assert.ok(JSON.stringify(logged).length < 20_000, 'log.jsonl must not swallow the whole output');
  assert.equal(logged.handle, '@tool:1');
});

test('a small result is passed through untouched — no preview, no truncation flag', async () => {
  const ctx = boundCtx();
  const rec = await executeTool('write_task_md', { content: '# spec' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.truncated, undefined);
  assert.equal(rec.note, undefined);
  assert.match(rec.result.written, /task-1\.spec\.md$/);
  assert.deepEqual(readArtifact(ctx, '1-write_task_md.json').result, rec.result);
});

test('handles are sequential and never collide', async () => {
  const ctx = boundCtx();
  await Promise.all([
    executeTool('write_task_md', { content: 'a' }, ctx),
    executeTool('write_task_md', { content: 'b' }, ctx),
    executeTool('write_task_md', { content: 'c' }, ctx)
  ]);
  assert.deepEqual(artifactsOf(ctx), ['1-write_task_md.json', '2-write_task_md.json', '3-write_task_md.json']);
});

test('read_tool_result redeems a handle, whole or narrowed', async () => {
  const ctx = boundCtx();
  await executeTool('bash', { command: `${NODE} -e "process.stdout.write('y'.repeat(120000))"` }, ctx);

  const narrowed = await executeTool('read_tool_result', { handle: '@tool:1', jsonPath: '$.exitCode' }, ctx);
  assert.equal(narrowed.ok, true);
  assert.equal(narrowed.result.value, 0);

  const whole = await executeTool('read_tool_result', { handle: '1' }, ctx);
  assert.equal(whole.ok, true, 'a bare sequence number is accepted too');
  assert.equal(whole.result.tool, 'bash');

  const missing = await executeTool('read_tool_result', { handle: '@tool:99' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No tool result/);

  const badPath = await executeTool('read_tool_result', { handle: '@tool:1', jsonPath: '$.nope' }, ctx);
  assert.equal(badPath.ok, false);
  assert.match(badPath.error, /does not exist/);
});

test('read_tool_result is itself archived, so reading a result is as auditable as producing one', async () => {
  const ctx = boundCtx();
  await executeTool('write_task_md', { content: 'x' }, ctx);
  await executeTool('read_tool_result', { handle: '@tool:1' }, ctx);
  assert.deepEqual(artifactsOf(ctx), ['1-write_task_md.json', '2-read_tool_result.json']);
});

test('credentials are redacted from the record, the artifact and the log', async () => {
  const ctx = boundCtx();
  const token = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
  const rec = await executeTool('write_task_md', { content: 'spec' }, { ...ctx, secrets: { WEATHER_KEY: 'super-secret-value' } });
  assert.equal(rec.ok, true);

  // The unit rules, exercised directly (no built-in takes a credential yet).
  assert.deepEqual(redactArgs({ key: token }), { key: REDACTED });
  assert.deepEqual(redactArgs({ headers: { Authorization: `Bearer ${token}` } }),
    { headers: { Authorization: `Bearer ${REDACTED}` } });
  assert.deepEqual(redactArgs({ url: 'https://api.example.com/w?q=oslo&api_key=abc123' }),
    { url: 'https://api.example.com/w?q=oslo&api_key=%5Bredacted%5D' });
  // A resolved secret comes back as its REFERENCE — the record reads like the
  // definition that produced it.
  assert.deepEqual(
    redactArgs({ url: 'https://x.test?k=super-secret-value' }, { WEATHER_KEY: 'super-secret-value' }),
    { url: 'https://x.test?k=${secrets.WEATHER_KEY}' });
  // ...and ordinary content is never mangled, whatever it happens to contain.
  const prose = 'The docs say to pass sk-xxx as your key, e.g. sk-live-1234.';
  assert.deepEqual(redactArgs({ content: prose }), { content: prose });
});

test('without a store there is no artifact, and the full result stays inline', async () => {
  const rec = await executeTool('read_tool_result', { handle: '@tool:1' }, {});
  assert.equal(rec.ok, false);
  assert.match(rec.error, /only available inside a run/);
  assert.equal(rec.artifact, undefined);
});

test('preview shapes: json keeps structure, text keeps both ends, none withholds', () => {
  const long = 'a'.repeat(5000) + 'END';
  const json = previewResult({ head: 'keep', body: long }, { preview: 'json', maxPreviewChars: 500 });
  assert.equal(json.truncated, true);
  assert.equal(json.value.head, 'keep');
  assert.match(json.value.body, /characters omitted/);

  const text = previewResult(long, { preview: 'text', maxPreviewChars: 400 });
  assert.equal(text.truncated, true);
  assert.match(text.value, /^a{60,}/);
  assert.match(text.value, /END$/);

  assert.deepEqual(previewResult({ a: 1 }, { preview: 'none' }), { value: null, truncated: true });
  assert.deepEqual(previewResult({ a: 1 }, { preview: 'json' }), { value: { a: 1 }, truncated: false });

  // A circular result can't be sized, so it is previewed structurally rather
  // than crashing the call that produced it.
  const circular = { name: 'loop' };
  circular.self = circular;
  const out = previewResult(circular, { preview: 'json', maxPreviewChars: 500 });
  assert.equal(out.truncated, true);
  assert.equal(out.value.name, 'loop');
});
