// The brand is Flyt; stacks and blocks are the canonical domain nouns (D62).
//
// This file exists to stop the scope question from being relitigated. The
// rename covered brand surfaces first; the v2 cutover later made `.stack.yaml`,
// `stacklang`, `StackRunner`, and `stack.blocks` canonical. Compatibility flow
// code remains intentionally isolated while existing projects migrate.
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

// --- Canonical vocabulary and its explicit compatibility boundary ----------

test('brand: stack vocabulary is canonical after the v2 cutover', () => {
  for (const p of ['core/stacklang/parse.js', 'core/stacklang/serialize.js',
                   'core/stackRunner.js', 'core/stackstore.js', 'STACK_LANG.md', 'BLOCKS.md']) {
    assert.ok(fs.existsSync(path.join(REPO, p)), `${p} is part of the canonical stack surface`);
  }

  const store = fs.readFileSync(path.join(REPO, 'core/stackstore.js'), 'utf8');
  assert.match(store, /\.stack\.yaml/, 'canonical stacks use the .stack.yaml extension');
  assert.match(store, /parseFlow/, 'the stack store owns the legacy migration boundary');

  const brand = fs.readFileSync(path.join(REPO, 'core/brand.js'), 'utf8');
  for (const legacyName of ['LEGACY_FLOWS_DIR', 'LEGACY_FLOW_EXTENSION',
                            'LEGACY_FLOW_NODES_KEY', 'LEGACY_FLOW_GRAPH_KEY']) {
    assert.match(brand, new RegExp(`export const ${legacyName}`), `${legacyName} must remain explicit`);
  }
});
