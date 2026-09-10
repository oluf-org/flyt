/**
 * The run folder, rebuilt as a projection of the log.
 *
 * `runs/<id>/session.jsonl` is the record; everything beside it is derived
 * (D55). The projection exists because principle 1 is about a person opening a
 * folder, not about a person reading JSONL: `meta.json` still says what stage
 * a run reached, `blocks/*.md` still holds what each block wrote, and
 * `tools/*.json` still holds every tool result in full.
 *
 * What changes is which file is allowed to be wrong. If the projection and the
 * log disagree, the log is right and the projection is rebuilt — so the ledger
 * reads the log, and a settled call cannot escape a ceiling by failing to be
 * projected.
 *
 * @module #kernel/session/projection
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '../types.js';
import type { SessionEvent } from '../seams/sessions.js';

/** What the run folder's `meta.json` says. The same shape v1 wrote, in v2 nouns. */
export interface RunMeta {
  runId: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  /** prompt | planning | awaiting_approval | awaiting_input | execution | done | failed | ... */
  stage: string;
  currentBlockId: string | null;
  error: string | null;
  stackId: string | null;
  stackName: string | null;
  /** Where the work happened: the project, or a worktree for unattended work. */
  workspace: string | null;
  approvalMode: string | null;
  executionWorld: JsonValue;
  sandbox: JsonValue;
  /** Set when this run is a Loop worker's attempt at a backlog task. */
  loopTaskId: string | null;
  conversationId: string | null;
  parentRunId: string | null;
  userMessage: string | null;
  supervisorSummary: boolean;
  requireLaunchable: boolean;
  profile: string | null;
  presetId: string | null;
  model: string | null;
  provider: string | null;
  routing: JsonValue;
  blockWorkers: JsonValue;
  defaultFallbacks: JsonValue;
  blockFallbacks: JsonValue;
  tierWorkers: JsonValue;
  level: string | null;
  skills: JsonValue;
  /** blockId -> pending | active | done | failed | skipped. */
  blockStatus: Record<string, string>;
}

/** One model call, as the call trace records it. */
export interface CallRecord {
  ts: string;
  callId: string | null;
  blockId: string | null;
  taskId: string | null;
  provider: string | null;
  model: string | null;
  ok: boolean;
  ms: number | null;
  finishReason: string | null;
  usage: JsonValue;
  /** Present when the request did not get what it asked for. */
  route?: JsonValue;
}

/** One tool result, stored complete. */
export interface ToolRecord {
  seq: number;
  callId: string | null;
  tool: string;
  args: JsonValue;
  /** The bounded preview the model received. */
  preview: string;
  /** The complete result, untruncated. */
  result: JsonValue;
  error: string | null;
}

/** A whole run folder, in memory. */
export interface RunProjection {
  meta: RunMeta;
  /** The resolved stack at run start, or null for a run that never resolved one. */
  stack: JsonValue | null;
  prompt: string;
  /** blockId -> markdown. A port writes `<blockId>.<port>`. */
  blocks: Record<string, string>;
  tools: ToolRecord[];
  calls: CallRecord[];
  sandboxDecisions: JsonValue[];
  sandboxFailures: JsonValue[];
  /** True when this came from a legacy run folder rather than a log. */
  legacy: boolean;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function emptyMeta(runId: string): RunMeta {
  return {
    runId,
    name: null,
    createdAt: '',
    updatedAt: '',
    stage: 'prompt',
    currentBlockId: null,
    error: null,
    stackId: null,
    stackName: null,
    workspace: null,
    approvalMode: null,
    executionWorld: null,
    sandbox: null,
    loopTaskId: null,
    conversationId: null,
    parentRunId: null,
    userMessage: null,
    supervisorSummary: true,
    requireLaunchable: false,
    profile: null,
    presetId: null,
    model: null,
    provider: null,
    routing: null,
    blockWorkers: {},
    defaultFallbacks: [],
    blockFallbacks: {},
    tierWorkers: {},
    level: null,
    skills: [],
    blockStatus: {},
  };
}

/**
 * Fold a log into a run folder.
 *
 * Pure, and total: an incomplete log projects an incomplete run rather than
 * throwing, because the most important run to be able to open is the one that
 * died halfway.
 *
 * @param events — the log, in order.
 * @param runId — the run these events belong to.
 * @returns the projection.
 */
export function projectRun(events: readonly SessionEvent[], runId: string): RunProjection {
  const projector = createRunProjector(runId);
  for (const event of events) projector.append(event);
  return projector.snapshot();
}

/** Stateful form of the same fold. Finalization never mutates the live state. */
export function createRunProjector(runId: string, { retainArtifacts = true } = {}) {
  const meta = emptyMeta(runId);
  const projection: RunProjection = {
    meta, stack: null, prompt: '', blocks: {}, tools: [], calls: [], sandboxDecisions: [], sandboxFailures: [], legacy: false,
  };
  /** callId -> the request half, waiting for its response. */
  const pending = new Map<string, Partial<CallRecord>>();
  let toolSeq = 0;

  let firstAt: string | undefined;
  const append = (event: SessionEvent): void => {
    firstAt ??= event.at;
    const data = asRecord(event.data);
    meta.updatedAt = event.at || meta.updatedAt;

    switch (event.type) {
      case 'run.created':
        meta.createdAt = String(data.createdAt ?? event.at ?? '');
        meta.stackId = data.stackId ? String(data.stackId) : meta.stackId;
        meta.stackName = data.stackName ? String(data.stackName) : meta.stackName;
        meta.workspace = data.workspace ? String(data.workspace) : meta.workspace;
        meta.approvalMode = data.approvalMode ? String(data.approvalMode) : meta.approvalMode;
        if ('executionWorld' in data) meta.executionWorld = (data.executionWorld ?? null) as JsonValue;
        if ('sandbox' in data) meta.sandbox = (data.sandbox ?? null) as JsonValue;
        meta.loopTaskId = data.loopTaskId ? String(data.loopTaskId) : meta.loopTaskId;
        meta.conversationId = data.conversationId ? String(data.conversationId) : meta.conversationId;
        meta.parentRunId = data.parentRunId ? String(data.parentRunId) : meta.parentRunId;
        meta.userMessage = data.userMessage == null ? (typeof data.input === 'string' ? data.input : meta.userMessage) : String(data.userMessage);
        meta.supervisorSummary = data.supervisorSummary !== false;
        meta.requireLaunchable = Boolean(data.requireLaunchable);
        meta.profile = data.profile ? String(data.profile) : meta.profile;
        meta.presetId = data.presetId ? String(data.presetId) : meta.presetId;
        meta.model = data.model ? String(data.model) : meta.model;
        meta.provider = data.provider ? String(data.provider) : meta.provider;
        if ('routing' in data) meta.routing = (data.routing ?? null) as JsonValue;
        if ('blockWorkers' in data) meta.blockWorkers = (data.blockWorkers ?? {}) as JsonValue;
        if ('defaultFallbacks' in data) meta.defaultFallbacks = (data.defaultFallbacks ?? []) as JsonValue;
        if ('blockFallbacks' in data) meta.blockFallbacks = (data.blockFallbacks ?? {}) as JsonValue;
        if ('tierWorkers' in data) meta.tierWorkers = (data.tierWorkers ?? {}) as JsonValue;
        meta.level = data.level ? String(data.level) : meta.level;
        if ('skills' in data) meta.skills = (data.skills ?? []) as JsonValue;
        if (typeof data.prompt === 'string') projection.prompt = data.prompt;
        else if (typeof data.input === 'string') projection.prompt = data.input;
        break;

      case 'run.named':
        meta.name = data.name == null ? null : String(data.name);
        break;

      case 'run.reconfigured':
        if ('model' in data) meta.model = data.model == null ? null : String(data.model);
        if ('provider' in data) meta.provider = data.provider == null ? null : String(data.provider);
        if ('routing' in data) meta.routing = (data.routing ?? null) as JsonValue;
        if ('blockWorkers' in data) meta.blockWorkers = (data.blockWorkers ?? {}) as JsonValue;
        if ('defaultFallbacks' in data) meta.defaultFallbacks = (data.defaultFallbacks ?? []) as JsonValue;
        if ('blockFallbacks' in data) meta.blockFallbacks = (data.blockFallbacks ?? {}) as JsonValue;
        if ('tierWorkers' in data) meta.tierWorkers = (data.tierWorkers ?? {}) as JsonValue;
        if ('level' in data) meta.level = data.level == null ? null : String(data.level);
        if ('sandbox' in data) meta.sandbox = (data.sandbox ?? null) as JsonValue;
        break;

      case 'sandbox.decision':
      case 'sandbox.escalation':
        if (retainArtifacts) projection.sandboxDecisions.push({ type: event.type, at: event.at, ...data } as JsonValue);
        break;

      case 'sandbox.failure':
        if (retainArtifacts) projection.sandboxFailures.push({ at: event.at, ...data } as JsonValue);
        break;

      case 'stack.resolved':
        projection.stack = (data.stack ?? null) as JsonValue;
        if (data.stackId) meta.stackId = String(data.stackId);
        if (data.stackName) meta.stackName = String(data.stackName);
        break;

      case 'run.stage':
        meta.stage = String(data.stage ?? meta.stage);
        if ('currentBlockId' in data) meta.currentBlockId = data.currentBlockId ? String(data.currentBlockId) : null;
        if (data.error) meta.error = String(data.error);
        break;

      case 'run.error':
        meta.error = String(data.error ?? 'unknown error');
        meta.stage = String(data.stage ?? 'failed');
        break;

      case 'block.status': {
        const id = String(data.blockId ?? '');
        if (!id) break;
        meta.blockStatus[id] = String(data.status ?? 'pending');
        if (data.status === 'active') meta.currentBlockId = id;
        break;
      }

      case 'block.output': {
        const id = String(data.blockId ?? '');
        if (!id) break;
        const key = data.port ? `${id}.${String(data.port)}` : id;
        projection.blocks[key] = String(data.content ?? '');
        break;
      }

      case 'llm.request': {
        const callId = String(data.callId ?? '');
        pending.set(callId, {
          ts: event.at,
          callId: callId || null,
          blockId: data.blockId ? String(data.blockId) : null,
          taskId: data.taskId ? String(data.taskId) : null,
          provider: data.provider ? String(data.provider) : null,
          model: data.model ? String(data.model) : null,
        });
        break;
      }

      case 'llm.response': {
        const callId = String(data.callId ?? '');
        const half = pending.get(callId) ?? { ts: event.at, callId: callId || null };
        pending.delete(callId);
        const call: CallRecord = {
          ts: String(half.ts ?? event.at),
          callId: half.callId ?? null,
          blockId: half.blockId ?? (data.blockId ? String(data.blockId) : null),
          taskId: half.taskId ?? (data.taskId ? String(data.taskId) : null),
          provider: half.provider ?? (data.provider ? String(data.provider) : null),
          model: half.model ?? (data.model ? String(data.model) : null),
          ok: data.ok !== false && !data.error,
          ms: typeof data.ms === 'number' ? data.ms : null,
          finishReason: data.finishReason ? String(data.finishReason) : null,
          usage: (data.usage ?? null) as JsonValue,
        };
        if (data.route) call.route = data.route as JsonValue;
        projection.calls.push(call);
        break;
      }

      case 'tool.result': {
        if (!retainArtifacts) break;
        toolSeq += 1;
        projection.tools.push({
          seq: typeof data.seq === 'number' ? data.seq : toolSeq,
          callId: data.callId ? String(data.callId) : null,
          tool: String(data.name ?? 'tool'),
          args: (data.args ?? null) as JsonValue,
          preview: String(data.content ?? ''),
          result: (data.result ?? data.content ?? null) as JsonValue,
          error: data.error ? String(data.error) : null,
        });
        break;
      }

      default:
        break;
    }
  };

  const snapshot = (): RunProjection => {
    const result = { ...projection, meta: { ...meta, blockStatus: { ...meta.blockStatus } }, calls: [...projection.calls] };
    // A request whose response never arrived is still a call that happened. It
    // belongs in the trace, marked as unsettled, rather than vanishing because
    // the process died between the two events.
    for (const half of pending.values()) {
      result.calls.push({
        ts: String(half.ts ?? ''),
        callId: half.callId ?? null,
        blockId: half.blockId ?? null,
        taskId: half.taskId ?? null,
        provider: half.provider ?? null,
        model: half.model ?? null,
        ok: false,
        ms: null,
        finishReason: 'never_returned',
        usage: null,
      });
    }

    // The run lifecycle is authoritative over transient block markers. A crash
    // or scheduler-level exception can occur after `active` was appended but
    // before that block had a chance to append its own terminal status. Keeping
    // that marker active makes every projection claim work is still happening
    // after the run has explicitly ended.
    if (['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected'].includes(result.meta.stage)) {
      for (const [id, status] of Object.entries(result.meta.blockStatus)) {
        if (status !== 'active') continue;
        result.meta.blockStatus[id] = result.meta.stage === 'failed' ? 'failed' : 'pending';
      }
      result.meta.currentBlockId = null;
    }

    if (!result.meta.createdAt) result.meta.createdAt = firstAt ?? '';
    if (!result.meta.updatedAt) result.meta.updatedAt = result.meta.createdAt;
    return result;
  };
  return { append, snapshot };
}

/** One priced call, as the ledger records it. */
export interface SpendEntry {
  callId: string | null;
  taskId: string | null;
  model: string | null;
  provider: string | null;
  /** Null when the provider reported no cost and no table could price it. Never 0. */
  usd: number | null;
  estimated: boolean;
}

/**
 * What a run cost, read from the log.
 *
 * The ledger reads this rather than `calls/*.jsonl`, so a call that settled
 * but was never projected still counts against the ceiling. A cost the
 * provider reported is used as-is; an absent cost is null, never zero, because
 * "$0" must only ever mean it was free.
 *
 * @param events — the log, in order.
 * @returns one entry per settled model call.
 */
export function spendFromLog(events: readonly SessionEvent[]): SpendEntry[] {
  const out: SpendEntry[] = [];
  const requests = new Map<string, { model: string | null; provider: string | null; taskId: string | null }>();

  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === 'llm.request') {
      requests.set(String(data.callId ?? ''), {
        model: data.model ? String(data.model) : null,
        provider: data.provider ? String(data.provider) : null,
        taskId: data.taskId ? String(data.taskId) : null,
      });
      continue;
    }
    if (event.type !== 'llm.response') continue;

    const callId = String(data.callId ?? '');
    const request = requests.get(callId);
    const usage = asRecord(data.usage);
    const reported = typeof usage.costUsd === 'number'
      ? usage.costUsd
      : typeof usage.cost === 'number'
        ? usage.cost
        : null;
    out.push({
      callId: callId || null,
      taskId: (data.taskId ? String(data.taskId) : null) ?? request?.taskId ?? null,
      model: (data.model ? String(data.model) : null) ?? request?.model ?? null,
      provider: (data.provider ? String(data.provider) : null) ?? request?.provider ?? null,
      usd: reported,
      estimated: reported === null,
    });
  }
  return out;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

const safe = (id: string) => String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');

/**
 * Write a projection into a run folder, beside the log it came from.
 *
 * Rebuilding is always safe: every file written here is derived, so a folder
 * that disagrees with the log is repaired by running this again.
 *
 * @param dir — the run folder.
 * @param projection — what to write.
 */
export function materialise(dir: string, projection: RunProjection): void {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'meta.json'), projection.meta);
  if (projection.stack !== null) writeJson(path.join(dir, 'stack.json'), projection.stack);
  if (projection.prompt) fs.writeFileSync(path.join(dir, 'prompt.md'), projection.prompt, 'utf8');

  for (const [blockId, content] of Object.entries(projection.blocks)) {
    const file = path.join(dir, 'blocks', `${safe(blockId)}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }

  for (const record of projection.tools) {
    writeJson(path.join(dir, 'tools', `${record.seq}-${safe(record.tool)}.json`), record);
  }

  /** One file per block, the way the call trace is grouped today. */
  const byFile = new Map<string, CallRecord[]>();
  for (const call of projection.calls) {
    const name = `${safe(call.blockId ?? 'run')}${call.taskId ? `_${safe(call.taskId)}` : ''}.jsonl`;
    const list = byFile.get(name) ?? [];
    list.push(call);
    byFile.set(name, list);
  }
  for (const [name, calls] of byFile) {
    const file = path.join(dir, 'calls', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, calls.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf8');
  }
}

/**
 * Materialise only projection files whose value changed since the preceding
 * fold. The full {@link materialise} function remains the repair/rebuild path;
 * this is the live path used while an append-only log is growing.
 */
export function materialiseChanged(
  dir: string,
  projection: RunProjection,
  previous: RunProjection | null = null,
): void {
  if (!previous) { materialise(dir, projection); return; }
  fs.mkdirSync(dir, { recursive: true });
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (!same(previous.meta, projection.meta)) writeJson(path.join(dir, 'meta.json'), projection.meta);

  const stackFile = path.join(dir, 'stack.json');
  if (!same(previous.stack, projection.stack)) {
    if (projection.stack === null) fs.rmSync(stackFile, { force: true });
    else writeJson(stackFile, projection.stack);
  }
  const promptFile = path.join(dir, 'prompt.md');
  if (previous.prompt !== projection.prompt) {
    if (projection.prompt) fs.writeFileSync(promptFile, projection.prompt, 'utf8');
    else fs.rmSync(promptFile, { force: true });
  }

  const blockDir = path.join(dir, 'blocks');
  for (const [blockId, content] of Object.entries(projection.blocks)) {
    if (previous.blocks[blockId] === content) continue;
    const file = path.join(blockDir, `${safe(blockId)}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  for (const blockId of Object.keys(previous.blocks)) {
    if (!(blockId in projection.blocks)) fs.rmSync(path.join(blockDir, `${safe(blockId)}.md`), { force: true });
  }

  const toolFile = (record: ToolRecord): string => `${record.seq}-${safe(record.tool)}.json`;
  const oldTools = new Map(previous.tools.map(record => [toolFile(record), record]));
  const nextTools = new Set<string>();
  for (const record of projection.tools) {
    const name = toolFile(record);
    nextTools.add(name);
    if (!same(oldTools.get(name), record)) writeJson(path.join(dir, 'tools', name), record);
  }
  for (const name of oldTools.keys()) {
    if (!nextTools.has(name)) fs.rmSync(path.join(dir, 'tools', name), { force: true });
  }

  const groupedCalls = (calls: readonly CallRecord[]): Map<string, CallRecord[]> => {
    const grouped = new Map<string, CallRecord[]>();
    for (const call of calls) {
      const name = `${safe(call.blockId ?? 'run')}${call.taskId ? `_${safe(call.taskId)}` : ''}.jsonl`;
      const list = grouped.get(name) ?? [];
      list.push(call);
      grouped.set(name, list);
    }
    return grouped;
  };
  const oldCalls = groupedCalls(previous.calls);
  const nextCalls = groupedCalls(projection.calls);
  for (const [name, calls] of nextCalls) {
    const before = oldCalls.get(name) ?? [];
    const file = path.join(dir, 'calls', name);
    // Calls in one block are append-only except for its newest request, which
    // may gain a response after an overlapping parallel projection. When the
    // prior tail is unchanged, append only the new JSONL records instead of
    // rewriting the block's complete call history on every turn.
    const priorTailUnchanged = before.length === 0
      || (before.length <= calls.length && same(before.at(-1), calls[before.length - 1]));
    if (priorTailUnchanged && (before.length === 0 || fs.existsSync(file))) {
      if (calls.length === before.length) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, calls.slice(before.length).map(call => JSON.stringify(call)).join('\n') + '\n', 'utf8');
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, calls.map(call => JSON.stringify(call)).join('\n') + '\n', 'utf8');
  }
  for (const name of oldCalls.keys()) {
    if (!nextCalls.has(name)) fs.rmSync(path.join(dir, 'calls', name), { force: true });
  }
}

/**
 * Read a legacy run folder — one written before the log existed.
 *
 * Read-only and lossy on purpose (D55): an old run does not gain a trace it
 * never recorded, and converting one would be inventing a record. What it gets
 * is the ability to open, which is what a person actually wants from a run
 * from six weeks ago.
 *
 * @param dir — the run folder.
 * @returns the projection, marked `legacy`.
 */
export function readLegacyRun(dir: string): RunProjection {
  const runId = path.basename(dir);
  const projection: RunProjection = {
    meta: emptyMeta(runId), stack: null, prompt: '', blocks: {}, tools: [], calls: [], sandboxDecisions: [], sandboxFailures: [], legacy: true,
  };
  const read = (rel: string) => {
    const file = path.join(dir, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const readJson = (rel: string) => {
    const text = read(rel);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
  };

  const old = asRecord(readJson('meta.json'));
  Object.assign(projection.meta, {
    runId: String(old.runId ?? runId),
    name: old.name == null ? null : String(old.name),
    createdAt: String(old.createdAt ?? ''),
    updatedAt: String(old.updatedAt ?? old.createdAt ?? ''),
    stage: String(old.stage ?? 'unknown'),
    // v1 nouns on the way in, v2 nouns on the way out: node -> block, flow -> stack.
    currentBlockId: old.currentNodeId ? String(old.currentNodeId) : null,
    error: old.error ? String(old.error) : null,
    stackId: old.flowId ? String(old.flowId) : null,
    stackName: old.flowName ? String(old.flowName) : null,
    workspace: old.workspace ? String(old.workspace) : null,
    approvalMode: old.approvalMode ? String(old.approvalMode) : null,
    loopTaskId: old.loopTaskId ? String(old.loopTaskId) : null,
    blockStatus: asRecord(old.nodeStatus),
  });

  projection.stack = readJson('flow.json');
  projection.prompt = read('prompt.md') ?? '';

  const nodesDir = path.join(dir, 'nodes');
  if (fs.existsSync(nodesDir)) {
    for (const file of fs.readdirSync(nodesDir)) {
      if (file.endsWith('.md')) projection.blocks[file.slice(0, -3)] = fs.readFileSync(path.join(nodesDir, file), 'utf8');
    }
  }

  const toolsDir = path.join(dir, 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const file of fs.readdirSync(toolsDir).sort()) {
      const record = asRecord(readJson(path.join('tools', file)));
      projection.tools.push({
        seq: typeof record.seq === 'number' ? record.seq : projection.tools.length + 1,
        callId: record.callId ? String(record.callId) : null,
        tool: String(record.tool ?? file.replace(/^\d+-|\.json$/g, '')),
        args: (record.args ?? null) as JsonValue,
        preview: String(record.preview ?? record.content ?? ''),
        result: (record.result ?? null) as JsonValue,
        error: record.error ? String(record.error) : null,
      });
    }
  }

  const callsDir = path.join(dir, 'calls');
  if (fs.existsSync(callsDir)) {
    for (const file of fs.readdirSync(callsDir).sort()) {
      const text = read(path.join('calls', file)) ?? '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: Record<string, any>;
        try { parsed = asRecord(JSON.parse(line)); } catch { continue; }
        projection.calls.push({
          ts: String(parsed.ts ?? ''),
          callId: parsed.callId ? String(parsed.callId) : null,
          blockId: parsed.nodeId ? String(parsed.nodeId) : (file.split('_')[0] ?? null),
          taskId: parsed.taskId ? String(parsed.taskId) : null,
          provider: parsed.provider ? String(parsed.provider) : null,
          model: parsed.model ? String(parsed.model) : null,
          ok: parsed.ok !== false,
          ms: typeof parsed.ms === 'number' ? parsed.ms : null,
          finishReason: parsed.finishReason ? String(parsed.finishReason) : null,
          usage: (parsed.usage ?? null) as JsonValue,
        });
      }
    }
  }

  return projection;
}

/** Whether this run folder has a canonical record, or is one of the old ones. */
export function hasSessionLog(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'session.jsonl'));
}
