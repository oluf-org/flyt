/** Rebuildable SQLite projection over canonical session JSONL events. */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionEvent } from '../seams/sessions.js';

export interface IndexedSessionEvent extends SessionEvent { runId: string; }
export interface ProjectionQuery {
  runId?: string;
  kinds?: readonly string[];
  blockId?: string;
  limit?: number;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export class SessionProjectionIndex {
  private db: DatabaseSync;
  constructor(file: string) {
    let Database: typeof DatabaseSync;
    try { ({ DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync }); }
    catch { throw new Error('SessionProjectionIndex requires a host runtime with node:sqlite'); }
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS session_events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
        block_id TEXT, call_id TEXT, tool TEXT, task_id TEXT, payload TEXT NOT NULL,
        prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER,
        PRIMARY KEY(run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS session_events_kind ON session_events(kind, at);
      CREATE INDEX IF NOT EXISTS session_events_call ON session_events(run_id, call_id);
      CREATE INDEX IF NOT EXISTS session_events_task ON session_events(run_id, task_id);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, created_at TEXT, stage TEXT, last_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, handle TEXT, path TEXT, kind TEXT,
        PRIMARY KEY(run_id, seq)
      );
    `);
  }

  append(event: IndexedSessionEvent): void {
    const data = record(event.data);
    const usage = record(data.usage);
    this.db.prepare(`INSERT OR IGNORE INTO session_events
      (run_id,seq,at,kind,block_id,call_id,tool,task_id,payload,prompt_tokens,completion_tokens,reasoning_tokens)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.runId, event.seq, event.at, event.type, data.blockId ?? null,
      data.callId ?? data.requestCallId ?? null, data.name ?? data.tool ?? null,
      data.taskId ?? null, JSON.stringify(event.data), usage.promptTokens ?? null,
      usage.completionTokens ?? null, usage.reasoningTokens ?? null,
    );
    this.db.prepare(`INSERT INTO runs(run_id,created_at,stage,last_seq) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET
        created_at=COALESCE(runs.created_at,excluded.created_at),
        stage=COALESCE(excluded.stage,runs.stage), last_seq=MAX(runs.last_seq,excluded.last_seq)`).run(
      event.runId, event.type === 'run.created' ? event.at : null,
      event.type === 'run.stage' ? data.stage ?? null : null, event.seq,
    );
    const handle = data.handle ?? data.artifact?.handle;
    const artifactPath = data.path ?? data.artifact?.path;
    if (handle || artifactPath) this.db.prepare(`INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?,?)`).run(
      event.runId, event.seq, handle ?? null, artifactPath ?? null, event.type,
    );
  }

  /** Destructive only to the projection: callers replay authoritative JSONL immediately. */
  rebuild(events: readonly IndexedSessionEvent[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM session_events; DELETE FROM runs; DELETE FROM artifacts;');
      for (const event of events) this.append(event);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  query(query: ProjectionQuery = {}): unknown[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.runId) { where.push('run_id = ?'); args.push(query.runId); }
    if (query.blockId) { where.push('block_id = ?'); args.push(query.blockId); }
    if (query.kinds?.length) { where.push(`kind IN (${query.kinds.map(() => '?').join(',')})`); args.push(...query.kinds); }
    args.push(Math.max(1, Math.min(100_000, query.limit ?? 1_000)));
    return this.db.prepare(`SELECT * FROM session_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY run_id,seq LIMIT ?`).all(...args);
  }

  close(): void { this.db.close(); }
}
