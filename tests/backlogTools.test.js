// The backlog READ tools (DECISIONS.md D45) plus run_gate, read_run and
// ask_human. `enqueue_task` gave an agent a way to add to the queue and no way
// to look at it; these are the other half.
//
// The load-bearing assertions here are the refusals: update_task's allowlist is
// the tool (an agent that can write `status: landed` is not being checked), and
// ask_human has to actually PARK the task rather than only saying it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Backlog } from '../core/backlog.js';
import { executeTool, resolveTools } from '../core/tools/index.js';
import { Workspace } from '../core/workspace.js';
import { EDITABLE } from '../core/tools/update_task.js';
import { QUESTION_PREFIX } from '../core/tools/ask_human.js';
import { makeStore } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-btools-'));

// A ctx with a real backlog, a real workspace and a run, the way a loop worker
// actually stands: the run's meta names the backlog task it belongs to.
function loopCtx({ files = {}, loopTaskId = null, gates = null } = {}) {
  const store = makeStore();
  const runId = store.createRun('backlog tools test');
  const proj = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(proj, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (gates) {
    fs.mkdirSync(path.join(proj, '.flyt'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.flyt', 'config.json'), JSON.stringify({ gates }));
  }
  const workspace = new Workspace(proj).ensure();
  const backlog = new Backlog(path.join(tmp(), '.flyt', 'backlog'));
  store.writeMeta(runId, {
    ...store.readMeta(runId), workspace: workspace.root,
    ...(loopTaskId ? { loopTaskId } : {})
  });
  return { store, runId, nodeId: 'work', workspace, backlog, proj };
}

// --- list_tasks / read_task ------------------------------------------------

test('list_tasks: titles and metadata, no bodies', async () => {
  const ctx = loopCtx();
  ctx.backlog.add({ title: 'First', goal: 'a long body that should not be in the list' });
  ctx.backlog.add({ title: 'Second', goal: 'another' });
  const rec = await executeTool('list_tasks', {}, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.total, 2);
  assert.equal(rec.result.tasks.length, 2);
  assert.equal(rec.result.tasks[0].body, undefined);
  assert.ok(rec.result.tasks.some(t => t.title === 'First'));
});

test('list_tasks: filters by status and honours the limit', async () => {
  const ctx = loopCtx();
  const a = ctx.backlog.add({ title: 'A', goal: 'g' });
  ctx.backlog.add({ title: 'B', goal: 'g' });
  ctx.backlog.update(a.id, { status: 'parked' });

  const parked = await executeTool('list_tasks', { status: 'parked' }, ctx);
  assert.equal(parked.result.tasks.length, 1);
  assert.equal(parked.result.tasks[0].id, a.id);

  const one = await executeTool('list_tasks', { limit: 1 }, ctx);
  assert.equal(one.result.tasks.length, 1);
  assert.equal(one.result.truncated, 1);
});

test('list_tasks: with no backlog bound, the failure says so instead of writing somewhere', async () => {
  const store = makeStore();
  const runId = store.createRun('unbound');
  const rec = await executeTool('list_tasks', {}, { store, runId });
  assert.equal(rec.ok, false);
  assert.match(rec.error, /No backlog is bound/);
});

test('read_task: the body comes back, and an unknown id names what does exist', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'Real one', goal: 'the goal text' });
  const ok = await executeTool('read_task', { id: t.id }, ctx);
  assert.equal(ok.ok, true);
  assert.match(ok.result.body, /the goal text/);

  const miss = await executeTool('read_task', { id: 't-9999' }, ctx);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /No task "t-9999"/);
  assert.match(miss.error, new RegExp(t.id));
});

// --- update_task -----------------------------------------------------------

test('update_task: writes the allowlisted fields', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'T', goal: 'g' });
  const rec = await executeTool('update_task', { id: t.id, gates: ['npm test'], level: 'high', effort: 5 }, ctx);
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.result.changed.sort(), ['effort', 'gates', 'level']);
  const after = ctx.backlog.get(t.id);
  assert.deepEqual(after.gates, ['npm test']);
  assert.equal(after.level, 'high');
  assert.equal(after.effort, 5);
});

test('update_task: cannot set status — the schema refuses it before the tool runs', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'T', goal: 'g' });
  const rec = await executeTool('update_task', { id: t.id, status: 'landed' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /Invalid arguments/);
  // And nothing moved.
  assert.equal(ctx.backlog.get(t.id).status, 'queued');
  // The allowlist is the tool: assert it explicitly so widening it is a
  // deliberate edit here rather than a slip in a schema.
  assert.deepEqual(EDITABLE, ['value', 'effort', 'level', 'dependsOn', 'gates', 'blastRadius', 'references', 'body']);
});

test('update_task: refuses a task a worker is holding, rather than racing the supervisor', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'T', goal: 'g' });
  ctx.backlog.update(t.id, { status: 'running' });
  const rec = await executeTool('update_task', { id: t.id, effort: 1 }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /running/);
  assert.equal(ctx.backlog.get(t.id).effort, 3);
});

test('update_task: naming only an id is an error that says what can be changed', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'T', goal: 'g' });
  const rec = await executeTool('update_task', { id: t.id }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /Nothing to change/);
});

// --- why_blocked -----------------------------------------------------------

test('why_blocked: names the missing dependency', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'Blocked one', goal: 'g', dependsOn: ['t-9999'] });
  const rec = await executeTool('why_blocked', { id: t.id }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.blocked, true);
  assert.equal(rec.result.blockers[0].kind, 'dep-missing');
  assert.match(rec.result.blockers[0].summary, /t-9999/);
});

test('why_blocked: a clear task says nothing is in its way', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'Fine', goal: 'g' });
  const rec = await executeTool('why_blocked', { id: t.id }, ctx);
  assert.equal(rec.result.blocked, false);
  assert.deepEqual(rec.result.blockers, []);
  assert.match(rec.result.note, /Nothing is blocking/);
});

test('why_blocked: with no id, it reports every blocked task and the project-wide ones', async () => {
  const ctx = loopCtx();
  ctx.backlog.add({ title: 'A', goal: 'g', dependsOn: ['t-9999'] });
  ctx.backlog.add({ title: 'B', goal: 'g' });
  const rec = await executeTool('why_blocked', {}, ctx);
  assert.equal(rec.result.blocked.length, 1);
  // No reviewer is configured in this ctx, so the board-level blocker is there.
  assert.ok(rec.result.project.some(b => b.kind === 'no-reviewer'));
});

// --- run_gate --------------------------------------------------------------

test('run_gate: runs a declared gate and reports the exit code', async () => {
  const ctx = loopCtx({ gates: ['node -e "process.exit(0)"'] });
  const rec = await executeTool('run_gate', {}, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.ok, true);
  assert.equal(rec.result.results[0].exitCode, 0);
});

test('run_gate: a failing gate is a successful CALL with ok:false in the result', async () => {
  const ctx = loopCtx({ gates: ['node -e "console.log(\'boom\'); process.exit(3)"'] });
  const rec = await executeTool('run_gate', {}, ctx);
  // The call ran — that is what rec.ok means. Whether the gate PASSED is the
  // result's business, and conflating the two is the ambiguity that makes
  // bash's exit codes untrustworthy (DESIGN-SPEC.md §8).
  assert.equal(rec.ok, true);
  assert.equal(rec.result.ok, false);
  assert.equal(rec.result.results[0].exitCode, 3);
  assert.match(rec.result.results[0].output, /boom/);
  assert.equal(rec.result.failure.exitCode, 3);
});

test('run_gate: an undeclared command is refused with the list of what is available', async () => {
  const ctx = loopCtx({ gates: ['node -e "process.exit(0)"'] });
  const rec = await executeTool('run_gate', { command: 'rm -rf /' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /is not a declared gate/);
  assert.match(rec.error, /node -e/);
});

test('run_gate: the task may ADD a gate, and that one is runnable', async () => {
  const ctx = loopCtx({ gates: ['node -e "process.exit(0)"'] });
  const t = ctx.backlog.add({ title: 'T', goal: 'g', gates: ['node -e "process.exit(0)" // extra'] });
  ctx.store.writeMeta(ctx.runId, { ...ctx.store.readMeta(ctx.runId), loopTaskId: t.id });
  const rec = await executeTool('run_gate', { command: 'node -e "process.exit(0)" // extra' }, ctx);
  assert.equal(rec.ok, true);
  assert.ok(rec.result.declared.length >= 2);
});

test('run_gate: unbound run says there are no gates rather than shelling out somewhere', async () => {
  const store = makeStore();
  const runId = store.createRun('unbound');
  const rec = await executeTool('run_gate', {}, { store, runId });
  assert.equal(rec.ok, false);
  assert.match(rec.error, /not bound to a project folder/);
});

// --- read_run --------------------------------------------------------------

test('read_run: summary reports the shape and the task it belongs to', async () => {
  const ctx = loopCtx({ loopTaskId: 't-0007' });
  const rec = await executeTool('read_run', { runId: ctx.runId }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.runId, ctx.runId);
  assert.equal(rec.result.loopTaskId, 't-0007');
  // createRun() writes the prompt; the summary carries it back clipped.
  assert.equal(rec.result.prompt, 'backlog tools test');
});

test('read_run: the log view pulls tool calls out of the noise', async () => {
  const ctx = loopCtx();
  ctx.store.appendLog(ctx.runId, { event: 'node_start', node: 'x' });
  ctx.store.appendLog(ctx.runId, { event: 'tool_call', tool: 'read_file', node: 'x', ok: true, ms: 4 });
  const rec = await executeTool('read_run', { runId: ctx.runId, what: 'log' }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.toolCalls.length, 1);
  assert.equal(rec.result.toolCalls[0].tool, 'read_file');
});

test('read_run: an unknown run is an error naming the run, not a crash', async () => {
  const ctx = loopCtx();
  const rec = await executeTool('read_run', { runId: 'run-does-not-exist' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /run-does-not-exist/);
});

// --- ask_human -------------------------------------------------------------

test('ask_human: parks the task with a question rather than a failure', async () => {
  const ctx = loopCtx();
  const t = ctx.backlog.add({ title: 'Ambiguous', goal: 'g' });
  ctx.store.writeMeta(ctx.runId, { ...ctx.store.readMeta(ctx.runId), loopTaskId: t.id });
  const rec = await executeTool('ask_human', {
    question: 'Should the drawer height be per project or global?',
    options: ['per project', 'global'],
    context: 'Both are one line; nothing in the plan says which.'
  }, ctx);

  assert.equal(rec.ok, true);
  assert.equal(rec.result.terminal, true);
  const after = ctx.backlog.get(t.id);
  assert.equal(after.status, 'parked');
  assert.ok(after.blockedReason.startsWith(QUESTION_PREFIX));
  assert.match(after.blockedReason, /per project or global/);
  assert.match(after.blockedReason, /\(1\) per project/);
  assert.match(after.blockedReason, /Already established/);
});

test('ask_human: a run with no backlog task tells the agent to say it in its output', async () => {
  const ctx = loopCtx();
  const rec = await executeTool('ask_human', { question: 'anything?' }, ctx);
  assert.equal(rec.ok, false);
  assert.match(rec.error, /not working a backlog task/);
});

// --- the loop toolset ------------------------------------------------------

test('the loop toolset resolves to the repo tools plus the queue tools', () => {
  const { tools, problems } = resolveTools({ ceiling: 'loop' });
  const names = tools.map(t => t.name);
  assert.deepEqual(problems ?? [], []);
  for (const want of ['edit_file', 'run_gate', 'list_tasks', 'read_task', 'why_blocked',
    'update_task', 'enqueue_task', 'read_run', 'ask_human', 'write_file', 'bash', 'read_file']) {
    assert.ok(names.includes(want), `loop set is missing ${want}`);
  }
  // Not the web: a backlog worker should be reading this repository, and a
  // task that genuinely needs the network names the `web` set itself.
  assert.ok(!names.includes('web_fetch'));
});
