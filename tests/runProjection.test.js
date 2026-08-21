// The run folder as a projection of the log (D55). Two properties matter:
// what a person opens is still there, and what the ledger counts comes from
// the record rather than from the derived copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JsonlSessionStore, projectRun, materialise, spendFromLog, readLegacyRun, hasSessionLog,
} from '#kernel';
import { RunStore } from '../core/state.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-projection-'));

// One run, told as events: created, stack resolved, a block runs, a model is
// called, a tool answers, the block writes its output, the run finishes.
const A_RUN = [
  { type: 'run.created', data: {
    createdAt: '2026-08-21T08:39:56.330Z', prompt: 'Work t-0048.',
    stackId: 'loop-task', stackName: 'Work one backlog task',
    workspace: 'C:\\worktrees\\t-0048', approvalMode: 'always', loopTaskId: 't-0048',
  } },
  { type: 'stack.resolved', data: { stack: { id: 'loop-task', blocks: [{ id: 'work' }] } } },
  { type: 'run.stage', data: { stage: 'execution', currentBlockId: 'work' } },
  { type: 'block.status', data: { blockId: 'work', status: 'active' } },
  { type: 'llm.request', data: {
    callId: 'c1', blockId: 'work', taskId: 'task-1',
    provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', messages: 2,
  } },
  { type: 'llm.response', data: {
    callId: 'c1', ok: true, ms: 4910, finishReason: 'tool_calls',
    usage: { prompt_tokens: 6571, completion_tokens: 113, cost: 0.0079150896 },
    toolCalls: [{ id: 'c1-t1', name: 'read_file', args: { path: 'GOALS.md' } }],
  } },
  { type: 'tool.result', data: {
    callId: 'c1-t1', name: 'read_file', args: { path: 'GOALS.md' },
    content: 'Flyt makes structured AI work…', result: { text: 'the whole file, untruncated' },
  } },
  { type: 'block.output', data: { blockId: 'work', content: '# What I did\n\nRead the goals.' } },
  { type: 'block.status', data: { blockId: 'work', status: 'done' } },
  { type: 'run.stage', data: { stage: 'done', currentBlockId: null } },
];

async function aLoggedRun(dir, runId = 'run-1', events = A_RUN) {
  const store = new JsonlSessionStore(dir);
  const session = await store.open(runId);
  for (const event of events) await session.append(event);
  return session;
}

test('a log projects the run folder a person opens', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir);
    const projection = projectRun(session.readSync(), 'run-1');
    materialise(path.join(dir, 'run-1'), projection);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-1', 'meta.json'), 'utf8'));
    assert.equal(meta.runId, 'run-1');
    assert.equal(meta.stage, 'done');
    assert.equal(meta.stackId, 'loop-task');
    assert.equal(meta.stackName, 'Work one backlog task');
    assert.equal(meta.loopTaskId, 't-0048');
    assert.equal(meta.approvalMode, 'always');
    assert.equal(meta.workspace, 'C:\\worktrees\\t-0048');
    assert.deepEqual(meta.blockStatus, { work: 'done' });
    assert.equal(meta.error, null);

    assert.equal(
      fs.readFileSync(path.join(dir, 'run-1', 'blocks', 'work.md'), 'utf8'),
      '# What I did\n\nRead the goals.',
    );
    assert.equal(fs.readFileSync(path.join(dir, 'run-1', 'prompt.md'), 'utf8'), 'Work t-0048.');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, 'run-1', 'stack.json'), 'utf8')),
      { id: 'loop-task', blocks: [{ id: 'work' }] },
    );

    const tool = JSON.parse(fs.readFileSync(path.join(dir, 'run-1', 'tools', '1-read_file.json'), 'utf8'));
    assert.equal(tool.tool, 'read_file');
    assert.deepEqual(tool.result, { text: 'the whole file, untruncated' }, 'the full result, not the preview');
    assert.equal(tool.preview, 'Flyt makes structured AI work…');

    const calls = fs.readFileSync(path.join(dir, 'run-1', 'calls', 'work_task-1.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'deepseek/deepseek-v4-pro-0813');
    assert.equal(calls[0].usage.cost, 0.0079150896);
    assert.equal(calls[0].ms, 4910);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the projection carries every field v1 kept in meta.json', async () => {
  const dir = tmp();
  try {
    // What v1 writes, for the same run.
    const store = new RunStore(path.join(dir, 'v1'));
    const runId = store.createRun('Work t-0048.');
    store.setStage(runId, 'execution', {
      flowId: 'loop-task', flowName: 'Work one backlog task',
      workspace: 'C:\\worktrees\\t-0048', approvalMode: 'always', loopTaskId: 't-0048',
      nodeStatus: { work: 'done' }, currentNodeId: 'work',
    });
    const v1 = store.readMeta(runId);

    const session = await aLoggedRun(path.join(dir, 'v2'));
    const v2 = projectRun(session.readSync(), 'run-1').meta;

    // Same facts, v1 nouns to v2 nouns. Nothing v1 recorded is dropped.
    const renamed = { flowId: 'stackId', flowName: 'stackName', nodeStatus: 'blockStatus', currentNodeId: 'currentBlockId' };
    for (const key of Object.keys(v1)) {
      if (key === 'currentTaskId') continue; // v1's plan-era field; tasks are blocks now
      const target = renamed[key] ?? key;
      assert.ok(target in v2, `the projection dropped "${key}" (as "${target}")`);
    }
    assert.equal(v2.stackId, v1.flowId);
    assert.equal(v2.stackName, v1.flowName);
    assert.deepEqual(v2.blockStatus, v1.nodeStatus);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the ledger reads the log, so an unprojected call still counts', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir);
    const projection = projectRun(session.readSync(), 'run-1');
    materialise(path.join(dir, 'run-1'), projection);

    // The projection is derived, and derived files can be lost.
    fs.rmSync(path.join(dir, 'run-1', 'calls'), { recursive: true, force: true });

    const spend = spendFromLog(session.readSync());
    assert.equal(spend.length, 1);
    assert.equal(spend[0].usd, 0.0079150896);
    assert.equal(spend[0].estimated, false);
    assert.equal(spend[0].model, 'deepseek/deepseek-v4-pro-0813');
    assert.equal(spend[0].taskId, 'task-1', 'the request half supplies what the response half omits');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a cost nobody reported is null, never zero', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir, 'run-1', [
      { type: 'llm.request', data: { callId: 'c1', provider: 'anthropic', model: 'claude-sonnet-5' } },
      { type: 'llm.response', data: { callId: 'c1', ok: true, usage: { prompt_tokens: 10 } } },
    ]);
    const [entry] = spendFromLog(session.readSync());
    assert.equal(entry.usd, null);
    assert.equal(entry.estimated, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a request whose response never arrived is still in the trace', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir, 'run-1', [
      { type: 'run.stage', data: { stage: 'execution' } },
      { type: 'llm.request', data: { callId: 'c1', blockId: 'work', model: 'a-model' } },
    ]);
    const projection = projectRun(session.readSync(), 'run-1');
    assert.equal(projection.calls.length, 1);
    assert.equal(projection.calls[0].finishReason, 'never_returned');
    assert.equal(projection.calls[0].ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rebuilding repairs a projection that disagrees with the log', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir);
    const runDir = path.join(dir, 'run-1');
    materialise(runDir, projectRun(session.readSync(), 'run-1'));

    fs.writeFileSync(path.join(runDir, 'blocks', 'work.md'), 'something else entirely', 'utf8');
    fs.writeFileSync(path.join(runDir, 'meta.json'), '{"stage":"failed"}', 'utf8');

    materialise(runDir, projectRun(session.readSync(), 'run-1'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')).stage, 'done');
    assert.match(fs.readFileSync(path.join(runDir, 'blocks', 'work.md'), 'utf8'), /Read the goals/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an old run opens read-only, in the new nouns, without being converted', () => {
  const dir = tmp();
  try {
    // A run folder as v1 wrote it.
    const store = new RunStore(path.join(dir, 'runs'));
    const runId = store.createRun('An older question.');
    store.setStage(runId, 'done', {
      flowId: 'research', flowName: 'Research', nodeStatus: { orient: 'done' }, currentNodeId: 'orient',
    });
    store.writeFlow(runId, { id: 'research', nodes: [{ id: 'orient' }] });
    store.writeNodeOutput(runId, 'orient', '# What I found');
    store.writeToolResult(runId, { tool: 'web_search', args: { q: 'flyt' }, preview: 'three results' });
    const runDir = path.join(dir, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'calls'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'calls', 'orient.jsonl'),
      JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', provider: 'openrouter', model: 'a-model', ok: true, ms: 900 }) + '\n',
      'utf8',
    );

    assert.equal(hasSessionLog(runDir), false, 'it has no canonical record, and never will');

    const projection = readLegacyRun(runDir);
    assert.equal(projection.legacy, true);
    assert.equal(projection.meta.stackId, 'research');
    assert.equal(projection.meta.currentBlockId, 'orient');
    assert.deepEqual(projection.meta.blockStatus, { orient: 'done' });
    assert.equal(projection.blocks.orient, '# What I found');
    assert.equal(projection.prompt, 'An older question.');
    assert.equal(projection.tools[0].tool, 'web_search');
    assert.equal(projection.calls[0].model, 'a-model');

    // Nothing was written back into the old run.
    assert.equal(fs.existsSync(path.join(runDir, 'session.jsonl')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'blocks')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a half-written run still projects, rather than refusing to open', async () => {
  const dir = tmp();
  try {
    const session = await aLoggedRun(dir, 'run-1', A_RUN.slice(0, 4));
    const projection = projectRun(session.readSync(), 'run-1');
    assert.equal(projection.meta.stage, 'execution');
    assert.equal(projection.meta.currentBlockId, 'work');
    assert.deepEqual(projection.blocks, {}, 'the block never wrote anything, and that is the truth');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
