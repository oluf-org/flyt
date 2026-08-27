// The brand is Flyt; the domain noun is still "flow" (D29).
//
// This file exists to stop the scope question from being relitigated. The
// rename covered brand surfaces only — app name, appId, window titles, the IPC
// bridge, storage keys, log prefixes, the .flyt/ config directory, the mark. It
// deliberately did NOT touch the vocabulary of the thing you build: a *flow* is
// still a flow, so `.flow.yaml`, `stacklang`, `StackRunner` and `flow.nodes` keep
// their names and `grep -i flow` keeps returning thousands of hits forever.
//
// So the test asserts BOTH halves. Forbidding the brand strings alone would be
// half an argument; the second half pins the domain vocabulary in place, so a
// future "let me finish the rename" pass fails just as loudly as a leak.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every spelling of the old brand, case-insensitively: "LLM Flow", "llm-flow",
// "llmflow", and the shoutier variants ("LLM FLOW" was a run-dossier header).
const FORBIDDEN = [/LLM\s+Flow/i, /llm-flow/i, /llmflow/i];

const SCAN_DIRS = ['src', 'core', 'electron', '.github'];
const SCAN_FILES = ['index.html', 'package.json', 'electron-builder.yml'];

// core/brand.js is the single documented home for the old name: every legacy
// literal lives there, beside the migration that consumes it. Exempting exactly
// one file is what keeps "where is the old brand allowed?" answerable.
const EXEMPT_FILES = new Set(['core/brand.js', 'tests/brand.test.js']);

// index.html's pre-paint theme bootstrap runs before any module loads, so it
// cannot import brand.js. That single line carries this marker instead.
const LINE_EXEMPTION = 'brand-legacy';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'build', '.git']);
const TEXT_EXT = new Set(['.js', '.jsx', '.cjs', '.mjs', '.json', '.html', '.css', '.yml', '.yaml', '.md']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (TEXT_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

function scannedFiles() {
  const files = SCAN_DIRS.flatMap(d => walk(path.join(REPO, d)));
  for (const f of SCAN_FILES) {
    const p = path.join(REPO, f);
    if (fs.existsSync(p)) files.push(p);
  }
  return files
    .map(p => path.relative(REPO, p).split(path.sep).join('/'))
    .filter(rel => !EXEMPT_FILES.has(rel));
}

test('brand: no shipping file names the old brand', () => {
  const leaks = [];
  for (const rel of scannedFiles()) {
    const lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(LINE_EXEMPTION)) return;
      if (FORBIDDEN.some(re => re.test(line))) leaks.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(leaks, [], `brand leaked into ${leaks.length} line(s):\n${leaks.join('\n')}`);
});

test('brand: the scan actually covers the files it claims to', () => {
  const files = scannedFiles();
  // A walk that silently returns nothing would make the test above vacuous.
  assert.ok(files.length > 40, `expected a real file list, got ${files.length}`);
  for (const expected of ['index.html', 'package.json', 'electron-builder.yml',
                          'electron/preload.cjs', 'electron/main.js', 'src/Root.jsx',
                          'core/projects.js', 'core/workspace.js']) {
    assert.ok(files.includes(expected), `${expected} is not being scanned`);
  }
});

test('brand: the exemption is narrow — brand.js really is the only one', () => {
  // If the exempt list ever grows, this fails and forces the question to be
  // answered on purpose rather than by appending another path.
  assert.deepEqual([...EXEMPT_FILES].sort(), ['core/brand.js', 'tests/brand.test.js']);
  const brand = fs.readFileSync(path.join(REPO, 'core/brand.js'), 'utf8');
  assert.match(brand, /llmflow/i, 'brand.js is exempt because it HOLDS the legacy literals');

  // And the line-level escape hatch is used exactly once, where documented.
  const tagged = [];
  for (const rel of scannedFiles()) {
    fs.readFileSync(path.join(REPO, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (line.includes(LINE_EXEMPTION)) tagged.push(`${rel}:${i + 1}`);
    });
  }
  assert.equal(tagged.length, 1, `expected one ${LINE_EXEMPTION} line, found: ${tagged.join(', ')}`);
  assert.match(tagged[0], /^index\.html:/);
});

test('brand: the new name is actually wired up, not just the old one removed', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'flyt');

  const builder = fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^appId: com\.olaaxe\.flyt$/m);
  assert.match(builder, /^productName: Flyt$/m);

  assert.match(fs.readFileSync(path.join(REPO, 'index.html'), 'utf8'), /<title>Flyt<\/title>/);
  assert.match(fs.readFileSync(path.join(REPO, 'electron/preload.cjs'), 'utf8'),
    /exposeInMainWorld\('flyt'/);
});

// --- The other half of the boundary: the domain noun stays put -------------

test('brand: "flow" is still the domain noun and was NOT renamed', () => {
  // The DSL, its parser, and the runner keep their names on purpose.
  for (const p of ['core/stacklang/parse.js', 'core/stacklang/serialize.js',
                   'core/stackRunner.js', 'core/flowstore.js', 'STACK_LANG.md', 'BLOCKS.md']) {
    assert.ok(fs.existsSync(path.join(REPO, p)), `${p} must keep its name (D29)`);
  }
  // Flows on disk are still *.flow.yaml — renaming the extension would have
  // meant a migration for every existing project, which D29 explicitly
  // declined. Asserted against the store that mints the filenames, NOT against
  // flows/ on disk: that directory is gitignored user data and simply does not
  // exist on a fresh checkout (which is where CI runs).
  const store = fs.readFileSync(path.join(REPO, 'core/flowstore.js'), 'utf8');
  assert.match(store, /'\.flow\.yaml'/, 'the on-disk flow extension must not be rebranded');

  // If a working copy does have flows/, they must match that extension too.
  const flowsDir = path.join(REPO, 'flows');
  if (fs.existsSync(flowsDir)) {
    const stray = fs.readdirSync(flowsDir)
      .filter(f => f.endsWith('.yaml') && !f.endsWith('.flow.yaml'));
    assert.deepEqual(stray, [], 'flows/ should only hold *.flow.yaml files');
  }

  // And the word survives in code at scale: if some future pass "finished" the
  // rename, this count would collapse.
  let hits = 0;
  for (const rel of scannedFiles()) {
    hits += (fs.readFileSync(path.join(REPO, rel), 'utf8').match(/flow/gi) ?? []).length;
  }
  assert.ok(hits > 500, `expected "flow" to remain everywhere as the domain noun, saw ${hits}`);
});
