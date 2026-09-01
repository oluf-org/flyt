/**
 * `ctx.fs` — confined file access.
 *
 * The seam is why worktree isolation stops being a special case threaded
 * through the runner and becomes a provider: a block running in a worktree
 * gets a different `ctx.fs`, not a runner that remembers to check.
 *
 * Every path is relative to `root`. A path that escapes it is refused, and
 * refusal is an error, never a silently clamped path.
 *
 * Reads and writes go through the single text interpretation in
 * `./textFile.ts` (ported from `core/tools/textFile.js` — the v2 boundary
 * forbids importing from `core/`). That means a BOM is a fact about the file
 * not a character in it, CRLF is preserved, and a binary file is refused
 * rather than destroyed by a UTF-8 round-trip.
 *
 * @module #kernel/seams/fs
 */
import fs from 'node:fs';
import path from 'node:path';
import { decode, encode, readFileShaped, sniff, toEol } from './textFile.js';
import type { TextShape } from './textFile.js';
import {
  applyMutationBatch, contentHash, ABSENT_HASH,
  type DiagnoseBatch, type FilePatch, type MutationBatchResult,
} from '../fs/transactional-patches.js';

/** One directory entry. */
export interface FsEntry {
  /** Relative to `root`, with forward slashes on every platform. */
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

/** The seam. Providers: `flyt-fs-workspace`, `flyt-fs-worktree`. */
export interface FsSeam {
  /** The confinement boundary, for diagnostics. Not a licence to bypass the seam. */
  readonly root: string;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Current optimistic-concurrency hash, or `absent`. */
  hash(path: string): Promise<string>;
  /** Canonical worker mutation path: hash-checked, diagnosed, diffed and reversible. */
  patch(patches: readonly FilePatch[], diagnose?: DiagnoseBatch): Promise<MutationBatchResult>;
  /** True when the path exists inside the root. False — never a throw — when it does not. */
  exists(path: string): Promise<boolean>;
  list(path?: string): Promise<FsEntry[]>;
  remove(path: string): Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FsSeam;
  }
}

// --- implementation -------------------------------------------------------

/** Resolve `rel` inside `root` or throw. Mirrors `Workspace.resolve` confinement. */
function resolveInside(root: string, relPath: string): string {
  const rel = String(relPath ?? '');
  if (rel.includes('\0')) throw new Error(`Path "${relPath}" contains a null byte`);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${relPath}" escapes the workspace root`);
  }
  // Symlink confinement: nearest existing ancestor must realpath inside root.
  const realRoot = fs.realpathSync(root);
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new Error(`Path "${relPath}" resolves outside the workspace root (symlink escape)`);
  }
  return resolved;
}

/**
 * Create an `FsSeam` confined to `root` that reads and writes through
 * the single text interpretation. Binary files are refused on read
 * (never decoded to mojibake) so they cannot be read as text and
 * written back.
 */
export function createFsSeam(root: string): FsSeam {
  const resolvedRoot = path.resolve(String(root ?? ''));
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`FsSeam root "${root}" is not an existing directory`);
  }

  return {
    get root() {
      return resolvedRoot;
    },

    async read(relPath: string): Promise<string> {
      const abs = resolveInside(resolvedRoot, relPath);
      let buf: Buffer;
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          throw new Error(`File "${relPath}" not found in the workspace.`);
        }
        buf = fs.readFileSync(abs);
      } catch (err) {
        if ((err as Error)?.message?.includes('not found')) throw err;
        throw new Error(`File "${relPath}" not found in the workspace.`);
      }
      const shape = sniff(buf);
      if (shape.binary) {
        throw new Error(
          `"${relPath}" is not a text file, so there is nothing to read as text. Its bytes are intact; inspect it with a tool that understands its format.`,
        );
      }
      // Use decode so BOM stripping is shared, not reimplemented.
      return decode(buf).text;
    },

    async write(relPath: string, content: string): Promise<void> {
      const abs = resolveInside(resolvedRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Preserve encoding/BOM/eol of an existing text file; new files are utf8/lf.
      let shape: TextShape | null = null;
      const existing = readFileShaped(abs);
      if (existing && !existing.shape.binary) shape = existing.shape;
      const toWrite = shape ? toEol(content, shape.eol) : String(content ?? '');
      const bytes = shape ? encode(toWrite, shape) : Buffer.from(toWrite, 'utf8');
      fs.writeFileSync(abs, bytes);
    },

    async hash(relPath: string): Promise<string> {
      const abs = resolveInside(resolvedRoot, relPath);
      return fs.existsSync(abs) && fs.statSync(abs).isFile()
        ? contentHash(fs.readFileSync(abs)) : ABSENT_HASH;
    },

    async patch(patches: readonly FilePatch[], diagnose?: DiagnoseBatch): Promise<MutationBatchResult> {
      return applyMutationBatch(resolvedRoot, patches, diagnose);
    },

    async exists(relPath: string): Promise<boolean> {
      try {
        const abs = resolveInside(resolvedRoot, relPath);
        return fs.existsSync(abs) && fs.statSync(abs).isFile();
      } catch {
        // Path confinement violation is an error for read/write but exists()
        // is specified to return false, never throw, when the path is outside.
        // However escaping paths are programmer errors; we return false to
        // honor the interface without leaking the confinement check shape.
        // Callers that need to distinguish can call read() and get the throw.
        return false;
      }
    },

    async list(dirPath?: string): Promise<FsEntry[]> {
      const rel = dirPath ?? '.';
      const abs = resolveInside(resolvedRoot, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
      const out: FsEntry[] = [];
      const walk = (dirAbs: string, dirRel: string) => {
        for (const name of fs.readdirSync(dirAbs)) {
          const entryAbs = path.join(dirAbs, name);
          const entryRel = dirRel ? `${dirRel}/${name}` : name;
          const stat = fs.statSync(entryAbs);
          if (stat.isDirectory()) {
            out.push({ path: entryRel, kind: 'directory' });
            walk(entryAbs, entryRel);
          } else if (stat.isFile()) {
            out.push({ path: entryRel, kind: 'file', size: stat.size });
          }
        }
      };
      walk(abs, dirPath && dirPath !== '.' ? dirPath : '');
      // Normalize to forward slashes (already) and sort for determinism.
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    },

    async remove(relPath: string): Promise<void> {
      const abs = resolveInside(resolvedRoot, relPath);
      if (!fs.existsSync(abs)) return;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
    },
  };
}

// Re-export the text interpretation so consumers and tests have one shared answer.
export { sniff, decode, encode, toEol, readFileShaped } from './textFile.js';
export type { TextShape, Decoded, Encoding, Eol } from './textFile.js';
export { SNIFF_BYTES, BOM_CHAR } from './textFile.js';
