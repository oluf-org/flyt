// The chat-style node feed (src/nodeFeedData.js): a run's graph flattened into
// execution reading order — pure over a run snapshot, so it tests without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feedItems, finalAnswer } from '../src/nodeFeedData.js';

const node = (id, type, extra = {}) => ({
  id, type, position: { x: 0, y: 0 }, data: {}, ...extra
});
const edge = (source, target) => ({ id: `e-${source}-${target}`, source, target });

const snap = ({ nodeStatus = {}, nodes = [], edges = [], tasks = [], nodeOutputs = {}, taskOutputs = {}, retrospectives = {}, stage = 'execution' }) => ({
  meta: { runId: 'r1', stage, nodeStatus },
  flow: { id: 'f', name: 'F', nodes, edges },
  tasks: { tasks },
  taskOutputs,
  nodeOutputs,
  retrospectives
});

test('no snapshot, no feed', () => {
  assert.deepEqual(feedItems(null), []);
  assert.deepEqual(feedItems({}), []);
});

test('flow runs flatten in execution order, not array order', () => {
  const items = feedItems(snap({
    nodes: [node('out', 'output'), node('b', 'aiStep'), node('in', 'input'), node('a', 'aiStep')],
    edges: [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')],
    nodeStatus: { in: 'done', a: 'done', b: 'active', out: 'pending' }
  }));
  assert.deepEqual(items.map(i => i.id), ['in', 'a', 'b', 'out']);
  assert.deepEqual(items.map(i => i.status), ['done', 'done', 'active', 'pending']);
  assert.ok(items.every(i => i.depth === 0));
});

test('orchestrator children nest at depth 1 right after their box', () => {
  const items = feedItems(snap({
    nodes: [
      node('in', 'input'),
      node('orch', 'orchestrator'),
      node('k2', 'aiStep', { parentId: 'orch' }),
      node('k1', 'aiStep', { parentId: 'orch' }),
      node('out', 'output')
    ],
    edges: [edge('in', 'orch'), edge('orch', 'out'), edge('k1', 'k2')],
    nodeStatus: { in: 'done', orch: 'active', k1: 'done', k2: 'active', out: 'pending' }
  }));
  assert.deepEqual(items.map(i => i.id), ['in', 'orch', 'k1', 'k2', 'out']);
  assert.deepEqual(items.map(i => i.depth), [0, 0, 1, 1, 0]);
});

test('a runtime-spawned task appends under its owning node', () => {
  const items = feedItems(snap({
    nodes: [node('in', 'input'), node('a', 'aiStep'), node('out', 'output')],
    edges: [edge('in', 'a'), edge('a', 'out')],
    tasks: [{ id: 't1', status: 'running', title: 'Sub job', worker: { provider: 'mock', model: 'm' }, createdBy: 'a' }],
    nodeStatus: { in: 'done', a: 'active', out: 'pending' }
  }));
  assert.deepEqual(items.map(i => i.id), ['in', 'a', 't1', 'out']);
  const t = items[2];
  assert.equal(t.depth, 1);
  assert.equal(t.spawned, true);
  assert.equal(t.status, 'active');
});

test('active nodes carry their stream, done nodes an output preview', () => {
  const items = feedItems(snap({
    nodes: [node('a', 'aiStep', { data: { title: 'Worker' } })],
    nodeStatus: { a: 'active' },
    nodeOutputs: { a: 'partial text here' }
  }));
  assert.equal(items[0].streamText, 'partial text here');
  assert.equal(items[0].outputPreview, null);

  const done = feedItems(snap({
    nodes: [node('a', 'aiStep')],
    nodeStatus: { a: 'done' },
    nodeOutputs: { a: 'the full result' },
    retrospectives: { a: { status: 'success', confidence: 0.9, problems: [], recommendation: 'keep it' } }
  }));
  assert.equal(done[0].streamText, null);
  assert.equal(done[0].outputPreview, 'the full result');
  assert.equal(done[0].retro.status, 'success');
  assert.equal(done[0].retro.recommendation, 'keep it');
});

test('follow-up provenance and retrospective briefs ride along', () => {
  const items = feedItems(snap({
    nodes: [node('a', 'aiStep', { data: { origin: 'followup', turn: 2 } })],
    nodeStatus: { a: 'done' },
    retrospectives: { a: { status: 'partial', problems: ['thin data'], recommendation: 'retry with more context' } }
  }));
  assert.equal(items[0].turn, 2);
  assert.deepEqual(items[0].retro.problems, ['thin data']);
});

test('classic pipeline runs (no flow) fall back to the stage feed', () => {
  const items = feedItems({
    meta: { runId: 'r1', stage: 'execution', nodeStatus: {}, currentTaskId: 't1' },
    tasks: { tasks: [
      { id: 't1', status: 'running', title: 'Build', worker: { provider: 'mock', model: 'm' } },
      { id: 't2', status: 'pending', title: 'Verify', worker: { provider: 'mock', model: 'm' } }
    ] },
    taskOutputs: {},
    retrospectives: {}
  });
  assert.deepEqual(items.map(i => i.id), ['prompt', 'planner', 'router', 'execution', 't1', 't2', 'verifier']);
  assert.equal(items[4].status, 'active');
  assert.equal(items[4].depth, 1);
  assert.equal(items[0].status, 'done'); // prompt is always done
});

test('finalAnswer reads the output node, and stays honest when empty', () => {
  assert.equal(finalAnswer(null), null);
  assert.equal(finalAnswer(snap({ nodes: [node('out', 'output')], nodeOutputs: { out: '  ' } })), null);
  assert.equal(
    finalAnswer(snap({ nodes: [node('out', 'output')], nodeOutputs: { out: 'the answer' } })),
    'the answer'
  );
});
