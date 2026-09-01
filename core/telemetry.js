// Global transparency telemetry.
//
// The durable record is date-partitioned JSONL. SQLite is a rebuildable query
// index when the host runtime exposes node:sqlite (Electron's Node does); older
// CLI/test runtimes transparently use the same projection code over JSONL.
// This deliberately keeps the writer contract smaller than either backend so
// a future remote sink can replace the local implementation without entering
// model/tool execution code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

export const TELEMETRY_SCHEMA_VERSION = 1;
export const PROJECTION_VERSION = 1;
export const SOURCES = new Set(['provider_reported', 'harness_observed', 'derived', 'estimated']);
const FLUSH_MS = 120;
const MAX_BATCH = 250;
const IDLE_GAP_MS = 1_000;

const require = createRequire(import.meta.url);

function sqliteModule() {
  try { return require('node:sqlite'); } catch { return null; }
}

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function safeNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function sum(object, keys) {
  for (const key of keys) if (safeNumber(object?.[key]) != null) return Number(object[key]);
  return null;
}
function sha(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
}
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }

// Retain shape, not secrets or payloads. Existing run logs already redact
// credentials; the global store is stricter because it aggregates every run.
export function structuralArgs(args) {
  const object = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const json = JSON.stringify(object);
  return {
    argumentKeys: Object.keys(object).sort(),
    argumentBytes: Buffer.byteLength(json, 'utf8'),
    argumentHash: sha(json),
  };
}

function clean(value, depth = 0) {
  if (depth > 5) return '[depth]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 200);
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    /(^|_)(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)($|_)/i.test(key)
      ? '[redacted]'
      : clean(item, depth + 1),
  ]));
}

function envelope(input) {
  const at = input.at ?? iso();
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: input.eventId ?? id('evt'),
    traceId: String(input.traceId ?? input.runId ?? id('run')),
    spanId: String(input.spanId ?? id('span')),
    parentSpanId: input.parentSpanId ?? null,
    runId: input.runId ?? null,
    projectId: input.projectId ?? null,
    blockId: input.blockId ?? null,
    taskId: input.taskId ?? null,
    step: safeNumber(input.step),
    at,
    monotonicMs: safeNumber(input.monotonicMs) ?? performance.now(),
    kind: String(input.kind ?? 'unknown'),
    source: SOURCES.has(input.source) ? input.source : 'harness_observed',
    attributes: clean(input.attributes ?? {}),
    measurements: clean(input.measurements ?? {}),
  };
}

function usageMeasurements(usage = {}, record = {}) {
  const detail = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  return {
    promptTokens: sum(usage, ['prompt_tokens', 'input_tokens']),
    completionTokens: sum(usage, ['completion_tokens', 'output_tokens']),
    reasoningTokens: sum(detail, ['reasoning_tokens']) ?? sum(usage, ['reasoning_tokens']),
    cachedTokens: sum(usage.prompt_tokens_details, ['cached_tokens']) ?? sum(usage, ['cached_tokens']),
    cacheWriteTokens: sum(usage.prompt_tokens_details, ['cache_write_tokens']) ?? sum(usage, ['cache_write_tokens']),
    costUsd: safeNumber(record.cost ?? usage.cost ?? usage.total_cost),
  };
}

const EVENT_KIND = {
  run_created: 'run.created', flow_run_created: 'run.created', stage_change: 'run.stage',
  model_retry: 'llm.attempt', tool_call: 'tool.result', tool_repeat: 'tool.repeated',
  wave_start: 'scheduler.wave', task_wave: 'scheduler.wave', task_claimed: 'scheduler.task_start',
  task_error: 'scheduler.task_end', human_decision: 'human.decision',
  run_stopped: 'scheduler.cancelled', run_interrupted: 'scheduler.restart',
  route_fallback: 'llm.route_fallback', plan_validated: 'planner.accepted', plan_rejected: 'planner.rejected',
  fanout_planned: 'planner.candidate', backlog_plan_warning: 'planner.diagnostic',
  tool_gate_pause: 'tool.approval_requested', tool_gate_decision: 'tool.approval',
  tool_gate_abandoned: 'tool.approval_cancelled', approval_gate_skipped: 'tool.approval_skipped',
  input_gate: 'human.question_requested', question_asked: 'human.question_requested',
  input_answered: 'human.question_answered',
  effect_contract: 'workspace.effect_contract', effect_missing: 'workspace.effect_missing',
  effect_observed: 'workspace.effect_observed', effect_unverified: 'workspace.effect_unverified', workspace_write_conflict: 'workspace.conflict',
  gate_run: 'verification.gate',
};

/** Convert the compatibility runner's audit vocabulary into the common envelope. */
export function normalizeRunLog(projectId, runId, entry, monotonicMs = performance.now()) {
  const baseEventId = entry.__telemetryEventId ?? null;
  const common = {
    projectId, runId, traceId: runId, blockId: entry.node ?? null,
    taskId: entry.task ?? (String(entry.node ?? '').startsWith('executor:') ? String(entry.node).slice(9) : null),
    at: entry.ts ?? iso(), monotonicMs,
  };
  if (entry.event === 'model_call') {
    const spanId = id('span');
    const startedAt = entry.startedAt ?? iso(Date.parse(entry.ts ?? iso()) - (Number(entry.ms) || 0));
    const usage = entry.usage ?? {};
    const request = envelope({ ...common, eventId: baseEventId ? `${baseEventId}_request` : null, spanId, at: startedAt, kind: 'llm.request', source: 'harness_observed',
      attributes: {
        requestedProvider: entry.requestedProvider ?? entry.provider, effectiveProvider: entry.provider,
        requestedModel: entry.requestedModel ?? entry.model, effectiveModel: entry.servedBy ?? entry.model,
        fallbackRung: entry.fallbackRung ?? 0, messages: entry.messages, promptChars: entry.promptChars,
        toolSchemasOffered: entry.toolNames ?? [], toolSchemaCount: entry.tools ?? 0,
        outputCeiling: entry.maxTokens, temperature: entry.temperature ?? null, effort: entry.effort ?? null,
        queuedAt: entry.queuedAt ?? null, dispatchAt: entry.dispatchAt ?? null,
        headersAt: entry.headersAt ?? null, completedAt: entry.completedAt ?? null,
      }, measurements: {
        queueTimeMs: safeNumber(entry.queueTimeMs),
        requestedOutputBudget: safeNumber(entry.requestedOutputBudget ?? entry.maxTokens),
        effectiveOutputBudget: safeNumber(entry.effectiveOutputBudget ?? entry.maxTokens),
        contextTokens: safeNumber(entry.contextTokens), contextLimit: safeNumber(entry.contextLimit),
        contextUtilization: safeNumber(entry.contextUtilization),
      } });
    const milestones = [
      ['llm.first_byte', entry.firstByteMs], ['llm.first_reasoning', entry.firstReasoningMs],
      ['llm.first_visible_content', entry.firstVisibleMs], ['llm.first_tool_input', entry.firstToolInputMs],
      ['llm.last_chunk', entry.lastChunkMs],
    ].filter(([, value]) => safeNumber(value) != null).map(([kind, elapsed]) => envelope({
      ...common, eventId: baseEventId ? `${baseEventId}_${kind.replaceAll('.', '_')}` : null, spanId, parentSpanId: spanId, at: iso(Date.parse(startedAt) + Number(elapsed)), kind,
      source: 'harness_observed', measurements: { elapsedMs: Number(elapsed) },
    }));
    const measured = usageMeasurements(usage, entry);
    const result = envelope({ ...common, eventId: baseEventId ? `${baseEventId}_result` : null, spanId, parentSpanId: spanId, kind: 'llm.result',
      source: entry.estimated || usage.estimated ? 'estimated' : (Object.keys(usage).length ? 'provider_reported' : 'harness_observed'),
      attributes: {
        provider: entry.provider, model: entry.servedBy ?? entry.model, finishReason: entry.finishReason ?? null,
        ok: entry.ok !== false, errorClass: entry.errorClass ?? (entry.ok === false ? 'model_error' : null),
        error: entry.error ?? null, nativeToolCalls: entry.toolCalls ?? 0,
        unparsedDialect: entry.unparsedToolCall ?? null,
        firstByteAt: entry.firstByteAt ?? null, firstReasoningAt: entry.firstReasoningAt ?? null,
        firstVisibleAt: entry.firstVisibleAt ?? null, firstToolCallAt: entry.firstToolCallAt ?? null,
      }, measurements: {
        durationMs: safeNumber(entry.attemptMs ?? entry.ms), totalDurationMs: safeNumber(entry.ms), visibleChars: safeNumber(entry.contentChars),
        reasoningChars: safeNumber(entry.reasoningChars), streamedChars: safeNumber(entry.streamedChars),
        streamIdleGapCount: entry.streamIdleGaps?.length ?? 0,
        maxStreamIdleGapMs: entry.streamIdleGaps?.length ? Math.max(...entry.streamIdleGaps) : null,
        tokensBeforeFirstVisibleContent: safeNumber(entry.tokensBeforeFirstVisible),
        tokensBeforeFirstNativeToolCall: safeNumber(entry.tokensBeforeFirstTool),
        milestoneTokensEstimated: entry.milestoneTokensEstimated === true,
        ...measured,
      } });
    return [request, ...milestones, result];
  }
  if (entry.event === 'tool_call') {
    const structure = structuralArgs(entry.args);
    return [envelope({ ...common, eventId: baseEventId, kind: 'tool.result', source: 'harness_observed',
      attributes: {
        tool: entry.tool, ok: entry.ok !== false, schemaValid: entry.schemaValid,
        validationDiagnostics: entry.validationDiagnostics ?? [], resultStatus: entry.ok === false ? 'failed' : 'success',
        effects: entry.effects ?? [], scope: entry.scope ?? null, risk: entry.risk ?? null,
        artifact: entry.artifact ?? null, handle: entry.handle ?? null, ...structure,
      }, measurements: { durationMs: safeNumber(entry.ms), resultBytes: safeNumber(entry.bytes) } })];
  }
  const kind = EVENT_KIND[entry.event] ?? `harness.${String(entry.event ?? 'event').replaceAll('_', '.')}`;
  const attributes = { ...entry };
  delete attributes.ts; delete attributes.event; delete attributes.args; delete attributes.__telemetryEventId;
  return [envelope({ ...common, eventId: baseEventId, kind, source: 'harness_observed', attributes })];
}

/** Convert canonical kernel session lines without changing their immutable source. */
export function normalizeSessionEvent(projectId, runId, event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const kind = event.type === 'llm.request' ? 'llm.request'
    : event.type === 'llm.stream' ? 'llm.stream'
    : event.type === 'llm.response' ? 'llm.result'
    : event.type === 'tool.call' ? 'tool.call'
    : event.type === 'tool.result' ? 'tool.result'
    : event.type === 'tool.state' ? 'tool.state'
    : event.type === 'context.budget' ? 'llm.context_budget'
    : event.type === 'context.checkpoint' ? 'compaction.checkpoint'
    : event.type === 'permission.decision' ? 'tool.approval'
    : event.type;
  const source = event.type === 'llm.response' && data.usage ? 'provider_reported' : 'harness_observed';
  const attributes = event.type === 'tool.call'
    ? { tool: data.call?.name ?? data.name ?? null, callId: data.call?.id ?? data.callId ?? null, ...structuralArgs(data.call?.arguments ?? data.args) }
    : clean(data);
  const measurements = event.type === 'llm.response'
    ? {
        ...usageMeasurements(data.usage ?? {}, data),
        requestedOutputBudget: safeNumber(data.requestedOutputBudget),
        effectiveOutputBudget: safeNumber(data.effectiveOutputBudget),
        toolCallRepairCount: safeNumber(data.toolCallRepairCount),
        toolValidationCount: safeNumber(data.toolValidationCount),
        tokensSinceDurableProgress: safeNumber(data.tokensSinceDurableProgress),
        costSinceDurableProgress: safeNumber(data.costSinceDurableProgress),
      }
    : event.type === 'context.budget' ? {
        requestedTokens: safeNumber(data.requested?.total), effectiveTokens: safeNumber(data.effective?.total),
        contextLimit: safeNumber(data.contextLimit), contextUtilization: safeNumber(data.contextUtilization),
        requestedOutputBudget: safeNumber(data.requestedOutput), effectiveOutputBudget: safeNumber(data.effectiveOutput),
      }
    : event.type === 'context.checkpoint' ? {
        inputTokens: safeNumber(data.inputTokens), outputTokens: safeNumber(data.outputTokens),
        compressionRatio: safeNumber(data.compressionRatio),
      } : {};
  return envelope({
    projectId, runId, traceId: runId, blockId: data.blockId ?? null, step: data.step,
    at: event.at, kind, source, attributes,
    measurements,
  });
}

class SqliteIndex {
  constructor(file) {
    const sqlite = sqliteModule();
    if (!sqlite?.DatabaseSync) throw new Error('node:sqlite unavailable');
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2500;
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
        trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
        run_id TEXT, project_id TEXT, block_id TEXT, task_id TEXT, step REAL,
        monotonic_ms REAL, attributes TEXT NOT NULL, measurements TEXT NOT NULL, schema_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE INDEX IF NOT EXISTS events_kind_at ON events(kind, at);
      CREATE INDEX IF NOT EXISTS events_run_at ON events(run_id, at);
      CREATE INDEX IF NOT EXISTS events_model_results ON events(kind, at) WHERE kind='llm.result';
    `);
    this.insert = this.db.prepare(`INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }
  append(rows) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of rows) this.insert.run(
        e.eventId, e.at, e.kind, e.source, e.traceId, e.spanId, e.parentSpanId,
        e.runId, e.projectId, e.blockId, e.taskId, e.step, e.monotonicMs,
        JSON.stringify(e.attributes), JSON.stringify(e.measurements), e.schemaVersion,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }
  all({ from = null, to = null, kinds = null, runId = null, limit = 100_000 } = {}) {
    const where = [], args = [];
    if (from) { where.push('at >= ?'); args.push(from); }
    if (to) { where.push('at <= ?'); args.push(to); }
    if (runId) { where.push('run_id = ?'); args.push(runId); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
    args.push(Math.max(1, Math.min(Number(limit) || 100_000, 250_000)));
    return this.db.prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC LIMIT ?`).all(...args).map(row => ({
      schemaVersion: row.schema_version, eventId: row.event_id, traceId: row.trace_id, spanId: row.span_id,
      parentSpanId: row.parent_span_id, runId: row.run_id, projectId: row.project_id, blockId: row.block_id,
      taskId: row.task_id, step: row.step, at: row.at, monotonicMs: row.monotonic_ms, kind: row.kind,
      source: row.source, attributes: JSON.parse(row.attributes), measurements: JSON.parse(row.measurements),
    }));
  }
  close() { this.db.close(); }
}

function datesBetween(from, to) {
  const start = from ? new Date(from) : null, end = to ? new Date(to) : null;
  if (!start || !end || Number.isNaN(+start) || Number.isNaN(+end)) return null;
  const out = [];
  for (let at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); at <= +end; at += 86_400_000) out.push(iso(at).slice(0, 10));
  return out;
}

export class TelemetryStore {
  constructor(rootDir, { flushMs = FLUSH_MS } = {}) {
    this.rootDir = rootDir;
    this.eventsDir = path.join(rootDir, 'events');
    this.flushMs = flushMs;
    this.queue = [];
    this.timer = null;
    fs.mkdirSync(this.eventsDir, { recursive: true });
    try { this.index = new SqliteIndex(path.join(rootDir, 'telemetry.sqlite')); }
    catch { this.index = null; }
  }
  get backend() { return this.index ? 'jsonl+sqlite' : 'jsonl'; }
  record(input) {
    const row = envelope(input);
    this.queue.push(row);
    if (this.queue.length >= MAX_BATCH) this.flush();
    else if (!this.timer) { this.timer = setTimeout(() => this.flush(), this.flushMs); this.timer.unref?.(); }
    return row;
  }
  recordRunLog(projectId, runId, entry) { return normalizeRunLog(projectId, runId, entry).map(row => this.record(row)); }
  recordSessionEvent(projectId, runId, event) { return this.record(normalizeSessionEvent(projectId, runId, event)); }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rows = this.queue.splice(0);
    if (!rows.length) return 0;
    const byDay = new Map();
    for (const row of rows) {
      const day = row.at.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(row));
    }
    // Raw first. The SQLite index is explicitly disposable and rebuildable.
    for (const [day, lines] of byDay) fs.appendFileSync(path.join(this.eventsDir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    try { this.index?.append(rows); } catch { /* raw data already survived */ }
    return rows.length;
  }
  read(filters = {}) {
    this.flush();
    if (this.index) return this.index.all(filters);
    const selected = datesBetween(filters.from, filters.to);
    const names = selected ?? fs.readdirSync(this.eventsDir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).map(name => name.slice(0, 10));
    const out = [], seen = new Set();
    for (const day of names) {
      const file = path.join(this.eventsDir, `${day}.jsonl`);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (filters.from && event.at < filters.from) continue;
        if (filters.to && event.at > filters.to) continue;
        if (filters.runId && event.runId !== filters.runId) continue;
        if (filters.kinds?.length && !filters.kinds.includes(event.kind)) continue;
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId); out.push(event);
        if (out.length >= (filters.limit ?? 100_000)) return out;
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
  close() { this.flush(); this.index?.close(); }
}

export { IDLE_GAP_MS };
