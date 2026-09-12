import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { changeChannel, prepareRecord, uploadPlatform } from '../scripts/release.mjs';
import { STATE_KEY, emptyState, releaseKey, assetKey } from '../src/model.js';

export const content = Buffer.from('0123456789');
export const hash = createHash('sha512').update(content).digest('base64');
export function record(platform = 'linux', version = '2.1.23') {
  const name = `Flyt-${version}-${platform === 'windows' ? 'win-x64.exe' : platform === 'mac' ? 'mac-arm64.zip' : 'linux-x64.AppImage'}`;
  return { schemaVersion: 1, platform, version, commit: 'a'.repeat(40), runId: '123', createdAt: '2026-09-12T00:00:00.000Z', notes: 'Test release', signing: platform === 'linux' ? 'not-applicable' : 'not-configured', assets: [{ name, size: content.length, sha512: hash }], manifest: { version, files: [{ url: name, size: content.length, sha512: hash }] } };
}
class MemoryStorage {
  values = new Map();
  binaries = new Map();
  etag = 'one';
  async read(key) { const value = this.values.get(key); return value ? { value: structuredClone(value), etag: this.etag } : null; }
  async immutable(key, value) { assert.ok(!this.values.has(key) || JSON.stringify(this.values.get(key)) === JSON.stringify(value)); this.values.set(key, structuredClone(value)); }
  async verify(key, asset) { assert.equal(this.binaries.get(key), asset.sha512, `Missing/corrupt ${key}`); }
  async swapState(state, etag) { assert.equal(etag, this.values.has(STATE_KEY) ? this.etag : undefined); this.values.set(STATE_KEY, structuredClone(state)); this.etag += 'x'; }
  add(release) { this.values.set(releaseKey(release.version, release.platform), release); for (const asset of release.assets) this.binaries.set(assetKey(release.version, release.platform, asset.name), asset.sha512); }
}
const activate = (store, version = '2.1.23', platforms = ['linux']) => changeChannel(store, { action: 'activate', version, platforms, commit: 'a'.repeat(40), runId: '123' });

test('candidate -> promotion -> next candidate preserves stable and history', async () => {
  const store = new MemoryStorage(); store.add(record());
  await activate(store);
  assert.equal(store.values.get(STATE_KEY).channels.stable.linux.current, null);
  await changeChannel(store, { action: 'promote', version: '2.1.23', platforms: ['linux'] });
  const history = [...store.values.entries()].filter(([key]) => key.startsWith('flyt/history/')).at(-1)[1];
  assert.equal(history.previous.channels.stable.linux.current, null);
  assert.equal(history.next.channels.stable.linux.current, '2.1.23');
  store.add(record('linux', '2.1.24')); await activate(store, '2.1.24');
  assert.equal(store.values.get(STATE_KEY).channels.stable.linux.current, '2.1.23');
  await assert.rejects(changeChannel(store, { action: 'promote', version: '2.1.23', platforms: ['linux'] }), /current beta/);
});
test('missing or corrupt platform prevents any candidate activation', async () => {
  const store = new MemoryStorage(); store.add(record());
  await assert.rejects(activate(store, '2.1.23', ['linux', 'windows']), /incomplete/);
  assert.equal(store.values.has(STATE_KEY), false);
  store.binaries.clear(); await assert.rejects(activate(store), /Missing\/corrupt/);
  assert.equal(store.values.has(STATE_KEY), false);
});
test('unsigned Windows/mac candidates cannot be promoted', async () => {
  const store = new MemoryStorage(); store.add(record('windows')); store.add(record('mac'));
  await activate(store, '2.1.23', ['windows', 'mac']);
  for (const platform of ['windows', 'mac']) await assert.rejects(changeChannel(store, { action: 'promote', version: '2.1.23', platforms: [platform] }), /signing\/Store/);
});
test('reject mixed workflow runs, downgrades, and unapproved withdrawal targets', async () => {
  const store = new MemoryStorage(); const r = record(); r.runId = 'other'; store.add(r);
  await assert.rejects(activate(store), /same workflow/);
  store.add(record()); await activate(store);
  store.add(record('linux', '2.1.22'));
  await assert.rejects(activate(store, '2.1.22'), /downgrade/);
  await assert.rejects(changeChannel(store, { action: 'withdraw', version: '2.1.22', platforms: ['linux'] }), /already belong/);
});
test('withdrawal removes the current bad release from channel access', async () => {
  const store = new MemoryStorage(); store.add(record()); await activate(store);
  store.add(record('linux', '2.1.24')); await activate(store, '2.1.24');
  await changeChannel(store, { action: 'withdraw', version: '2.1.23', platforms: ['linux'] });
  assert.deepEqual(store.values.get(STATE_KEY).channels.beta.linux, { current: '2.1.23', versions: ['2.1.23'] });
});
test('state compare-and-swap detects overlapping channel operations', async () => {
  const store = new MemoryStorage(); store.add(record()); await activate(store);
  store.add(record('linux', '2.1.24'));
  const original = store.verify.bind(store);
  store.verify = async (...args) => { await original(...args); store.etag = 'changed-by-other-job'; };
  await assert.rejects(activate(store, '2.1.24'));
  assert.equal(store.values.get(STATE_KEY).channels.beta.linux.current, '2.1.23');
});
test('packager validates hashes and complete mac architecture manifests', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flyt-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, version: '2.1.23', platform: 'mac', commit: 'a'.repeat(40), runId: '123' };
  const files = ['x64.dmg', 'arm64.dmg', 'x64.zip', 'arm64.zip'].map(s => `Flyt-2.1.23-mac-${s}`);
  for (const name of files) await writeFile(path.join(directory, name), content);
  const manifest = { version: '2.1.23', files: files.filter(n => n.endsWith('.zip')).map(url => ({ url, size: content.length, sha512: hash })) };
  await writeFile(path.join(directory, 'latest-mac.yml'), yaml.dump(manifest));
  const r = await prepareRecord(options); assert.equal(r.assets.length, 4);
  manifest.files.pop(); await writeFile(path.join(directory, 'latest-mac.yml'), yaml.dump(manifest));
  await assert.rejects(prepareRecord(options), /Manifest omits/);
  manifest.files[0].sha512 = 'x'.repeat(86) + '=='; await writeFile(path.join(directory, 'latest-mac.yml'), yaml.dump(manifest));
  await assert.rejects(prepareRecord(options), /mismatch/);
});
test('uploader refuses overwriting a version from another commit/run', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flyt-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const r = record(); await writeFile(path.join(directory, r.assets[0].name), content);
  await writeFile(path.join(directory, 'latest-linux.yml'), yaml.dump(r.manifest));
  const store = new MemoryStorage(); store.add(r);
  await assert.rejects(uploadPlatform(store, { directory, version: r.version, platform: r.platform, commit: r.commit, runId: 'different' }), /different build\/run/);
});
