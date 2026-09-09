import fs from 'node:fs';
import os from 'node:os';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseStack } from '#kernel';
import { emptyTrace, feed } from '../src/traceModel.js';
import * as views from '../src/v2/runView.js';
import { distribution } from './performance-metrics.mjs';
const mode = process.argv[2] ?? 'before';
const trace = emptyTrace();
let seq = 0;
const event = (type, data) => ({ seq: ++seq, at: new Date(1700000000000 + seq * 5).toISOString(), type, data });
const initial = [event('run.stage', { stage: 'execution' }), event('block.status', { blockId: 'work', status: 'active' }), event('turn.start', { runId: 'live', turn: 1 })];
for (let step = 1; step <= 1000; step++) initial.push(
  event('step.start', { runId: 'live', blockId: 'work', step }),
  event('llm.request', { callId: `call-${step}`, model: 'mock', prompt: 'Read the fixture.' }),
  event('llm.response', { callId: `call-${step}`, content: 'Finished previous step.', usage: { promptTokens: 100, completionTokens: 50 } }),
  event('step.end', { step }),
);
initial.push(event('step.start', { runId: 'live', blockId: 'work', step: 1001 }), event('llm.request', { callId: 'live-call', model: 'mock' }));
feed(trace, initial);
const project = mode === 'after' ? views.createRunView() : views.runView;
project(trace);
const samples = [], render = [];
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { default: BlockEditor } = await vite.ssrLoadModule('/src/v2/BlockEditor.jsx');
  const stack = parseStack('version: 2\nid: live\nblocks:\n  - id: work\n    use: work\n');
  let view, html;
  for (let batch = 0; batch < 120; batch++) {
    const events = Array.from({ length: 8 }, () => event('llm.stream', { text: 'A live replay chunk. ', ...(batch % 7 === 0 ? { reasoning: 'Thinking. ' } : {}) }));
    const at = performance.now();
    feed(trace, events); view = project(trace); samples.push(performance.now() - at);
    if (batch % 20 === 0) {
      const start = performance.now();
      html = renderToStaticMarkup(React.createElement(BlockEditor, { stack, mode: 'run', run: view, blocks: { resolve: () => ({ use: 'work' }) } }));
      render.push(performance.now() - start);
    }
  }
  const expected = views.runView(trace);
  const { default: assert } = await import('node:assert/strict');
  assert.deepEqual(view, expected);
  const report = { mode, at: new Date().toISOString(), cpu: os.cpus()[0].model, node: process.version, priorSteps: 1000, batches: 120, chunksPerBatch: 8,
    foldAndViewMs: distribution(samples), serverRenderMs: distribution(render), mountedActivityRows: (html.match(/class="be-activity-item /g) ?? []).length, equivalent: true,
    limitations: 'CPU replay and React server rendering; excludes browser layout, paint and input delay. No provider effects.' };
  fs.writeFileSync(`docs/reviews/performance-2026-09-09/four-tasks/live-work-${mode}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await vite.close(); }
