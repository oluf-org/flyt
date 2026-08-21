// What the loop did, on disk (DESIGN-SPEC.md §8).
//
// The loop's account of itself used to be a 500-entry ring in the supervisor's
// process and an event on a channel. Both die with the process, so the morning
// question — "what happened to t-0014 last night, and why did it stop?" — was
// answerable only by opening run folders one at a time and reading call traces.
// Working that out for one task took an hour.
//
// So: one line per event, appended to a file per day, beside the ledger. Same
// shape as the ledger for the same reason — a day is the unit people ask about,
// and an append-only file is the thing you can still read when the process that
// wrote it is gone.
//
// Durable coordination is file-backed and correctness may not depend on memory
// surviving (CLAUDE.md). This is the loop's half of that. After the Phase 5
// cutover it becomes a projection of the session event log (D55) rather than a
// second mechanism; it is a file now because the loop needs it now.
import fs from 'node:fs';
import path from 'node:path';

// A day's file stops growing here. A runaway loop writing megabytes of the same
// line must not fill a disk, and the truncation is stated in the file rather
// than left for someone to infer from a suspiciously round file size.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const dayOf = at => String(at).slice(0, 10);

export class LoopLog {
  /**
   * @param rootDir — where the day files live (`<project>/.flyt/loop`).
   * @param options.maxBytes — cap per day file.
   */
  constructor(rootDir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.rootDir = rootDir;
    this.maxBytes = maxBytes;
    // Days this process has already reported as full, so the notice is written
    // once rather than on every line after the cap.
    this.capped = new Set();
  }

  #file(at) { return path.join(this.rootDir, `${dayOf(at)}.jsonl`); }

  /**
   * Append one event.
   *
   * Never throws: a loop that cannot write its diary must still work the
   * backlog. A caller that wants to know whether it landed gets false.
   *
   * @param entry — `{ at, line, taskId? }`; `at` defaults to now.
   * @returns whether it reached the file.
   */
  append({ at = new Date().toISOString(), line, taskId = null } = {}) {
    if (!line) return false;
    const file = this.#file(at);
    const day = dayOf(at);
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* first line of the day */ }
      if (size >= this.maxBytes) {
        if (this.capped.has(day)) return false;
        this.capped.add(day);
        fs.appendFileSync(file, JSON.stringify({
          at, taskId: null,
          line: `(this day's loop log reached ${this.maxBytes} bytes; further lines are not recorded)`
        }) + '\n', 'utf8');
        return false;
      }
      fs.appendFileSync(file, JSON.stringify({ at, taskId: taskId ?? null, line: String(line) }) + '\n', 'utf8');
      return true;
    } catch {
      return false;    // an unwritable path is today's behaviour, not a failure
    }
  }

  /** The days this log holds, oldest first. */
  days() {
    try {
      return fs.readdirSync(this.rootDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map(f => f.slice(0, -6))
        .sort();
    } catch { return []; }
  }

  /**
   * Read back what the loop said.
   *
   * @param options.date — one day (`YYYY-MM-DD`); omit for every day it holds.
   * @param options.taskId — only lines recorded against this task.
   * @param options.tail — the last N matching lines.
   * @returns entries, oldest first.
   */
  read({ date = null, taskId = null, tail = null } = {}) {
    const days = date ? [date] : this.days();
    const out = [];
    for (const day of days) {
      let text;
      try { text = fs.readFileSync(path.join(this.rootDir, `${day}.jsonl`), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        // A torn last line survives as a skipped line, not a crash — the same
        // rule the ledger reads by.
        try { entry = JSON.parse(line); } catch { continue; }
        if (taskId && entry.taskId !== taskId) continue;
        out.push(entry);
      }
    }
    return tail && out.length > tail ? out.slice(-tail) : out;
  }
}
