// What the live output panel considers to be working right now (src/runStreams.js,
// V1 task 8) and what each unit of work has produced so far — a pure function
// over a run snapshot, so it tests without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeStreams } from '../src/runStreams.js';

const snap = ({ nodeStatus = {}, nodes = [], tasks = [], taskOutputs = {}, nodeOutputs = {} }) => ({
  meta: { runId: 'r1', stage: 'execution', nodeStatus },
  flow: { id: 'f', name: 'F', nodes, edges: [] },
  tasks: { tasks },
  taskOutputs,
  nodeOutputs
});

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const task = (id, status, extra = {}) => ({
  id, status, title: `Task ${id}`, worker: { provider: 'mock', model: 'm' }, ...extra
});

test('nothing is working: no streams', () => {
  assert.deepEqual(activeStreams(snap({})), []);
  assert.deepEqual(activeStreams(null), []);
});

test('an active aiStep streams its node output', () => {
  const streams = activeStreams(snap({
    nodes: [node('a', 'aiStep', { title: 'Draft', role: 'execute' })],
    nodeStatus: { a: 'active' },
    nodeOutputs: { a: 'half a sentence' }
  }));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].key, 'node:a');
  assert.equal(streams[0].label, 'Draft');
  assert.equal(streams[0].text, 'half a sentence');
});

test('only nodes that make a model call stream (not input/output/pending)', () => {
  const streams = activeStreams(snap({
    nodes: [node('in', 'input'), node('out', 'output'), node('a', 'aiStep', { title: 'A' })],
    // input/output do go 'active' briefly in the walk; they have no model call.
    nodeStatus: { in: 'active', out: 'active', a: 'pending' }
  }));
  assert.deepEqual(streams, []);
});

// An agentTask's work IS its task, so it must appear once (via the task) rather
// than twice — the node goes 'active' and the task 'running' at the same time.
test('an agentTask surfaces through its task, not twice', () => {
  const streams = activeStreams(snap({
    nodes: [node('w', 'agentTask', { title: 'Worker', taskId: 'task-1' })],
    nodeStatus: { w: 'active' },
    tasks: [task('task-1', 'running')],
    taskOutputs: { 'task-1': 'working…' }
  }));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].key, 'task:task-1');
  assert.equal(streams[0].text, 'working…');
});

// A task spawned by create_task has no flow node at all — the task is the only
// handle on it, which is why streams key off tasks rather than nodes.
test('a spawned task with no node of its own still streams', () => {
  const streams = activeStreams(snap({
    nodes: [node('w', 'agentTask', { title: 'Worker', taskId: 'task-1' })],
    nodeStatus: { w: 'done' },
    tasks: [task('task-1', 'done'), task('task-2', 'running', { createdBy: 'task-1' })],
    taskOutputs: { 'task-2': 'delegated work' }
  }));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].key, 'task:task-2');
  assert.equal(streams[0].text, 'delegated work');
});

// A task pausing at a tool gate is still 'running', so the block it wants
// approved stays on screen next to the reply that asked for it.
test('a task waiting at a tool gate keeps streaming its pending call', () => {
  const streams = activeStreams(snap({
    nodes: [node('w', 'agentTask', { title: 'Worker', taskId: 'task-1' })],
    nodeStatus: { w: 'waiting' },
    tasks: [task('task-1', 'running')],
    taskOutputs: { 'task-1': '```tool\n{"tool":"bash","args":{"command":"rm -rf ."}}\n```' }
  }));
  assert.equal(streams.length, 1);
  assert.match(streams[0].text, /rm -rf/);
});

// nodes/<id>.md filenames are sanitized, so the sidecar an orchestrator streams
// its planning turn into ("orch.plan") is keyed "orch_plan" in the snapshot.
test('an orchestrator streams its planning sidecar under the sanitized key', () => {
  const streams = activeStreams(snap({
    nodes: [node('orch', 'orchestrator', { title: 'Boss' })],
    nodeStatus: { orch: 'active' },
    nodeOutputs: { orch_plan: '{ "nodes": [' }
  }));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].text, '{ "nodes": [');
  assert.equal(streams[0].sub, 'planning');
});

test('parallel work lists every stream, tasks and nodes together', () => {
  const streams = activeStreams(snap({
    nodes: [node('a', 'aiStep', { title: 'A' }), node('w', 'agentTask', { title: 'W', taskId: 'task-1' })],
    nodeStatus: { a: 'active', w: 'active' },
    tasks: [task('task-1', 'running')],
    nodeOutputs: { a: 'aaa' },
    taskOutputs: { 'task-1': 'www' }
  }));
  assert.deepEqual(streams.map(s => s.key).sort(), ['node:a', 'task:task-1']);
});

// A node that has gone active but produced nothing yet must still be listed —
// the panel shows it as "waiting for the first tokens" rather than vanishing.
test('an active node with no output yet is listed with empty text', () => {
  const streams = activeStreams(snap({
    nodes: [node('a', 'aiStep', { title: 'A' })],
    nodeStatus: { a: 'active' }
  }));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].text, '');
});
