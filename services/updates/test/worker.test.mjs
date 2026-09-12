import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { STATE_KEY, emptyState, releaseKey, assetKey } from '../src/model.js';

const content = '0123456789';
const sha512 = createHash('sha512').update(content).digest('base64');
const makeRecord = (platform = 'linux', version = '2.1.23') => {
  const name = `Flyt-${version}-${platform === 'mac' ? 'mac-arm64.zip' : 'linux-x64.AppImage'}`;
  return { schemaVersion: 1, version, platform, commit: 'a'.repeat(40), runId: '123', createdAt: '2026-09-12T00:00:00Z', notes: 'Hello', signing: platform === 'linux' ? 'not-applicable' : 'not-configured', assets: [{ name, sha512, size: 10 }], manifest: { version, files: [{ url: name, sha512, size: 10 }] } };
};
let mf, bucket;
before(async () => {
  const modules = {};
  for (const name of ['worker.js', 'model.js']) modules[name] = { type: 'esm', contents: await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8') };
  mf = new Miniflare({ workers: [{ config: { name: 'updates', type: 'worker', compatibilityDate: '2026-09-12',
    manifest: { mainModule: 'worker.js', modulesRoot: fileURLToPath(new URL('../src/', import.meta.url)), modules },
    env: { RELEASES: { type: 'r2', name: 'test-releases' } } } }] });
  bucket = await mf.getR2Bucket('RELEASES');
});
after(async () => { await mf?.dispose(); });
const fetch = (url, init) => mf.dispatchFetch(`https://updates.flyt.pro${url}`, init);
async function seed() {
  const state = emptyState();
  for (const platform of ['linux', 'mac']) {
    const r = makeRecord(platform);
    await bucket.put(releaseKey(r.version, platform), JSON.stringify(r));
    await bucket.put(assetKey(r.version, platform, r.assets[0].name), content);
    state.channels.beta[platform] = { current: r.version, versions: [r.version] };
  }
  await bucket.put(STATE_KEY, JSON.stringify(state)); return state;
}
const assetPath = '/beta/releases/2.1.23/linux/Flyt-2.1.23-linux-x64.AppImage';
test('empty catalog, CORS, HEAD, methods and health', async () => {
  assert.equal((await fetch('/healthz')).status, 200);
  const response = await fetch('/v1/releases/stable');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok((await response.json()).platforms.every(p => !p.available));
  assert.equal((await fetch('/stable/latest.yml')).status, 404);
  assert.equal((await fetch('/v1/releases/stable', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch('/v1/releases/stable', { method: 'OPTIONS' })).status, 204);
  const head = await fetch('/v1/releases/stable', { method: 'HEAD' }); assert.equal(await head.text(), '');
});
test('beta is isolated; feed resolves immutable URLs; unsigned mac has downloads but no feed', async () => {
  await seed();
  const response = await fetch('/beta/latest-linux.yml');
  const manifest = await response.json();
  assert.equal(manifest.files[0].url, `https://updates.flyt.pro${assetPath}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch('/stable/latest-linux.yml')).status, 404);
  assert.equal((await fetch(assetPath.replace('/beta/', '/stable/'))).status, 404);
  assert.equal((await fetch('/beta/latest-mac.yml')).status, 409);
  const catalog = await (await fetch('/v1/releases/beta')).json();
  assert.equal(catalog.platforms.find(p => p.platform === 'mac').autoUpdateAvailable, false);
});
test('streaming, byte ranges, suffixes, HEAD, validators and invalid ranges', async () => {
  await seed();
  const full = await fetch(assetPath); assert.equal(await full.text(), content);
  const etag = full.headers.get('etag');
  const partial = await fetch(assetPath, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345');
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await (await fetch(assetPath, { headers: { Range: 'bytes=-3' } })).text(), '789');
  assert.equal(await (await fetch(assetPath, { headers: { Range: 'bytes=8-' } })).text(), '89');
  const head = await fetch(assetPath, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal((await fetch(assetPath, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(assetPath, { headers: { Range: 'bytes=1-2', 'If-Range': '"different"' } })).status, 200);
  for (const range of ['bytes=99-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-']) assert.equal((await fetch(assetPath, { headers: { Range: range } })).status, 416, range);
});
test('unknown objects, metadata and unpublished versions cannot be retrieved', async () => {
  await seed();
  for (const url of ['/flyt/channels.json', '/beta/releases/2.1.23/linux/release.json', assetPath.replace('2.1.23', '2.1.99'), '/beta/releases/2.1.23/linux/%2e%2e%2frelease.json']) assert.equal((await fetch(url)).status, 404, url);
});
test('promotion exposes the same bytes, withdrawal removes access, corrupt state fails closed', async () => {
  const state = await seed();
  state.channels.stable.linux = structuredClone(state.channels.beta.linux);
  await bucket.put(STATE_KEY, JSON.stringify(state));
  assert.equal(await (await fetch(assetPath.replace('/beta/', '/stable/'))).text(), content);
  state.channels.stable.linux = { current: null, versions: [] };
  await bucket.put(STATE_KEY, JSON.stringify(state));
  assert.equal((await fetch(assetPath.replace('/beta/', '/stable/'))).status, 404);
  await bucket.put(STATE_KEY, '{bad'); assert.equal((await fetch('/v1/releases/stable')).status, 503);
});
