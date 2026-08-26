#!/usr/bin/env node
// One-shot applier: splices the stop()/pause()/stopFromFiles changes into
// core/flowRunner.js (CRLF endings) and the honest-result handling into
// bin/flyt.js. Deleted after use.
import fs from 'node:fs';

const read = p => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

const FR = 'core/flowRunner.js';
let src = read(FR);
if (!src.includes('\r\n')) throw new Error('expected CRLF in flowRunner.js');
const nl = '\r\n';
const lines = src.split(nl);

const findLine = (needle, from = 0) => {
  const i = lines.findIndex((l, idx) => idx >= from && l === needle);
  if (i < 0) throw new Error('anchor not found: ' + JSON.stringify(needle));
  return i;
};
const spliceBlock = (fileText, at, remove = 0) => {
  const body = fileText.replace(/\r?\n/g, nl);
  const arr = body.replace(new RegExp(nl + '$'), '').split(nl);
  lines.splice(at, remove, ...arr);
};

// --- 1. replace stop()'s guard with the three-way answer ---
{
  const i = findLine('  stop(runId) {');
  if (lines[i + 1] !== String.raw`    if (!this.live.has(runId)) return { ok: false, error: 'not-live' };`)
    throw new Error('unexpected stop() guard');
  spliceBlock(read('_patch/stop_head.txt'), i + 1, 1);
}
// --- 2. insert stopFromFiles before restartNode ---
{
  const i = findLine('  // Restart one node and everything downstream of it, on a non-live run.');
  spliceBlock(read('_patch/stop_from_files.txt'), i, 0);
}
// --- 3. pause(): keep the in-process-only guard, make its failure legible ---
{
  const guard = String.raw`    if (!this.live.has(runId)) return { ok: false, error: 'not-live' };`;
  const i = findLine(guard); // stop()'s copy is gone, so this is pause()'s
  const repl = [
    '    if (!this.live.has(runId)) {',
    '      // Deliberately NOT the stop() fallback: pausing a walk that exists',
    "      // only in some other process's memory means nothing - the pause",
    '      // request is consulted between waves by the walking loop itself, so',
    '      // there is no durable thing to hold. Say exactly that rather than a',
    '      // bare not-live that reads like a bug.',
    '      return { ok: false, error: "not-live", message: `Run ${runId} is not running in this process; there is nothing to pause.` };',
    '    }'
  ];
  lines.splice(i, 1, ...repl.map(l => l));
}
write(FR, lines.join(nl));

// --- 4. bin/flyt.js: honour the result for approve/reject/stop ---
const BIN = 'bin/flyt.js';
let bin = read(BIN);
if (!bin.includes('\r\n')) throw new Error('expected CRLF in flyt.js');
const OLD = [
  '      await api.invoke(`run:${command}`, {',
  '        projectId, runId,',
  "        ...(command === 'reject' ? { reason: String(flags.reason ?? '') } : {})",
  '      });',
  "      const stage = (await api.invoke('run:snapshot', { projectId, runId }))?.meta?.stage ?? 'unknown';",
  "      const done = { approve: 'approved', reject: 'rejected', stop: 'stopped' }[command];",
  '      return out(asJson ? { ok: true, runId, action: done, stage } : `${runId} ${done} — now ${stage}`);'
];
const NEW = [
  '      // The invoke result says whether anything actually happened - stop()',
  '      // answers not-live / owned-by-live-process when it could not act, and',
  '      // printing success anyway once reported stopping a run it never touched.',
  '      // A failed result dies non-zero with the reason; only a real success',
  '      // prints the new stage.',
  '      const res = await api.invoke(`run:${command}`, {',
  '        projectId, runId,',
  "        ...(command === 'reject' ? { reason: String(flags.reason ?? '') } : {})",
  '      });',
  "      const done = { approve: 'approved', reject: 'rejected', stop: 'stopped' }[command];",
  '      if (res && res.ok === false) {',
  '        const msg = res.message || res.error || `${command} failed`;',
  '        return die(`${runId} NOT ${done}: ${msg}`);',
  '      }',
  "      const stage = (await api.invoke('run:snapshot', { projectId, runId }))?.meta?.stage ?? 'unknown';",
  '      const note = res && res.fromFiles ? " (stopped from files - no live process)" : "";',
  '      return out(asJson',
  '        ? { ok: true, runId, action: done, stage, ...(note ? { how: note.trim() } : {}) }',
  '        : `${runId} ${done}${note} — now ${stage}`);'
];
const binLines = bin.split('\r\n');
{
  const i = binLines.findIndex((l, idx) =>
    l === OLD[0] && OLD.every((o, j) => binLines[idx + j] === o));
  if (i < 0) throw new Error('flyt.js approve/reject/stop block not found');
  binLines.splice(i, OLD.length, ...NEW);
}
write(BIN, binLines.join('\r\n'));

console.log('patched core/flowRunner.js and bin/flyt.js');
