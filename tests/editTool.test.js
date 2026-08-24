// edit_file (DECISIONS.md D45): anchored replacement. The two failure modes it
// exists to close — an ambiguous anchor silently hitting the wrong place, and a
// missing anchor sending the next turn back with another guess — are what most
// of these assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { Workspace } from '../core/workspace.js';
import { normalized, origin, closestLine, findAll } from '../core/tools/edit_file.js';
import { makeStore } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-edit-'));

function boundCtx(files = {}) {
  const store = makeStore();
  const runId = store.createRun('edit_file test');
  const proj = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const workspace = new Workspace(proj).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace, proj };
}

const read = (ctx, rel) => fs.readFileSync(path.join(ctx.proj, rel), 'utf8');

test('edit_file: a unique anchor is replaced and the rest of the file is untouched', async () => {
  const ctx = boundCtx({ 'a.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'const b = 2;', new: 'const b = 20;' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 1);
  assert.equal(rec.result.line, 2);
  assert.equal(read(ctx, 'a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
});

test('edit_file: the result shows the edit with surrounding context', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const ctx = boundCtx({ 'a.txt': lines });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'line 10', new: 'LINE TEN' }, ctx);
  assert.equal(rec.ok, true);
  // ±3 lines: the agent has to be able to SEE what it did without re-reading.
  assert.match(rec.result.after, /line 7/);
  assert.match(rec.result.after, /LINE TEN/);
  assert.match(rec.result.after, /line 13/);
  assert.match(rec.result.before, /line 10/);
});

test('edit_file: an ambiguous anchor is refused, and the error names every line', async () => {
  const ctx = boundCtx({ 'a.js': 'x = 1;\nfoo();\ny = 2;\nfoo();\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'foo();', new: 'bar();' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /matches 2 times/);
  assert.match(rec.error, /lines 2, 4/);
  assert.match(rec.error, /replaceAll/);
  // Nothing was written: an ambiguous edit must not half-apply.
  assert.equal(read(ctx, 'a.js'), 'x = 1;\nfoo();\ny = 2;\nfoo();\n');
});

test('edit_file: replaceAll takes every occurrence', async () => {
  const ctx = boundCtx({ 'a.js': 'foo();\nfoo();\nfoo();\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'foo()', new: 'bar()', replaceAll: true }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 3);
  assert.equal(read(ctx, 'a.js'), 'bar();\nbar();\nbar();\n');
});

test('edit_file: no match carries the closest line, so the next turn can correct itself', async () => {
  const ctx = boundCtx({ 'a.js': 'const timeout = 10 * MINUTE;\nconst other = 1;\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'const timeout = 10 * MINUTES;', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /was not found/);
  assert.match(rec.error, /closest line is 1/);
  assert.match(rec.error, /10 \* MINUTE/);
});

test('edit_file: no plausible near-line still gives an actionable message', async () => {
  const ctx = boundCtx({ 'a.js': 'zzz\n' });
  const rec = await executeTool('edit_file', { path: 'a.js', old: 'completely different content here', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /Read the file first/);
});

test('edit_file: a missing file points at create_file rather than creating one', async () => {
  const ctx = boundCtx({});
  const rec = await executeTool('edit_file', { path: 'nope.js', old: 'a', new: 'b' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /not found/);
  assert.match(rec.error, /create_file/);
  assert.equal(fs.existsSync(path.join(ctx.proj, 'nope.js')), false);
});

test('edit_file: a CRLF file keeps its line endings everywhere it was not touched', async () => {
  const ctx = boundCtx({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'two', new: 'TWO' }, ctx);
  assert.equal(rec.ok, true);
  // Splicing a substring cannot rewrite line endings — which is the whole
  // point next to a whole-file write on a repo with .gitattributes.
  assert.equal(read(ctx, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
});

test('edit_file: an empty `old` is refused rather than prepending', async () => {
  const ctx = boundCtx({ 'a.txt': 'body\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: '', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /empty/);
  assert.equal(read(ctx, 'a.txt'), 'body\n');
});

test('edit_file: an identical replacement reports 0 rather than a false success', async () => {
  const ctx = boundCtx({ 'a.txt': 'same\n' });
  const rec = await executeTool('edit_file', { path: 'a.txt', old: 'same', new: 'same' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 0);
  assert.equal(rec.result.unchanged, true);
});

test('edit_file: a 100k-line file edits in reasonable time', async () => {
  const big = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join('\n');
  const ctx = boundCtx({ 'big.txt': big });
  const started = Date.now();
  const rec = await executeTool('edit_file', { path: 'big.txt', old: 'line 99999', new: 'LAST' }, ctx);
  const ms = Date.now() - started;
  assert.equal(rec.ok, true);
  assert.equal(rec.result.replacements, 1);
  // Generous, because CI machines vary — the point is that it is linear, not
  // that it is fast. A quadratic implementation blows straight past this.
  assert.ok(ms < 5000, `edit took ${ms}ms`);
});

test('findAll / closestLine: the two primitives behave', () => {
  assert.deepEqual(findAll('aXbXc', 'X'), [1, 3]);
  assert.deepEqual(findAll('aaaa', 'aa'), [0, 2]); // non-overlapping
  assert.deepEqual(findAll('abc', 'z'), []);
  assert.equal(closestLine('hello world\nsomething else', 'hello wurld').line, 1);
  assert.equal(closestLine('totally unrelated', 'nothing alike at all xyz'), null);
});

// The failure that stopped two Phase 3 tasks dead.
//
// Over half the source files in a Windows checkout are CRLF, and a model writes
// `old` with plain newlines. Matched literally, every multi-line anchor into
// such a file missed — and the message blamed the model ("copy the text from a
// read_file result rather than retyping it") while reporting the nearest line as
// `"/**\r"`, which is line 1 of any file with a header comment. What a worker
// does next is not read more carefully: t-0093 and t-0097 each wrote programs
// that did their own normalisation and edited the file that way, and committed
// seven of them.
test('edit_file: a multi-line anchor written with plain newlines matches a CRLF file', async () => {
  const ctx = boundCtx({ 'a.ts': 'export const A = 1;\r\nexport const B = 2;\r\nexport const C = 3;\r\n' });
  const rec = await executeTool('edit_file', {
    path: 'a.ts',
    old: 'export const A = 1;\nexport const B = 2;',
    new: 'export const A = 1;\nexport const B = 22;'
  }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(read(ctx, 'a.ts'),
    'export const A = 1;\r\nexport const B = 22;\r\nexport const C = 3;\r\n',
    'the edit lands and every line keeps the ending the file already had');
});

test('edit_file: what it writes into a CRLF file is CRLF, even across added lines', async () => {
  const ctx = boundCtx({ 'a.ts': 'first\r\nlast\r\n' });
  const rec = await executeTool('edit_file', { path: 'a.ts', old: 'first', new: 'first\nsecond\nthird' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(read(ctx, 'a.ts'), 'first\r\nsecond\r\nthird\r\nlast\r\n');
});

test('edit_file: an LF file stays LF when the anchor arrives with CRLF', async () => {
  const ctx = boundCtx({ 'a.ts': 'one\ntwo\nthree\n' });
  const rec = await executeTool('edit_file', { path: 'a.ts', old: 'one\r\ntwo', new: 'one\r\nTWO' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(read(ctx, 'a.ts'), 'one\nTWO\nthree\n', 'the file decides, not the anchor');
});

test('edit_file: replaceAll over a CRLF file replaces every match and keeps the endings', async () => {
  const ctx = boundCtx({ 'a.ts': 'x\r\nkeep\r\nx\r\nkeep\r\n' });
  const rec = await executeTool('edit_file', { path: 'a.ts', old: 'x\nkeep', new: 'y\nkeep', replaceAll: true }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(rec.result.replacements, 2);
  assert.equal(read(ctx, 'a.ts'), 'y\r\nkeep\r\ny\r\nkeep\r\n');
});

test('edit_file: a genuine miss in a CRLF file names a real line, not the header', async () => {
  const ctx = boundCtx({ 'a.ts': '/**\r\n * A header.\r\n */\r\nexport const value = 1;\r\n' });
  const rec = await executeTool('edit_file', { path: 'a.ts', old: 'export const value = 2;', new: 'x' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /export const value = 1;/, 'the nearest line is the one actually meant');
  assert.ok(!/\r/.test(rec.error), `and it is not quoted with a stray carriage return: ${rec.error}`);
});

// The mapping back into the original is arithmetic, not a table: an index in
// the normalised view sits that many characters later as there were CRLF pairs
// collapsed before it. That is worth ten times the speed and none of the
// memory of the per-character version it replaced, and it is exactly the kind
// of cleverness that is wrong in one place nobody looks. So it is held against
// the obvious implementation, over strings built to be awkward.
test('origin() agrees with the obvious implementation, everywhere', () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const cases = [
    'no line endings at all',
    LF + LF + LF,
    CR + LF + CR + LF,
    'a' + CR + LF + 'b' + LF + 'c' + CR + LF,          // mixed
    CR + LF + 'leading pair',
    'trailing pair' + CR + LF,
    'lone carriage' + CR + 'return',                    // CR not followed by LF
    CR + CR + LF,                                       // CR then a real pair
    'x' + (CR + LF).repeat(50) + 'y',
    '',
  ];
  for (const text of cases) {
    const { norm, breaks } = normalized(text);
    // The obvious implementation: walk it, and remember where every kept
    // character came from.
    const expect = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === CR && text[i + 1] === LF) { expect.push(i); i++; continue; }
      expect.push(i);
    }
    expect.push(text.length);
    assert.equal(norm.length, expect.length - 1, `norm length for ${JSON.stringify(text)}`);
    for (let i = 0; i <= norm.length; i++) {
      assert.equal(origin(breaks, i), expect[i],
        `index ${i} of ${JSON.stringify(text)}`);
    }
  }
});

test('a file whose every line ending is a lone carriage return is left alone', () => {
  // Old-Mac endings are not a pair, so nothing is collapsed and nothing is
  // rewritten. The anchor has to match them as they are, which is the same
  // contract as before — recorded so a later change notices it is changing it.
  const CR = String.fromCharCode(13);
  const text = 'one' + CR + 'two' + CR + 'three';
  const { norm, breaks } = normalized(text);
  assert.equal(norm, text);
  assert.deepEqual(breaks, []);
});

// --- through the tools, which is where it actually bit ---------------------
//
// The unit tests above prove the interpreter. These prove the tools use it:
// a BOM that made line 1 unmatchable, a UTF-16 file that read as mojibake, and
// a binary file that a read-then-write destroyed.

const bytesOf = (ctx, rel) => fs.readFileSync(path.join(ctx.proj, rel));
const CRLF = String.fromCharCode(13, 10);
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

test('edit_file: an anchor on the first line of a file with a BOM matches', async () => {
  // The mark decodes to an invisible character in front of the first one, so
  // `old: "/**"` could not match however carefully it was copied.
  const before = Buffer.concat([BOM, Buffer.from("/**" + CRLF + " * A header." + CRLF, "utf8")]);
  const ctx = boundCtx({ 'a.ts': before });
  const rec = await executeTool('edit_file', {
    path: 'a.ts', old: '/**\n * A header.', new: '/**\n * A better header.',
  }, ctx);

  assert.equal(rec.ok, true, rec.error);
  const after = bytesOf(ctx, 'a.ts');
  assert.ok(after.subarray(0, 3).equals(BOM), "the mark is a fact about the file and survives");
  assert.equal(after.subarray(3).toString("utf8"), "/**" + CRLF + " * A better header." + CRLF);
});

test('edit_file: a UTF-16 file is edited as text and stays UTF-16', async () => {
  const before = Buffer.concat([Buffer.from([0xFF, 0xFE]),
    Buffer.from("const a = 1;" + CRLF + "const b = 2;" + CRLF, "utf16le")]);
  const ctx = boundCtx({ 'a.ts': before });
  const rec = await executeTool('edit_file', {
    path: 'a.ts', old: 'const b = 2;', new: 'const b = 22;',
  }, ctx);

  assert.equal(rec.ok, true, rec.error);
  const after = bytesOf(ctx, 'a.ts');
  assert.ok(after.subarray(0, 2).equals(Buffer.from([0xFF, 0xFE])), "still UTF-16, still marked");
  assert.equal(after.subarray(2).toString("utf16le"),
    "const a = 1;" + CRLF + "const b = 22;" + CRLF);
});

test('edit_file: a binary file is refused, and not one byte of it moves', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(32, 0xFF)]);
  const ctx = boundCtx({ 'logo.png': png });
  const rec = await executeTool('edit_file', { path: 'logo.png', old: 'IHDR', new: 'XXXX' }, ctx);

  assert.equal(rec.ok, false);
  assert.match(rec.error, /not a text file/);
  assert.ok(bytesOf(ctx, 'logo.png').equals(png), 'the file is exactly as it was');
});

test('read_file: a binary file is reported as binary, not as missing', async () => {
  // It used to read as mojibake, and writing that mojibake back destroyed the
  // file. Refusing to hand it over is what closes that path.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.alloc(40)]);
  const ctx = boundCtx({ 'logo.png': png });
  const rec = await executeTool('read_file', { path: 'logo.png' }, ctx);

  assert.equal(rec.ok, true);
  assert.equal(rec.result.binary, true);
  assert.equal(rec.result.bytes, png.length);
  assert.ok(!("content" in rec.result), "nothing pretends to have read it");
  assert.match(rec.result.note, /not a text file/);
});

test('write_file: replacing a file does not change what the file is', async () => {
  // A model answers in plain newlines whatever the file used. Without the
  // shape, a one-line correction to a CRLF file rewrites every line in it and
  // a file with a BOM quietly loses it.
  const before = Buffer.concat([BOM, Buffer.from("one" + CRLF + "two" + CRLF, "utf8")]);
  const ctx = boundCtx({ 'a.txt': before });
  const rec = await executeTool('write_file', {
    path: 'a.txt', content: 'one\ntwo\nthree\n',
  }, ctx);

  assert.equal(rec.ok, true, rec.error);
  const after = bytesOf(ctx, 'a.txt');
  assert.ok(after.subarray(0, 3).equals(BOM), "the mark survives a whole-file write");
  assert.equal(after.subarray(3).toString("utf8"),
    "one" + CRLF + "two" + CRLF + "three" + CRLF,
    "and so do the line endings the file already used");
});

test('write_file: a brand new file is written exactly as it was given', async () => {
  // Nothing to preserve, so nothing is imposed: the caller decides.
  const ctx = boundCtx({});
  const rec = await executeTool('write_file', { path: 'new.txt', content: 'a\nb\n' }, ctx);
  assert.equal(rec.ok, true, rec.error);
  assert.equal(bytesOf(ctx, 'new.txt').toString('utf8'), 'a\nb\n');
});
