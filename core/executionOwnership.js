import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const processId = crypto.randomUUID();
const held = new Map();
export function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
export function ownerAlive(owner) {
  if (!owner?.pid) return false;
  if (owner.host && owner.host !== os.hostname()) return Date.now() - Number(owner.beatAt ?? 0) < 60000;
  if (owner.pid === process.pid && owner.processId && owner.processId !== processId) return false;
  try { process.kill(Number(owner.pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}
export function acquireOwner(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (held.has(file) || ownerAlive(readOwner(file))) throw Object.assign(new Error('Execution is owned by another active controller'), { code: 'run_already_live' });
    fs.unlinkSync(file);
  }
  const owner = { pid: process.pid, host: os.hostname(), processId, token: crypto.randomUUID(), beatAt: Date.now(), controls: 1 };
  // Publish a complete record atomically, so another process never mistakes a
  // partially written ownership record for an abandoned execution.
  const temporary = `${file}.${owner.token}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx' });
  try { fs.linkSync(temporary, file); }
  finally { fs.unlinkSync(temporary); }
  held.set(file, owner.token);
  const beat = () => {
    try {
      if (readOwner(file)?.token === owner.token) { owner.beatAt = Date.now(); writeAtomic(file, owner); }
    } catch { /* A temporary filesystem failure must not crash the owner. */ }
  };
  const timer = setInterval(beat, 5000); timer.unref?.();
  return {
    ...owner,
    release() {
      clearInterval(timer); held.delete(file);
      if (readOwner(file)?.token === owner.token) fs.unlinkSync(file);
    },
  };
}

export function bounded(promise, ms, label = 'Cleanup') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} has not finished; resource ownership is retained`), { code: 'cleanup_timeout' })), ms);
  })]).finally(() => clearTimeout(timer));
}

export function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(Object.assign(new Error('Execution cancelled before dispatch'), { code: 'run_cancelled' }));
  }
  let abort;
  return Promise.race([promise, new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('Execution cancelled before dispatch'), { code: 'run_cancelled' }));
    signal.addEventListener('abort', abort, { once: true });
  })]).finally(() => signal.removeEventListener('abort', abort));
}
