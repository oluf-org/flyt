/**
 * The canonical record: one append-only JSONL file per run.
 *
 * `runs/<id>/session.jsonl` is the truth and every other file in the run
 * folder is a projection of it (D55). The format is one JSON object per line
 * so the file stays what principle 1 asks for — openable in a text editor,
 * greppable, and the thing you send someone when a run goes wrong.
 *
 * **Model-visible means logged.** {@link deriveMessages} reconstructs the exact
 * message list a model saw from the log alone. Anything that reaches a model
 * request and is not in here is a bug in the writer, not a gap in the reader.
 *
 * @module #kernel/session/jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Message, ToolCall, JsonValue } from '../types.js';
import type { SessionEvent, SessionEventInput, SessionHandle, SessionsSeam } from '../seams/sessions.js';
export { SESSION_EVENTS } from './events.js';
import { SESSION_EVENT_SET } from './events.js';
import { materialise, projectRun } from './projection.js';
export type { SessionEventMap, SessionEventType, DurableSessionEvent, DurableSessionEventInput } from './events.js';

/** The event types {@link deriveMessages} folds. Everything else is trace detail. */
export const MESSAGE_EVENTS = [
  'message.system',
  'message.user',
  'llm.response',
  'tool.call',
  'tool.result',
] as const;

/**
 * The whole session-log vocabulary, in the order a run produces it.
 *
 * Written down because two things read this log and neither is the writer: the
 * projection turns it into a run folder, and Trace renders it for a person. A
 * vocabulary agreed by everyone remembering the same strings is a vocabulary
 * that drifts — the first trace read model written against it invented
 * `turn/start` and `step/start`, borrowing the SLASH names from
 * `kernel/src/events.ts`, which are cordis events and a different thing
 * entirely. Same run, two spellings, and the fold silently matched nothing.
 *
 * Dots, always. A cordis event is dispatched to listeners in this process; a
 * session event is a line in a file that outlives the process. They are named
 * apart because confusing them is a category error, not a typo.
 */
/** A line the reader could not parse, kept rather than swallowed. */
export interface LogProblem {
  /** 1-based line number in the file. */
  line: number;
  reason: string;
}

/**
 * A single durable event should be comfortably larger than any model response
 * the configured context windows permit. The bound is nevertheless explicit:
 * malformed or hostile evidence stays on disk, but can never make reopening a
 * run construct an unbounded JavaScript string.
 */
export const MAX_SESSION_EVENT_BYTES = 64 * 1024 * 1024;

/** Old builds copied the complete conversation into every step.prompt. */
export const MAX_INLINE_LEGACY_PROMPT_BYTES = 256 * 1024;
const SESSION_READ_CHUNK_BYTES = 256 * 1024;
const SESSION_HEADER_BYTES = 8 * 1024;

export interface SessionLogRead {
  events: SessionEvent[];
  problems: LogProblem[];
  head: number;
  size: number;
  /** Bytes ending at the last newline; the safe crash-repair boundary. */
  completeBytes: number;
  torn: boolean;
}

function headerNumber(prefix: string, key: string): number | undefined {
  const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function headerString(prefix: string, key: string): string | undefined {
  const match = prefix.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`));
  return match?.[1];
}

/**
 * Read JSONL incrementally, with memory bounded by one ordinary event.
 *
 * Completed legacy step.prompt snapshots above 256 KiB are represented by a
 * compact locator in memory. Their exact bytes remain untouched on disk; the
 * messages they duplicated are already canonical events. Any other event over
 * 64 MiB is reported and skipped rather than allowed to hit V8's hard string
 * ceiling. This reader is shared by recovery, projection, trace and append.
 */
export function readSessionLogFile(file: string, {
  maxEventBytes = MAX_SESSION_EVENT_BYTES,
  maxInlinePromptBytes = MAX_INLINE_LEGACY_PROMPT_BYTES,
}: {
  /** Injectable for regression tests; production callers use the hard default. */
  maxEventBytes?: number;
  /** Injectable for regression tests; production callers use the hard default. */
  maxInlinePromptBytes?: number;
} = {}): SessionLogRead {
  const stat = fs.statSync(file);
  const events: SessionEvent[] = [];
  const problems: LogProblem[] = [];
  const chunk = Buffer.allocUnsafe(Math.min(SESSION_READ_CHUNK_BYTES, Math.max(1, stat.size)));
  const fd = fs.openSync(file, 'r');
  let position = 0;
  let completeBytes = 0;
  let lineNumber = 1;
  let lineBytes = 0;
  let parts: Buffer[] = [];
  let prefix = Buffer.alloc(0);
  let compactPrompt = false;
  let oversized = false;
  let head = 0;

  const add = (segment: Buffer): void => {
    if (!segment.length) return;
    lineBytes += segment.length;
    if (prefix.length < SESSION_HEADER_BYTES) {
      prefix = Buffer.concat([
        prefix,
        Buffer.from(segment.subarray(0, SESSION_HEADER_BYTES - prefix.length)),
      ]);
    }
    const header = prefix.toString('utf8');
    if (!compactPrompt && lineBytes > maxInlinePromptBytes
      && headerString(header, 'type') === 'step.prompt') {
      compactPrompt = true;
      parts = [];
    }
    if (!compactPrompt && !oversized && lineBytes > maxEventBytes) {
      oversized = true;
      parts = [];
    }
    if (!compactPrompt && !oversized) parts.push(Buffer.from(segment));
  };

  const finish = (): void => {
    if (!lineBytes) {
      lineNumber += 1;
      return;
    }
    const header = prefix.toString('utf8');
    const headerSeq = headerNumber(header, 'seq');
    if (oversized) {
      if (headerSeq !== undefined) head = Math.max(head, headerSeq);
      problems.push({
        line: lineNumber,
        reason: `event exceeds the ${maxEventBytes}-byte in-memory safety limit; evidence retained on disk`,
      });
    } else if (compactPrompt) {
      const seq = headerSeq;
      const type = headerString(header, 'type');
      if (seq === undefined || type !== 'step.prompt') {
        problems.push({ line: lineNumber, reason: 'not a JSON event object' });
      } else {
        const blockId = headerString(header, 'blockId');
        const step = headerNumber(header, 'step');
        events.push({
          seq,
          at: headerString(header, 'at') ?? '',
          type,
          data: {
            ...(blockId ? { blockId } : {}),
            ...(step !== undefined ? { step } : {}),
            content: {
              source: 'legacy-step-prompt', omitted: true, bytes: lineBytes,
              note: 'The duplicated prompt remains in session.jsonl; canonical message events are loaded instead.',
            },
          },
        });
        head = Math.max(head, seq);
      }
    } else {
      let text = Buffer.concat(parts, lineBytes).toString('utf8');
      if (text.endsWith('\r')) text = text.slice(0, -1);
      const parsed = asRecord(parseLine(text));
      if (typeof parsed.seq !== 'number') {
        problems.push({ line: lineNumber, reason: 'not a JSON event object' });
      } else {
        head = Math.max(head, parsed.seq);
        if (typeof parsed.type === 'string') {
          events.push({
            seq: parsed.seq,
            at: String(parsed.at ?? ''),
            type: parsed.type,
            data: parsed.data ?? null,
          });
        }
      }
    }
    lineNumber += 1;
    lineBytes = 0;
    parts = [];
    prefix = Buffer.alloc(0);
    compactPrompt = false;
    oversized = false;
  };

  try {
    while (position < stat.size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (!read) break;
      let start = 0;
      for (let index = 0; index < read; index++) {
        if (chunk[index] !== 10) continue;
        add(chunk.subarray(start, index));
        finish();
        completeBytes = position + index + 1;
        start = index + 1;
      }
      if (start < read) add(chunk.subarray(start, read));
      position += read;
    }
  } finally {
    fs.closeSync(fd);
  }

  const torn = lineBytes > 0;
  if (torn) problems.push({ line: lineNumber, reason: 'torn final line' });
  return { events, problems, head, size: stat.size, completeBytes, torn };
}

/** What the model is told when a tool call died with the process. */
export const NEVER_RETURNED =
  'This tool call never returned: the process ended while it was running. Its effect on the workspace is unknown.';

function parseLine(text: string): JsonValue | undefined {
  try { return JSON.parse(text) as JsonValue; } catch { return undefined; }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

/**
 * One run's log.
 *
 * A single writer per run is assumed — a run folder has one owner — but not
 * trusted: every append restats the file, so a second writer or a crash-
 * truncated tail is detected instead of silently producing duplicate seqs.
 */
export class JsonlSession implements SessionHandle {
  readonly runId: string;
  readonly file: string;
  /**
   * What the last read found wrong with the file: unparseable lines, and a
   * torn tail if there was one. Empty for a healthy log, and recomputed on
   * every read rather than accumulated — it describes the file as it stands,
   * not the history of how it got there.
   */
  readonly problems: LogProblem[] = [];
  #head = 0;
  #size = -1;
  /** Parsed on change so repeated cursor reads never parse the whole log again. */
  #events: SessionEvent[] = [];
  #readonly: boolean;

  constructor(runId: string, file: string, options: { readonly?: boolean } = {}) {
    this.runId = runId;
    this.file = file;
    this.#readonly = Boolean(options.readonly);
  }

  /**
   * Read the file, recovering the highest seq and repairing a torn tail.
   *
   * A half-written final line is what a crash mid-append leaves behind. It is
   * not an event, and leaving it in place would make every later read
   * unparseable, so an appendable log truncates it and records the repair. A
   * read-only handle reports it as a problem and changes nothing.
   */
  #sync(): void {
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(this.file); } catch { /* no log yet */ }
    if (!stat) { this.#head = 0; this.#size = -1; this.#events = []; return; }
    if (stat.size === this.#size) return;

    const read = readSessionLogFile(this.file);
    this.problems.length = 0;
    this.problems.push(...read.problems);

    if (read.torn && !this.#readonly) {
      fs.truncateSync(this.file, read.completeBytes);
      const torn = this.problems.at(-1);
      if (torn?.reason === 'torn final line') torn.reason = 'torn final line, truncated';
      this.#size = read.completeBytes;
    } else {
      this.#size = stat.size;
    }
    this.#head = read.head;
    this.#events = read.events;
  }

  async head(): Promise<number> {
    this.#sync();
    return this.#head;
  }

  /**
   * Append one event.
   *
   * Durable before it returns, in the sense that matters here: the write has
   * reached the filesystem, so a process that dies on the next line cannot
   * lose the event.
   */
  async append(event: SessionEventInput): Promise<SessionEvent> {
    if (this.#readonly) throw new Error(`Session ${this.runId} is open read-only`);
    if (!event || typeof event.type !== 'string' || !event.type) {
      throw new Error('A session event needs a type');
    }
    const extension = asRecord(event.data)._extension;
    const ignorableExtension = event.type.startsWith('extension.')
      && Boolean(asRecord(extension).ignorable);
    if (!SESSION_EVENT_SET.has(event.type) && !ignorableExtension) {
      throw new Error(`Unknown durable session event "${event.type}". Ignorable extensions must use an extension.* type and data._extension.ignorable=true.`);
    }
    this.#sync();
    const written: SessionEvent = {
      seq: this.#head + 1,
      at: event.at ?? new Date().toISOString(),
      type: event.type,
      data: event.data ?? null,
    };
    const line = JSON.stringify(written) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, line, 'utf8');
    this.#head = written.seq;
    this.#size = (this.#size < 0 ? 0 : this.#size) + Buffer.byteLength(line, 'utf8');
    this.#events.push(written);
    return written;
  }

  /** Every event after `after`, in order. The replay cursor is just this. */
  async *read(after = 0): AsyncIterable<SessionEvent> {
    for (const event of this.readSync(after)) yield event;
  }

  /**
   * The same read, synchronously.
   *
   * The projection writer and the ledger both need to fold a whole log with no
   * await in the middle, and a run folder is local files.
   */
  readSync(after = 0): SessionEvent[] {
    // One read and no repeat parsing: #sync() updates the parsed event cache
    // only when the file changed. Agent loops ask for the conversation before
    // every step, so splitting and JSON.parse-ing the full growing log here
    // made a long run increasingly expensive even with a single worker.
    this.#sync();
    return after > 0 ? this.#events.filter(event => event.seq > after) : this.#events.slice();
  }

  async deriveMessages(upTo?: number, blockId?: string, after?: number): Promise<Message[]> {
    return deriveMessages(this.readSync(), upTo, blockId, after);
  }
}

/**
 * Rebuild the model-visible message list from a log.
 *
 * The fold is deliberately dull — the interesting decisions were made by the
 * writer. The one thing it must not do is drop a tool call whose result never
 * arrived: a call that vanishes changes the shape of the conversation on
 * resume, and the model has no way to notice. It gets a synthetic result
 * saying exactly what happened instead.
 *
 * @param events — the log, in order.
 * @param upTo — fold only events up to this seq, for replay to a point.
 * @returns the messages a model would see next.
 */
export function deriveMessages(events: readonly SessionEvent[], upTo?: number, blockId?: string, after = 0): Message[] {
  const messages: Message[] = [];
  /** callId -> index of the assistant message that requested it. */
  const requested = new Map<string, { name: string; answered: boolean }>();
  // Very old single-block logs omitted owner tags. Only adopt their untagged
  // events when the bounded log has exactly one possible owner; ambiguous
  // multi-block history must never become shared context during migration.
  const owners = new Set(events.filter(e => (upTo === undefined || e.seq <= upTo) && e.seq > after)
    .filter(e => !(e.type === 'block.status' && ['sequence', 'parallel', 'repeat', 'foreach', 'until', 'if'].includes(String(asRecord(e.data).kind))))
    .map(e => asRecord(e.data).blockId).filter(id => typeof id === 'string'));
  const onlyOwner = owners.size === 1 ? [...owners][0] : undefined;
  const legacyOwner = onlyOwner !== undefined && events.some(event => {
    const data = asRecord(event.data);
    return event.seq > after && (upTo === undefined || event.seq <= upTo)
      && event.type === 'block.status' && data.status === 'active'
      && data.blockId === onlyOwner && !data.context && !data.executionId;
  }) ? onlyOwner : undefined;

  for (const event of events) {
    if (upTo !== undefined && event.seq > upTo) break;
    if (event.seq <= after) continue;
    const data = asRecord(event.data);
    if (blockId !== undefined && (data.blockId ?? legacyOwner) !== blockId) continue;
    if (data.modelVisible === false) continue;

    switch (event.type) {
      case 'message.system':
        messages.push({ role: 'system', content: String(data.content ?? '') });
        break;

      case 'message.user':
        messages.push({ role: 'user', content: String(data.content ?? '') });
        break;

      case 'llm.response': {
        const toolCalls: ToolCall[] = Array.isArray(data.toolCalls)
          ? data.toolCalls.map((c: any) => ({
              id: String(c?.id ?? ''),
              name: String(c?.name ?? ''),
              args: (c?.args ?? null) as JsonValue,
            }))
          : [];
        const message: Message = { role: 'assistant', content: String(data.content ?? '') };
        if (data.reasoning) message.reasoning = String(data.reasoning);
        if (data.replay && typeof data.replay === 'object') message.replay = data.replay as Message['replay'];
        if (toolCalls.length) message.toolCalls = toolCalls;
        messages.push(message);
        for (const call of toolCalls) requested.set(call.id, { name: call.name, answered: false });
        break;
      }

      case 'tool.call': {
        if (data.modelVisible === false) break;
        // A runner that logs the call separately from the response: record it
        // as requested so a missing result is still noticed.
        const id = String(data.callId ?? data.id ?? '');
        if (id && !requested.has(id)) requested.set(id, { name: String(data.name ?? ''), answered: false });
        break;
      }

      case 'tool.result': {
        if (data.modelVisible === false) break;
        const id = String(data.callId ?? data.id ?? '');
        const pending = requested.get(id);
        if (pending) pending.answered = true;
        // The CONTENT is what the writer meant the model to read, and it wins
        // wherever there is one. `refusal()` builds `Refused: <reason>` on
        // purpose, and rewriting that as `Error: <reason>` tells the model the
        // wrong thing about what happened: an error invites another attempt,
        // and a refusal invites a different approach. The error is the fallback
        // for a result that carries one and nothing to say.
        const text = String(data.content ?? '');
        const message: Message = {
          role: 'tool',
          content: text || (data.error ? `Error: ${String(data.error)}` : ''),
          toolCallId: id,
        };
        const name = String(data.name ?? pending?.name ?? '');
        if (name) message.name = name;
        if (data.handle) message.handle = String(data.handle);
        else if (data.result !== undefined && data.blockId && id) {
          // Older canonical runs retained the full result but omitted its
          // retrieval handle. Recover it without rewriting the saved trace.
          message.handle = `@call:${encodeURIComponent(String(data.blockId))}/${encodeURIComponent(id)}`;
        }
        messages.push(message);
        break;
      }

      default:
        break; // trace detail: real, logged, and not model-visible
    }
  }

  // Whatever is still unanswered died with the process. Say so, in the one
  // place the model will read it.
  for (const [id, pending] of requested) {
    if (pending.answered) continue;
    const message: Message = { role: 'tool', content: NEVER_RETURNED, toolCallId: id };
    if (pending.name) message.name = pending.name;
    messages.push(message);
  }

  return messages;
}

/** A directory of run logs. The `ctx.sessions` provider's storage. */
export class JsonlSessionStore implements SessionsSeam {
  readonly root: string;
  /**
   * All blocks in one kernel run write the same file. Sharing the handle is
   * load-bearing under parallel task graphs: separate handles each observed
   * the other writer's append as an external file change and re-read the
   * entire growing JSONL before writing their next token chunk.
   */
  #writers = new Map<string, JsonlSession>();
  #maxWriters = 64;

  /** @param root — the runs directory, e.g. `<project>/runs`. */
  constructor(root: string) {
    this.root = root;
  }

  /** Where one run's log lives. Rejects a runId that would escape the store. */
  fileFor(runId: string): string {
    const dir = path.resolve(this.root, String(runId));
    if (path.dirname(dir) !== path.resolve(this.root)) {
      throw new Error(`Not a run in this store: "${runId}"`);
    }
    return path.join(dir, 'session.jsonl');
  }

  async open(runId: string): Promise<JsonlSession> {
    const file = this.fileFor(runId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = this.#writers.get(runId);
    if (existing) {
      // Refresh insertion order so the bounded map behaves as an LRU.
      this.#writers.delete(runId);
      this.#writers.set(runId, existing);
      return existing;
    }
    const session = new JsonlSession(runId, file);
    this.#writers.set(runId, session);
    if (this.#writers.size > this.#maxWriters) {
      const oldest = this.#writers.keys().next().value;
      if (oldest !== undefined) this.#writers.delete(oldest);
    }
    return session;
  }

  async read(runId: string): Promise<JsonlSession> {
    const file = this.fileFor(runId);
    if (!fs.existsSync(file)) throw new Error(`Run "${runId}" has no session log`);
    return new JsonlSession(runId, file, { readonly: true });
  }

  /** Runs that have a log, newest first. Run ids begin with their timestamp. */
  async list(): Promise<string[]> {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root)
      .filter(id => fs.existsSync(path.join(this.root, id, 'session.jsonl')))
      .sort()
      .reverse();
  }
}

const TERMINAL_STAGES = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected']);

// Include identity and change time so replacement or same-size edits invalidate
// a hint, even when a writer preserves mtime. No persisted metadata is trusted.
function sessionFingerprint(file: string): string | null {
  try {
    const s = fs.statSync(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch { return null; }
}

function defaultLeaseLive(lease: Record<string, any>): boolean {
  const fresh = Date.now() - Number(lease.beatAt ?? 0) < 60_000;
  if (!fresh) return false;
  if (lease.host && lease.host !== os.hostname()) return true;
  try { process.kill(Number(lease.pid), 0); return true; }
  catch (error: any) { return error?.code === 'EPERM'; }
}

/**
 * Close canonical sessions left non-terminal by a dead process.
 *
 * All writes go through JsonlSession.append, so confinement, torn-tail repair,
 * dense sequencing and event validation are identical to ordinary execution.
 */
export async function repairInterruptedSessions(root: string, {
  reason = 'The process ended before the workflow settled.',
  isLeaseLive = defaultLeaseLive,
  runIds,
  claim,
  terminalCache,
  inspectSessions,
  signal,
}: {
  reason?: string;
  isLeaseLive?: (lease: Record<string, any>, runId: string) => boolean | Promise<boolean>;
  runIds?: readonly string[];
  claim?: (runId: string) => (() => void) | null;
  /** Optional process-local hints for unchanged terminal logs; never execution authority. */
  terminalCache?: Map<string, string>;
  /** Read-only preflight; a terminal result is usable only for the same file. */
  inspectSessions?: (root: string, runIds?: readonly string[]) => Promise<Array<{ runId: string; terminal: boolean; fingerprint: string | null; error?: { message: string; code?: string } }>>;
  signal?: AbortSignal;
} = {}): Promise<string[]> {
  const store = new JsonlSessionStore(root);
  const repaired: string[] = [];
  let yieldedAt = performance.now();
  const inspected = inspectSessions ? await inspectSessions(root, runIds) : null;
  signal?.throwIfAborted();
  const observations = new Map(inspected?.map(row => [row.runId, row]));
  const candidates = inspected ? inspected.map(row => row.runId)
    : runIds ? runIds.filter(id => fs.existsSync(store.fileFor(id))) : await store.list();
  for (const runId of candidates) {
    signal?.throwIfAborted();
    // Large histories must allow IPC/input between files, including the first scan.
    if (performance.now() - yieldedAt >= 8) {
      await new Promise<void>(resolve => setImmediate(resolve));
      yieldedAt = performance.now();
    }
    const file = store.fileFor(runId);
    const fingerprint = terminalCache && !runIds ? sessionFingerprint(file) : null;
    if (fingerprint && terminalCache?.get(file) === fingerprint) continue;
    terminalCache?.delete(file);
    let owner: Record<string, any> | null = null;
    try { owner = asRecord(JSON.parse(fs.readFileSync(path.join(root, runId, 'execution-owner.json'), 'utf8'))); } catch { /* no owner */ }
    if (owner && await isLeaseLive(owner, runId)) continue;
    const leaseFile = path.join(root, runId, 'live.json');
    let lease: Record<string, any> | null = null;
    try { lease = asRecord(JSON.parse(fs.readFileSync(leaseFile, 'utf8'))); } catch { /* no lease */ }
    if (lease && await isLeaseLive(lease, runId)) continue;
    // Completed history needs no temporary execution claim. Recheck inside
    // the claim below before repairing an unfinished session.
    let observation = observations.get(runId);
    if (inspectSessions && (!observation?.fingerprint || sessionFingerprint(file) !== observation.fingerprint)) {
      observation = (await inspectSessions(root, [runId]))[0];
      signal?.throwIfAborted();
    }
    // An unstable/missing observation falls through to claimed canonical
    // validation. Worker results can never authorize a recovery write.
    if (observation?.error) throw Object.assign(new Error(observation.error.message), { code: observation.error.code });
    const terminal = inspectSessions
      ? observation?.terminal && observation.fingerprint && sessionFingerprint(file) === observation.fingerprint
      : TERMINAL_STAGES.has(String((readSessionLogFile(file).events.findLast(event => event.type === 'run.stage')?.data as Record<string, any> | undefined)?.stage ?? ''));
    if (terminal) {
      // Do not cache a file changed during validation. Keep memory bounded; a
      // discarded hint costs another scan, never a missed recovery.
      if (fingerprint && sessionFingerprint(file) === fingerprint) {
        terminalCache?.set(file, fingerprint);
        if (terminalCache && terminalCache.size > 10_000) terminalCache.delete(terminalCache.keys().next().value!);
      }
      continue;
    }
    const release = claim?.(runId);
    if (claim && !release) continue;
    try {
    const session = await store.open(runId);
    const events = session.readSync();
    if (!events.some(event => event.type === 'run.created')) continue;
    const lastStage = events.filter(event => event.type === 'run.stage').at(-1)?.data as Record<string, any> | undefined;
    if (TERMINAL_STAGES.has(String(lastStage?.stage ?? ''))) continue;

    const latestBlocks = new Map<string, string>();
    for (const event of events) {
      if (event.type !== 'block.status') continue;
      const data = asRecord(event.data);
      if (data.blockId) latestBlocks.set(String(data.blockId), String(data.status ?? 'pending'));
    }
    for (const [blockId, status] of latestBlocks) {
      if (status !== 'active') continue;
      await session.append({
        type: 'block.status',
        data: { blockId, status: 'pending', reason: 'interrupted before this block settled' },
      });
    }
    await session.append({
      type: 'run.stage',
      data: { stage: 'interrupted', reason, previousStage: String(lastStage?.stage ?? '') },
    });
    materialise(path.join(root, runId), projectRun(session.readSync(), runId));
    try { fs.rmSync(leaseFile, { force: true }); } catch { /* already absent */ }
    repaired.push(runId);
    } finally { release?.(); }
  }
  return repaired;
}
