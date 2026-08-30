import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnosticLog } from '../core/diagnosticLog.js';

test('desktop diagnostics are append-only JSONL and serialize errors usefully', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-diagnostics-'));
  const file = path.join(dir, 'logs', 'flyt.jsonl');
  const log = createDiagnosticLog(file);
  log.info('process.start', { packaged: false });
  log.error('renderer.error', new Error('render failed'));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'process.start');
  assert.equal(rows[1].level, 'error');
  assert.equal(rows[1].details.message, 'render failed');
  assert.match(rows[1].details.stack, /render failed/);
});
