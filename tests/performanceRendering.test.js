import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { parseStack } from '#kernel';

test('hundreds of collapsed tool steps never serialize their expensive payloads', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: BlockEditor } = await vite.ssrLoadModule('/src/v2/BlockEditor.jsx');
    const payload = { toJSON() { throw new Error('closed tool payload was serialized'); } };
    const activity = Array.from({ length: 300 }, (_, i) => ({ id: `tool-${i}`, kind: 'tool', title: 'Tool call', status: 'done', args: payload, result: payload }));
    activity.push({ id: 'live', kind: 'tool', title: 'Live tool', status: 'running', args: { path: 'visible.txt' } });
    const html = renderToStaticMarkup(React.createElement(BlockEditor, {
      stack: parseStack('version: 2\nid: perf\nblocks:\n  - id: work\n    use: work\n'),
      blocks: { resolve: () => ({ use: 'work' }) }, mode: 'run',
      run: { blocks: { work: { status: 'active', activity } } },
    }));
    assert.equal((html.match(/class="be-activity-body"/g) ?? []).length, 1);
    assert.match(html, /visible.txt/);
    assert.equal((html.match(/class="be-activity-item /g) ?? []).length, 60);
    assert.match(html, /Earlier steps/);
  } finally { await vite.close(); }
});
