import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ACTIVITY_SETTLED_MS, projectActivity, runActivity, safeActivityLabel, showPersistentActivity
} from '../src/activityStatus.js';

const snapshot = ({ stage = 'execution', stream = '', calls = [], meta = {} } = {}) => ({
  meta: {
    runId: 'run-1', stage, nodeStatus: { work: stage === 'execution' ? 'active' : 'done' }, ...meta
  },
  flow: {
    nodes: [{
      id: 'work', type: 'aiStep', kind: 'ai',
      data: { title: 'Implement activity', worker: { provider: 'openrouter', model: 'moonshotai/kimi-k3' } }
    }],
    edges: []
  },
  tasks: { tasks: [] },
  nodeOutputs: { work: stream },
  retrospectives: calls.length ? { work: { toolCalls: calls } } : {},
  prompt: 'PROMPT MUST NEVER APPEAR'
});

const record = (snap, extra = {}) => ({ snapshot: snap, updatedAt: 10_000, live: true, ...extra });

test('activity phases distinguish thinking, streaming, and safe tool use', () => {
  assert.equal(runActivity(record(snapshot()), 10_100).phase, 'thinking');
  assert.equal(runActivity(record(snapshot({ stream: 'private model output' })), 10_100).phase, 'streaming');
  const tool = runActivity(record(snapshot({
    stream: 'private model output',
    calls: [{ tool: 'read_file', args: { path: 'src/App.jsx' }, ok: true }]
  })), 10_100);
  assert.equal(tool.phase, 'tool');
  assert.equal(tool.tool, 'read_file src/App.jsx');
  assert.match(tool.ariaLabel, /Kimi|kimi-k3/i);
});

test('attention, terminal, and stale states settle deterministically', () => {
  assert.equal(runActivity(record(snapshot({ stage: 'awaiting_approval' })), 10_100).phase, 'awaiting-approval');
  assert.equal(runActivity(record(snapshot({ stage: 'paused' })), 10_100).phase, 'paused');
  assert.equal(runActivity(record(snapshot()), 12_000, { staleMs: 1_000 }).phase, 'stalled');
  assert.equal(runActivity(record(snapshot({ stage: 'failed', meta: { error: 'raw failure' } }), { live: false }), 10_100).phase, 'failed');
  assert.equal(runActivity(record(snapshot({ stage: 'cancelled' }), { live: false }), 10_100).phase, 'cancelled');
  assert.equal(runActivity(record(snapshot({ stage: 'done' }), { live: false }), 10_100).phase, 'complete');
});

test('project activity chooses the freshest active run and reports concurrency', () => {
  const old = record(snapshot(), { updatedAt: 9_000 });
  const freshSnap = snapshot();
  freshSnap.meta.runId = 'run-2';
  freshSnap.flow.nodes[0].data.title = 'Fresh task';
  const fresh = record(freshSnap, { updatedAt: 10_000 });
  const view = projectActivity([old, fresh], 10_100);
  assert.equal(view.runId, 'run-2');
  assert.equal(view.nodeLabel, 'Fresh task');
  assert.equal(view.liveCount, 2);
  assert.match(view.ariaLabel, /2 AI runs are active/);
});

test('persistent activity never exposes prompts, streams, results, controls, or secret-looking args', () => {
  const snap = snapshot({
    stream: 'raw reasoning sk-streamsecret99',
    calls: [{
      tool: 'bash',
      args: { command: 'node build.js api_key=super-secret-value' },
      result: { stdout: 'PRIVATE COMMAND OUTPUT' },
      ok: true
    }]
  });
  snap.prompt = 'PRIVATE USER PROMPT';
  const serialized = JSON.stringify(runActivity(record(snap), 10_100));
  assert.doesNotMatch(serialized, /PRIVATE|streamsecret|super-secret/i);
  assert.match(serialized, /\"tool\":\"bash\"/);
  assert.doesNotMatch(serialized, /node build/);
  assert.match(safeActivityLabel('api_key=super-secret-value'), /redacted/);
  assert.equal(safeActivityLabel('line\nwith\u0000controls', 40), 'line with controls');
  assert.ok(safeActivityLabel('x'.repeat(200), 20).length <= 20);

  // Unknown tools and argument-shaped metadata never become persistent UI.
  const extension = snapshot({ calls: [{ tool: 'custom_tool', args: {
    subject: 'PRIVATE USER PROMPT', command: 'echo raw output'
  } }] });
  const extensionView = runActivity(record(extension), 10_100);
  assert.equal(extensionView.phase, 'tool');
  assert.equal(extensionView.tool, null);
  assert.doesNotMatch(extensionView.ariaLabel, /PRIVATE|raw output/i);

  // Even an allowlisted file tool gets no generic argsPreview escape hatch.
  // Only its exact path/pattern field is considered, and it must look like a
  // path rather than prompt prose, a secret, raw output, or a giant argument.
  for (const path of [
    'PRIVATE USER PROMPT',
    'Summarize private report.txt',
    'stdout PRIVATE COMMAND OUTPUT',
    'api_key=super-secret-value.txt',
    `${'x'.repeat(200)}.txt`
  ]) {
    const hostile = runActivity(record(snapshot({ calls: [{
      tool: 'read_file', args: { path, argsPreview: 'src/decoy.js' }, ok: true
    }] })), 10_100);
    assert.equal(hostile.tool, 'read_file');
    assert.doesNotMatch(JSON.stringify(hostile), /PRIVATE|COMMAND OUTPUT|super-secret|decoy|x{40}/i);
  }
});

test('terminal chrome is acknowledged briefly, then clears from shell and tabs', () => {
  for (const stage of ['done', 'failed', 'cancelled']) {
    const terminal = record(snapshot({ stage }), { live: false });
    const fresh = runActivity(terminal, 10_000 + ACTIVITY_SETTLED_MS - 1);
    assert.ok(fresh, `${stage} remains visible inside the acknowledgement window`);
    assert.equal(showPersistentActivity(fresh), true, `${stage} is shown by shell and tabs`);
    const expired = runActivity(terminal, 10_000 + ACTIVITY_SETTLED_MS);
    assert.equal(expired, null, `${stage} expires at the retention boundary`);
    assert.equal(showPersistentActivity(expired), false, `${stage} then clears from shell and tabs`);
  }
  assert.equal(showPersistentActivity({ phase: 'paused' }), true);
  assert.equal(showPersistentActivity({ phase: 'stalled' }), true);
  assert.equal(showPersistentActivity(null, 1), true, 'a live membership signal remains visible while its snapshot loads');
});

test('activity labels remain useful and accessible without relying on motion', () => {
  const view = runActivity(record(snapshot()), 10_100);
  assert.equal(view.phaseLabel, 'Thinking');
  assert.match(view.ariaLabel, /AI activity: Thinking/);
  assert.match(view.ariaLabel, /Updated now/);
  assert.ok(view.shortLabel.length <= 72);
});

test('reduced-motion CSS disables both persistent activity animations', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const blocks = [];
  for (const match of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < css.length && depth; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
    }
    blocks.push(css.slice(match.index, end));
  }
  const reduced = blocks.find(block => block.includes('.shell-activity-dot')) ?? '';
  assert.match(reduced, /\.shell-activity-dot/);
  assert.match(reduced, /\.tab-live-dot/);
  assert.match(reduced, /animation:\s*none\s*!important/);
  assert.match(reduced, /transform:\s*none\s*!important/);
});
