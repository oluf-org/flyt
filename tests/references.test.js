// The reference library (LOOP-PLAN §16).
//
// Recipes, not dependencies. The properties under test are the ones that make
// it safe to hand a model: it is READ-ONLY because there is no write path, it
// is confined so a crafted path cannot leave it, and it is honest about being
// empty rather than returning zero hits — which a model reads as "there is no
// prior art" and moves on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReferenceLibrary, defaultReferenceRoot, DEFAULT_REFERENCES } from '../core/references.js';
import { executeTool, toolNames } from '../core/tools/index.js';
import { makeStore } from './helpers.js';
import { Workspace } from '../core/workspace.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-ref-'));

// A library with two "clones" written by hand: cloning in a unit test would be
// a network dependency, and what is being tested is the reading, not git.
function seeded() {
  const root = path.join(tmp(), 'references');
  const repos = [
    { name: 'opencode', url: 'https://example.invalid/opencode', about: 'the server/client split' },
    { name: 'prime-agent', url: 'https://example.invalid/prime', about: 'long-running sessions' }
  ];
  fs.mkdirSync(path.join(root, 'opencode', 'src', 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'opencode', 'src', 'server', 'server.ts'),
    'export function createServer() {\n  return HttpRouter.serve(routes)\n}\n');
  fs.writeFileSync(path.join(root, 'opencode', 'README.md'), '# opencode\n\nA headless harness.\n');
  fs.writeFileSync(path.join(root, 'opencode', '.flyt-reference.json'),
    JSON.stringify({ name: 'opencode', commit: 'abc1234567', clonedAt: '2026-08-13T00:00:00.000Z' }));
  // Noise that must not be walked: enormous, generated, and uninteresting.
  fs.mkdirSync(path.join(root, 'opencode', 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'opencode', 'node_modules', 'junk', 'index.js'), 'serve(); serve(); serve();\n');

  fs.mkdirSync(path.join(root, 'prime-agent', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prime-agent', 'docs', 'long.md'),
    '# Long running\n\nGate commands run before a session may finish.\nHeartbeats re-enter a session.\n');
  return new ReferenceLibrary(root, { repos });
}

test('the shipped library is the one the plan actually learned from', () => {
  const names = DEFAULT_REFERENCES.map(r => r.name);
  assert.ok(names.includes('self_improving_coding_agent'));
  assert.ok(names.includes('opencode'));
  assert.ok(names.includes('prime-agent'));
  // Each says what it is good FOR: a name and a URL is a bibliography, and the
  // whole point of this is not being one.
  for (const r of DEFAULT_REFERENCES) assert.ok(r.about?.length > 40, `${r.name} needs a reason to be here`);
  // Outside every project, on every platform.
  assert.ok(defaultReferenceRoot({ home: '/home/x' }).startsWith('/home/x'));
});

test('a crafted path cannot leave the library', () => {
  const lib = seeded();
  // The path half comes from a model.
  for (const bad of ['opencode/../../etc/passwd', 'opencode/../../../root/.ssh/id_rsa']) {
    assert.throws(() => lib.resolve(bad), /escapes the library/);
  }
  for (const bad of ['../evil/x', 'nope!/x']) {
    assert.throws(() => lib.resolve(bad), /Invalid reference name|escapes the library/);
  }
  // The prefix is optional and equivalent.
  assert.equal(lib.resolve('reference:opencode/README.md'), lib.resolve('opencode/README.md'));
});

test('it reads, and a missing file is an answer rather than an error', () => {
  const lib = seeded();
  assert.match(lib.read('reference:opencode/src/server/server.ts'), /HttpRouter\.serve/);
  assert.equal(lib.read('reference:opencode/nope.ts'), null);
  // A directory is not a file.
  assert.equal(lib.read('reference:opencode/src'), null);
});

test('there is no write path into a clone — read-only is a fact about the code, not a flag', () => {
  const lib = seeded();
  // The property that makes this safe to hand a model: nothing to bypass. No
  // method modifies the CONTENTS of a reference, so no prompt can make one.
  for (const method of ['write', 'writeText', 'save', 'edit', 'delete', 'patch']) {
    assert.equal(typeof lib[method], 'undefined', `ReferenceLibrary must not expose ${method}()`);
  }
});

test('managing the library is a user act, and no tool can reach it', () => {
  // D36 P1.4 added adopt()/remove(): a general-purpose app has to be able to
  // point at any repository, and to forget one. That is MANAGEMENT, not content
  // mutation — but it is still a write, so the boundary moved from "the object
  // has no write method" to "nothing an agent can hold reaches those methods".
  //
  // The plan proposed an `add_reference` TOOL. That is deliberately not built:
  // a model that can make the harness clone an arbitrary URL is a different
  // security question from one that can read what a human already cloned, and
  // the flow's own repo input covers the case the plan wanted it for.
  const lib = seeded();
  assert.equal(typeof lib.adopt, 'function', 'the app can adopt a repository');
  assert.equal(typeof lib.remove, 'function', 'and forget one');

  const mutators = ['add_reference', 'adopt_reference', 'remove_reference', 'clone_repo', 'update_reference'];
  for (const id of mutators) {
    assert.ok(!toolNames().includes(id), `no tool may manage the reference library (found "${id}")`);
  }
  // What an agent DOES get: search and read, both read-only.
  assert.ok(toolNames().includes('search_references'));
});

test('search finds prior art, skips generated noise, and caps one loud file', () => {
  const lib = seeded();
  const found = lib.search('serve');
  assert.ok(found.results.some(r => r.ref === 'reference:opencode/src/server/server.ts'));
  // node_modules is never walked: it is enormous and it is not prior art.
  assert.ok(!found.results.some(r => r.ref.includes('node_modules')));

  // One file that mentions the pattern repeatedly must not consume the whole
  // budget and hide the file that answers the question — seen for real, where
  // three benchmark probes crowded out the server.
  const root = lib.dirFor('prime-agent');
  fs.writeFileSync(path.join(root, 'noisy.md'), Array(20).fill('gate commands gate').join('\n'));
  const capped = lib.search('gate', { maxPerFile: 2 });
  const fromNoisy = capped.results.filter(r => r.ref.endsWith('noisy.md'));
  assert.equal(fromNoisy.length, 2);
  assert.ok(capped.results.some(r => r.ref.endsWith('long.md')), 'the other file still gets a look in');
});

test('search can be scoped, carries line numbers, and refuses a broken pattern', () => {
  const lib = seeded();
  const scoped = lib.search('heartbeat', { repo: 'prime-agent' });
  assert.equal(scoped.results.length, 1);
  assert.equal(scoped.results[0].line, 4);
  assert.match(scoped.results[0].ref, /^reference:prime-agent\/docs\/long\.md$/);
  assert.equal(lib.search('heartbeat', { repo: 'opencode' }).results.length, 0);

  // A model writes this pattern; a bad one is a bad argument, not a crash.
  assert.throws(() => lib.search('([unclosed'), /Invalid search pattern/);

  const withContext = lib.search('Gate commands', { contextLines: 2 });
  assert.match(withContext.results[0].context, /Long running/);
});

test('the catalog says what exists and whether it is actually on disk', () => {
  const lib = seeded();
  const cat = lib.catalog();
  assert.equal(cat.length, 2);
  assert.equal(cat.find(c => c.name === 'opencode').cloned, true);
  assert.equal(cat.find(c => c.name === 'opencode').commit, 'abc12345');
  // An index falls back to the configured `about`, so a library with no
  // hand-written map still says something useful rather than nothing.
  assert.match(lib.index('prime-agent'), /long-running sessions/);
});

// --- the tools -------------------------------------------------------------

function ctxWith(references) {
  const store = makeStore();
  const runId = store.createRun('reference test');
  const workspace = new Workspace(tmp()).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, nodeId: 'work-1', workspace, references };
}

test('search_references returns hits an agent can act on', async () => {
  const ctx = ctxWith(seeded());
  const rec = await executeTool('search_references', { pattern: 'HttpRouter' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.hits, 1);
  assert.match(rec.result.results[0].ref, /^reference:opencode\//);
  assert.ok(rec.result.results[0].line > 0, 'a line number, so the next step is a targeted read');
  assert.ok(ctx.store.readLog(ctx.runId).some(e => e.event === 'reference_search'));
});

test('an empty library says so instead of reporting no prior art', async () => {
  // Zero hits would be read as "nobody has solved this", which is the opposite
  // of what an unclonded library means.
  const empty = new ReferenceLibrary(path.join(tmp(), 'references'), {
    repos: [{ name: 'opencode', url: 'x', about: 'y' }]
  });
  const rec = await executeTool('search_references', { pattern: 'anything' }, ctxWith(empty));
  assert.equal(rec.ok, false);
  assert.match(rec.error, /library is empty/);
  assert.match(rec.error, /flyt ref update/, 'and it says how to fix it');
});

test('read_file reaches the library through a prefix, and says it is read-only', async () => {
  const ctx = ctxWith(seeded());
  const rec = await executeTool('read_file', { path: 'reference:opencode/README.md' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.target, 'reference');
  assert.equal(rec.result.readOnly, true);
  assert.match(rec.result.content, /headless harness/);

  const missing = await executeTool('read_file', { path: 'reference:opencode/nope.md' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /search_references/, 'the error points at the way to find a real path');
});

test('no write tool can reach the library, because none of them know the prefix', async () => {
  const ctx = ctxWith(seeded());
  // write_file treats it as an ordinary workspace path: a file literally named
  // "reference:..." inside the sandbox, never a path into the library.
  const rec = await executeTool('write_file', { path: 'reference:opencode/README.md', content: 'pwned' }, ctx);
  const original = ctx.references.read('reference:opencode/README.md');
  assert.match(original, /headless harness/, 'the library is untouched whatever the write did');
  if (rec.ok) {
    assert.ok(!String(rec.result.path ?? '').startsWith('/'), 'and any file it made stayed in the workspace');
  }
});
