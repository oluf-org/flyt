// The v1 tool catalog (TOOLS-PLAN P4/§14): edit_file, glob, grep, get_time,
// http_fetch, web_search, ask_human.
//
// The one that matters most is edit_file — a node changing one line of a
// 2,000-line file used to have to reproduce all 2,000, which is the dominant
// way a coding agent silently destroys unrelated code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { checkTarget, isPrivateAddress, guardedFetch } from '../core/tools/net.js';
import { globToRegExp } from '../core/tools/glob.js';
import { Workspace } from '../core/workspace.js';
import { makeStore } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-catalog-'));

function boundCtx(files = {}) {
  const store = makeStore();
  const runId = store.createRun('catalog test');
  const root = tmpDir();
  const workspace = new Workspace(root).ensure();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace, root };
}

// --- edit_file ---------------------------------------------------------------

test('edit_file changes one hunk of a large file and leaves the rest byte-identical', async () => {
  // 2,000 lines; exactly one of them changes.
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
  lines[999] = 'const TIMEOUT = 5000;';
  const ctx = boundCtx({ 'src/config.js': lines.join('\n') });

  const rec = await executeTool('edit_file', {
    path: 'src/config.js', oldString: 'const TIMEOUT = 5000;', newString: 'const TIMEOUT = 30000;'
  }, ctx);

  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.result.replacements, 1);
  const after = fs.readFileSync(path.join(ctx.root, 'src/config.js'), 'utf8').split('\n');
  assert.equal(after.length, 2000, 'no lines gained or lost');
  assert.equal(after[999], 'const TIMEOUT = 30000;');
  lines.forEach((l, i) => { if (i !== 999) assert.equal(after[i], l, `line ${i + 1} was disturbed`); });
  // The diff shows the intended hunk and nothing else.
  const changed = rec.result.diff.split('\n').filter(l => /^[+-][^+-]/.test(l));
  assert.deepEqual(changed, ['-const TIMEOUT = 5000;', '+const TIMEOUT = 30000;']);
});

test('edit_file refuses an ambiguous or absent match instead of guessing', async () => {
  const ctx = boundCtx({ 'a.txt': 'x\nsame\ny\nsame\n' });

  const ambiguous = await executeTool('edit_file', { path: 'a.txt', oldString: 'same', newString: 'other' }, ctx);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /appears 2 times/);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'a.txt'), 'utf8'), 'x\nsame\ny\nsame\n', 'nothing was written');

  const missing = await executeTool('edit_file', { path: 'a.txt', oldString: 'nope', newString: 'x' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /was not found/);

  const all = await executeTool('edit_file', { path: 'a.txt', oldString: 'same', newString: 'other', replaceAll: true }, ctx);
  assert.equal(all.ok, true);
  assert.equal(all.result.replacements, 2);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'a.txt'), 'utf8'), 'x\nother\ny\nother\n');

  const gone = await executeTool('edit_file', { path: 'nope.txt', oldString: 'a', newString: 'b' }, ctx);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /not found in the workspace/);
});

// --- glob / grep -------------------------------------------------------------

test('glob patterns behave like the glob everyone expects', () => {
  const m = (pattern, p) => globToRegExp(pattern).test(p);
  assert.ok(m('src/**/*.js', 'src/a/b/c.js'));
  assert.ok(m('**/*.js', 'a.js'), '**/ matches zero directories');
  assert.ok(m('*.md', 'README.md'));
  assert.ok(!m('*.md', 'docs/README.md'), '* does not cross a separator');
  assert.ok(m('{README,LICENSE}*', 'LICENSE.txt'));
  assert.ok(m('src/?.js', 'src/a.js'));
  assert.ok(!m('src/?.js', 'src/ab.js'));
});

test('glob and grep search the repo without the shell, and skip what nobody means', async () => {
  const ctx = boundCtx({
    'src/app.js': 'export const hello = 1;\n// TODO: tidy\n',
    'src/deep/util.js': 'export const hello = 2;\n',
    'README.md': 'hello\n',
    'node_modules/pkg/index.js': 'export const hello = 3;\n',
    'build/out.js': 'export const hello = 4;\n',
    '.gitignore': 'secret.txt\n'
  });
  fs.writeFileSync(path.join(ctx.root, 'secret.txt'), 'hello secret\n');

  const g = await executeTool('glob', { pattern: 'src/**/*.js' }, ctx);
  assert.equal(g.ok, true);
  assert.deepEqual(g.result.paths.sort(), ['src/app.js', 'src/deep/util.js']);

  const all = await executeTool('glob', { pattern: '**/*.js' }, ctx);
  assert.ok(!all.result.paths.some(p => p.startsWith('node_modules/')), 'node_modules is never walked');
  assert.ok(!all.result.paths.some(p => p.startsWith('build/')), 'build output is skipped');

  const hits = await executeTool('grep', { pattern: 'hello' }, ctx);
  assert.equal(hits.ok, true);
  const found = hits.result.matches.map(m => m.path).sort();
  assert.ok(found.includes('src/app.js') && found.includes('README.md'));
  assert.ok(!found.includes('secret.txt'), '.gitignore is respected');
  assert.equal(hits.result.matches.find(m => m.path === 'src/app.js').line, 1);

  const scoped = await executeTool('grep', { pattern: 'TODO', glob: 'src/**/*.js' }, ctx);
  assert.equal(scoped.result.matches.length, 1);
  assert.equal(scoped.result.matches[0].line, 2);

  const bad = await executeTool('grep', { pattern: '([' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid regular expression/);
});

// --- get_time ----------------------------------------------------------------

test('get_time answers the question models are systematically wrong about', async () => {
  const rec = await executeTool('get_time', {}, {});
  assert.equal(rec.ok, true);
  assert.match(rec.result.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Math.abs(rec.result.unix * 1000 - Date.now()) < 60_000);
  assert.ok(rec.result.timezone);

  const zoned = await executeTool('get_time', { timezone: 'Europe/Oslo' }, {});
  assert.equal(zoned.result.timezone, 'Europe/Oslo');

  const bogus = await executeTool('get_time', { timezone: 'Mars/Olympus' }, {});
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /Unknown timezone/);
});

// --- network policy ----------------------------------------------------------

test('private network space is recognised, including the shapes people forget', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be public`);
  }
});

test('checkTarget denies private space by name and by DNS answer, and pins what it allowed', async () => {
  const resolver = { lookup: async host => (
    host === 'evil.test' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]
  ) };

  const loopback = await checkTarget('http://localhost:5173/', { resolver });
  assert.equal(loopback.ok, false);
  assert.match(loopback.reason, /private network space/);

  const literal = await checkTarget('http://169.254.169.254/latest/meta-data/', { resolver });
  assert.equal(literal.ok, false, 'cloud metadata is the address this exists to refuse');

  // DNS rebinding: a public-looking name that answers with a private address.
  const rebind = await checkTarget('https://evil.test/', { resolver });
  assert.equal(rebind.ok, false);
  assert.match(rebind.reason, /resolves to 127\.0\.0\.1/);

  const ok = await checkTarget('https://example.test/page', { resolver });
  assert.equal(ok.ok, true);
  assert.equal(ok.address, '93.184.216.34', 'the vetted address is returned so the request can be pinned to it');

  const allowed = await checkTarget('http://localhost:5173/', { resolver, allowPrivate: true });
  assert.equal(allowed.ok, true, 'a local dev server is a real use case, behind an explicit opt-in');

  const scheme = await checkTarget('file:///etc/passwd', { resolver });
  assert.equal(scheme.ok, false);
  assert.match(scheme.reason, /only http and https/);

  const listed = await checkTarget('https://other.test/', { resolver, allowedHosts: ['example.test'] });
  assert.equal(listed.ok, false);
  assert.match(listed.reason, /allowedHosts/);
});

test('http_fetch refuses private targets and header injection', async () => {
  const blocked = await executeTool('http_fetch', { url: 'http://127.0.0.1:9/' }, {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /network policy/);

  const injected = await executeTool('http_fetch', {
    url: 'https://example.test/', headers: { 'x-a': 'v\r\nx-evil: 1' }
  }, {});
  assert.equal(injected.ok, false);
  assert.match(injected.error, /line break/);
});

test('guardedFetch re-checks every redirect hop and caps the body', async () => {
  const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
  // A public URL that redirects into loopback — the classic way past a check
  // that only ever looked at the first URL.
  const request = (opts, onRes) => {
    const res = fakeResponse(opts.hostname === 'example.test'
      ? { status: 302, headers: { location: 'http://127.0.0.1/admin' }, body: '' }
      : { status: 200, headers: {}, body: 'x'.repeat(50) });
    onRes(res);   // handlers attach synchronously...
    res.emit();   // ...before anything is emitted
    return fakeRequest();
  };
  await assert.rejects(
    guardedFetch('https://example.test/', { resolver, request }),
    /network policy/
  );

  const big = (opts, onRes) => {
    const res = fakeResponse({ status: 200, headers: {}, body: 'y'.repeat(5000) });
    onRes(res);
    res.emit();
    return fakeRequest();
  };
  const capped = await guardedFetch('https://example.test/', { resolver, request: big, maxBytes: 100 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.bytes, 100);
});

// Minimal stand-ins for http.request's response/request objects.
function fakeResponse({ status, headers, body }) {
  const handlers = {};
  return {
    statusCode: status, headers,
    on(event, fn) { handlers[event] = fn; return this; },
    destroy() { handlers.close?.(); },
    emit() {
      handlers.data?.(Buffer.from(body, 'utf8'));
      handlers.end?.();
    }
  };
}
function fakeRequest() {
  return { setTimeout() {}, on() {}, write() {}, end() {}, destroy() {} };
}

// --- web_search --------------------------------------------------------------

test('web_search says what is missing instead of failing obscurely', async () => {
  const rec = await executeTool('web_search', { query: 'anything' }, {});
  assert.equal(rec.ok, false);
  assert.match(rec.error, /No web-search provider is configured/);
});

// --- ask_human ---------------------------------------------------------------

test('ask_human parks, returns the answer, and never asks the same thing twice', async () => {
  const ctx = boundCtx();
  const asked = [];
  ctx.askHuman = payload => { asked.push(payload); return Promise.resolve('Use Postgres.'); };

  const first = await executeTool('ask_human', { question: 'Which database?', options: ['Postgres', 'SQLite'] }, ctx);
  assert.equal(first.ok, true);
  assert.equal(first.result.answer, 'Use Postgres.');
  assert.deepEqual(asked[0].options, ['Postgres', 'SQLite']);

  // The answer is a FILE, so the same question is recalled rather than re-asked
  // — which is also what makes this survive a restart.
  const again = await executeTool('ask_human', { question: 'Which database?' }, ctx);
  assert.equal(again.result.recalled, true);
  assert.equal(again.result.answer, 'Use Postgres.');
  assert.equal(asked.length, 1, 'the user was asked once');

  const stored = ctx.store.readAskAnswers(ctx.runId, 'task-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].question, 'Which database?');
});

test('ask_human is bounded, and says so truthfully when it runs out', async () => {
  const ctx = boundCtx();
  ctx.askHuman = () => Promise.resolve('yes');
  for (const q of ['q1?', 'q2?', 'q3?']) await executeTool('ask_human', { question: q }, ctx);

  const extra = await executeTool('ask_human', { question: 'q4?' }, ctx);
  assert.equal(extra.ok, true, 'exhaustion is an answer, not an error');
  assert.equal(extra.result.exhausted, true);
  assert.match(extra.result.answer, /No more questions available/);
});

test('ask_human outside a run says so rather than hanging', async () => {
  const rec = await executeTool('ask_human', { question: 'anyone there?' }, {});
  assert.equal(rec.ok, false);
  assert.match(rec.error, /only available inside a run/);
});
