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
import type { Message, ToolCall, JsonValue } from '../types.js';
import type { SessionEvent, SessionEventInput, SessionHandle, SessionsSeam } from '../seams/sessions.js';

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
export const SESSION_EVENTS = [
  // The run
  'run.created',
  'stack.resolved',
  'run.stage',
  'run.error',
  // A block's turn, and the steps within it
  'turn.start',
  'step.start',
  'step.prompt',
  'step.end',
  'turn.end',
  // What the model was asked and what it said
  'message.system',
  'message.user',
  'llm.request',
  'llm.response',
  // What it did
  'tool.call',
  'permission.decision',
  'tool.result',
  // What the block produced
  'block.status',
  'block.output',
] as const;

/** One of the session log's event types. */
export type SessionEventType = (typeof SESSION_EVENTS)[number];

/** A line the reader could not parse, kept rather than swallowed. */
export interface LogProblem {
  /** 1-based line number in the file. */
  line: number;
  reason: string;
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
  /** The file as of the last read. The log is append-only, so equal size means equal content. */
  #text = '';
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
    if (!stat) { this.#head = 0; this.#size = -1; this.#text = ''; return; }
    if (stat.size === this.#size) return;

    const raw = fs.readFileSync(this.file, 'utf8');
    this.#text = raw;
    const torn = raw.length > 0 && !raw.endsWith('\n');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    this.problems.length = 0;
    let head = 0;
    let goodBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const parsed = asRecord(parseLine(text));
      const lastLine = i === lines.length - 1;
      if (typeof parsed.seq !== 'number') {
        if (lastLine && torn) break;                       // a torn tail, repaired below
        this.problems.push({ line: i + 1, reason: 'not a JSON event object' });
        goodBytes += Buffer.byteLength(text, 'utf8') + 1;  // keep it; it is somebody's evidence
        continue;
      }
      head = Math.max(head, parsed.seq);
      goodBytes += Buffer.byteLength(text, 'utf8') + 1;
    }

    if (torn && !this.#readonly) {
      fs.truncateSync(this.file, goodBytes);
      this.problems.push({ line: lines.length, reason: 'torn final line, truncated' });
      this.#size = goodBytes;
      this.#text = raw.slice(0, goodBytes);
    } else {
      if (torn) this.problems.push({ line: lines.length, reason: 'torn final line' });
      this.#size = stat.size;
    }
    this.#head = head;
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
    this.#text += line;
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
    // One read, not two: #sync() has already loaded the file if it changed,
    // and an append-only file of the same size is the same file.
    this.#sync();
    const out: SessionEvent[] = [];
    for (const text of this.#text.split('\n')) {
      if (!text.trim()) continue;
      const parsed = asRecord(parseLine(text));
      if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') continue;
      if (parsed.seq <= after) continue;
      out.push({ seq: parsed.seq, at: String(parsed.at ?? ''), type: parsed.type, data: parsed.data ?? null });
    }
    return out;
  }

  async deriveMessages(upTo?: number): Promise<Message[]> {
    return deriveMessages(this.readSync(), upTo);
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
export function deriveMessages(events: readonly SessionEvent[], upTo?: number): Message[] {
  const messages: Message[] = [];
  /** callId -> index of the assistant message that requested it. */
  const requested = new Map<string, { name: string; answered: boolean }>();

  for (const event of events) {
    if (upTo !== undefined && event.seq > upTo) break;
    const data = asRecord(event.data);

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
        if (toolCalls.length) message.toolCalls = toolCalls;
        messages.push(message);
        for (const call of toolCalls) requested.set(call.id, { name: call.name, answered: false });
        break;
      }

      case 'tool.call': {
        // A runner that logs the call separately from the response: record it
        // as requested so a missing result is still noticed.
        const id = String(data.callId ?? data.id ?? '');
        if (id && !requested.has(id)) requested.set(id, { name: String(data.name ?? ''), answered: false });
        break;
      }

      case 'tool.result': {
        const id = String(data.callId ?? data.id ?? '');
        const pending = requested.get(id);
        if (pending) pending.answered = true;
        const message: Message = {
          role: 'tool',
          content: data.error ? `Error: ${String(data.error)}` : String(data.content ?? ''),
          toolCallId: id,
        };
        const name = String(data.name ?? pending?.name ?? '');
        if (name) message.name = name;
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
    return new JsonlSession(runId, file);
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
