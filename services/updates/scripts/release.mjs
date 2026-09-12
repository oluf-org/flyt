import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as yaml from 'js-yaml';
import semver from 'semver';
import { STATE_KEY, PLATFORMS, MANIFESTS, emptyState, validateState, validateRelease, validVersion, validFilename, releaseKey, assetKey, stableEligible } from '../src/model.js';

const missing = err => err?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(err?.name);
const conflict = err => [409, 412].includes(err?.$metadata?.httpStatusCode);
export async function digest(stream) {
  const hash = createHash('sha512');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('base64');
}
export class Storage {
  constructor(env = process.env) {
    for (const name of ['R2_ENDPOINT', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!env[name]) throw new Error(`Missing ${name}`);
    const endpoint = new URL(env.R2_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}(\.eu|\.us)?\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid R2_ENDPOINT');
    this.bucket = env.R2_BUCKET_NAME;
    this.client = new S3Client({ region: 'auto', endpoint: endpoint.origin,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY } });
  }
  async head(key) {
    try { return await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (err) { if (missing(err)) return null; throw err; }
  }
  async read(key) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!Number.isSafeInteger(r.ContentLength) || r.ContentLength > 1024 * 1024) { r.Body?.destroy(); throw new Error('Metadata exceeds 1 MiB'); }
      return { value: JSON.parse(await r.Body.transformToString()), etag: r.ETag };
    } catch (err) { if (missing(err)) return null; throw err; }
  }
  async immutable(key, value) {
    const body = JSON.stringify(value);
    try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json', IfNoneMatch: '*' })); }
    catch (err) {
      if (!conflict(err)) throw err;
      const old = await this.read(key);
      if (JSON.stringify(old?.value) !== body) throw new Error(`Immutable object differs: ${key}; use a new version`);
    }
  }
  async upload(key, file, info) {
    if (!await this.head(key)) {
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(file), ContentLength: info.size,
          ContentType: 'application/octet-stream', Metadata: { sha512: info.sha512 }, IfNoneMatch: '*' }));
      } catch (err) { if (!conflict(err)) throw err; }
    }
    await this.verify(key, info);
  }
  async verify(key, info) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (r.ContentLength !== info.size) { r.Body?.destroy(); throw new Error(`Size mismatch: ${key}`); }
    if (await digest(r.Body) !== info.sha512) throw new Error(`SHA-512 mismatch: ${key}`);
  }
  async swapState(state, etag) {
    if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) throw new Error('Channel state exceeds 1 MiB; archive history before publishing');
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: STATE_KEY, Body: JSON.stringify(state), ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }) }));
    } catch (err) { if (conflict(err)) throw new Error('Channel state changed concurrently; re-read and retry'); throw err; }
  }
  async check() {
    // Exercise read/write and conditional publication without touching releases or channels.
    const key = `flyt/checks/${randomUUID()}.json`;
    try {
      await this.immutable(key, { probe: 1 });
      let rejected = false;
      try { await this.immutable(key, { probe: 2 }); } catch (err) {
        if (!err.message.startsWith('Immutable object differs:')) throw err;
        rejected = true;
      }
      if (!rejected) throw new Error('R2 did not enforce conditional creation');
      const initial = await this.read(key);
      if (initial.value.probe !== 1) throw new Error('R2 conditional creation changed existing bytes');
      try {
        await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: '{"probe":3}', IfMatch: '"wrong-etag"' }));
        throw new Error('R2 did not enforce conditional replacement');
      } catch (err) { if (!conflict(err)) throw err; }
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: '{"probe":2}', IfMatch: initial.etag }));
      if ((await this.read(key)).value.probe !== 2) throw new Error('R2 replacement verification failed');
    } finally {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
  }
}

export async function prepareRecord({ directory, version, platform, commit, runId, notes = '', createdAt = new Date().toISOString() }) {
  if (!validVersion(version) || !PLATFORMS.includes(platform) || !/^[a-f0-9]{40}$/.test(commit) || !runId) throw new Error('Valid version, platform, commit and runId required');
  const manifest = yaml.load(await readFile(path.join(directory, MANIFESTS[platform]), 'utf8'));
  const names = (await readdir(directory)).filter(name => /\.(exe|dmg|zip|AppImage|blockmap)$/.test(name)).sort();
  const assets = [];
  for (const name of names) {
    if (!validFilename(name) || !name.startsWith(`Flyt-${version}-`)) throw new Error(`Unexpected release asset: ${name}`);
    const file = path.join(directory, name);
    const meta = await stat(file);
    if (!meta.isFile() || meta.size > 4 * 1024 ** 3) throw new Error('Release assets must be files smaller than 4 GiB');
    assets.push({ name, size: meta.size, sha512: await digest(createReadStream(file)) });
  }
  const required = platform === 'windows' ? ['win32-x64.exe', 'win32-x64.exe.blockmap'] : platform === 'linux' ? ['linux-x64.AppImage'] : ['darwin-x64.dmg', 'darwin-arm64.dmg', 'darwin-x64.zip', 'darwin-arm64.zip'];
  // electron-builder's ${os} uses win/mac/linux, not Node's win32/darwin names.
  for (const suffix of required.map(s => s.replace('win32-', 'win-').replace('darwin-', 'mac-'))) {
    if (!assets.some(a => a.name === `Flyt-${version}-${suffix}`)) throw new Error(`Missing required ${platform} asset: ${suffix}`);
  }
  const record = validateRelease({ schemaVersion: 1, version, platform, commit, runId, createdAt, notes,
    signing: platform === 'linux' ? 'not-applicable' : 'not-configured', assets, manifest });
  // Require every updater payload architecture to be represented, especially both mac ZIPs.
  const updateNames = assets.filter(a => platform === 'mac' ? a.name.endsWith('.zip') : platform === 'windows' ? a.name.endsWith('.exe') : a.name.endsWith('.AppImage')).map(a => a.name);
  for (const name of updateNames) if (!manifest.files.some(f => f.url === name)) throw new Error(`Manifest omits ${name}`);
  return record;
}

export async function uploadPlatform(store, options) {
  const record = await prepareRecord(options);
  // Retrying identical bytes from the same commit is safe; never rewrite the durable record.
  const existing = await store.read(releaseKey(record.version, record.platform));
  if (existing && (existing.value.commit !== record.commit || existing.value.runId !== record.runId || JSON.stringify(existing.value.assets) !== JSON.stringify(record.assets) || JSON.stringify(existing.value.manifest) !== JSON.stringify(record.manifest))) throw new Error('Version already contains a different build/run; rerun the original workflow or increment the version');
  for (const info of record.assets) await store.upload(assetKey(record.version, record.platform, info.name), path.join(options.directory, info.name), info);
  await store.immutable(releaseKey(record.version, record.platform), existing?.value ?? record);
  return record;
}

export async function verifiedRelease(store, version, platform) {
  const result = await store.read(releaseKey(version, platform));
  if (!result) throw new Error(`Release ${version}/${platform} is incomplete`);
  const record = validateRelease(result.value);
  if (record.version !== version || record.platform !== platform) throw new Error('Release identity mismatch');
  for (const info of record.assets) await store.verify(assetKey(version, platform, info.name), info);
  return record;
}

export async function changeChannel(store, { action, version, platforms = PLATFORMS, channel = 'beta', commit, runId }) {
  if (!validVersion(version) || !platforms.length || platforms.some(p => !PLATFORMS.includes(p)) || new Set(platforms).size !== platforms.length) throw new Error('Invalid version/platforms');
  if (!['activate', 'promote', 'withdraw'].includes(action) || !['beta', 'stable'].includes(channel)) throw new Error('Invalid action/channel');
  if (action === 'activate' && (!commit || !runId)) throw new Error('Activation requires originating commit/run');
  if (action === 'promote') channel = 'stable';
  if (action === 'activate') channel = 'beta';
  const prior = await store.read(STATE_KEY);
  const state = validateState(structuredClone(prior?.value ?? emptyState()));
  for (const platform of platforms) {
    const record = await verifiedRelease(store, version, platform);
    const selection = state.channels[channel][platform];
    if (action === 'activate' && (record.commit !== commit || record.runId !== runId)) throw new Error('Candidate platforms must come from the same workflow run and commit');
    if (action === 'promote' && state.channels.beta[platform].current !== version) throw new Error(`Only the current beta can be promoted (${platform})`);
    if (channel === 'stable' && !stableEligible(record)) throw new Error(`Stable ${platform} distribution is not configured; signing/Store integration is required`);
    if (action === 'withdraw') {
      if (!selection.versions.includes(version)) throw new Error('Withdrawal target must already belong to this channel');
    } else if (selection.current && semver.lt(version, selection.current)) throw new Error('Refusing channel downgrade; use withdrawal explicitly');
    if (action === 'withdraw' && selection.current !== version) selection.versions = selection.versions.filter(v => v !== selection.current);
    selection.current = version;
    if (!selection.versions.includes(version)) selection.versions.push(version);
  }
  state.revision = randomUUID();
  await store.immutable(`flyt/history/${state.revision}.json`, { action, channel, version, platforms, at: new Date().toISOString(), previous: prior?.value ?? emptyState(), next: state });
  await store.swapState(state, prior?.etag);
  return { revision: state.revision, channel, version, platforms };
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    directory: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string' }, platforms: { type: 'string' },
    channel: { type: 'string', default: 'beta' }, commit: { type: 'string' }, 'run-id': { type: 'string' }, 'notes-file': { type: 'string' },
  } });
  const store = new Storage();
  const action = positionals[0];
  if (action === 'check') { await store.check(); console.log('R2 read/write, conditional creation/replacement and cleanup succeeded'); return; }
  if (action === 'upload') {
    const notes = values['notes-file'] ? await readFile(values['notes-file'], 'utf8') : `Flyt ${values.version}`;
    const record = await uploadPlatform(store, { directory: values.directory, version: values.version, platform: values.platform, commit: values.commit, runId: values['run-id'], notes });
    console.log(JSON.stringify({ uploaded: record.version, platform: record.platform, assets: record.assets.length }));
    return;
  }
  console.log(JSON.stringify(await changeChannel(store, { action, version: values.version, platforms: values.platforms?.split(',') ?? [...PLATFORMS], channel: values.channel, commit: values.commit, runId: values['run-id'] })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
