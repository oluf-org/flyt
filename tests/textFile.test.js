// What a byte stream actually is (core/tools/textFile.js).
//
// One property carries most of this file: `encode(decode(buf).text, shape)`
// must give back exactly `buf`. Everything the file tools do rests on it —
// `edit_file` splices a string and writes the result, `write_file` replaces
// one, and if the trip through text is not lossless then both of them corrupt
// files by simply touching them. It used to: `Buffer.from(buf.toString('utf8'),
// 'utf8')` is not the bytes you started with the moment any byte is not valid
// UTF-8, so reading a PNG and writing it back destroyed it.
//
// So the property is tested over fixtures AND over several thousand random
// buffers, because the inputs that break this kind of code are the ones nobody
// thinks to write down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniff, decode, encode, toEol, BOM_CHAR, SNIFF_BYTES } from '../core/tools/textFile.js';

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

/** The whole point, as a function, so every case can be held to it. */
function roundTrips(buf, what) {
  const { text, shape } = decode(buf);
  if (shape.binary) return; // binary is refused, not round-tripped through text
  assert.ok(encode(text, shape).equals(buf), `${what}: bytes must survive the trip through text`);
}

// --- the property ----------------------------------------------------------

test('every shape of text survives being decoded and encoded again', () => {
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
  for (const [what, buf] of Object.entries(cases)) roundTrips(buf, what);
});

test('the property holds over buffers nobody would think to write down', () => {
  // A deterministic PRNG, so a failure is reproducible from the seed rather
  // than being a story about a build that went red once.
  let seed = 0x2026_0824;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    return seed / 0x7FFFFFFF;
  };
  for (let i = 0; i < 4000; i++) {
    const len = Math.floor(rand() * 64);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) {
      // Weighted toward the bytes that decide things: NUL, CR, LF, BOM parts,
      // ASCII, and continuation bytes.
      const r = rand();
      buf[j] = r < 0.1 ? 0x00
        : r < 0.2 ? [0x0D, 0x0A, 0xEF, 0xBB, 0xBF, 0xFF, 0xFE][Math.floor(rand() * 7)]
          : r < 0.7 ? 0x20 + Math.floor(rand() * 95)
            : Math.floor(rand() * 256);
    }
    assert.doesNotThrow(() => decode(buf), `seed ${seed}, buffer ${buf.toString('hex')}`);
    roundTrips(buf, `random ${buf.toString('hex')}`);
  }
});

test('sniff never throws, whatever it is handed', () => {
  for (const odd of [null, undefined, Buffer.alloc(0), bytes(0), bytes(0xFF), bytes(0xFF, 0xFE),
    bytes(0xEF), bytes(0xEF, 0xBB), bytes(0xFE), 'a string', [1, 2, 3]]) {
    assert.doesNotThrow(() => sniff(odd), `sniff(${JSON.stringify(odd)})`);
  }
});

// --- what it says ----------------------------------------------------------

test('a BOM is a fact about the file, never a character in it', () => {
  const { text, shape } = decode(withBom(utf8('/**' + LF + ' * A header.' + LF)));
  assert.equal(shape.bom, true);
  assert.equal(shape.encoding, 'utf8');
  assert.ok(!text.includes(BOM_CHAR), 'the mark must not reach the model');
  assert.ok(text.startsWith('/**'),
    'an anchor on the first line of the file has to be able to match it');
});

test('UTF-16 is read as text, not as mojibake', () => {
  const { text, shape } = decode(utf16le('const a = 1;' + CR + LF));
  assert.equal(shape.encoding, 'utf16le');
  assert.equal(shape.binary, false);
  assert.equal(text, 'const a = 1;' + CR + LF, 'not a NUL between every letter');
});

test('big-endian UTF-16 is not read back to front', () => {
  const { text, shape } = decode(Buffer.concat([bytes(0xFE, 0xFF), utf16be('hello' + LF)]));
  assert.equal(shape.encoding, 'utf16be');
  assert.equal(text, 'hello' + LF);
});

test('a binary file is named as one rather than decoded into nonsense', () => {
  const png = Buffer.concat([bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), Buffer.alloc(64, 0x7F)]);
  const shape = sniff(png);
  assert.equal(shape.binary, true, 'a PNG is not text');
  assert.equal(decode(png).text, '', 'and nothing pretends to have read it');
});

test('UTF-32 is refused rather than mistaken for UTF-16', () => {
  // Its BOM starts with UTF-16LE's, and calling it UTF-16 produces confident
  // nonsense rather than an error.
  const shape = sniff(Buffer.concat([bytes(0xFF, 0xFE, 0x00, 0x00), Buffer.alloc(8)]));
  assert.equal(shape.binary, true);
});

test('a lone NUL in dense bytes is binary, not UTF-16', () => {
  const buf = Buffer.concat([utf8('a'.repeat(60)), bytes(0x00), utf8('b'.repeat(60))]);
  assert.equal(sniff(buf).binary, true, 'one NUL is not half a wide encoding');
});

test('bytes no encoding claims are read losslessly rather than refused', () => {
  // Latin-1 maps every byte to a character and back. The letters may be wrong;
  // the file on disk stays right, which is the half worth protecting.
  const buf = bytes(0x48, 0xE9, 0x6C, 0x6C, 0xF6, 0x0A);
  const { text, shape } = decode(buf);
  assert.equal(shape.encoding, 'latin1');
  assert.equal(shape.binary, false);
  assert.ok(encode(text, shape).equals(buf));
});

test('a multi-byte character cut in half by the prefix is not a bad file', () => {
  // The sniff only reads the first 64KB, so a character straddling that
  // boundary must not make a perfectly good UTF-8 file read as latin1.
  const filler = 'a'.repeat(SNIFF_BYTES - 1);
  const buf = utf8(filler + '🙂' + 'b'.repeat(100));
  assert.equal(sniff(buf).encoding, 'utf8');
});

// --- line endings ----------------------------------------------------------

test('it says which ending the file uses, and when it is inconsistent', () => {
  const shapes = {
    lf: sniff(utf8('a' + LF + 'b' + LF)),
    crlf: sniff(utf8('a' + CR + LF + 'b' + CR + LF)),
    cr: sniff(utf8('a' + CR + 'b' + CR)),
    mixed: sniff(utf8('a' + CR + LF + 'b' + LF + 'c' + LF)),
    none: sniff(utf8('one line, no ending')),
  };
  assert.equal(shapes.lf.eol, LF);
  assert.equal(shapes.crlf.eol, CR + LF);
  assert.equal(shapes.cr.eol, CR);
  assert.equal(shapes.mixed.eol, LF, 'the majority, when there is one');
  assert.equal(shapes.mixed.mixedEol, true, 'and it says the majority is all it is');
  assert.equal(shapes.none.eol, LF, 'something has to be chosen for the first one added');
  assert.equal(shapes.none.mixedEol, false);
});

test('it says whether the file ends with a newline', () => {
  assert.equal(sniff(utf8('a' + LF)).finalNewline, true);
  assert.equal(sniff(utf8('a')).finalNewline, false);
  assert.equal(sniff(Buffer.alloc(0)).finalNewline, false);
});

test('toEol rewrites every ending, from whatever mixture it finds', () => {
  const messy = 'a' + CR + LF + 'b' + LF + 'c' + CR + 'd';
  assert.equal(toEol(messy, LF), 'a' + LF + 'b' + LF + 'c' + LF + 'd');
  assert.equal(toEol(messy, CR + LF), 'a' + CR + LF + 'b' + CR + LF + 'c' + CR + LF + 'd');
  assert.equal(toEol('', LF), '');
});

// --- the cost --------------------------------------------------------------

test('the answer costs the same for a large file as for a small one', () => {
  // It is asked on every read, so it is prefix-limited by design. A 12MB file
  // must not cost meaningfully more than the prefix it looks at.
  const big = utf8(('const value = 1;' + CR + LF).repeat(700000));
  assert.ok(big.length > 12_000_000, `the fixture is big enough: ${big.length}`);
  const started = Date.now();
  const shape = sniff(big);
  const ms = Date.now() - started;
  assert.equal(shape.encoding, 'utf8');
  assert.equal(shape.eol, CR + LF);
  assert.ok(ms < 1500, `sniffing 12MB took ${ms}ms`);
});
