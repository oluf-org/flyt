// src/loopLive.js (DECISIONS.md D45): what one loop worker is doing, derived from
// the run snapshot that was already on the wire.
//
// The assertions that matter: nothing invents a placeholder for state it does
// not have, tool calls are newest-first, and the patch protocol cannot be made
// to produce a snapshot that never existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workerView, nowLine, currentNode, toolCalls, argsPreview, filesFromDiff,
  gateResults, applyPatch, SILENT_MS
} from '../src/loopLive.js';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const snap = ({ nodeStatus = {}, nodes = [], tasks = [], retrospectives = {}, ...rest } = {}) => ({
  meta: { runId: 'r1', stage: 'execution', createdAt: '2026-08-18T10:00:00.000Z', nodeStatus },
  flow: { id: 'f', name: 'F', nodes, edges: [] },
  tasks: { tasks },
  taskOutputs: {},
  nodeOutputs: {},
  retrospectives,
  ...rest
});

// --- currentNode -----------------------------------------------------------

test('currentNode: the active node, with the label the canvas shows', () => {
  const s = snap({ nodes: [node('a', 'aiStep', { title: 'Planning' })], nodeStatus: { a: 'active' } });
  assert.deepEqual(currentNode(s), { id: 'a', label: 'Planning', status: 'active', type: 'aiStep' });
});

test('currentNode: nothing active yields null, not a placeholder', () => {
  assert.equal(currentNode(snap({ nodes: [node('a', 'aiStep')], nodeStatus: { a: 'done' } })), null);
  assert.equal(currentNode(null), null);
  assert.equal(currentNode(snap({})), null);
});

test('currentNode: a running task stands in when no flow node is active', () => {
  const s = snap({ tasks: [{ id: 'task-1', title: 'Write the thing', status: 'running' }] });
  assert.deepEqual(currentNode(s), { id: 'task-1', label: 'Write the thing', status: 'active', type: 'agentTask' });
});

// --- toolCalls -------------------------------------------------------------

const retroWith = calls => ({ 'executor-task-1': { status: 'success', toolCalls: calls } });

test('toolCalls: newest first', () => {
  const calls = toolCalls(snap({
    retrospectives: retroWith([
      { tool: 'read_file', args: { path: 'a.js' }, ok: true, ms: 3 },
      { tool: 'edit_file', args: { path: 'b.js' }, ok: true, ms: 5 },
      { tool: 'run_gate', args: { command: 'npm test' }, ok: true, ms: 30_000 }
    ])
  }));
  assert.deepEqual(calls.map(c => c.name), ['run_gate', 'edit_file', 'read_file']);
  assert.equal(calls[0].argsPreview, 'npm test');
  assert.equal(calls[0].ms, 30_000);
  assert.equal(calls[0].node, 'executor-task-1');
});

test('toolCalls: a failed call keeps its error and reads as not ok', () => {
  const [call] = toolCalls(snap({
    retrospectives: retroWith([{ tool: 'edit_file', args: { path: 'x' }, ok: false, error: 'ambiguous anchor', ms: 1 }])
  }));
  assert.equal(call.ok, false);
  assert.equal(call.error, 'ambiguous anchor');
});

test('toolCalls: no retrospectives is an empty list', () => {
  assert.deepEqual(toolCalls(snap({})), []);
  assert.deepEqual(toolCalls(null), []);
});

test('toolCalls: bounded, so a long run is a card and not a log', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i}.js` }, ok: true, ms: 1 }));
  assert.equal(toolCalls(snap({ retrospectives: retroWith(many) })).length, 12);
  assert.equal(toolCalls(snap({ retrospectives: retroWith(many) }), 3).length, 3);
});

test('argsPreview: names the subject per tool, and falls back to the first string', () => {
  assert.equal(argsPreview('read_file', { path: 'core/api.js' }), 'core/api.js');
  assert.equal(argsPreview('bash', { command: 'npm test' }), 'npm test');
  assert.equal(argsPreview('web_fetch', { url: 'https://x.example' }), 'https://x.example');
  assert.equal(argsPreview('some_new_tool', { whatever: 'a value' }), 'a value');
  assert.equal(argsPreview('read_file', {}), null);
  assert.equal(argsPreview('read_file', null), null);
  // Long values are clipped, and newlines never break the row.
  assert.equal(argsPreview('ask_human', { question: 'a\nb' }), 'a b');
  assert.equal(argsPreview('bash', { command: 'x'.repeat(100) }), `${'x'.repeat(57)}…`);
});

// --- the "now:" line -------------------------------------------------------

test('nowLine: node plus the last tool call, or whichever of the two exists', () => {
  const s = snap({
    nodes: [node('a', 'aiStep', { title: 'Working' })], nodeStatus: { a: 'active' },
    retrospectives: retroWith([{ tool: 'read_file', args: { path: 'core/api.js' }, ok: true, ms: 2 }])
  });
  assert.equal(nowLine(workerView(s)), 'Working · read_file core/api.js');

  const nodeOnly = snap({ nodes: [node('a', 'aiStep', { title: 'Thinking' })], nodeStatus: { a: 'active' } });
  assert.equal(nowLine(workerView(nodeOnly)), 'Thinking');

  // Nothing to say beats saying nothing convincingly.
  assert.equal(nowLine(workerView(snap({}))), null);
  assert.equal(nowLine(null), null);
});

// --- the diff --------------------------------------------------------------

const DIFF = [
  'diff --git a/src/loop/Board.jsx b/src/loop/Board.jsx',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/loop/Board.jsx',
  '@@ -0,0 +1,3 @@',
  '+import React from "react";',
  '+export default function Board() { return null; }',
  '+',
  'diff --git a/src/styles.css b/src/styles.css',
  '--- a/src/styles.css',
  '+++ b/src/styles.css',
  '@@ -10,3 +10,3 @@',
  ' .loop-page {',
  '-  padding: 1rem;',
  '+  padding: 2rem;',
  ' }'
].join('\n');

test('filesFromDiff: one entry per file with real add/remove counts', () => {
  const files = filesFromDiff(DIFF);
  assert.deepEqual(files.map(f => f.path), ['src/loop/Board.jsx', 'src/styles.css']);
  // The +++/--- headers are headers, not content: counting them would inflate
  // every single file by one add and one remove.
  assert.deepEqual({ added: files[0].added, removed: files[0].removed }, { added: 3, removed: 0 });
  assert.deepEqual({ added: files[1].added, removed: files[1].removed }, { added: 1, removed: 1 });
  assert.match(files[1].hunk, /padding: 2rem/);
});

test('filesFromDiff: no diff is an empty list, never a crash', () => {
  assert.deepEqual(filesFromDiff(null), []);
  assert.deepEqual(filesFromDiff(''), []);
  assert.deepEqual(filesFromDiff('not a diff at all'), []);
});

// --- gates -----------------------------------------------------------------

test('gateResults: flattens work:verify, and tails the output', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const g = gateResults({ ok: false, gates: ['npm test'], results: [{ command: 'npm test', status: 'fail', code: 1, ms: 900, output: long }] });
  assert.equal(g.ok, false);
  assert.deepEqual(g.declared, ['npm test']);
  assert.equal(g.results[0].output.split('\n').length, 40);
  // A failing suite puts its summary at the bottom, so the tail is what matters.
  assert.match(g.results[0].output, /line 199/);
});

test('gateResults: nothing has run yet is null, not a fake pass', () => {
  assert.equal(gateResults(null), null);
});

// --- the whole view --------------------------------------------------------

test('workerView: assembles without a snapshot, because an expanding card has none yet', () => {
  const view = workerView(null, { taskId: 't-0001', idleMs: 0, interventions: [] });
  assert.deepEqual(view.streams, []);
  assert.equal(view.currentNode, null);
  assert.deepEqual(view.toolCalls, []);
  assert.equal(view.progress, null);
  assert.equal(view.stalled, false);
});

test('workerView: stalled follows the supervisor\'s own silence threshold', () => {
  const quiet = workerView(snap({}), { idleMs: SILENT_MS - 1 });
  const stalled = workerView(snap({}), { idleMs: SILENT_MS });
  assert.equal(quiet.stalled, false);
  assert.equal(stalled.stalled, true);
});

test('workerView: what the supervisor already tried rides along', () => {
  const view = workerView(snap({}), { idleMs: SILENT_MS, interventions: ['nudged', 'restarted node'] });
  assert.deepEqual(view.interventions, ['nudged', 'restarted node']);
});

test('workerView: streams are the live-output panel\'s, not a second implementation', () => {
  const s = snap({ nodes: [node('a', 'aiStep', { title: 'Draft' })], nodeStatus: { a: 'active' } });
  s.nodeOutputs = { a: 'half a sentence' };
  const view = workerView(s, null);
  assert.equal(view.streams.length, 1);
  assert.equal(view.streams[0].text, 'half a sentence');
});

// --- the patch protocol ----------------------------------------------------

const held = (snapshot, rev) => ({ snapshot, rev });

test('applyPatch: a full snapshot replaces whatever was held', () => {
  const next = applyPatch(held(snap({}), 4), { full: snap({ nodeStatus: { a: 'active' } }), rev: 9 });
  assert.equal(next.rev, 9);
  assert.equal(next.refetch, false);
  assert.deepEqual(next.snapshot.meta.nodeStatus, { a: 'active' });
});

test('applyPatch: re-applying the same rev is a no-op', () => {
  const base = snap({});
  const first = applyPatch(held(base, 3), { base: 3, rev: 4, patch: { meta: { stage: 'verify' } } });
  assert.equal(first.rev, 4);
  // The same push again — two cards expanded on one channel — changes nothing.
  const again = applyPatch(first, { base: 3, rev: 4, patch: { meta: { stage: 'verify' } } });
  assert.equal(again.rev, 4);
  assert.deepEqual(again.snapshot, first.snapshot);
});

test('applyPatch: a patch that does not line up asks for a re-fetch rather than guessing', () => {
  const out = applyPatch(held(snap({}), 3), { base: 7, rev: 8, patch: { meta: { stage: 'done' } } });
  assert.equal(out.refetch, true);
  assert.equal(out.rev, 3, 'the held snapshot is left exactly as it was');
});

test('applyPatch: with nothing held, a patch is a re-fetch', () => {
  const out = applyPatch(null, { base: 0, rev: 1, patch: {} });
  assert.equal(out.refetch, true);
  assert.equal(out.snapshot, null);
});
