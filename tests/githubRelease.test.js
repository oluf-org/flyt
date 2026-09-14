import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectReleaseAssets, verifyExistingAssets } from '../scripts/publish-github-release.mjs';

test('GitHub publication requires every platform and generates checksums for the actual bytes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flyt-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = [
    'Flyt-2.1.23-linux-x86_64.AppImage', 'Flyt-2.1.23-win-x64.exe', 'Flyt-2.1.23-win-x64.exe.blockmap',
    ...['x64', 'arm64'].flatMap(arch => ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap'].map(ext => `Flyt-2.1.23-mac-${arch}.${ext}`)),
    'latest.yml', 'latest-mac.yml', 'latest-linux.yml',
  ];
  for (const name of names) await writeFile(path.join(directory, name), 'hello');
  const assets = await collectReleaseAssets(directory, '2.1.23');
  assert.equal(assets.length, 15);
  assert.equal(assets[0].digest, 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const checksums = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
  for (const name of names) assert.ok(checksums.includes(`  ${name}\n`));
  await rm(path.join(directory, 'Flyt-2.1.23-win-x64.exe'));
  await assert.rejects(collectReleaseAssets(directory, '2.1.23'), /Missing or empty release asset/);
});

test('GitHub reruns reuse identical draft assets and refuse changed or incomplete published releases', () => {
  const local = [{ name: 'installer.exe', size: 5, digest: 'sha256:abc' }];
  const existing = [{ ...local[0], state: 'uploaded' }];
  assert.deepEqual(verifyExistingAssets(local, existing), []);
  assert.deepEqual(verifyExistingAssets(local, []), local);
  assert.throws(() => verifyExistingAssets(local, [], { published: true }), /Published release is incomplete/);
  assert.throws(() => verifyExistingAssets(local, [{ ...existing[0], digest: 'sha256:changed' }]), /Immutable GitHub asset differs/);
  assert.throws(() => verifyExistingAssets(local, [{ ...existing[0], state: 'starter' }]), /Immutable GitHub asset differs/);
});
