import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ASSET_IMPORTERS } from './assetImporters.js';

export const ASSET_LIMITS = Object.freeze({ count: 10, fileBytes: 20 * 1024 ** 2, totalBytes: 50 * 1024 ** 2, pixels: 40_000_000 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = id => { if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw new Error('Invalid asset ID'); return id; };
const safeDraft = id => { if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid draft ID'); return id; };
async function atomic(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, bytes, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

// Durable generic asset ownership and references. Image decoding/variants are the
// first importer; future PDF/audio importers can retain this storage contract.
export class AssetStore {
  constructor(root) { this.root = path.resolve(root); }
  async directory(id) {
    const dir = path.join(this.root, safeId(id));
    if ((await fs.lstat(this.root)).isSymbolicLink() || (await fs.lstat(dir)).isSymbolicLink()) throw new Error('Asset links are not allowed');
    return dir;
  }
  async import({ name = 'Image', base64, bytes }) {
    if (!bytes && (typeof base64 !== 'string' || base64.length > Math.ceil(ASSET_LIMITS.fileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))) throw new Error('Invalid or oversized image bytes');
    const original = bytes ? Buffer.from(bytes) : Buffer.from(base64, 'base64');
    if (!original.length || original.length > ASSET_LIMITS.fileBytes) throw new Error('Images must be at most 20 MiB');
    const importer = ASSET_IMPORTERS.find(candidate => candidate.accepts(original));
    if (!importer) throw new Error(`${name}: unsupported asset. Use PNG, JPEG, WebP, or static GIF`);
    let prepared;
    try { prepared = await importer.prepare(original, ASSET_LIMITS); }
    catch (error) { throw new Error(`${name}: ${error.message}`); }
    const assetId = hash(original);
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('Asset links are not allowed');
    const destination = path.join(this.root, assetId);
    try { return (await this.read({ assetId }, 'original')).ref; } catch (error) {
      // Existing corrupt evidence must never be overwritten by another import.
      try { await fs.stat(destination); throw error; } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    }
    const dir = await fs.mkdtemp(path.join(this.root, '.upload-'));
    const ref = { assetId, kind: importer.kind, name: String(name).replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'Asset',
      byteLength: original.length, ...prepared.metadata };
    try {
      await atomic(path.join(dir, 'original'), original);
      const variants = {};
      for (const key of ['display', 'thumbnail']) {
        const { bytes: variantBytes, ...descriptor } = prepared.variants[key];
        await atomic(path.join(dir, `${key}.png`), variantBytes);
        variants[key] = { ...descriptor, hash: hash(variantBytes) };
      }
      await atomic(path.join(dir, 'manifest.json'), JSON.stringify({ ...ref, variants }));
      try { await fs.rename(dir, destination); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; return (await this.read({ assetId }, 'original')).ref; }
      return ref;
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  async read(ref, variant = 'thumbnail') {
    safeId(ref?.assetId);
    try {
      const dir = await this.directory(ref.assetId);
      if ((await fs.lstat(path.join(dir, 'manifest.json'))).isSymbolicLink()) throw new Error('Asset links are not allowed');
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
      const filename = variant === 'original' ? 'original' : variant === 'display' ? 'display.png' : 'thumbnail.png';
      if ((await fs.lstat(path.join(dir, filename))).isSymbolicLink()) throw new Error('Asset links are not allowed');
      const bytes = await fs.readFile(path.join(dir, filename));
      const expected = variant === 'original' ? ref.assetId : manifest.variants[variant === 'display' ? 'display' : 'thumbnail'].hash;
      if (hash(bytes) !== expected) throw new Error('integrity check failed');
      const { variants, ...owned } = manifest;
      return { ref: owned, bytes, mimeType: variant === 'original' ? owned.mimeType : variants[variant === 'display' ? 'display' : 'thumbnail'].mimeType };
    } catch (error) { throw new Error(`Image "${ref?.name ?? ref?.assetId}" is missing or corrupt: ${error.message}`); }
  }
  async references(refs = []) {
    if (!Array.isArray(refs) || refs.length > ASSET_LIMITS.count) throw new Error('Attach at most 10 images');
    const unique = [...new Map(refs.map(ref => [safeId(ref?.assetId), ref])).values()];
    const owned = await Promise.all(unique.map(async ref => (await this.read(ref, 'original')).ref));
    if (owned.reduce((sum, ref) => sum + ref.byteLength, 0) > ASSET_LIMITS.totalBytes) throw new Error('Attachments exceed 50 MiB');
    return owned;
  }
}
export const projectAssets = runsRoot => new AssetStore(path.join(runsRoot, '_assets'));
export const draftAssets = (root, draftId) => new AssetStore(path.join(root, 'asset-drafts', safeDraft(draftId)));
export function chatSubmission(value) {
  if (typeof value === 'string' || value == null) return { text: value ?? '', attachments: [], requestId: null };
  if (typeof value !== 'object' || typeof value.text !== 'string' || !Array.isArray(value.attachments)) throw new Error('Invalid chat submission');
  if (value.requestId != null && !/^[a-zA-Z0-9-]{8,100}$/.test(value.requestId)) throw new Error('Invalid submission request ID');
  return { text: value.text, attachments: value.attachments, requestId: value.requestId ?? null };
}
