/** Optimistic, reversible mutation batches with structured diffs and diagnostics. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ABSENT_HASH = 'absent';

export interface FilePatch {
  path: string;
  /** sha256:<hex>, or `absent` when creating a file. */
  expectedHash: string;
  content: string;
}

export interface DiffLine { kind: 'context' | 'add' | 'remove'; line: number; text: string; }
export interface StructuredFileDiff {
  path: string;
  beforeHash: string;
  afterHash: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface Diagnostic {
  source: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface MutationBatchResult {
  batchId: string;
  diffs: StructuredFileDiff[];
  diagnostics: Diagnostic[];
  revert(): Promise<void>;
}

export type DiagnoseBatch = (paths: readonly string[]) => Promise<readonly Diagnostic[]>;

export function contentHash(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function resolveInside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return target;
  if (target === root) throw new Error('A mutation batch cannot replace the workspace root');
  return target;
}

function assertInside(root: string, relative: string): string {
  const target = resolveInside(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`Patch path "${relative}" escapes the workspace`);
  return target;
}

function structuredDiff(file: string, before: string, after: string, beforeHash: string): StructuredFileDiff {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  return {
    path: file, beforeHash, afterHash: contentHash(after),
    added: added.length, removed: removed.length,
    lines: [
      ...removed.map((text, index): DiffLine => ({ kind: 'remove', line: prefix + index + 1, text })),
      ...added.map((text, index): DiffLine => ({ kind: 'add', line: prefix + index + 1, text })),
    ],
  };
}

/** Validate every precondition before writing, then expose exactly one revert capability. */
export async function applyMutationBatch(
  root: string,
  patches: readonly FilePatch[],
  diagnose?: DiagnoseBatch,
): Promise<MutationBatchResult> {
  const resolvedRoot = path.resolve(root);
  const unique = new Set(patches.map(patch => path.normalize(patch.path).toLowerCase()));
  if (unique.size !== patches.length) throw new Error('A mutation batch may name each path only once');
  const snapshots = patches.map(patch => {
    const target = assertInside(resolvedRoot, patch.path);
    const existed = fs.existsSync(target);
    const bytes = existed ? fs.readFileSync(target) : null;
    const actual = bytes === null ? ABSENT_HASH : contentHash(bytes);
    if (actual !== patch.expectedHash) {
      throw new Error(`Stale patch for "${patch.path}": expected ${patch.expectedHash}, found ${actual}`);
    }
    return { patch, target, existed, bytes, before: bytes?.toString('utf8') ?? '' };
  });
  const batchId = randomUUID();
  const changed: typeof snapshots = [];
  try {
    for (const snapshot of snapshots) {
      fs.mkdirSync(path.dirname(snapshot.target), { recursive: true });
      const temp = `${snapshot.target}.flyt-${batchId}.tmp`;
      fs.writeFileSync(temp, snapshot.patch.content, 'utf8');
      fs.renameSync(temp, snapshot.target);
      changed.push(snapshot);
    }
  } catch (error) {
    for (const snapshot of changed.reverse()) {
      if (snapshot.existed) fs.writeFileSync(snapshot.target, snapshot.bytes!);
      else fs.rmSync(snapshot.target, { force: true });
    }
    throw error;
  }

  let reverted = false;
  const revert = async () => {
    if (reverted) throw new Error(`Mutation batch ${batchId} was already reverted`);
    for (const snapshot of snapshots) {
      const actual = fs.existsSync(snapshot.target) ? contentHash(fs.readFileSync(snapshot.target)) : ABSENT_HASH;
      const expected = contentHash(snapshot.patch.content);
      if (actual !== expected) throw new Error(`Cannot revert "${snapshot.patch.path}": it changed after batch ${batchId}`);
    }
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.existed) fs.writeFileSync(snapshot.target, snapshot.bytes!);
      else fs.rmSync(snapshot.target, { force: true });
    }
    reverted = true;
  };
  let diagnostics: Diagnostic[] = [];
  try { diagnostics = diagnose ? [...await diagnose(snapshots.map(item => item.patch.path))] : []; }
  catch (error) { await revert(); throw error; }
  return {
    batchId,
    diffs: snapshots.map(snapshot => structuredDiff(snapshot.patch.path, snapshot.before, snapshot.patch.content, snapshot.patch.expectedHash)),
    diagnostics,
    revert,
  };
}
