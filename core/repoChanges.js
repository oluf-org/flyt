// Persist observed tool effects, independent of Git's index/HEAD and pre-existing
// dirty files. Counts describe edits performed, so a later revert still appears.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeAtomic } from './executionOwnership.js';
import { scrubbedParentEnv } from '#kernel';

const exec = promisify(execFile);
const observations = new Map();
const SKIP = new Set(['.git', '.flyt', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', 'vendor']);
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const parentId = id => id.split('--child-')[0];
const reportFile = (store, id) => path.join(store.runDir(parentId(id)), 'repo-changes.json');
// Trusted control-plane reads only: fixed argv, no shell, hooks, external diff
// drivers, or inherited credentials. Never expose this launcher as a tool.
const gitOptions = cwd => ({ cwd, env: scrubbedParentEnv(), windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });

export const repoSnapshotDigest = snapshot => crypto.createHash('sha256').update(JSON.stringify(
  [...snapshot.files].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value.hash]),
)).digest('hex');

export async function captureRepoFiles(root) {
  const files = new Map();
  if (!root) return { files, partial: true };
  root = await fsp.realpath(root);
  let names;
  let partial = false;
  try {
    const top = (await exec('git', ['rev-parse', '--show-toplevel'], gitOptions(root))).stdout.trim();
    // A bound fixture/project nested in another repository may be ignored by
    // that parent. Its files still exist and must never become an empty snapshot.
    if (await fsp.realpath(top) !== root) throw new Error('Bound workspace is not this Git root');
    const { stdout } = await exec('git', ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], gitOptions(root));
    names = [...new Set(stdout.split('\0').filter(Boolean))];
  } catch {
    names = [];
    const walk = async (dir, prefix = '') => {
      for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
        if (names.length >= MAX_FILES) { partial = true; break; }
        if (SKIP.has(item.name)) continue;
        const rel = prefix + item.name;
        if (item.isDirectory()) await walk(path.join(dir, item.name), rel + '/');
        else if (item.isFile()) names.push(rel);
      }
    };
    await walk(root);
  }
  let bytes = 0;
  if (names.length > MAX_FILES) partial = true;
  for (const name of names.slice(0, MAX_FILES)) {
    const rel = name.replaceAll('\\', '/');
    if (rel.split('/').some(part => SKIP.has(part))) continue;
    const full = path.resolve(root, name);
    if (!inside(root, full)) { partial = true; continue; }
    try {
      // Do not follow symlinks/junctions out of the workspace.
      const real = await fsp.realpath(full);
      if (!inside(root, real)) { partial = true; continue; }
      const stat = await fsp.lstat(full);
      if (!stat.isFile()) { partial = true; continue; }
      if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_BYTES) {
        partial = true;
        files.set(rel, { hash: `metadata:${stat.size}:${stat.mtimeMs}`, content: null });
        continue;
      }
      const content = await fsp.readFile(full);
      bytes += content.length;
      files.set(rel, { hash: crypto.createHash('sha256').update(content).digest('hex'), content });
    } catch (error) {
      if (error.code !== 'ENOENT') partial = true;
    }
  }
  return { files, partial };
}

const lines = content => content.length ? content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0) : 0;
export async function changedRepoFiles(before, after) {
  const rows = [];
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const a = before.files.get(name), b = after.files.get(name);
    if (a?.hash === b?.hash) continue;
    const row = { path: name, status: !a ? 'created' : !b ? 'deleted' : 'modified', added: null, deleted: null, binary: false };
    const left = a?.content ?? (a ? null : Buffer.alloc(0));
    const right = b?.content ?? (b ? null : Buffer.alloc(0));
    if (left && right) {
      row.binary = left.includes(0) || right.includes(0);
      if (!row.binary) {
        if (!a || !b) { row.added = lines(right); row.deleted = lines(left); }
        else {
          const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'flyt-diff-'));
          try {
            await fsp.writeFile(path.join(temp, 'before'), left);
            await fsp.writeFile(path.join(temp, 'after'), right);
            const result = await exec('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--numstat', '--', 'before', 'after'], gitOptions(temp))
              .catch(error => { if (error.code === 1) return error; throw error; });
            const match = /^(\d+)\t(\d+)\t/.exec(result.stdout);
            if (match) { row.added = Number(match[1]); row.deleted = Number(match[2]); }
          } catch { /* File identity remains useful when Git/line stats are unavailable. */ }
          finally { await fsp.rm(temp, { recursive: true, force: true }); }
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

export function readRepoChanges(store, id) {
  const file = reportFile(store, id);
  if (!fs.existsSync(file)) return { available: false, files: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function createRepoChangeTracker(store, workspace) {
  const save = (id, report) => writeAtomic(reportFile(store, id), report);
  const initialize = id => {
    if (!fs.existsSync(reportFile(store, id))) save(id, { available: true, workspace, files: [], partial: false, updatedAt: new Date().toISOString() });
  };
  const tracker = {
    initialize,
    async observe(id, tool, blockId, action, onObserved) {
      // Mutating calls sharing a workspace get non-overlapping observation
      // windows, including calls from generated workers and pooled hosts.
      const key = path.resolve(workspace);
      const previous = observations.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        const before = await tracker.before();
        try { return await action(); }
        finally { const observation = await tracker.after(id, before, tool, blockId); onObserved?.(observation); }
      });
      observations.set(key, pending);
      try { return await pending; }
      finally { if (observations.get(key) === pending) observations.delete(key); }
    },
    async before() {
      try { return await captureRepoFiles(workspace); }
      catch { return { files: new Map(), partial: true, unavailable: true }; }
    },
    async after(id, before, tool, blockId) {
      try {
        const after = await captureRepoFiles(workspace);
        const rows = before.unavailable ? [] : await changedRepoFiles(before, after);
        initialize(id);
        // Read after asynchronous diff work, so sibling workers cannot overwrite
        // one another's already persisted rows in this process.
        const report = readRepoChanges(store, id);
        const files = new Map(report.files.map(file => [file.path, file]));
        for (const row of rows) {
          const old = files.get(row.path);
          const initialExists = old?.initialExists ?? row.status !== 'created';
          files.set(row.path, {
            ...row, initialExists,
            status: row.status === 'deleted' ? (initialExists ? 'deleted' : 'created then deleted') : initialExists ? 'modified' : 'created',
            added: old ? old.added == null || row.added == null ? null : old.added + row.added : row.added,
            deleted: old ? old.deleted == null || row.deleted == null ? null : old.deleted + row.deleted : row.deleted,
            tools: [...new Set([...(old?.tools ?? []), tool])],
            blocks: [...new Set([...(old?.blocks ?? []), blockId])],
          });
        }
        save(id, { ...report, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), partial: report.partial || before.partial || after.partial, updatedAt: new Date().toISOString() });
        return { changed: rows.length > 0, partial: before.partial || after.partial,
          ...(after.partial ? {} : { digest: repoSnapshotDigest(after) }) };
      } catch {
        // Tracking is optional, but a missing observation must not look complete.
        try { initialize(id); save(id, { ...readRepoChanges(store, id), partial: true }); } catch { /* Preserve the tool outcome. */ }
        return { changed: false, partial: true };
      }
    },
  };
  return tracker;
}

export function resolveChangedRepoPath(store, id, relPath) {
  const report = readRepoChanges(store, id);
  const row = report.files.find(file => file.path === relPath);
  if (!row || !report.workspace) throw new Error('File is not recorded in this run');
  const root = fs.realpathSync(report.workspace);
  const target = path.resolve(root, row.path);
  if (!inside(root, target)) throw new Error('Path escapes the workspace');
  // Resolve again when opening: a file may have become a symlink since the run.
  const real = fs.realpathSync(target);
  if (!inside(root, real)) throw new Error('Path escapes the workspace');
  return real;
}
