/**
 * What a byte stream actually IS, decided in one place — v2 kernel port.
 *
 * Ported from `core/tools/textFile.js` (the v1 single source of truth) into
 * `kernel/src` so the v2 kernel never imports across the `core/` boundary
 * (the boundary the v2 rebuild exists to draw). The two modules must not
 * silently disagree: a shared test vector covers both.
 *
 * Every file tool used to answer this question by assumption:
 * `fs.readFileSync(p, 'utf8')`, and then hope. Three things went wrong with
 * that, in ascending order of how much they cost.
 *
 * 1. LINE ENDINGS. 77 of the 145 source files in this checkout are CRLF and a
 *    model writes plain newlines, so `edit_file` matched nothing on half the
 *    repository.
 * 2. A BOM. A UTF-8 byte-order mark decodes to a `U+FEFF` sitting in front of
 *    the first character, so an anchor on the first line cannot match.
 * 3. BINARY. `Buffer.from(buf.toString('utf8'), 'utf8')` is NOT the bytes you
 *    started with once any byte is not valid UTF-8.
 *
 * So: one module that reads bytes and says what they are, and that can put a
 * string back as the bytes it came from. Dependency-free and prefix-limited.
 *
 * The contract that matters most: `encode(decode(buf).text, shape)` returns the
 * original bytes exactly, for every input, including the ones we could not
 * identify.
 *
 * @module #kernel/seams/textFile
 */

import fs from 'node:fs';

/** How much of a file is enough to say what it is. */
export const SNIFF_BYTES = 65536;

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);
/** The character a UTF-8 BOM decodes to, which must never reach the model. */
export const BOM_CHAR = String.fromCharCode(0xfeff);

const CR = 0x0d;
const LF = 0x0a;

export type Encoding = 'utf8' | 'utf16le' | 'utf16be' | 'latin1';
export type Eol = '\n' | '\r\n' | '\r';

export interface TextShape {
  encoding: Encoding;
  bom: boolean;
  binary: boolean;
  eol: Eol;
  mixedEol: boolean;
  finalNewline: boolean;
}

export interface Decoded {
  text: string;
  shape: TextShape;
  bytes: number;
}

/**
 * Read the bytes and say what they are. Never throws.
 */
export function sniff(buf: Buffer | Uint8Array | unknown): TextShape {
  const b = Buffer.isBuffer(buf) ? (buf as Buffer) : Buffer.from((buf as Uint8Array) ?? []);
  const head = b.length > SNIFF_BYTES ? b.subarray(0, SNIFF_BYTES) : b;

  if (b.length >= 3 && b.subarray(0, 3).equals(BOM_UTF8)) {
    return { ...eolOf(decodeBody(b, 'utf8', 3)), encoding: 'utf8', bom: true, binary: false };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xfe && b[2] === 0x00 && b[3] === 0x00) {
    return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
  }
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

  if (controlHeavy(head)) {
    return { encoding: 'latin1', bom: false, binary: true, eol: '\n', mixedEol: false, finalNewline: false };
  }

  return { ...eolOf(decodeBody(b, 'latin1', 0)), encoding: 'latin1', bom: false, binary: false };
}

/**
 * Bytes to text, with the shape that puts it back.
 */
export function decode(buf: Buffer | Uint8Array | unknown): Decoded {
  const b = Buffer.isBuffer(buf) ? (buf as Buffer) : Buffer.from((buf as Uint8Array) ?? []);
  const shape = sniff(b);
  if (shape.binary) return { text: '', shape, bytes: b.length };
  const skip = shape.bom ? (shape.encoding === 'utf8' ? 3 : 2) : 0;
  return { text: decodeBody(b, shape.encoding, skip), shape, bytes: b.length };
}

/**
 * Text back to bytes, in the shape it came from.
 */
export function encode(text: string | unknown, shape: TextShape | null | undefined): Buffer {
  const s = String(text ?? '');
  const encoding = shape?.encoding ?? 'utf8';
  const body =
    encoding === 'utf16be' ? swap16(Buffer.from(s, 'utf16le')) : Buffer.from(s, encoding === 'latin1' ? 'latin1' : encoding);
  if (!shape?.bom) return body;
  const mark = encoding === 'utf8' ? BOM_UTF8 : encoding === 'utf16be' ? BOM_UTF16BE : BOM_UTF16LE;
  return Buffer.concat([mark, body]);
}

/**
 * Rewrite `text` to use one line ending throughout.
 */
export function toEol(text: string | unknown, eol: Eol): string {
  const flat = String(text ?? '')
    .split('\r\n')
    .join('\n')
    .split('\r')
    .join('\n');
  return eol === '\n' ? flat : flat.split('\n').join(eol);
}

/** Read a file and say what it is. Returns null when there is no file. */
export function readFileShaped(absPath: string): Decoded | null {
  let buf: Buffer;
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    buf = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  return decode(buf);
}

// --- internals ---

function decodeBody(b: Buffer, encoding: Encoding, skip: number): string {
  const body = skip ? b.subarray(skip) : b;
  if (encoding === 'utf16be') return swap16(Buffer.from(body)).toString('utf16le');
  return body.toString(encoding === 'latin1' ? 'latin1' : encoding);
}

function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  const end = out.length - (out.length % 2);
  for (let i = 0; i < end; i += 2) {
    const t = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = t;
  }
  return out;
}

function wideness(head: Buffer): Encoding | null {
  if (head.length < 4) return null;
  const end = head.length - (head.length % 2);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < end; i += 2) {
    if (head[i] === 0) even++;
    if (head[i + 1] === 0) odd++;
  }
  const pairs = end / 2;
  if (odd > pairs * 0.66 && even < pairs * 0.1) return 'utf16le';
  if (even > pairs * 0.66 && odd < pairs * 0.1) return 'utf16be';
  return null;
}

function controlHeavy(head: Buffer): boolean {
  if (!head.length) return false;
  let odd = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i]!;
    if ((c < 0x09 || (c > 0x0d && c < 0x20)) || c === 0x7f) odd++;
  }
  return odd / head.length > 0.3;
}

function validUtf8(head: Buffer, truncated: boolean): boolean {
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
  } catch {
    return false;
  }
}

function eolOf(text: string): Pick<TextShape, 'eol' | 'mixedEol' | 'finalNewline'> {
  const s = String(text ?? '');
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CR) {
      if (s.charCodeAt(i + 1) === LF) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === LF) lf++;
  }
  const most = Math.max(crlf, lf, cr);
  const eol: Eol = most === 0 ? '\n' : crlf === most ? '\r\n' : lf === most ? '\n' : '\r';
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  return {
    eol,
    mixedEol: kinds > 1,
    finalNewline: s.length > 0 && (s.endsWith('\n') || s.endsWith('\r')),
  };
}
