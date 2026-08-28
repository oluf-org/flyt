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
  /** Set when this run is a Loop worker's attempt at a backlog task. */
  loopTaskId: string | null;
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
  /** True when this came from a legacy run folder rather than a log. */
  legacy: boolean;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function emptyMeta(runId: string): RunMeta {
  return {
    runId,
    createdAt: '',
    updatedAt: '',
    stage: 'prompt',
    currentBlockId: null,
    error: null,
    stackId: null,
    stackName: null,
    workspace: null,
    approvalMode: null,
    loopTaskId: null,
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
  const meta = emptyMeta(runId);
  const projection: RunProjection = {
    meta, stack: null, prompt: '', blocks: {}, tools: [], calls: [], legacy: false,
  };
  /** callId -> the request half, waiting for its response. */
  const pending = new Map<string, Partial<CallRecord>>();
  let toolSeq = 0;

  for (const event of events) {
    const data = asRecord(event.data);
    meta.updatedAt = event.at || meta.updatedAt;

    switch (event.type) {
      case 'run.created':
        meta.createdAt = String(data.createdAt ?? event.at ?? '');
        meta.stackId = data.stackId ? String(data.stackId) : meta.stackId;
        meta.stackName = data.stackName ? String(data.stackName) : meta.stackName;
        meta.workspace = data.workspace ? String(data.workspace) : meta.workspace;
        meta.approvalMode = data.approvalMode ? String(data.approvalMode) : meta.approvalMode;
        meta.loopTaskId = data.loopTaskId ? String(data.loopTaskId) : meta.loopTaskId;
        if (typeof data.prompt === 'string') projection.prompt = data.prompt;
        else if (typeof data.input === 'string') projection.prompt = data.input;
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
  }

  // A request whose response never arrived is still a call that happened. It
  // belongs in the trace, marked as unsettled, rather than vanishing because
  // the process died between the two events.
  for (const half of pending.values()) {
    projection.calls.push({
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

  if (!meta.createdAt) meta.createdAt = events[0]?.at ?? '';
  if (!meta.updatedAt) meta.updatedAt = meta.createdAt;
  return projection;
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
    meta: emptyMeta(runId), stack: null, prompt: '', blocks: {}, tools: [], calls: [], legacy: true,
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
