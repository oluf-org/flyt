import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchedRoots = ['core', 'electron', path.join('kernel', 'dist')]
  .map(relative => path.join(projectRoot, relative));
const watchedExtensions = new Set(['.js', '.cjs', '.json']);

function filesBelow(root, rows = []) {
  if (!fs.existsSync(root)) return rows;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) filesBelow(target, rows);
    else if (watchedExtensions.has(path.extname(entry.name))) rows.push(target);
  }
  return rows;
}

function sourceSignature() {
  return watchedRoots.flatMap(root => filesBelow(root)).sort().map(file => {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  }).join('\n');
}

let child = null;
let stopping = false;
let restartPending = false;
let observed = sourceSignature();
let changedAt = 0;

function startElectron() {
  if (stopping) return;
  const next = spawn(electron, ['.'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  child = next;
  next.on('exit', code => {
    if (child === next) child = null;
    if (stopping) process.exit(0);
    if (restartPending) {
      restartPending = false;
      startElectron();
      return;
    }
    process.exit(code ?? 0);
  });
}

function restartElectron() {
  if (stopping) return;
  restartPending = true;
  if (child) child.kill();
  else {
    restartPending = false;
    startElectron();
  }
}

const poll = setInterval(() => {
  const current = sourceSignature();
  if (current !== observed) {
    observed = current;
    changedAt = Date.now();
    return;
  }
  // TypeScript writes several output files for one edit. Restart only after
  // that write burst settles, so Electron never imports half of a new kernel.
  if (changedAt && Date.now() - changedAt >= 700) {
    changedAt = 0;
    restartElectron();
  }
}, 250);
poll.unref();

function shutdown() {
  stopping = true;
  clearInterval(poll);
  if (child) child.kill();
  else process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
startElectron();
