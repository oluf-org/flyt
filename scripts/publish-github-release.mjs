import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export async function collectReleaseAssets(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a three-component release version');
  const names = await readdir(directory);
  const prefix = `Flyt-${version}`;
  const required = [
    `${prefix}-win-x64.exe`, `${prefix}-win-x64.exe.blockmap`,
    ...['x64', 'arm64'].flatMap(arch => ['dmg', 'zip', 'dmg.blockmap', 'zip.blockmap'].map(ext => `${prefix}-mac-${arch}.${ext}`)),
    'latest.yml', 'latest-mac.yml', 'latest-linux.yml',
  ];
  const linux = names.filter(name => name === `${prefix}-linux-x64.AppImage` || name === `${prefix}-linux-x86_64.AppImage`);
  if (linux.length !== 1) throw new Error('Expected exactly one Linux x64 AppImage');
  required.push(linux[0]);
  const assets = [];
  for (const name of required.sort()) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty release asset: ${name}`);
    assets.push({ name, file, size: info.size, digest: await sha256(file) });
  }
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  await writeFile(checksumFile, assets.map(asset => `${asset.digest.slice(7)}  ${asset.name}\n`).join(''));
  assets.push({ name: 'SHA256SUMS.txt', file: checksumFile, size: (await stat(checksumFile)).size, digest: await sha256(checksumFile) });
  return assets;
}

export function verifyExistingAssets(local, remote, { published = false } = {}) {
  const missing = [];
  for (const asset of local) {
    const existing = remote.find(candidate => candidate.name === asset.name);
    if (!existing) {
      if (published) throw new Error(`Published release is incomplete: ${asset.name}; use a new version`);
      missing.push(asset);
    } else if (existing.state !== 'uploaded' || existing.size !== asset.size || existing.digest !== asset.digest) {
      throw new Error(`Immutable GitHub asset differs: ${asset.name}; use a new version`);
    }
  }
  return missing;
}

async function main() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  const repo = process.env.GITHUB_REPOSITORY;
  if (tag !== `v${version}` || !repo) throw new Error('Release tag, package version and repository are required');
  const assets = await collectReleaseAssets('release', version);
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const api = suffix => JSON.parse(gh(['api', `repos/${repo}/${suffix}`]));
  // Listing distinguishes absence from an authentication/network failure.
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]));
  let release = pages.flat().find(candidate => candidate.tag_name === tag);
  if (!release) {
    const notes = path.join('docs', 'release-notes', `${version}.md`);
    const notesArgs = await stat(notes).then(() => ['--notes-file', notes], () => ['--generate-notes']);
    gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', `Flyt ${version}`, ...notesArgs]);
    release = api(`releases/tags/${tag}`);
  }
  const remote = () => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases/${release.id}/assets?per_page=100`])).flat();
  const missing = verifyExistingAssets(assets, remote(), { published: !release.draft });
  for (const asset of missing) {
    gh(['release', 'upload', tag, asset.file, '--repo', repo]);
    console.log(`Uploaded ${asset.name}`);
  }
  verifyExistingAssets(assets, remote(), { published: true });
  if (release.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  console.log(`Verified all ${assets.length} assets: https://github.com/${repo}/releases/tag/${tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
