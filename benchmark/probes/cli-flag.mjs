// Probe: `flyt task list --limit` (benchmark/cli-flag.bench.md).
//
// This one runs the CLI rather than importing anything, because the case is
// about the CLI. An agent can make a function exist without making a command
// work, and "the command works" is the only claim worth scoring here.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const fail = msg => { console.error(`probe: ${msg}`); process.exit(1); };

const flyt = (...args) => {
  try {
    return execFileSync(process.execPath, [path.join(root, 'bin', 'flyt.js'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    fail(`flyt ${args.join(' ')} failed: ${String(err.stderr || err.message).slice(0, 400)}`);
  }
};

// Three tasks of our own, so the probe does not depend on what the benchmark
// happened to seed or on the order the cases ran in.
for (const n of [1, 2, 3]) flyt('task', 'add', `probe task ${n}`, '--goal', 'a task the probe made');

const all = JSON.parse(flyt('task', 'list', '--json')).tasks;
if (all.length < 3) fail(`expected at least 3 tasks in the backlog, saw ${all.length}`);

const limited = JSON.parse(flyt('task', 'list', '--limit', '1', '--json')).tasks;
if (limited.length !== 1) fail(`--limit 1 --json printed ${limited.length} task(s)`);

const two = flyt('task', 'list', '--limit', '2').trim().split('\n').filter(Boolean);
if (two.length > 2) fail(`--limit 2 printed ${two.length} lines of task output`);

console.log('probe: ok');
