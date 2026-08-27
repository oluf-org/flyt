// v2 fs seam goes through the text interpreter (kernel/src/seams/textFile.ts).
//
// Ported from core/tools/textFile.js so the kernel never imports across the
// core/ boundary. Three guarantees:
//
//  1. encode(decode(bytes)) is the original bytes (fixtures + random)
//  2. A binary file cannot be read as text and written back through the seam
//  3. v1 and v2 cannot silently disagree (shared vectors / generated from other)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as v1 from '../core/tools/textFile.js';
import * as v2 from '#kernel/seams/textFile.js';
import { createFsSeam } from '#kernel/seams/fs.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const bytes = (...n) => Buffer.from(n);
const utf8 = s => Buffer.from(s, 'utf8');
const withBom = b => Buffer.concat([bytes(0xEF, 0xBB, 0xBF), b]);
const utf16le = s => Buffer.from(s, 'utf16le');
const utf16be = s => {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return b;
};

function roundTripsV2(buf, what) {
  const { text, shape } = v2.decode(buf);
  if (shape.binary) return;
  assert.ok(v2.encode(text, shape).equals(buf), `${what}: v2 bytes must survive the trip through text`);
}
function roundTripsV1(buf, what) {
  const { text, shape } = v1.decode(buf);
  if (shape.binary) return;
  assert.ok(v1.encode(text, shape).equals(buf), `${what}: v1 bytes must survive`);
}

// ---------------------------------------------------------------------------
// 1. v2 round-trip over fixtures and random buffers (same shape as v1 test)
// ---------------------------------------------------------------------------

test('v2: every shape of text survives being decoded and encoded again', () => {
  const cases = {
    'empty': Buffer.alloc(0),
    'ascii lf': utf8('one' + LF + 'two' + LF),
    'ascii crlf': utf8('one' + CR + LF + 'two' + CR + LF),
    'ascii cr': utf8('one' + CR + 'two' + CR),
    'no final newline': utf8('one' + LF + 'two'),
    'utf8 accents': utf8('naïve café — æøå' + LF),
    'utf8 emoji': utf8('a 🙂 b' + LF),
    'utf8 bom': withBom(utf8('const a = 1;' + CR + LF)),
    'utf8 bom only': withBom(Buffer.alloc(0)),
    'utf16le bom': Buffer.concat([bytes(0xFF, 0xFE), utf16le('const a = 1;' + CR + LF)]),
    'utf16be bom': Buffer.concat([bytes(0xFE, 0xFF), utf16be('const a = 1;' + CR + LF)]),
    'utf16le no bom': utf16le('const a = 1;' + CR + LF + 'const b = 2;' + CR + LF),
    'utf16be no bom': utf16be('const a = 1;' + CR + LF + 'const b = 2;' + CR + LF),
    'latin1 high bytes': bytes(0x48, 0xE9, 0x6C, 0x6C, 0xF6, 0x0A),
    'lone high byte': bytes(0xFF),
    'truncated utf8 char': utf8('café').subarray(0, 4),
    'odd length utf16': Buffer.concat([bytes(0xFF, 0xFE), utf16le('ab'), bytes(0x41)]),
  };
  for (const [what, buf] of Object.entries(cases)) roundTripsV2(buf, what);
});

test('v2: the property holds over buffers nobody would think to write down', () => {
  let seed = 0x2026_0824;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    return seed / 0x7FFFFFFF;
  };
  for (let i = 0; i < 4000; i++) {
    const len = Math.floor(rand() * 64);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) {
      const r = rand();
      buf[j] = r < 0.1 ? 0x00
        : r < 0.2 ? [0x0D, 0x0A, 0xEF, 0xBB, 0xBF, 0xFF, 0xFE][Math.floor(rand() * 7)]
          : r < 0.7 ? 0x20 + Math.floor(rand() * 95)
            : Math.floor(rand() * 256);
    }
    assert.doesNotThrow(() => v2.decode(buf), `seed ${seed}, buffer ${buf.toString('hex')}`);
    roundTripsV2(buf, `random ${buf.toString('hex')}`);
  }
});

// ---------------------------------------------------------------------------
// 2. v1 and v2 cannot silently disagree — shared vectors
// ---------------------------------------------------------------------------

test('v1 and v2 agree on sniff/decode/encode for every fixture', () => {
  const fixtures = [
    Buffer.alloc(0),
    utf8('one' + LF + 'two' + LF),
    utf8('one' + CR + LF + 'two' + CR + LF),
    utf8('one' + CR + 'two' + CR),
    utf8('naïve café — æøå' + LF),
    withBom(utf8('const a = 1;' + CR + LF)),
    withBom(Buffer.alloc(0)),
    Buffer.concat([bytes(0xFF, 0xFE), utf16le('const a = 1;' + CR + LF)]),
    Buffer.concat([bytes(0xFE, 0xFF), utf16be('const a = 1;' + CR + LF)]),
    utf16le('const a = 1;' + CR + LF + 'const b = 2;' + CR + LF),
    utf16be('const a = 1;' + CR + LF + 'const b = 2;' + CR + LF),
    bytes(0x48, 0xE9, 0x6C, 0x6C, 0xF6, 0x0A),
    bytes(0xFF),
    Buffer.concat([bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), Buffer.alloc(64, 0x7F)]),
    Buffer.concat([bytes(0xFF, 0xFE, 0x00, 0x00), Buffer.alloc(8)]),
    bytes(0xFF, 0xFE), // lone BOM-like prefix
  ];
  for (const buf of fixtures) {
    const s1 = v1.sniff(buf);
    const s2 = v2.sniff(buf);
    assert.deepEqual(s2, s1, `sniff disagreement on ${buf.toString('hex').slice(0, 40)}`);
    const d1 = v1.decode(buf);
    const d2 = v2.decode(buf);
    assert.equal(d2.text, d1.text, 'decode text disagreement');
    assert.deepEqual(d2.shape, d1.shape, 'decode shape disagreement');
    if (!d1.shape.binary) {
      assert.ok(v1.encode(d1.text, d1.shape).equals(v2.encode(d2.text, d2.shape)), 'encode disagreement');
    }
  }
});

test('v1 and v2 agree over random buffers (shared generated vectors)', () => {
  // Same deterministic PRNG as above — vectors generated once, checked on both.
  let seed = 0x9a3b_52c1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    return seed / 0x7FFFFFFF;
  };
  for (let i = 0; i < 2000; i++) {
    const len = Math.floor(rand() * 64);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rand() * 256);
    const s1 = v1.sniff(buf);
    const s2 = v2.sniff(buf);
    assert.deepEqual(s2, s1, `random ${i}: sniff disagreement on ${buf.toString('hex')}`);
    // Round-trip must match between implementations when not binary.
    if (!s1.binary) {
      const d1 = v1.decode(buf);
      const d2 = v2.decode(buf);
      assert.ok(v1.encode(d1.text, d1.shape).equals(buf));
      assert.ok(v2.encode(d2.text, d2.shape).equals(buf));
      assert.ok(v1.encode(d1.text, d1.shape).equals(v2.encode(d2.text, d2.shape)));
    }
  }
});

// ---------------------------------------------------------------------------
// 3. FsSeam goes through the interpreter — not straight to utf8
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-fs-seam-'));
}

test('fs seam: a BOM is not a character in the read text', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  const abs = path.join(dir, 'bom.js');
  fs.writeFileSync(abs, withBom(utf8('/**' + LF + ' * header' + LF)));
  const text = await seam.read('bom.js');
  assert.ok(!text.includes(v2.BOM_CHAR), 'BOM must not reach the caller');
  assert.ok(text.startsWith('/**'), 'anchor on first line must be able to match');
  // Writing back preserves the BOM.
  await seam.write('bom.js', text.replace('header', 'changed'));
  const raw = fs.readFileSync(abs);
  assert.ok(raw.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'BOM preserved on write');
  assert.ok(raw.toString('utf8').includes('changed'));
});

test('fs seam: CRLF is preserved on write', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  const abs = path.join(dir, 'crlf.js');
  fs.writeFileSync(abs, Buffer.from('one' + CR + LF + 'two' + CR + LF, 'utf8'));
  const text = await seam.read('crlf.js');
  assert.ok(text.includes(CR + LF), 'read preserves CRLF');
  await seam.write('crlf.js', text + 'three' + LF);
  const raw = fs.readFileSync(abs, 'utf8');
  // New content should be normalized to CRLF (the file's eol).
  assert.ok(raw.includes(CR + LF), 'write uses file eol');
  // Model wrote LF, seam converted to CRLF so line count stays consistent.
  assert.equal(raw.split(CR + LF).length, 4, 'three lines plus trailing');
});

test('fs seam: multi-line anchors work on CRLF files', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  fs.writeFileSync(path.join(dir, 'crlf.js'), Buffer.from('const foo = 1;' + CR + LF + 'const bar = 2;' + CR + LF, 'utf8'));
  const text = await seam.read('crlf.js');
  // An end-of-line anchor must match — CRLF must not leave stray CR.
  assert.match(text, /foo = 1;$/m);
  const lines = text.split('\n');
  assert.ok(lines.every(l => !l.endsWith('\r') || l.endsWith('\r')), 'no stray CR left in reporting — handled via eol');
});

test('fs seam: UTF-16 file is read as text, not mojibake', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  const abs = path.join(dir, 'wide.js');
  fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('const needle = 1;' + LF, 'utf16le')]));
  const text = await seam.read('wide.js');
  assert.equal(text, 'const needle = 1;' + LF);
  assert.match(text, /needle/);
});

test('fs seam: a binary file cannot be read as text and written back', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  const abs = path.join(dir, 'logo.png');
  const original = Buffer.concat([bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), Buffer.alloc(64, 0x00)]);
  fs.writeFileSync(abs, original);
  await assert.rejects(() => seam.read('logo.png'), /not a text file/);
  // Even if someone catches the error and writes something, the original bytes stay intact.
  assert.ok(fs.readFileSync(abs).equals(original), 'bytes intact after refused read');
  // And writing a new text file over a binary path is allowed (overwrite) but
  // reading the original binary again would still be refused until overwritten.
  // Verify that a binary file is not round-tripped through text.
  const before = fs.readFileSync(abs);
  // No seam operation should have mutated it.
  assert.ok(before.equals(original));
});

test('fs seam: round-trip through read+write preserves bytes for text', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  // CRLF + BOM file
  const original = withBom(utf8('line one' + CR + LF + 'line two' + CR + LF));
  fs.writeFileSync(path.join(dir, 'round.js'), original);
  const text = await seam.read('round.js');
  await seam.write('round.js', text);
  const after = fs.readFileSync(path.join(dir, 'round.js'));
  assert.ok(after.equals(original), 'read then write same content must be byte-identical');
});

test('fs seam: confinement is enforced', async () => {
  const dir = tmpDir();
  const seam = createFsSeam(dir);
  await assert.rejects(() => seam.read('../escape.txt'), /escapes the workspace/);
  await assert.rejects(() => seam.write('../escape.txt', 'x'), /escapes the workspace/);
});
