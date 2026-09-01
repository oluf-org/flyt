// Crash recovery at both sides of the tool boundary, with a real process
// really being killed — not a simulated one. A committed call that dies inside
// execution is reconstructed with an unknown-effect result; an input that dies
// while the model is still generating it remains exact partial evidence and is
// never promoted into something executable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, NEVER_RETURNED } from '#kernel';

const repo = fileURLToPath(new URL('..', import.meta.url));
const KERNEL = new URL('../kernel/dist/index.js', import.meta.url).href;

// A run that gets as far as asking for a tool, and is killed while the tool is
// still running. SIGKILL to its own pid, so no exit handler, no finally block
// and no flush gets a chance to tidy the log on the way out — which is the
// whole point: what survives has to survive without cooperation.
const A_RUN_THAT_DIES = `
// Imported by URL rather than by the "#kernel" subpath: this script lives in a
// temp directory, and a subpath import resolves against the script's own
// nearest package.json, which is not ours.
const { JsonlSessionStore } = await import(process.argv[3]);

const store = new JsonlSessionStore(process.argv[2]);
const session = await store.open('run-1');
await session.append({ type: 'run.stage', data: { stage: 'execution' } });
await session.append({ type: 'message.user', data: { content: 'Tidy the temp files.' } });
await session.append({ type: 'llm.response', data: {
  content: 'Running that now.',
  toolCalls: [{ id: 'call-1', name: 'bash', args: { command: 'rm -rf tmp' } }],
} });
await session.append({ type: 'tool.call', data: { callId: 'call-1', name: 'bash' } });
// ...the tool is now running, and the process dies here.
process.kill(process.pid, 'SIGKILL');
await new Promise(() => {});
`;

const A_MODEL_INPUT_THAT_DIES = `
const { JsonlSessionStore } = await import(process.argv[3]);
const session = await new JsonlSessionStore(process.argv[2]).open('run-input');
await session.append({ type: 'message.user', data: { content: 'Write a file.' } });
await session.append({ type: 'llm.request', data: { callId: 'request-1', model: 'm' } });
await session.append({ type: 'tool.input.start', data: {
  requestCallId: 'request-1', inputId: 'input-1', index: 0, toolCallId: 'call-1', name: 'write_file'
} });
await session.append({ type: 'tool.input.delta', data: {
  requestCallId: 'request-1', inputId: 'input-1', index: 0, delta: '{"path":"half'
} });
process.kill(process.pid, 'SIGKILL');
await new Promise(() => {});
`;

test('a tool call the process died inside is reconstructed on replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-crash-'));
  try {
    const script = path.join(dir, 'a-run-that-dies.mjs');
    fs.writeFileSync(script, A_RUN_THAT_DIES, 'utf8');

    const child = spawnSync(process.execPath, [script, dir, KERNEL], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(child.status, 0, `the run was supposed to die, not finish: ${child.stderr}`);

    // Nothing tidied up. What is on disk is what the run had written.
    const log = path.join(dir, 'run-1', 'session.jsonl');
    assert.ok(fs.existsSync(log), 'the log survived the process that wrote it');

    const session = await new JsonlSessionStore(dir).read('run-1');
    assert.equal(await session.head(), 4, 'every event that was appended is there');

    const messages = await session.deriveMessages();
    const last = messages[messages.length - 1];
    assert.equal(last.role, 'tool');
    assert.equal(last.toolCallId, 'call-1');
    assert.equal(last.name, 'bash');
    assert.equal(last.content, NEVER_RETURNED);

    // And the conversation resumes in the right shape: the assistant's request
    // is still there, answered, so the next model request is well-formed
    // rather than an assistant turn with a call nobody replied to.
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool']);
    assert.equal(messages[1].toolCalls[0].id, 'call-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a run killed mid-append leaves a log the next writer can continue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-crash-'));
  try {
    const script = path.join(dir, 'a-run-that-dies.mjs');
    fs.writeFileSync(script, A_RUN_THAT_DIES, 'utf8');
    spawnSync(process.execPath, [script, dir, KERNEL], { cwd: repo, encoding: 'utf8' });

    // A torn line, as a kill during the write would leave.
    fs.appendFileSync(path.join(dir, 'run-1', 'session.jsonl'), '{"seq":5,"type":"tool.res');

    const session = await new JsonlSessionStore(dir).open('run-1');
    const resumed = await session.append({
      type: 'tool.result',
      data: { callId: 'call-1', name: 'bash', error: 'this call did not survive a restart' },
    });
    assert.equal(resumed.seq, 5, 'the torn line never got a seq, so 5 is still free');

    const messages = await session.deriveMessages();
    assert.match(messages[messages.length - 1].content, /did not survive a restart/,
      'and the reconstructed answer is the real one now, not the synthetic one');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a process killed while the model streams tool arguments leaves the exact partial input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-input-crash-'));
  try {
    const script = path.join(dir, 'a-model-input-that-dies.mjs');
    fs.writeFileSync(script, A_MODEL_INPUT_THAT_DIES, 'utf8');
    const child = spawnSync(process.execPath, [script, dir, KERNEL], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(child.status, 0);

    const session = await new JsonlSessionStore(dir).read('run-input');
    const events = session.readSync();
    assert.deepEqual(events.map(event => event.type), [
      'message.user', 'llm.request', 'tool.input.start', 'tool.input.delta',
    ]);
    assert.equal(events.at(-1).data.delta, '{"path":"half');
    assert.deepEqual(await session.deriveMessages(), [{ role: 'user', content: 'Write a file.' }],
      'recovery retries the interrupted model step; it does not execute a half-generated call');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
