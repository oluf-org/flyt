/**
 * `ctx.sessions` — the canonical record.
 *
 * The append-only event log is the truth and the run folder is a projection
 * materialised beside it (D55). **Model-visible means logged:** anything that
 * reaches a model request must be reconstructable from the log alone, which is
 * what makes replay, fork, resume and an honest trace one mechanism instead of
 * four.
 *
 * @module #kernel/seams/sessions
 */
import type { JsonValue, Message } from '../types.js';

/** One appended event. `seq` is dense and starts at 1. */
export interface SessionEvent {
  seq: number;
  /** ISO-8601, from the writer's clock at append time. */
  at: string;
  /** Dotted event type, e.g. `llm.request`, `tool.call`, `permission.decision`. */
  type: string;
  data: JsonValue;
}

/** An event on its way in: seq and at belong to the log, not the caller. */
export type SessionEventInput = Omit<SessionEvent, 'seq' | 'at'> & { at?: string };

/** One run's log, open for appending and reading. */
export interface SessionHandle {
  readonly runId: string;
  /**
   * Append one event and return it as written.
   *
   * Durable before it returns: a caller that observes the returned seq may
   * assume a crash on the next line cannot lose the event.
   */
  append(event: SessionEventInput): Promise<SessionEvent>;
  /**
   * Read forward from a cursor.
   *
   * @param after — the last seq the caller already has; omit to read from the start.
   */
  read(after?: number): AsyncIterable<SessionEvent>;
  /**
   * Rebuild the model-visible message list from the log.
   *
   * A tool call with no result — the process died mid-tool — reconstructs with
   * a synthetic never-returned result rather than being dropped, because a
   * dropped call is how a resumed conversation silently changes shape.
   */
  deriveMessages(upTo?: number): Promise<Message[]>;
  /** The highest seq written. 0 for an empty log. */
  head(): Promise<number>;
}

/** The seam. Providers: `flyt-session-jsonl` today; a SQLite one is a swap, not a rewrite. */
export interface SessionsSeam {
  /** Open (creating if needed) one run's log. */
  open(runId: string): Promise<SessionHandle>;
  /** Open an existing log read-only. Rejects if there is none. */
  read(runId: string): Promise<SessionHandle>;
  /** Every run this store holds, newest first. */
  list(): Promise<string[]>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionsSeam;
  }
}
