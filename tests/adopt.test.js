// Adopting a repository at run time (BRICKS P1.4). The library shipped with a
// fixed list; this makes it general purpose — any URL, from the app, from a
// flow, or from a task that points at one.
//
// The clone half runs against a real local git repository rather than the
// network: the thing worth testing is that a URL becomes a pinned, named,
// read-only directory the rest of the app can find.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReferenceLibrary, assertRepoUrl, nameFromRepoUrl } from '../core/references.js';

const run = promisify(execFile);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A throwaway git repository, so the clone path is exercised for real.
async function makeRepo(name = 'demo') {
  const dir = path.join(tmp('flyt-src-'), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n\nthe needle is here\n');
  const git = args => run('git', args, { cwd: dir });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['add', '-A']);
  await git(['commit', '-qm', 'first']);
  return dir;
}

// --- the URL guard ----------------------------------------------------------

test('a URL that could run a command is refused before it reaches git', () => {
  // git's ext:: transport executes an arbitrary command, and an argument
  // starting with "-" is read as an option. Both arrive here from a paste OR
  // from a model's tool call, so neither is trusted.
  assert.throws(() => assertRepoUrl('ext::sh -c whoami'), /ext::/);
  assert.throws(() => assertRepoUrl('--upload-pack=evil'), /cannot begin with/);
  assert.throws(() => assertRepoUrl('not a url'), /not a repository URL/);
  assert.throws(() => assertRepoUrl(''), /required/);
});

test('the ordinary shapes are accepted, whatever the host', () => {
  // General purpose: which forge someone reads from is their business, and a
  // repository already on this machine is as legitimate a source as any.
  for (const u of [
    '/home/me/projects/thing',
    'C:\\Users\\me\\projects\\thing',
    'https://github.com/owner/repo',
    'https://git.example.internal/team/thing.git',
    'ssh://git@example.com:22/owner/repo',
    'git@github.com:owner/repo.git',
    'git://example.com/repo'
  ]) assert.equal(assertRepoUrl(u), u);
});

test('a name is derived from the URL, and the owner is kept for collisions', () => {
  assert.deepEqual(nameFromRepoUrl('https://github.com/MaximeRobeyns/self_improving_coding_agent.git'),
    { name: 'self_improving_coding_agent', owner: 'maximerobeyns' });
  assert.deepEqual(nameFromRepoUrl('git@github.com:sst/opencode.git'), { name: 'opencode', owner: 'sst' });
  // Always something usable as a directory name, whatever the URL looks like.
  assert.match(nameFromRepoUrl('https://example.com/').name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.equal(nameFromRepoUrl('').name, 'repository');
});

// --- adopting ---------------------------------------------------------------

test('adopting clones, pins, names, and makes the repo readable', async () => {
  const src = await makeRepo('needle-repo');
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });

  const r = await lib.adopt(src);
  assert.equal(r.adopted, true);
  assert.equal(r.name, 'needle-repo', 'named from the URL');
  assert.match(r.commit, /^[0-9a-f]{7,40}$/, 'pinned to a commit');

  // It is in the library, and the rest of the app can find it by name.
  const listed = lib.list().find(x => x.name === 'needle-repo');
  assert.equal(listed.cloned, true);
  assert.equal(listed.adopted, true, 'distinguishable from a shipped entry');
  assert.match(lib.read('needle-repo/README.md'), /the needle is here/);
  assert.ok(lib.search('needle').results.length > 0, 'greppable at task time');
  assert.ok(lib.catalog().some(c => c.name === 'needle-repo'), 'and an agent is told it exists');
});

test('adopting the same URL twice refreshes rather than failing', async () => {
  const src = await makeRepo('twice');
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  await lib.adopt(src);
  const again = await lib.adopt(src);
  assert.equal(again.refreshed, true);
  assert.equal(again.adopted, false);
  assert.equal(lib.list().length, 1, 'a flow that runs twice must not fail the second time');
});

test('a name collision is suffixed with the owner, never silently shared', async () => {
  const a = await makeRepo('same');
  const b = await makeRepo('same');
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  const first = await lib.adopt(a);
  const second = await lib.adopt(b);
  assert.equal(first.name, 'same');
  assert.notEqual(second.name, 'same');
  assert.equal(lib.list().length, 2);
  // Two repositories sharing a directory is the one outcome worse than an ugly name.
  assert.notEqual(lib.dirFor(first.name), lib.dirFor(second.name));
});

test('a clone that fails leaves nothing half-registered', async () => {
  const lib = new ReferenceLibrary(tmp('flyt-lib-'), { repos: [] });
  await assert.rejects(() => lib.adopt('https://example.invalid/nope/nope.git'));
  assert.deepEqual(lib.list(), [], 'the next attempt is a clean first attempt');
});

test('adopted repos survive a new library instance over the same root', async () => {
  const src = await makeRepo('persisted');
  const root = tmp('flyt-lib-');
  await new ReferenceLibrary(root, { repos: [] }).adopt(src);
  // A different process, same disk: the manifest is the memory. Searching has
  // to see it too — the constructor never saw this entry.
  const reopened = new ReferenceLibrary(root, { repos: [] });
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].name, 'persisted');
  assert.ok(reopened.search('needle').results.length > 0, 'and it is searchable after a restart');
});

test('the configured list still wins, and removing an adopted repo forgets it', async () => {
  const src = await makeRepo('mine');
  const root = tmp('flyt-lib-');
  const lib = new ReferenceLibrary(root, { repos: [{ name: 'shipped', url: 'https://example.com/a', about: 'ships' }] });
  await lib.adopt(src);
  assert.deepEqual(lib.list().map(r => r.name), ['shipped', 'mine'], 'configured first');
  assert.equal(lib.list().find(r => r.name === 'shipped').adopted, false);

  const removed = lib.remove('mine');
  assert.equal(removed.removed, true);
  assert.deepEqual(lib.list().map(r => r.name), ['shipped']);

  // A CONFIGURED repo is only un-cloned — its entry is the user's file to edit.
  const stillThere = lib.remove('shipped');
  assert.equal(stillThere.removed, false);
  assert.deepEqual(lib.list().map(r => r.name), ['shipped']);
});
