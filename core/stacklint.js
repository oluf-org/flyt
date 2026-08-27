#!/usr/bin/env node
// Canonical stack linter. `npm run stack -- lint` is the public spelling;
// `npm run flow -- lint` remains a compatibility alias because the Phase 5
// landing contract itself uses that command. Both execute this file.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseStack } from '#kernel';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter(arg => !arg.startsWith('--'));
const [command, target] = positional;

if (command !== 'lint') {
  console.error('usage: npm run stack -- lint [<file.stack.yaml>] [--json]');
  process.exit(2);
}

const stackDir = path.join(projectRoot, 'stacks');
const relative = file => path.relative(projectRoot, file).split(path.sep).join('/');
let files;
if (target) {
  files = [path.resolve(target)];
} else {
  try {
    files = fs.readdirSync(stackDir)
      .filter(file => file.endsWith('.stack.yaml'))
      .sort()
      .map(file => path.join(stackDir, file));
  } catch {
    files = [];
  }
}

if (!files.length) {
  console.error('no stacks/*.stack.yaml to lint');
  process.exit(1);
}

const results = files.map(file => {
  try {
    const fallbackId = path.basename(file, '.stack.yaml');
    const stack = parseStack(fs.readFileSync(file, 'utf8'), fallbackId);
    return { file: relative(file), ok: true, id: stack.id };
  } catch (error) {
    return {
      file: relative(file), ok: false,
      error: String(error?.message ?? error),
    };
  }
});
const ok = results.every(result => result.ok);

if (json) {
  process.stdout.write(`${JSON.stringify({ ok, files: results }, null, 2)}\n`);
} else {
  for (const result of results) {
    console.log(result.ok ? `OK      ${result.file}` : `ERROR   ${result.file}: ${result.error}`);
  }
  console.log(ok
    ? `OK — ${results.length} stack${results.length === 1 ? '' : 's'}`
    : `FAILED — ${results.filter(result => !result.ok).length} of ${results.length} stack(s)`);
}
process.exitCode = ok ? 0 : 1;
