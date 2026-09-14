import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressDetector } from '#kernel';
import { describeToolReceipts } from '../kernel/dist/models/capabilities.js';
import { summarizeWorkflowRun } from '../core/conversationSupervisor.js';

test('missing-file retries separated by novel successful evidence do not stop an active investigation', () => {
  const detector = new ProgressDetector();
  const missing = { id: 'missing', name: 'read_file', args: { path: 'missing-plan.md' } };
  for (let i = 0; i < 4; i++) {
    assert.equal(detector.record(missing, true, 1000, true).clearLoop, false);
    detector.record({ id: String(i), name: 'read_file', args: { path: `evidence-${i}.md` } }, false, 1000, true);
  }
  assert.equal(detector.record(missing, true, 1000, true).clearLoop, false);
  assert.equal(detector.record(missing, true, 1000, true).clearLoop, false);
  assert.equal(detector.record(missing, true, 1000, true).clearLoop, true);
});

test('alternating old reads still trips repetition; a read does not excuse repeated writes', () => {
  const detector = new ProgressDetector();
  let stopped = false;
  for (let i = 0; i < 14; i++) {
    stopped ||= detector.record({ id: String(i), name: 'read_file', args: { path: i % 2 ? 'a' : 'b' } }, false, 100, true).clearLoop;
  }
  assert.equal(stopped, true);
  const writes = new ProgressDetector();
  const call = { id: 'write', name: 'write', args: {} };
  for (let i = 0; i < 2; i++) {
    assert.equal(writes.record(call, true, 10).clearLoop, false);
    writes.record({ id: String(i), name: 'read_file', args: { path: String(i) } }, false, 10, true);
  }
  assert.equal(writes.record(call, true, 10).clearLoop, true);
});

test('checkpoint receipts retain missing-file error and pair evidence queries with durable handles', () => {
  const receipts = describeToolReceipts([
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', args: { path: 'missing-plan.md' } }] },
    { role: 'tool', toolCallId: '1', content: '{"error":"ENOENT: missing-plan.md"}', handle: '@call:worker/1' },
  ]).join('\n');
  assert.match(receipts, /read_file\(missing-plan.md\).*@call:worker\/1.*ENOENT/);
});

test('optional summary times out, aborts the provider, and keeps run facts even if provider ignores abort', async () => {
  let signal;
  const result = await summarizeWorkflowRun({
    snapshot: { meta: { stage: 'done', nodeStatus: { worker: 'done' } }, nodeOutputs: { worker: 'Retained evidence' } },
    worker: { model: 'test' }, resolveModelSource: () => ({ provider: 'mock', model: 'test' }),
    callModel: request => { signal = request.signal; return new Promise(() => {}); }, deadlineMs: 15,
  });
  assert.equal(signal.aborted, true);
  assert.equal(result.degraded, true);
  assert.match(result.reason, /deadline/);
  assert.match(result.text, /Retained evidence/);
  assert.match(result.text, /Completed: worker/);
});

test('a rejected workflow cannot be recapped as verified by an optional model', async () => {
  const result = await summarizeWorkflowRun({
    snapshot: { meta: { stage: 'failed', nodeStatus: { research: 'failed', investigate: 'done' },
      error: 'Source quote did not match package.json' },
      nodeOutputs: { investigate: 'All sources verified', research: 'Incomplete: source evidence rejected' } },
    worker: { model: 'test' }, resolveModelSource: () => ({ provider: 'mock', model: 'test' }),
    callModel: () => { assert.fail('Incomplete runs use authoritative facts'); },
  });
  assert.match(result.text, /status: failed/);
  assert.equal(result.degraded, false, 'intentional deterministic summaries are not provider failures');
  assert.match(result.text, /source evidence rejected/);
  assert.match(result.text, /Source quote did not match package.json/);
  assert.doesNotMatch(result.text, /All sources verified/);
});
