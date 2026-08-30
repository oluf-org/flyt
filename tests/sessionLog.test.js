// The canonical record (D55). Everything here is about one promise: what the
// model saw can be rebuilt from the log alone, including the call that never
// came back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, JsonlSessionStore, JsonlSession, deriveMessages, NEVER_RETURNED, sessionJsonl,
} from '#kernel';

function tempRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-session-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// One turn: a system prompt, a question, an answer that calls a tool, the
// tool's result, and the answer that follows it.
async function recordATurn(session) {
  await session.append({ type: 'message.system', data: { content: 'You are careful.' } });
  await session.append({ type: 'message.user', data: { content: 'How many files?' } });
  await session.append({ type: 'llm.request', data: { model: 'a-model', messages: 2 } });
  await session.append({
    type: 'llm.response',
    data: {
      content: 'Let me look.',
      reasoning: 'counting is a tool job',
      toolCalls: [{ id: 'call-1', name: 'glob', args: { pattern: '*' } }],
      finishReason: 'tool_calls',
    },
  });
  await session.append({ type: 'permission.decision', data: { callId: 'call-1', decision: 'allow' } });
  await session.append({ type: 'tool.result', data: { callId: 'call-1', name: 'glob', content: '3 files' } });
  await session.append({ type: 'llm.response', data: { content: 'Three.', finishReason: 'stop' } });
}

test('a log rebuilds exactly the messages the model saw', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await recordATurn(session);

    assert.deepEqual(await session.deriveMessages(), [
      { role: 'system', content: 'You are careful.' },
      { role: 'user', content: 'How many files?' },
      {
        role: 'assistant',
        content: 'Let me look.',
        reasoning: 'counting is a tool job',
        toolCalls: [{ id: 'call-1', name: 'glob', args: { pattern: '*' } }],
      },
      { role: 'tool', content: '3 files', toolCallId: 'call-1', name: 'glob' },
      { role: 'assistant', content: 'Three.' },
    ]);
  } finally { cleanup(); }
});

test('trace detail is logged and is not model-visible', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await recordATurn(session);

    const types = session.readSync().map(e => e.type);
    assert.ok(types.includes('llm.request'), 'the request is in the record');
    assert.ok(types.includes('permission.decision'), 'so is the permission decision');

    const messages = await session.deriveMessages();
    assert.equal(messages.filter(m => m.content.includes('a-model')).length, 0);
  } finally { cleanup(); }
});

test('a call that never returned is reconstructed, not dropped', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'Delete the temp files.' } });
    await session.append({
      type: 'llm.response',
      data: { content: '', toolCalls: [{ id: 'call-9', name: 'bash', args: { command: 'rm -rf tmp' } }] },
    });
    // ...and the process dies here, mid-tool.

    const messages = await new JsonlSession('run-1', store.fileFor('run-1')).deriveMessages();
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'tool');
    assert.equal(last.toolCallId, 'call-9');
    assert.equal(last.name, 'bash');
    assert.equal(last.content, NEVER_RETURNED);
    assert.match(last.content, /effect on the workspace is unknown/);
  } finally { cleanup(); }
});

test('replay from a cursor returns only what the caller has not seen', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await recordATurn(session);

    const first = [];
    for await (const event of session.read()) first.push(event.seq);
    assert.deepEqual(first, [1, 2, 3, 4, 5, 6, 7]);

    const cursor = first[3];
    const rest = [];
    for await (const event of session.read(cursor)) rest.push(event.seq);
    assert.deepEqual(rest, [5, 6, 7], 'nothing before the cursor is re-emitted');

    await session.append({ type: 'message.user', data: { content: 'And again?' } });
    const tail = [];
    for await (const event of session.read(7)) tail.push(event.type);
    assert.deepEqual(tail, ['message.user'], 'a live cursor picks up what arrived after it');
  } finally { cleanup(); }
});

test('deriveMessages to a point replays the conversation as it stood', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await recordATurn(session);

    const midway = await session.deriveMessages(4);
    assert.equal(midway.length, 4, 'three real messages and the unanswered call');
    assert.equal(midway[3].content, NEVER_RETURNED, 'at seq 4 the tool had not answered yet');
  } finally { cleanup(); }
});

test('a new writer recovers the sequence after a crash', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const first = await store.open('run-1');
    await first.append({ type: 'message.user', data: { content: 'one' } });
    await first.append({ type: 'message.user', data: { content: 'two' } });

    const second = await new JsonlSessionStore(dir).open('run-1'); // a fresh process, same file
    assert.equal(await second.head(), 2);
    const third = await second.append({ type: 'message.user', data: { content: 'three' } });
    assert.equal(third.seq, 3, 'the next seq continues, it does not restart');
  } finally { cleanup(); }
});

test('parallel blocks share one writer and one parsed event cache per run', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const [one, two, three] = await Promise.all([
      store.open('run-1'), store.open('run-1'), store.open('run-1'),
    ]);
    assert.equal(one, two);
    assert.equal(two, three);
    const written = await Promise.all(Array.from({ length: 40 }, (_, index) => (
      (index % 2 ? one : two).append({ type: 'message.user', data: { content: String(index) } })
    )));
    assert.deepEqual(written.map(event => event.seq), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(one.readSync().length, 40);
  } finally { cleanup(); }
});

test('a torn final line is repaired, and the repair is stated', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'complete' } });
    fs.appendFileSync(store.fileFor('run-1'), '{"seq":2,"type":"message.user","da');

    const reopened = await store.open('run-1');
    const written = await reopened.append({ type: 'message.user', data: { content: 'after the crash' } });

    assert.equal(written.seq, 2, 'the torn line never got a seq, so 2 is still free');
    assert.deepEqual(reopened.readSync().map(e => e.data.content), ['complete', 'after the crash']);
    assert.match(reopened.problems.map(p => p.reason).join(' '), /torn final line, truncated/);
  } finally { cleanup(); }
});

test('a read-only handle repairs nothing', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'complete' } });
    const file = store.fileFor('run-1');
    fs.appendFileSync(file, '{"seq":2,"ty');
    const sizeBefore = fs.statSync(file).size;

    const reader = await store.read('run-1');
    await reader.head();
    assert.equal(fs.statSync(file).size, sizeBefore, 'the evidence is left alone');
    await assert.rejects(() => reader.append({ type: 'message.user', data: {} }), /read-only/);
  } finally { cleanup(); }
});

test('a corrupt line in the middle is reported, not swallowed', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    const session = await store.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'one' } });
    fs.appendFileSync(store.fileFor('run-1'), 'this is not JSON\n');
    await session.append({ type: 'message.user', data: { content: 'two' } });

    const reopened = await store.open('run-1');
    assert.equal(await reopened.head(), 2);
    assert.deepEqual(reopened.problems, [{ line: 2, reason: 'not a JSON event object' }]);
    assert.deepEqual(reopened.readSync().map(e => e.data.content), ['one', 'two']);
  } finally { cleanup(); }
});

test('a runId cannot escape the store', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    assert.throws(() => store.fileFor('../elsewhere'), /Not a run in this store/);
    assert.throws(() => store.fileFor('a/b'), /Not a run in this store/);
    await assert.rejects(() => store.read('run-nothing'), /no session log/);
  } finally { cleanup(); }
});

test('runs are listed newest first, and only if they have a log', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const store = new JsonlSessionStore(dir);
    for (const id of ['2026-01-01T00-00-00-000Z-aaaa', '2026-02-01T00-00-00-000Z-bbbb']) {
      await (await store.open(id)).append({ type: 'message.user', data: { content: id } });
    }
    fs.mkdirSync(path.join(dir, '2026-03-01T00-00-00-000Z-cccc'));
    assert.deepEqual(await store.list(), [
      '2026-02-01T00-00-00-000Z-bbbb',
      '2026-01-01T00-00-00-000Z-aaaa',
    ]);
  } finally { cleanup(); }
});

test('an event with no type is refused rather than written', async () => {
  const { dir, cleanup } = tempRuns();
  try {
    const session = await new JsonlSessionStore(dir).open('run-1');
    await assert.rejects(() => session.append({ data: { content: 'x' } }), /needs a type/);
    assert.equal(await session.head(), 0);
  } finally { cleanup(); }
});

test('deriveMessages folds a log it was handed, with no file in sight', () => {
  const messages = deriveMessages([
    { seq: 1, at: '', type: 'message.user', data: { content: 'hi' } },
    { seq: 2, at: '', type: 'tool.call', data: { callId: 'c1', name: 'read_file' } },
    { seq: 3, at: '', type: 'tool.result', data: { callId: 'c1', name: 'read_file', error: 'no such file' } },
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'tool', content: 'Error: no such file', toolCallId: 'c1', name: 'read_file' },
  ]);
});

test('the plugin provides ctx.sessions and republishes every append', async () => {
  const { dir, cleanup } = tempRuns();
  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(sessionJsonl, { root: dir });
    assert.ok(kernel.ctx.sessions, 'the seam resolves');

    const seen = [];
    kernel.ctx.on('session/append', (runId, event) => seen.push([runId, event.seq, event.type]));

    const session = await kernel.ctx.sessions.open('run-1');
    await session.append({ type: 'message.user', data: { content: 'hello' } });
    await session.append({ type: 'llm.response', data: { content: 'hi' } });

    assert.deepEqual(seen, [['run-1', 1, 'message.user'], ['run-1', 2, 'llm.response']]);
  } finally { await kernel.dispose(); cleanup(); }
});
