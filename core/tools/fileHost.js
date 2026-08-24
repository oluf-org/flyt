// The file backend a tool call operates on. When the run is bound to a real
// project folder (meta.workspace, provisioned in V1 task 1) file tools act on
// that repo; otherwise they fall back to the run's own runs/<id>/workspace/
// sandbox so mock/no-workspace flows keep working unchanged. BOTH confine every
// path to their root — traversal (..), absolute paths, and drive-letter escapes
// are rejected (Workspace.resolve / RunStore.workspacePath).
import fs from 'node:fs';
import path from 'node:path';
import { readFileShaped, encode } from './textFile.js';

export function fileHost(ctx) {
  if (ctx.workspace) {
    const ws = ctx.workspace;
    return {
      target: 'workspace',
      resolve: rel => ws.resolve(rel),
      rel: abs => path.relative(ws.root, abs).split(path.sep).join('/')
    };
  }
  return {
    target: 'run-workspace',
    resolve: rel => ctx.store.workspacePath(ctx.runId, rel),
    rel: abs => path.relative(ctx.store.runDir(ctx.runId), abs).split(path.sep).join('/')
  };
}

/**
 * Read a file and say what it is: `{ text, shape }`, or null when there is no
 * file. `shape.binary` means the bytes are not text and `text` is empty.
 *
 * Every file tool goes through this rather than `readFileSync(p, 'utf8')`, so
 * the encoding, the byte-order mark and the line ending are decided once
 * (core/tools/textFile.js). Decided privately, they disagree: `edit_file`
 * matched raw bytes while models write plain newlines, a BOM sat invisibly in
 * front of the first character so no anchor on line 1 could match, and reading
 * a PNG as UTF-8 and writing it back destroyed it.
 */
export function readShaped(host, relPath) {
  const p = host.resolve(relPath);
  return readFileShaped(p);
}

// Read a text file; null when it doesn't exist or isn't a regular file. A
// binary file reads as null too: there is no text in it to hand back.
export function readText(host, relPath) {
  const read = readShaped(host, relPath);
  if (!read || read.shape.binary) return null;
  return read.text;
}

// Write a text file (creating parent dirs); returns the path relative to the
// backend's reporting root. With a `shape`, the bytes go back in the encoding
// and byte-order mark they came in — a file does not change what it IS because
// something edited a line in it.
export function writeText(host, relPath, content, shape = null) {
  const p = host.resolve(relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, shape ? encode(content, shape) : Buffer.from(String(content), 'utf8'));
  return host.rel(p);
}

export function fileExists(host, relPath) {
  const p = host.resolve(relPath);
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

// Record a write against the run's concurrent-write ledger, which is present
// only while a parallel task batch is in flight (V1 task 6). When another
// still-running task already wrote this path, the interference goes to
// log.jsonl and is returned so the tool can surface it in its result (and from
// there the retrospective + inspector). Null when there is no conflict.
export function noteWorkspaceWrite(ctx, relPath) {
  const conflict = ctx.ledger?.noteWrite(ctx.taskId, relPath) ?? null;
  if (conflict) {
    ctx.store?.appendLog(ctx.runId, {
      event: 'workspace_write_conflict',
      node: ctx.taskId ? `executor:${ctx.taskId}` : undefined,
      path: relPath,
      alsoWrittenBy: `executor:${conflict}`
    });
  }
  return conflict;
}
