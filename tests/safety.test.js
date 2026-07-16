// Minimal safety envelope (V1 task 4): a node flagged approveToolCalls pauses
// before each DESTRUCTIVE tool call (write_file / create_file / bash); read-only
// calls run unpaused. Approve runs the call, reject aborts the task. Path
// confinement holds under adversarial paths (traversal, null bytes, symlinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlowRunner } from '../core/flowRunner.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-safety-'));
const readLog = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

const gatedFlow = () => makeFlow(
  [ node('in', 'input', { text: 'edit the repo' }),
    node('work', 'agentTask', { title: 'Editor', goal: 'read then write', tools: ['read_file', 'write_file'], approveToolCalls: true }),
    node('out', 'output') ],
  [ edge('in', 'work'), edge('work', 'out') ]);

// read existing.txt (safe, no pause) -> write target.txt (gated) -> done.
function setReadThenWriteScript() {
  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT'))
      return '```tool\n{"tool":"read_file","args":{"path":"existing.txt"}}\n```';
    if (!prompt.includes('TOOL RESULT (write_file)'))
      return '```tool\n{"tool":"write_file","args":{"path":"target.txt","content":"written by agent\\n"}}\n```';
    return '## Done';
  });
}

function boundRunner() {
  const store = makeStore();
  const proj = tmpDir();
  fs.writeFileSync(path.join(proj, 'existing.txt'), 'seed\n');
  const ws = new Workspace(proj).ensure();
  return { store, proj, ws, runner: new FlowRunner(store, testConfig()) };
}

const waitForToolGate = (store, runId) => waitFor(() => {
  const m = store.readMeta(runId);
  return m.stage === 'awaiting_approval' && m.pendingGateKind === 'tool' ? m : null;
}, { label: 'tool gate' });

test('tool gate: read_file runs unpaused, write_file pauses, approve lands the write', async () => {
  const { store, proj, ws, runner } = boundRunner();
  setReadThenWriteScript();
  const runId = runner.start(gatedFlow(), { workspace: ws.root });

  const meta = await waitForToolGate(store, runId);
  // The first (and only) pause is the DESTRUCTIVE write — read_file was never gated.
  assert.equal(meta.pendingToolCall.tool, 'write_file');
  assert.equal(meta.pendingToolCall.summary, 'target.txt');
  assert.equal(fs.existsSync(path.join(proj, 'target.txt')), false); // nothing written before approval

  runner.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed', 'rejected']), 'done');
  assert.equal(fs.readFileSync(path.join(proj, 'target.txt'), 'utf8'), 'written by agent\n');
});

test('tool gate: rejecting a destructive call aborts the task, nothing is written', async () => {
  const { store, proj, ws, runner } = boundRunner();
  setReadThenWriteScript();
  const runId = runner.start(gatedFlow(), { workspace: ws.root });

  await waitForToolGate(store, runId);
  runner.rejectPlan(runId, 'no');
  assert.equal(await waitForStage(store, runId, ['done', 'failed', 'rejected']), 'rejected');
  assert.equal(fs.existsSync(path.join(proj, 'target.txt')), false); // the write never happened
  assert.ok(readLog(store, runId).some(e => e.event === 'tool_gate_decision' && e.decision === 'rejected'));
});

test('no gate flag: destructive tools run without pausing', async () => {
  const { store, proj, ws, runner } = boundRunner();
  setReadThenWriteScript();
  const flow = makeFlow(
    [ node('in', 'input', { text: 'x' }),
      node('work', 'agentTask', { title: 'Editor', goal: 'write', tools: ['read_file', 'write_file'] }), // approveToolCalls unset
      node('out', 'output') ],
    [ edge('in', 'work'), edge('work', 'out') ]);
  const runId = runner.start(flow, { workspace: ws.root });
  // If it wrongly paused we'd observe 'awaiting_approval' instead of 'done'.
  assert.equal(await waitForStage(store, runId, ['done', 'failed', 'awaiting_approval']), 'done');
  assert.equal(fs.readFileSync(path.join(proj, 'target.txt'), 'utf8'), 'written by agent\n');
});

// The gate has to survive delegation. A gated agent can call create_task (not
// itself destructive), and the spawned task has no flow node of its own — so a
// gate derived from the node graph simply wasn't there for it, and its
// write_file hit the real workspace unapproved. The flag now rides on the task
// and create_task copies it onto whatever it spawns.
test('tool gate: a task spawned by a gated node inherits the gate', async () => {
  const { store, proj, ws, runner } = boundRunner();
  // No `tools` restriction, so the agent has the full registry incl. create_task.
  const flow = makeFlow(
    [ node('in', 'input', { text: 'edit the repo' }),
      node('work', 'agentTask', { title: 'Editor', goal: 'delegate the work', approveToolCalls: true }),
      node('out', 'output') ],
    [ edge('in', 'work'), edge('work', 'out') ]);

  setScript(({ prompt }) => {
    const title = (prompt.match(/TASK:\s*(.+)/) ?? [])[1]?.trim();
    if (title === 'Editor') {
      return prompt.includes('TOOL RESULT')
        ? '## Delegated'
        : '```tool\n{"tool":"create_task","args":{"title":"Delegate","goal":"write a file"}}\n```';
    }
    return prompt.includes('TOOL RESULT')
      ? '## Done'
      : '```tool\n{"tool":"write_file","args":{"path":"delegated.txt","content":"via subtask\\n"}}\n```';
  });

  const runId = runner.start(flow, { workspace: ws.root });

  // The spawned task's write must pause, not sail through.
  const meta = await waitForToolGate(store, runId);
  assert.equal(meta.pendingToolCall.tool, 'write_file');
  assert.equal(meta.pendingToolCall.summary, 'delegated.txt');
  assert.equal(fs.existsSync(path.join(proj, 'delegated.txt')), false);

  const spawned = store.readTasks(runId).tasks.find(t => t.title === 'Delegate');
  assert.equal(spawned.approveToolCalls, true, 'create_task must copy the gate onto the child');
  assert.equal(spawned.createdBy, 'task-1');

  runner.rejectPlan(runId, 'no');
  assert.equal(await waitForStage(store, runId, ['done', 'failed', 'rejected']), 'rejected');
  assert.equal(fs.existsSync(path.join(proj, 'delegated.txt')), false); // still never written
});

test('confinement: null bytes and traversal are rejected', () => {
  const ws = new Workspace(tmpDir()).ensure();
  assert.throws(() => ws.resolve('a\0b'), /null byte/);
  assert.throws(() => ws.resolve('../x'), /escapes the workspace/);
  assert.throws(() => ws.resolve('../../etc/passwd'), /escapes the workspace/);
});

test('confinement: a symlink pointing outside the workspace is rejected', () => {
  const proj = tmpDir();
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
  const ws = new Workspace(proj).ensure();
  try {
    fs.symlinkSync(outside, path.join(proj, 'link'), 'dir');
  } catch {
    return; // creating symlinks needs privilege on Windows; skip where unavailable
  }
  // Lexically the path looks inside the workspace, but it realpaths outside.
  assert.throws(() => ws.resolve('link/secret.txt'), /symlink escape|escapes the workspace/);
});
