import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readFile from '../core/tools/read_file.js';
import { previewResult } from '../core/tools/preview.js';
import { Workspace } from '../core/workspace.js';
import { getTools } from '../core/tools/index.js';

test('model source previews have exact line numbers and lossless contiguous pagination', async t => {
  const registered = getTools().find(tool => tool.name === 'read_file');
  assert.equal(registered.result.preview, 'file', 'normalization preserves the production preview mode');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-source-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = Array.from({ length: 1300 }, (_, i) => `function line${i + 1}() { return "${'evidence '.repeat(6)}"; }\r\n`).join('');
  fs.writeFileSync(path.join(root, 'source.js'), source);
  const ctx = { workspace: new Workspace(root).ensure() };
  let offset = 0;
  let reconstructed = '';
  let pages = 0;
  do {
    const raw = await readFile.run({ path: 'source.js', offset }, ctx);
    const { value } = previewResult(raw, registered.result);
    assert.ok(JSON.stringify(value).length <= 24000);
    assert.equal(value.lineNumbered, true);
    assert.equal(value.startLine, source.slice(0, offset).split('\n').length);
    assert.ok(value.content.startsWith(`${value.startLine}: `));
    const plain = value.content.replace(/^\d+: /gm, '');
    reconstructed += plain;
    if (!value.truncated) break;
    assert.equal(value.nextOffset, offset + plain.length);
    assert.ok(value.nextOffset > offset);
    offset = value.nextOffset;
    assert.ok(++pages < 30);
  } while (true);
  assert.equal(reconstructed, source);
  assert.ok(pages > 1);
});

test('numbered previews handle escaped strings and a line longer than the preview budget', () => {
  const raw = { path: 'long', content: '"\\'.repeat(30000), offset: 100, startLine: 8, startColumn: 101 };
  const { value, truncated } = previewResult(raw, readFile.result);
  assert.equal(truncated, true);
  assert.ok(JSON.stringify(value).length <= 24000);
  assert.ok(value.nextOffset > 100);
  assert.equal(value.nextOffset - 100, value.content.slice(3).length);
  assert.equal(value.startColumn, 101);
});
