// The backlog chat (DECISIONS.md D45): one agent turn loop over a read-mostly
// toolset whose single write is enqueue_task.
//
// The assertion that matters more than any other is the last one: the toolset
// must not resolve `bash`, `write_file` or `edit_file`. Asserted against the
// REGISTRY, not against the prompt — a system prompt is a request, and a chat
// that can write files is a second unsupervised loop with no worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore, runChatTurn, chatSystemPrompt, historyPrompt, CHAT_TOOLS } from '../core/chat.js';
import { resolveTools } from '../core/tools/index.js';
import { Backlog } from '../core/backlog.js';
import { setScript } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-chat-'));
const newStore = () => new ChatStore(path.join(tmp(), '.flyt', 'chats'));
const newBacklog = () => new Backlog(path.join(tmp(), '.flyt', 'backlog'));

const worker = { provider: 'script', model: 'test-model' };

// --- storage ---------------------------------------------------------------

test('a thread round-trips through its jsonl, one object per turn', () => {
  const store = newStore();
  const id = store.newThreadId();
  store.append(id, { role: 'user', text: 'why is t-0008 blocked?' });
  store.append(id, { role: 'assistant', text: 'It waits on t-0006, which does not exist.' });

  const turns = store.read(id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].text, 'It waits on t-0006, which does not exist.');
  assert.ok(turns[0].at, 'every turn is stamped');

  const raw = fs.readFileSync(path.join(store.rootDir, `${id}.jsonl`), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2, 'one line per turn — appendable and greppable');
});

test('a torn last line costs that line, not the thread', () => {
  const store = newStore();
  const id = store.newThreadId();
  store.append(id, { role: 'user', text: 'first' });
  // What a crash mid-append leaves behind.
  fs.appendFileSync(path.join(store.rootDir, `${id}.jsonl`), '{"role":"assistant","tex');
  const turns = store.read(id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'first');
});

test('threads() names each thread by what was actually asked, newest first', async () => {
  const store = newStore();
  const a = store.newThreadId();
  store.append(a, { role: 'user', text: 'what should I work on next?' });
  await new Promise(r => setTimeout(r, 5));
  const b = store.newThreadId();
  store.append(b, { role: 'user', text: 'why is the queue stuck?' });

  const threads = store.threads();
  assert.deepEqual(threads.map(t => t.id), [b, a]);
  // The first question IS the name: a model-generated title is a second call
  // to produce something less accurate than the sentence already there.
  assert.equal(threads[0].title, 'why is the queue stuck?');
  assert.equal(threads[1].turns, 1);
});

test('an unreadable thread is reported, never thrown past', () => {
  const store = newStore();
  fs.writeFileSync(path.join(store.rootDir, 'good.jsonl'), '{"role":"user","text":"hi","at":"2026-01-01T00:00:00.000Z"}\n');
  const threads = store.threads();
  assert.equal(threads.length, 1);
  assert.deepEqual(store.problems, []);
});

test('a thread can be deleted, and deleting a missing one is not an error', () => {
  const store = newStore();
  const id = store.newThreadId();
  store.append(id, { role: 'user', text: 'x' });
  assert.equal(store.remove(id), true);
  assert.equal(store.remove(id), false);
  assert.deepEqual(store.read(id), []);
});

test('an invalid thread id is refused before it becomes a path', () => {
  const store = newStore();
  assert.throws(() => store.read('../../etc/passwd'), /Invalid thread id/);
  assert.throws(() => store.append('a/b', {}), /Invalid thread id/);
});

// --- the system prompt -----------------------------------------------------

test('the system prompt is grounded in the actual board, not generic', () => {
  const tasks = [
    { id: 't-0001', title: 'A', status: 'queued', dependsOn: [], gates: [] },
    { id: 't-0002', title: 'B', status: 'queued', dependsOn: ['t-0006'], gates: [] },
    { id: 't-0003', title: 'C', status: 'parked', dependsOn: [], gates: [] }
  ];
  const prompt = chatSystemPrompt({
    projectName: 'flyt', tasks,
    ctx: { settings: { workers: { reviewer: { model: 'm' } }, loopModels: { low: 'm' } }, status: { running: true } }
  });
  assert.match(prompt, /"flyt"/);
  assert.match(prompt, /2 queued/);
  assert.match(prompt, /1 parked/);
  assert.match(prompt, /t-0002: Waiting for t-0006, which does not exist\./);
  // The instruction the whole phase turns on.
  assert.match(prompt, /PROPOSE A TASK AND CALL enqueue_task/);
  assert.match(prompt, /Do NOT attempt the work here/);
});

test('the system prompt carries a project-wide blocker as a project-wide fact', () => {
  const prompt = chatSystemPrompt({ tasks: [], ctx: { settings: { loopModels: { low: 'm' } }, status: {} } });
  assert.match(prompt, /BLOCKING THE WHOLE PROJECT/);
  assert.match(prompt, /No reviewer model is set/);
});

test('historyPrompt carries the conversation and is bounded', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }));
  const p = historyPrompt(many, 'and now?');
  assert.match(p, /USER: and now\?$/);
  assert.match(p, /EARLIER IN THIS CONVERSATION/);
  // A thread that ran all afternoon must not make every question cost the
  // afternoon again — the tools can re-read anything that matters.
  assert.ok(!p.includes('turn 0'), 'the oldest turns fall out of context');
  assert.ok(p.includes('turn 58'));
  // A fresh thread has no preamble at all.
  assert.equal(historyPrompt([], 'first?'), 'USER: first?');
});

// --- a turn ----------------------------------------------------------------

test('a turn that calls list_tasks answers from the real queue', async () => {
  const store = newStore();
  const backlog = newBacklog();
  backlog.add({ title: 'Build the board', goal: 'columns' });
  const id = store.newThreadId();

  let sawTools = null;
  setScript(({ system, prompt }) => {
    sawTools = system;
    if (!prompt.includes('TOOL RESULT')) {
      return ['Let me look.', '```tool', JSON.stringify({ tool: 'list_tasks', args: {} }), '```'].join('\n');
    }
    return 'There is one task queued: t-0001, "Build the board".';
  });

  const turn = await runChatTurn({
    store, threadId: id, text: 'what is in the backlog?', worker,
    tasks: backlog.list(), toolCtx: { backlog }
  });

  assert.equal(turn.role, 'assistant');
  assert.match(turn.text, /Build the board/);
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].tool, 'list_tasks');
  assert.equal(turn.toolCalls[0].ok, true);
  // The tool protocol was offered — this really is the agent loop.
  assert.match(sawTools, /ROLE: backlog-chat/);

  // Both halves are on disk, in order.
  const turns = store.read(id);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant']);
  assert.equal(turns[0].text, 'what is in the backlog?');
});

test('an enqueue_task call comes back as a proposal the human can commit', async () => {
  const store = newStore();
  const backlog = newBacklog();
  const id = store.newThreadId();

  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT')) {
      return ['I will queue that.', '```tool', JSON.stringify({
        tool: 'enqueue_task',
        args: { title: 'Split LoopPage into src/loop/', goal: 'It is 563 lines and this phase adds three surfaces.' }
      }), '```'].join('\n');
    }
    return 'Queued as t-0001.';
  });

  const turn = await runChatTurn({
    store, threadId: id, text: 'split the loop page up', worker, toolCtx: { backlog }
  });

  // The proposal is surfaced separately, because the UI renders it as a card
  // with Queue it / Discard: the model proposes, the human commits.
  assert.equal(turn.proposals.length, 1);
  assert.equal(turn.proposals[0].title, 'Split LoopPage into src/loop/');
  assert.ok(turn.proposals[0].id, 'it names the task it created');
  assert.equal(backlog.list().length, 1);
});

test('a model failure keeps the question, so you can see what broke it', async () => {
  const store = newStore();
  const id = store.newThreadId();
  setScript(() => { throw new Error('provider exploded'); });

  const turn = await runChatTurn({ store, threadId: id, text: 'anything?', worker, toolCtx: {} });
  assert.match(turn.error, /provider exploded/);
  const turns = store.read(id);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant']);
  assert.equal(turns[0].text, 'anything?');
});

test('an empty message is refused before anything is written', async () => {
  const store = newStore();
  const id = store.newThreadId();
  await assert.rejects(
    () => runChatTurn({ store, threadId: id, text: '   ', worker, toolCtx: {} }),
    /nothing to answer/
  );
  assert.deepEqual(store.read(id), []);
});

test('streaming and tool events reach the caller as they happen', async () => {
  const store = newStore();
  const backlog = newBacklog();
  const id = store.newThreadId();
  const events = [];
  setScript(({ prompt }) => (prompt.includes('TOOL RESULT')
    ? 'Nothing is queued.'
    : ['Checking.', '```tool', JSON.stringify({ tool: 'list_tasks', args: {} }), '```'].join('\n')));

  await runChatTurn({
    store, threadId: id, text: 'anything queued?', worker, toolCtx: { backlog },
    onEvent: e => events.push(e.kind + (e.tool ? `:${e.tool}` : ''))
  });
  // Two model calls around one tool call — the shape of a turn that looked
  // something up before answering. `model` and `tool` are distinct kinds on
  // purpose: they were conflated first, and one settled model call rendered as
  // a tool call the agent never made.
  assert.deepEqual(events, ['user', 'model', 'tool:list_tasks', 'model', 'assistant']);
});

// --- the toolset IS the design position ------------------------------------

test('the chat toolset cannot reach a shell or a file write', () => {
  const { tools, refused, missing } = resolveTools({ grant: CHAT_TOOLS, ceiling: CHAT_TOOLS });
  const names = tools.map(t => t.name);

  // Asserted against the REGISTRY, not the prompt. A prompt is a request; this
  // is what the run loop will actually bind.
  for (const forbidden of ['bash', 'write_file', 'edit_file', 'create_file', 'run_gate', 'update_task', 'web_fetch']) {
    assert.ok(!names.includes(forbidden), `chat must not be able to call ${forbidden}`);
  }
  // And what it CAN do: read the queue, read the code, read a run, queue work.
  for (const allowed of ['list_tasks', 'read_task', 'why_blocked', 'read_file', 'glob', 'read_run', 'enqueue_task']) {
    assert.ok(names.includes(allowed), `chat should be able to call ${allowed}`);
  }
  assert.deepEqual(refused, [], 'the ceiling and the grant are the same list, so nothing is refused');
  assert.deepEqual(missing, [], 'every named tool exists');
});

test('exactly ONE tool in the chat set writes anything', () => {
  const { tools } = resolveTools({ grant: CHAT_TOOLS, ceiling: CHAT_TOOLS });
  const writers = tools.filter(t => (t.effects ?? []).some(e => ['write', 'shell', 'destructive'].includes(e)));
  assert.deepEqual(writers.map(t => t.name), ['enqueue_task'],
    'the moment a second writer appears here, this is a loop without a worktree');
});
