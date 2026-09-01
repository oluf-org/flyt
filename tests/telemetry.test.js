import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetryStore, normalizeRunLog, normalizeSessionEvent, structuralArgs } from '../core/telemetry.js';
import { flatCsv, projectHistory } from '../core/telemetryProjection.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-telemetry-'));

test('telemetry writes versioned raw JSONL before building a projection', () => {
  const root = temp();
  try {
    const store = new TelemetryStore(root, { flushMs: 60_000 });
    store.record({ runId: 'run-1', traceId: 'run-1', kind: 'run.created', attributes: { apiKey: 'never-store-this' } });
    assert.equal(store.read().length, 1);
    const files = fs.readdirSync(path.join(root, 'events'));
    assert.equal(files.length, 1);
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'events', files[0]), 'utf8').trim());
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.attributes.apiKey, '[redacted]');
    assert.equal(raw.traceId, 'run-1');
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('model audit records become correlated request, milestone and provider result events', () => {
  const events = normalizeRunLog('project-1', 'run-1', {
    ts: '2026-09-01T10:00:02.000Z', event: 'model_call', node: 'executor:t-1',
    provider: 'openrouter', model: 'model-a', startedAt: '2026-09-01T10:00:00.000Z',
    promptChars: 100, messages: 2, maxTokens: 4096, tools: 1, toolNames: ['read_file'],
    firstByteMs: 100, firstReasoningMs: 120, firstVisibleMs: 400, firstToolInputMs: 900,
    contentChars: 80, reasoningChars: 120, toolCalls: 1, finishReason: 'tool_calls', ms: 2000,
    usage: { prompt_tokens: 25, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } },
  });
  assert.deepEqual(events.map(e => e.kind), ['llm.request', 'llm.first_byte', 'llm.first_reasoning', 'llm.first_visible_content', 'llm.first_tool_input', 'llm.result']);
  assert.ok(events.every(e => e.traceId === 'run-1'));
  assert.equal(events.at(-1).source, 'provider_reported');
  assert.equal(events.at(-1).measurements.reasoningTokens, 30);
  assert.equal(events.at(-1).taskId, 't-1');
});

test('request telemetry retains transport, budgets, cache writes, compaction, repair and progress counters', () => {
  const events = normalizeRunLog('p', 'r', {
    ts: '2026-09-01T10:00:02.000Z', event: 'model_call', provider: 'openai', model: 'gpt',
    queuedAt: '2026-09-01T10:00:00.000Z', dispatchAt: '2026-09-01T10:00:00.010Z',
    headersAt: '2026-09-01T10:00:00.100Z', completedAt: '2026-09-01T10:00:02.000Z',
    requestedOutputBudget: 4096, effectiveOutputBudget: 3000,
    contextTokens: 7000, contextLimit: 10000, contextUtilization: .7,
    usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 50, cache_write_tokens: 25 },
  });
  assert.equal(events[0].attributes.dispatchAt, '2026-09-01T10:00:00.010Z');
  assert.equal(events[0].measurements.effectiveOutputBudget, 3000);
  assert.equal(events[0].measurements.contextUtilization, .7);
  assert.equal(events.at(-1).measurements.cacheWriteTokens, 25);

  const budget = normalizeSessionEvent('p', 'r', {
    at: '2026-09-01T10:00:00Z', type: 'context.budget', data: {
      requested: { total: 9000 }, effective: { total: 6000 }, contextLimit: 10000,
      contextUtilization: .6, requestedOutput: 4096, effectiveOutput: 2048,
    },
  });
  assert.equal(budget.kind, 'llm.context_budget');
  assert.equal(budget.measurements.effectiveTokens, 6000);

  const checkpoint = normalizeSessionEvent('p', 'r', {
    at: '2026-09-01T10:00:00Z', type: 'context.checkpoint',
    data: { inputTokens: 9000, outputTokens: 3000, compressionRatio: 1 / 3 },
  });
  assert.equal(checkpoint.measurements.compressionRatio, 1 / 3);

  const response = normalizeSessionEvent('p', 'r', {
    at: '2026-09-01T10:00:00Z', type: 'llm.response', data: {
      toolCallRepairCount: 2, toolValidationCount: 1,
      tokensSinceDurableProgress: 1200, costSinceDurableProgress: .08,
    },
  });
  assert.equal(response.measurements.toolCallRepairCount, 2);
  assert.equal(response.measurements.tokensSinceDurableProgress, 1200);
});

test('tool telemetry retains safe structure rather than argument payloads', () => {
  const structure = structuralArgs({ path: 'src/private.js', apiKey: 'secret' });
  assert.deepEqual(structure.argumentKeys, ['apiKey', 'path']);
  assert.ok(structure.argumentBytes > 0);
  assert.match(structure.argumentHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(structure), /private|secret/);
});

test('history projection keeps reasoning descriptive and names no-visible output accurately', () => {
  const results = [
    { schemaVersion: 1, eventId: '1', traceId: 'r', spanId: 's1', runId: 'r', projectId: 'p', at: '2026-09-01T10:00:00Z', kind: 'llm.result', source: 'provider_reported', attributes: { model: 'm', ok: true, nativeToolCalls: 0 }, measurements: { promptTokens: 10, completionTokens: 100, reasoningTokens: 90, visibleChars: 20, durationMs: 1000 } },
    { schemaVersion: 1, eventId: '2', traceId: 'r', spanId: 's2', runId: 'r', projectId: 'p', at: '2026-09-01T10:00:02Z', kind: 'llm.result', source: 'provider_reported', attributes: { model: 'm', ok: true, nativeToolCalls: 0 }, measurements: { promptTokens: 10, completionTokens: 100, reasoningTokens: 95, visibleChars: 0, durationMs: 2000 } },
  ];
  const view = projectHistory(results);
  assert.equal(view.models[0].reasoningTokenShare, .93);
  assert.equal(view.quality.noVisibleOutputRate, .5);
  assert.equal(Object.hasOwn(view.quality, 'overReasoningRate'), false);
  assert.match(flatCsv(results), /schemaVersion,eventId/);
});

test('history derives workspace closure, recovery, and efficiency from correlated facts', () => {
  const base = { schemaVersion: 1, traceId: 'run-a', runId: 'run-a', projectId: 'p', source: 'harness_observed', attributes: {}, measurements: {} };
  const events = [
    { ...base, eventId: 'r0', spanId: 'r0', at: '2026-09-01T10:00:00Z', kind: 'run.created', attributes: { workflowId: 'implementation', workflowVersion: 'v2', taskClass: 'change' } },
    { ...base, eventId: 'p0', spanId: 'p0', at: '2026-09-01T10:00:01Z', kind: 'planner.accepted', attributes: { attempt: 1 } },
    { ...base, eventId: 'l0', spanId: 'l0', at: '2026-09-01T10:00:02Z', kind: 'llm.result', source: 'provider_reported', attributes: { model: 'm', ok: true }, measurements: { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, costUsd: .03, durationMs: 900 } },
    { ...base, eventId: 't0', spanId: 't0', taskId: 'task', at: '2026-09-01T10:00:03Z', kind: 'tool.result', attributes: { tool: 'edit_file', ok: false, schemaValid: true, effects: ['write'], scope: 'workspace' } },
    { ...base, eventId: 't1', spanId: 't1', taskId: 'task', at: '2026-09-01T10:00:04Z', kind: 'tool.result', attributes: { tool: 'edit_file', ok: true, schemaValid: true, effects: ['write'], scope: 'workspace' } },
    { ...base, eventId: 'w0', spanId: 'w0', taskId: 'task', at: '2026-09-01T10:00:05Z', kind: 'workspace.effect_observed', attributes: { workspaceChange: true, ok: true } },
    { ...base, eventId: 'g0', spanId: 'g0', taskId: 'task', at: '2026-09-01T10:00:06Z', kind: 'verification.gate', attributes: { status: 'pass', code: 0, supportsFinalClaim: true } },
    { ...base, eventId: 's0', spanId: 's0', at: '2026-09-01T10:00:07Z', kind: 'run.stage', attributes: { stage: 'done' } },
  ];
  const view = projectHistory(events);
  assert.equal(view.quality.failedCallRecoveryRate, 1);
  assert.equal(view.quality.verificationClosureRate, 1);
  assert.equal(view.latency.timeToFirstWorkspaceEffectMs, 4000);
  assert.equal(view.efficiency.tokensPerAcceptedPlan, 150);
  assert.equal(view.efficiency.costPerVerifiedCompletionUsd, .03);
  assert.equal(view.comparisons[0].reasoningTokenShare, .4);
});
