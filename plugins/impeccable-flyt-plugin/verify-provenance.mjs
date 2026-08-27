import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProvenancePath = path.join(packageDir, 'provenance.json');
const defaultRoot = path.resolve(packageDir, '../..');

async function filesBelow(root, current = '') {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`unsupported payload entry: ${relative}`);
  }
  return files;
}

function frame(hash, bytes) {
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update(';');
}

export async function digestPayload(payloadDir, flytDelta) {
  const files = await filesBelow(payloadDir);
  const hash = createHash('sha256');
  let deltaMatches = 0;

  for (const relative of files) {
    const pathBytes = Buffer.from(relative, 'utf8');
    let content = (await readFile(path.join(payloadDir, ...relative.split('/'))))
      .toString('utf8')
      .replace(/\r\n/g, '\n');

    if (flytDelta && relative === flytDelta.file) {
      const escaped = flytDelta.exactLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp(`^${escaped}\\n`, 'gm'), match => {
        deltaMatches += 1;
        return '';
      });
    }

    frame(hash, pathBytes);
    frame(hash, Buffer.from(content, 'utf8'));
  }

  if (flytDelta && deltaMatches !== 1) {
    throw new Error(`expected exactly one declared Flyt metadata delta, found ${deltaMatches}`);
  }
  return { sha256: hash.digest('hex'), fileCount: files.length };
}

export async function verifyPayload({ root = defaultRoot, provenancePath = defaultProvenancePath } = {}) {
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const payloadDir = path.resolve(root, provenance.payload.path);
  const actual = await digestPayload(payloadDir, provenance.payload.flytDelta);
  if (actual.fileCount !== provenance.payload.fileCount) {
    throw new Error(`Impeccable payload file count mismatch: expected ${provenance.payload.fileCount}, got ${actual.fileCount}`);
  }
  if (actual.sha256 !== provenance.payload.normalizedTreeSha256) {
    throw new Error(`Impeccable payload digest mismatch: expected ${provenance.payload.normalizedTreeSha256}, got ${actual.sha256}`);
  }
  return { ...actual, artifactSha256: provenance.upstream.artifactSha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPayload().then(result => {
    process.stdout.write(`Impeccable payload verified (${result.fileCount} files, tree ${result.sha256}, artifact ${result.artifactSha256})\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
