// What a byte stream actually IS, decided in one place.
//
// Every file tool used to answer this question by assumption:
// `fs.readFileSync(p, 'utf8')`, and then hope. Three things went wrong with
// that, in ascending order of how much they cost.
//
// 1. LINE ENDINGS. 77 of the 145 source files in this checkout are CRLF and a
//    model writes plain newlines, so `edit_file` matched nothing on half the
//    repository. That one is fixed in edit_file itself, but it is the same
//    question — what shape is this file — answered privately.
// 2. A BOM. A UTF-8 byte-order mark decodes to a `﻿` sitting in front of
//    the first character, so an anchor on the first line of the file cannot
//    match no matter how carefully it is copied. Invisible in every diff and
//    every error message.
// 3. BINARY. `Buffer.from(buf.toString('utf8'), 'utf8')` is NOT the bytes you
//    started with once any byte is not valid UTF-8. Reading a PNG and writing
//    it back silently destroys it. That is data loss, in a tool a worker calls
//    unattended.
//
// So: one module that reads bytes and says what they are, and that can put a
// string back as the bytes it came from. It is deliberately dependency-free
// (D24) and deliberately prefix-limited — the answer for a 4MB file has to
// cost the same as for a 4KB one, because it is asked on every read.
//
// The contract that matters most: `encode(decode(buf).text, shape)` returns the
// original bytes exactly, for every input, including the ones we could not
// identify. Where we cannot be sure, we fall back to latin1, which maps every
// byte 0-255 to one character and back — so being wrong costs fidelity in what
// the model READS, never in what is written to disk.
import fs from 'node:fs';

/** How much of a file is enough to say what it is. */
export const SNIFF_BYTES = 65536;

const BOM_UTF8 = Buffer.from([0xEF, 0xBB, 0xBF]);
const BOM_UTF16LE = Buffer.from([0xFF, 0xFE]);
const BOM_UTF16BE = Buffer.from([0xFE, 0xFF]);
/** The character a UTF-8 BOM decodes to, which must never reach the model. */
export const BOM_CHAR = String.fromCharCode(0xFEFF);

const CR = 0x0D;
const LF = 0x0A;

/**
 * What a buffer is.
 *
 * @typedef {object} TextShape
 * @property {'utf8'|'utf16le'|'utf16be'|'latin1'} encoding — how to turn bytes into text.
 * @property {boolean} bom — whether a byte-order mark leads the file, kept off the text.
 * @property {boolean} binary — true when this is not text at all and must not be edited.
 * @property {'\n'|'\r\n'|'\r'} eol — the ending it mostly uses; '\n' when it has none.
 * @property {boolean} mixedEol — it uses more than one, so "the" ending is a majority verdict.
 * @property {boolean} finalNewline — it ends with one.
 */

/**
 * Read the bytes and say what they are. Never throws.
 *
 * Order matters and is cheapest-first: a BOM is three bytes, a NUL scan is one
 * pass over a prefix, and the UTF-8 check is native. Nothing here looks at the
 * whole file unless the file is small.
 *
 * @param {Buffer} buf
 * @returns {TextShape}
 */
export function sniff(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const head = b.length > SNIFF_BYTES ? b.subarray(0, SNIFF_BYTES) : b;

  // A BOM is a statement by whoever wrote the file, and it outranks a guess.
  if (b.length >= 3 && b.subarray(0, 3).equals(BOM_UTF8)) {
    return { ...eolOf(decodeBody(b, 'utf8', 3)), encoding: 'utf8', bom: true, binary: false };
  }
  // UTF-32's BOM starts with UTF-16LE's. Check the longer one first, and refuse
  // it: we do not decode UTF-32, and calling it UTF-16 would produce confident
  // nonsense.
  if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xFE && b[2] === 0x00 && b[3] === 0x00) {
    return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
  }
  // A UTF-16 body with an odd number of bytes is malformed: the last byte is
  // half a code unit, `toString('utf16le')` drops it, and nothing we write back
  // can put it there again. Refusing beats a lossy read of a corrupt file —
  // the one thing this module may not do is lose a byte.
  if (b.length >= 2 && b.subarray(0, 2).equals(BOM_UTF16LE)) {
    if (b.length % 2 !== 0) {
      return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
    }
    return { ...eolOf(decodeBody(b, 'utf16le', 2)), encoding: 'utf16le', bom: true, binary: false };
  }
  if (b.length >= 2 && b.subarray(0, 2).equals(BOM_UTF16BE)) {
    if (b.length % 2 !== 0) {
      return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
    }
    return { ...eolOf(decodeBody(b, 'utf16be', 2)), encoding: 'utf16be', bom: true, binary: false };
  }

  // No BOM. A NUL byte is the fork: text does not contain them, but UTF-16
  // without a BOM is half NULs and is text.
  const nul = head.indexOf(0);
  if (nul !== -1) {
    const wide = wideness(head);
    if (wide && b.length % 2 === 0) {
      return { ...eolOf(decodeBody(b, wide, 0)), encoding: wide, bom: false, binary: false };
    }
    return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
  }

  if (validUtf8(head, b.length > head.length)) {
    return { ...eolOf(decodeBody(b, 'utf8', 0)), encoding: 'utf8', bom: false, binary: false };
  }

  // Not valid UTF-8 and no NULs. That is either a legacy single-byte encoding —
  // which is text — or a compressed or binary format that happens not to have
  // hit a NUL in its first bytes. Control characters tell them apart: prose in
  // any encoding has almost none, and a binary format is full of them.
  if (controlHeavy(head)) {
    return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
  }

  // Latin1 reads a legacy encoding without loss and writes it back byte for
  // byte. The text may show the wrong letters for bytes above 0x7F; the file on
  // disk stays correct, which is the half worth protecting.
  return { ...eolOf(decodeBody(b, 'latin1', 0)), encoding: 'latin1', bom: false, binary: false };
}

/**
 * Bytes to text, with the shape that puts it back.
 *
 * The BOM is stripped from the text and remembered in the shape. It is a fact
 * about the FILE, not a character in it, and leaving it in the string is how an
 * anchor on the first line of a file becomes impossible to match.
 *
 * @param {Buffer} buf
 * @returns {{ text: string, shape: TextShape }}
 */
export function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const shape = sniff(b);
  if (shape.binary) return { text: '', shape, bytes: b.length };
  const skip = shape.bom ? (shape.encoding === 'utf8' ? 3 : 2) : 0;
  return { text: decodeBody(b, shape.encoding, skip), shape, bytes: b.length };
}

/**
 * Text back to bytes, in the shape it came from.
 *
 * `encode(decode(buf).text, shape)` must equal `buf` for anything that is not
 * binary. That is the property the tests hold this to, over BOMs, over UTF-16,
 * and over bytes no encoding claims.
 *
 * @param {string} text
 * @param {TextShape} shape
 * @returns {Buffer}
 */
export function encode(text, shape) {
  const s = String(text ?? '');
  const encoding = shape?.encoding ?? 'utf8';
  const body = encoding === 'utf16be'
    ? swap16(Buffer.from(s, 'utf16le'))
    : Buffer.from(s, encoding === 'latin1' ? 'latin1' : encoding);
  if (!shape?.bom) return body;
  const mark = encoding === 'utf8' ? BOM_UTF8 : encoding === 'utf16be' ? BOM_UTF16BE : BOM_UTF16LE;
  return Buffer.concat([mark, body]);
}

/**
 * Rewrite `text` to use one line ending throughout.
 *
 * Used when replacing a whole file, so a model that answers in plain newlines
 * does not silently convert a CRLF file. Not used when splicing part of one:
 * there, only the inserted text is converted, and every untouched line keeps
 * the bytes it had — including in a file that is already inconsistent.
 */
export function toEol(text, eol) {
  const flat = String(text ?? '').split('\r\n').join('\n').split('\r').join('\n');
  return eol === '\n' ? flat : flat.split('\n').join(eol);
}

/** Read a file and say what it is. Returns null when there is no file. */
export function readFileShaped(absPath) {
  let buf;
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    buf = fs.readFileSync(absPath);
  } catch { return null; }
  return decode(buf);
}

// --- the parts ------------------------------------------------------------

function decodeBody(b, encoding, skip) {
  const body = skip ? b.subarray(skip) : b;
  if (encoding === 'utf16be') return swap16(Buffer.from(body)).toString('utf16le');
  return body.toString(encoding === 'latin1' ? 'latin1' : encoding);
}

// Buffer.swap16 throws on an odd length, which a truncated or malformed file
// has. Copy the whole pairs and leave a trailing odd byte where it is: the
// alternative is throwing out of a reader, and a reader that throws is how a
// run dies on a file nobody cared about.
function swap16(buf) {
  const out = Buffer.from(buf);
  const end = out.length - (out.length % 2);
  for (let i = 0; i < end; i += 2) {
    const t = out[i];
    out[i] = out[i + 1];
    out[i + 1] = t;
  }
  return out;
}

/**
 * Is this UTF-16 without a BOM, and which way round?
 *
 * ASCII text in UTF-16 is every other byte NUL, so the giveaway is not that
 * NULs exist but that they are all on one side of the pair. A single NUL in the
 * middle of otherwise dense bytes is a binary file, and this says so by
 * returning null.
 */
function wideness(head) {
  if (head.length < 4) return null;
  const end = head.length - (head.length % 2);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < end; i += 2) {
    if (head[i] === 0) even++;
    if (head[i + 1] === 0) odd++;
  }
  const pairs = end / 2;
  // Two thirds is enough: real UTF-16 text is nearly all ASCII in one lane, and
  // demanding all of it would fail on the first accented character.
  if (odd > pairs * 0.66 && even < pairs * 0.1) return 'utf16le';
  if (even > pairs * 0.66 && odd < pairs * 0.1) return 'utf16be';
  return null;
}

/**
 * Is this dense with characters that text does not contain?
 *
 * The C0 controls, minus the four that appear in real files — tab, newline,
 * carriage return and form feed — plus DEL. Prose in any single-byte encoding
 * has essentially none of these; a compressed or binary format is made of them.
 * A third is a deliberately generous line: the cost of calling a text file
 * binary is that a tool refuses to edit it, which is annoying, and the cost of
 * calling a binary file text is that a tool destroys it.
 */
function controlHeavy(head) {
  if (!head.length) return false;
  let odd = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if ((c < 0x09 || (c > 0x0D && c < 0x20)) || c === 0x7F) odd++;
  }
  return odd / head.length > 0.3;
}

/**
 * Is this valid UTF-8?
 *
 * TextDecoder in fatal mode is native and does the whole table — the
 * continuation bytes, the overlong forms, the surrogate range — which a
 * hand-rolled check gets subtly wrong and then trusts. When the buffer is a
 * PREFIX of a longer file, a failure in the last three bytes is a multi-byte
 * character cut in half by the prefix rather than a bad file, so it is retried
 * without them.
 */
function validUtf8(head, truncated) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(head);
    return true;
  } catch {
    if (!truncated || head.length < 4) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3));
    return true;
  } catch { return false; }
}

/**
 * Which line ending it uses, and whether it is consistent.
 *
 * Counted over the text rather than the bytes so it is one answer for every
 * encoding. A file with none at all is called '\n': something has to be chosen
 * for the first ending anybody adds, and on a one-line file it is unknowable.
 */
function eolOf(text) {
  const s = String(text ?? '');
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CR) {
      if (s.charCodeAt(i + 1) === LF) { crlf++; i++; } else cr++;
    } else if (c === LF) lf++;
  }
  const most = Math.max(crlf, lf, cr);
  const eol = most === 0 ? '\n' : crlf === most ? '\r\n' : lf === most ? '\n' : '\r';
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  return {
    eol,
    mixedEol: kinds > 1,
    finalNewline: s.length > 0 && (s.endsWith('\n') || s.endsWith('\r')),
  };
}
