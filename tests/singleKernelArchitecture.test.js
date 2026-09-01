import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const productionRoots = ['core', 'electron', 'bin', 'src'];
const files = productionRoots.flatMap(dir => {
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|jsx|cjs|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(root, dir));
  return out;
});
const source = file => fs.readFileSync(file, 'utf8');
const relative = file => path.relative(root, file).replaceAll('\\', '/');

test('production entry points cannot reach the retired runner ownership seams', () => {
  const offenders = [];
  for (const file of files) {
    if (relative(file) === 'core/stackRunner.js') continue; // migration reader retained, never imported
    const text = source(file);
    if (/from\s+['"][^'"]*stackRunner\.js['"]|import\(['"][^'"]*stackRunner\.js['"]\)/.test(text)
      || /\bentry\.runner\b|\brunnerFor\s*\(|\.kernelRuns\b/.test(text)) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, []);
});

test('all execution profiles enter through RunController', () => {
  const api = source(path.join(root, 'core', 'api.js'));
  const cli = source(path.join(root, 'bin', 'flyt.js'));
  const supervisor = source(path.join(root, 'core', 'supervisor.js'));
  const host = source(path.join(root, 'core', 'kernelHost.js'));
  assert.match(api, /runController\.start\(/);
  assert.match(api, /profile:\s*'flyt-loop-worker'/);
  assert.match(api, /profile:\s*'flyt-cli'/);
  assert.match(api, /profile\s*=\s*'flyt-desktop'/);
  assert.match(cli, /runCliWorkflow/);
  assert.match(supervisor, /'stack:run'/);
  assert.equal((host.match(/export async function startStackRun/g) ?? []).length, 1);
});

test('renderer and preload expose canonical controls only', () => {
  const preload = source(path.join(root, 'electron', 'preload.cjs'));
  const daily = source(path.join(root, 'src', 'v2', 'DailyRoot.jsx'));
  for (const retired of ['restartNode:', 'approveRun:', 'rejectRun:', 'answerInput:', 'followUp:', 'runFlow:']) {
    assert.doesNotMatch(preload, new RegExp(retired));
  }
  assert.match(preload, /restartBlock:/);
  assert.match(preload, /runWorkflow:/);
  assert.match(daily, /restartBlock\(/);
  assert.match(daily, /runWorkflow\(/);
});

test('canonical durable events are declared in one typed registry', () => {
  const events = source(path.join(root, 'kernel', 'src', 'session', 'events.ts'));
  for (const type of [
    'run.created', 'run.named', 'run.reconfigured', 'block.status', 'message.user',
    'llm.request', 'llm.response', 'tool.call', 'tool.result', 'run.stage', 'run.error',
  ]) assert.match(events, new RegExp(`['"]${type.replace('.', '\\.')}`));
  assert.match(events, /extension\.\$\{string\}/);
});
