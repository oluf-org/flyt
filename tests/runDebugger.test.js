import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeWorkflowRun, deterministicDebugReport, workflowDebugFacts } from '../core/runDebugger.js';

const snapshot = { meta: { runId: 'run-1', stackId: 'ship', stage: 'failed', currentBlockId: 'verify' }, prompt: 'Ship it' };
const events = [
  { type: 'block.status', data: { blockId: 'build', status: 'done' } },
  { type: 'block.output', data: { blockId: 'build', content: 'first output' } },
  { type: 'step.prompt', data: { blockId: 'verify', content: 'Run the tests' } },
  { type: 'llm.request', data: { callId: 'c1', blockId: 'verify', model: 'model-a' } },
  { type: 'tool.result', data: { blockId: 'verify', name: 'bash', error: 'tests failed' } },
  { type: 'block.status', data: { blockId: 'verify', status: 'failed', error: 'gate failed' } },
];

test('debug facts retain causal prompts, failures and output history', () => {
  const facts = workflowDebugFacts(snapshot, events);
  assert.equal(facts.run.stage, 'failed');
  assert.equal(facts.blocks.find(block => block.id === 'verify').error, 'gate failed');
  assert.equal(facts.tools[0].error, 'tests failed');
  assert.equal(facts.outputs[0].content, 'first output');
  assert.equal(facts.notable[0].content, 'Run the tests');
});

test('deterministic report points to the failed block and recorded tool evidence', () => {
  const report = deterministicDebugReport(workflowDebugFacts(snapshot, events));
  assert.equal(report.suspectedBlockId, 'verify');
  assert.match(report.probableCause, /tests failed/);
  assert.equal(report.confidence, 'high');
});

test('debug agent parses a structured report and keeps the evidence packet', async () => {
  const report = await analyzeWorkflowRun({
    snapshot, events, worker: { provider: 'mock', model: 'debugger' },
    resolveModelSource: () => ({ provider: 'mock', model: 'debugger' }),
    callModel: async () => ({ text: JSON.stringify({
      summary: 'Verification failed.', probableCause: 'The test command returned a failure.', confidence: 'high',
      suspectedBlockId: 'verify', evidence: ['bash: tests failed'], suggestedAreas: ['test setup'],
      suggestedPrompt: 'Re-run the focused test and repair the implementation.', recommendedAction: 'Retry verify.',
    }) }),
  });
  assert.equal(report.degraded, false);
  assert.equal(report.suspectedBlockId, 'verify');
  assert.equal(report.facts.tools[0].name, 'bash');
});

test('debugger follows child sessions and resolves repaired planner warnings before attributing terminal failure', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'repaired-planner-stream-termination.json'), 'utf8'));
  const parent = [
    ...fixture.plannerWarnings.map((warning, index) => ({ seq: index + 1, type: 'block.warning', data: { blockId: 'dispatch', ...warning, reason: 'static check failed' } })),
    { seq: 3, type: 'block.output', data: { blockId: 'dispatch', port: 'plan', content: '{"tasks":[]}' } },
    { seq: 4, type: 'child.session', data: { sessionId: fixture.childSessionId, taskId: 'audit', stage: 'active' } },
  ];
  const child = [
    { seq: 1, type: 'step.start', data: { blockId: 'worker', step: 38 } },
    { seq: 2, type: 'llm.request', data: { blockId: 'worker', callId: 'worker-38', model: fixture.terminal.model } },
    { seq: 3, type: 'llm.stream', data: { blockId: 'worker', callId: 'worker-38', reasoning: 'thinking' } },
    { seq: 4, type: 'llm.failure', data: { blockId: 'worker', callId: 'worker-38', step: 38, failure: fixture.terminal } },
  ];
  const report = await analyzeWorkflowRun({
    snapshot: { meta: { runId: 'run-audit', stage: 'failed', currentBlockId: 'dispatch.audit' } },
    events: parent, readSession: async id => id === fixture.childSessionId ? child : [],
  });
  assert.equal(report.facts.failures[0].sessionId, fixture.childSessionId);
  assert.ok(report.facts.blocks.find(block => block.id === 'dispatch').warnings.every(warning => warning.resolved));
  assert.match(report.probableCause, /initial graph failed two static checks and was successfully repaired/i);
  assert.match(report.probableCause, /worker-38/);
  assert.match(report.suggestedAreas[0], /event 4/);
});

test('configured debugger model cannot override terminal causal attribution', async () => {
  const failure = {
    code: 'stream_terminated', source: 'provider', provider: 'openrouter', model: 'z-ai/glm-5.3-flash',
    callId: 'worker-38', step: 38, retryable: true, userInitiated: false,
    visibleOutputProduced: false, reasoningOutputProduced: true, durableWriteProduced: false,
    detail: 'provider stream terminated unexpectedly',
  };
  const report = await analyzeWorkflowRun({
    snapshot: { meta: { runId: 'run-causal', stage: 'failed', currentBlockId: 'worker' } },
    events: [{ seq: 9, type: 'llm.failure', data: { blockId: 'worker', callId: 'worker-38', step: 38, failure } }],
    worker: { provider: 'mock', model: 'debugger' },
    resolveModelSource: () => ({ provider: 'mock', model: 'debugger' }),
    callModel: async () => ({ text: JSON.stringify({
      summary: 'The planner warning caused the failure.', probableCause: 'A stale warning caused the failure.', confidence: 'low',
      suspectedBlockId: 'planner', evidence: ['warning'], suggestedAreas: ['planner'], suggestedPrompt: 'Repair planner.', recommendedAction: 'Retry.',
    }) }),
  });
  assert.equal(report.degraded, false);
  assert.equal(report.suspectedBlockId, 'worker');
  assert.equal(report.confidence, 'high');
  assert.match(report.probableCause, /worker-38/);
  assert.match(report.evidence[0], /session=run-causal seq=9/);
});
