// What it cost (DESIGN-SPEC.md §8).
//
// The plan wanted a price table per provider and model. §8 already declined to
// build one for routing, and the same argument applies here: a table is stale
// the week after it ships. But a *band* bounds quality, not spend, so something
// has to hold the dollars or an unattended run has no ceiling at all.
//
// The way out is that the number already exists. OpenRouter reports what a call
// actually cost, so the ledger reads it rather than recomputing it, and there is
// no table to maintain and nothing to get wrong. A provider that reports nothing
// falls back to an optional local price table — empty by default — and the entry
// is marked `estimated`, because a guess presented as a measurement is worse
// than no number.
//
// Enforcement is by SUPERVISION, not by a pre-flight check in every call site.
// The supervisor already polls each in-flight task (§11.1); the same poll reads
// the ledger. That keeps the ceiling in one place instead of scattered through
// every path that can reach a model, and it is why a cap can stop a task
// mid-run rather than only between tasks.
import fs from 'node:fs';
import path from 'node:path';

export const CAP_KINDS = ['task', 'soft', 'hard'];

/**
 * What one call cost.
 *
 * Preference order, and the order matters: what the provider SAYS it charged,
 * then a local estimate, then nothing. Never a silent zero — a call whose cost
 * is unknown is recorded as unknown, so "the ledger says $0" can only ever mean
 * "it was free", not "we failed to look".
 */
export function costOf({ usage = null, provider = null, model = null, prices = {} } = {}) {
  // OpenRouter returns the real charge on the usage object.
  const reported = usage?.cost ?? usage?.total_cost ?? null;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    return { usd: reported, estimated: false };
  }
  const key = `${provider}/${model}`;
  const price = prices[key] ?? prices[model] ?? null;
  if (price) {
    const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const usd = (inTok / 1e6) * (price.in ?? 0) + (outTok / 1e6) * (price.out ?? 0);
    return { usd, estimated: true };
  }
  return { usd: null, estimated: true };
}

// Everything a finished run spent, read from the artifacts it already wrote.
// No hook threaded through every call site: retrospectives carry `usage` and
// `model` because they always did, and files are the source of truth.
export function spendFromRun(store, runId, { prices = {} } = {}) {
  const entries = [];
  let retros = {};
  try { retros = store.snapshot(runId)?.retrospectives ?? {}; } catch { return entries; }
  for (const [node, retro] of Object.entries(retros)) {
    if (!retro?.usage) continue;
    const { usd, estimated } = costOf({
      usage: retro.usage,
      provider: retro.model?.provider,
      model: retro.model?.model,
      prices
    });
    entries.push({
      node,
      provider: retro.model?.provider ?? null,
      model: retro.model?.model ?? null,
      usage: retro.usage,
      usd,
      estimated
    });
  }
  return entries;
}

export class Ledger {
  constructor(rootDir, { prices = {} } = {}) {
    this.rootDir = rootDir;
    this.prices = prices;
  }

  #file(date = new Date()) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    return path.join(this.rootDir, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  // Append-only, one line per call. The audit trail is the point: "what did
  // last night cost" must be answerable from files after the process is gone.
  record(entry) {
    const line = { at: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.#file(), `${JSON.stringify(line)}\n`);
    return line;
  }

  // Everything a run spent, recorded against its task.
  recordRun(store, { runId, taskId = null, level = null }) {
    const entries = spendFromRun(store, runId, { prices: this.prices });
    for (const e of entries) this.record({ taskId, runId, level, ...e });
    return entries;
  }

  entries({ sinceMs = null } = {}) {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.rootDir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return out; }
    const cutoff = sinceMs ? Date.now() - sinceMs : null;
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(this.rootDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (cutoff && Date.parse(e.at) < cutoff) continue;
          out.push(e);
        } catch { /* a torn last line survives as a skipped line, not a crash */ }
      }
    }
    return out;
  }

  totals({ sinceMs = null, taskId = null } = {}) {
    const entries = this.entries({ sinceMs }).filter(e => !taskId || e.taskId === taskId);
    let usd = 0;
    let unknown = 0;
    let estimated = 0;
    for (const e of entries) {
      if (typeof e.usd === 'number') { usd += e.usd; if (e.estimated) estimated += 1; }
      else unknown += 1;
    }
    return {
      usd: Number(usd.toFixed(6)),
      calls: entries.length,
      // Reported separately rather than folded in: a total with six unpriced
      // calls behind it is a different fact from a total without them.
      unknown,
      estimated
    };
  }

  /**
   * Where we stand against the ceilings (§9).
   *
   *   task — this task has spent its allowance; park it and move on.
   *   soft — stop ESCALATING. The loop keeps working at the cheapest band.
   *   hard — finish the current node, land or revert cleanly, stop the loop.
   *
   * The window is rolling, not calendar-daily: a run that starts at 22:00 must
   * not get a fresh allowance at midnight (§9).
   */
  check({ caps = {}, taskId = null, windowMs = 24 * 60 * 60 * 1000 } = {}) {
    const window = this.totals({ sinceMs: windowMs });
    const task = taskId ? this.totals({ taskId }) : null;
    const hits = [];
    if (caps.hardUsd != null && window.usd >= caps.hardUsd) hits.push('hard');
    if (caps.softUsd != null && window.usd >= caps.softUsd) hits.push('soft');
    if (task && caps.taskUsd != null && task.usd >= caps.taskUsd) hits.push('task');
    return {
      ok: !hits.length,
      hits,
      // The strongest hit decides what the supervisor does.
      action: hits.includes('hard') ? 'stop' : hits.includes('task') ? 'park' : hits.includes('soft') ? 'no-escalate' : null,
      window,
      task,
      caps
    };
  }
}
