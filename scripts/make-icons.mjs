// Build the packaged app icons from the same geometry the in-app mark uses
// (src/logo.js). `npm run icons`.
//
// Why a hand-rolled rasterizer instead of a library: the DSL's zero-dependency
// rule (D24) is about the runtime, but adding sharp/resvg to devDependencies to
// draw eleven lines and two circles is a poor trade — a native build step on
// three platforms for a file that changes when the logo does, which is
// approximately never. The mark is strokes and discs; both have exact
// signed-distance functions, so a supersampled coverage pass gives clean
// antialiasing in ~60 lines and stays honest to the SVG by construction.
//
// The app icon is the ONE place `currentColor` cannot apply — a PNG has to bake
// a colour in. Sage (--accent) on transparent, matching the mark's colour
// everywhere else in the app.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { logoGeometry } from '../src/logo.js';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const COLOR = [0x5b, 0x8c, 0x6e];   // sage #5b8c6e
const SS = 4;                        // supersampling factor per axis

// --- Rasterizer ----------------------------------------------------------
// Distance from point p to segment ab; the round-capped stroke is exactly the
// set of points within strokeWidth/2 of the segment, so coverage is a single
// distance test. Same for a disc. No path filling, no scanline conversion.
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// RGBA buffer, premultiplied-free straight alpha, transparent background.
function rasterize(size) {
  const g = logoGeometry(size);
  const half = g.strokeWidth / 2;
  const shapes = [
    ...g.rays.map(r => p => distToSegment(p.x, p.y, r.x0, r.y0, r.x1, r.y1) <= half),
    ...g.dots.map(d => p => Math.hypot(p.x - d.x, p.y - d.y) <= d.r),
    p => Math.hypot(p.x - g.centre.x, p.y - g.centre.y) <= g.centre.r
  ];
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = { x: x + (sx + 0.5) * step, y: y + (sy + 0.5) * step };
          if (shapes.some(inside => inside(p))) hits++;
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      rgba[i] = COLOR[0]; rgba[i + 1] = COLOR[1]; rgba[i + 2] = COLOR[2];
      rgba[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return rgba;
}

// --- PNG encoder ---------------------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  // Filter type 0 (None) on every scanline: the image is mostly flat colour
  // with a varying alpha, and zlib handles it fine without per-line heuristics.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- Containers ----------------------------------------------------------
// ICO: a directory of entries, each pointing at an embedded PNG. Vista+ accepts
// PNG payloads directly, which is why no BMP encoder is needed here.
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;     // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                          // palette size
    e[3] = 0;                          // reserved
    e.writeUInt16LE(1, 4);             // colour planes
    e.writeUInt16LE(32, 6);            // bits per pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

// ICNS: 'icns' magic + total length, then typed chunks. The ic07..ic10 and
// ic11..ic14 families take PNG data verbatim, so this is pure containering.
const ICNS_TYPES = {
  16: 'icp4', 32: 'icp5', 64: 'icp6',
  128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10'
};
function encodeIcns(pngs) {
  const chunks = [];
  for (const { size, data } of pngs) {
    const type = ICNS_TYPES[size];
    if (!type) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(Buffer.concat([head, data]));
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// --- Build ---------------------------------------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ALL = [...new Set([...ICO_SIZES, ...ICNS_SIZES, 1024])].sort((a, b) => a - b);

fs.mkdirSync(OUT_DIR, { recursive: true });

const png = new Map();
for (const size of ALL) png.set(size, encodePng(rasterize(size), size));

const at = sizes => sizes.map(size => ({ size, data: png.get(size) }));

const written = [
  ['icon.png', png.get(1024)],
  ['icon.ico', encodeIco(at(ICO_SIZES))],
  ['icon.icns', encodeIcns(at(ICNS_SIZES))]
];
for (const [name, data] of written) {
  fs.writeFileSync(path.join(OUT_DIR, name), data);
  console.log(`build/${name}  ${(data.length / 1024).toFixed(1)} KB`);
}
