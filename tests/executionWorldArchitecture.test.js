import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const slash = value => path.relative(root, value).split(path.sep).join('/');
const allow = new Set([
  'core/adapters/cliDelegate.js',
  'core/effect.js',
  'core/homeSeed.js',
  'core/python.js',
  'core/stackRunner.js',
  'core/worktree.js',
  'kernel/src/plugins/subprocess-local.ts',
]);

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['dist', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(file));
    else if (/\.(?:js|ts)$/.test(entry.name)) out.push(file);
  }
  return out;
}

test('every shipped direct child_process import is a reviewed provider or control-plane exception', () => {
  const imported = [...sources(path.join(root, 'core')), ...sources(path.join(root, 'kernel', 'src'))]
    .filter(file => /from\s+['"]node:child_process['"]|require\(['"]node:child_process['"]\)/.test(fs.readFileSync(file, 'utf8')))
    .map(slash).sort();
  assert.deepEqual(imported, [...allow].sort());
});

test('execution-plane consumers have no direct process launch', () => {
  for (const rel of ['core/tools/bash.js', 'core/gates.js']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(text, /node:child_process|\bshell\s*:\s*true|\b(?:spawn|execFile|fork)\s*\(/, rel);
  }
  const python = fs.readFileSync(path.join(root, 'core/python.js'), 'utf8');
  const beforeSetup = python.slice(0, python.indexOf('// --- the managed environment'));
  assert.doesNotMatch(beforeSetup, /(?<!\.)\bspawn\s*\(/, 'model-side Python must use ctx.subprocess');
});

test('the production run host installs one execution-world family, not a standalone fs provider', () => {
  const host = fs.readFileSync(path.join(root, 'core/kernelHost.js'), 'utf8');
  assert.match(host, /BUILTIN\.executionWorldLocal/);
  assert.doesNotMatch(host, /name:\s*kernel\.BUILTIN\.fs/);
  assert.match(host, /booted\.ctx\.fs\.world\.id/);
});

test('Loop launch cannot enable attended sandbox escalation', () => {
  const api = fs.readFileSync(path.join(root, 'core/api.js'), 'utf8');
  assert.match(api, /profile:\s*'flyt-loop-worker'[\s\S]{0,500}allowAttendedEscalation:\s*false/);
});
