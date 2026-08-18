// Tool feedback: what the toolbox was like to work with (DESIGN-SPEC.md §8).
//
// The loop's job is to improve its own ability to improve, and the toolbox is
// where that bites first: an agent that needed `grep` and didn't have it burns
// six `bash` calls and a lot of context reinventing it. Nobody sees that unless
// it is written down, because the run still SUCCEEDS — badly, expensively, and
// invisibly.
//
// So every LLM instance leaves two things behind:
//
//   1. WHAT IT USED, mechanically — derived from the run's own tool calls, so
//      it costs nothing and cannot be misremembered. Counts, failures, time.
//   2. WHAT IT THOUGHT — the judgment half, which only the agent has: was this
//      tool awkward, did it need three calls where one should do, and WHAT WAS
//      MISSING. That arrives through the `tool_feedback` tool.
//
// Both land here, in one place per project, and stay there until a reviewer
// digests them. The digest is deliberately NOT a pile of new backlog tasks: a
// hundred nodes each asking for "a better grep" should become one considered
// piece of work with all hundred contexts attached, not a hundred duplicates
// that then have to be de-duplicated by hand. Collect first, decide later.
//
// Files, like everything else (principle #1). Same canonical-location rule as
// the backlog (§5.2): this lives in the main checkout, never inside a worktree.
import fs from 'node:fs';
import path from 'node:path';

// Words that carry no signal when grouping "I needed a tool that…" requests.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'that', 'this',
  'it', 'is', 'was', 'be', 'would', 'could', 'have', 'had', 'with', 'tool',
  'able', 'ability', 'something', 'some', 'any', 'need', 'needed', 'needs',
  'want', 'wanted', 'me', 'my', 'i', 'we', 'us'
]);

export const RATINGS = ['good', 'adequate', 'awkward', 'broken'];

// The significant words of a free-text request, normalized.
export function requestWords(text) {
  return new Set(String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w)));
}

// A stable label for a request, used as the group's key once clustered.
export function requestKey(text) {
  return [...requestWords(text)].sort().join('-') || 'unspecified';
}

// How alike two requests are (Jaccard over their significant words).
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Cluster requests that mean the same thing in different words.
//
// Exact key matching is not enough, and the first real digest proved it:
// "search file contents by regex across the repo" and "regex search over file
// contents" are one request written twice, and splitting them defeats the whole
// purpose — the count of who asked IS the argument for building the thing.
//
// Greedy, deterministic, free. Deliberately the cheap half of the tiering
// safetyCheck.js and the clerk use; a model could cluster better, but it should
// earn that by first being shown a digest this one visibly gets wrong.
export const SIMILARITY_THRESHOLD = 0.5;

export function clusterRequests(requests, { threshold = SIMILARITY_THRESHOLD } = {}) {
  const clusters = [];
  for (const req of requests) {
    const words = requestWords(req.want);
    let best = null;
    let bestScore = threshold;
    for (const c of clusters) {
      const score = similarity(words, c.words);
      if (score >= bestScore) { best = c; bestScore = score; }
    }
    if (best) {
      best.requests.push(req);
      // Keep the shortest phrasing as the label: it is usually the one without
      // the incidental detail of whoever happened to ask first.
      if (String(req.want).length < String(best.want).length) {
        best.want = req.want;
        best.words = words;
      }
    } else {
      clusters.push({ key: requestKey(req.want), want: req.want, words, requests: [req] });
    }
  }
  // The key is recomputed from the final label so it matches what is displayed.
  return clusters.map(({ words, ...c }) => ({ ...c, key: requestKey(c.want) }));
}

/**
 * Record the mechanical half of an instance's retrospective, if there is one to
 * record and somewhere to put it. A no-op when the run has no feedback store
 * bound (an attended run, a test) or when the instance called no tools —
 * an entry saying "used nothing, thought nothing" is noise.
 */
export function recordToolUsage(feedback, { runId, nodeId, task = null, model = null, retro }) {
  if (!feedback || !retro?.tools?.length) return null;
  return feedback.record({ runId, nodeId, task, model, usage: retro.tools });
}

export class FeedbackStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.pendingDir = path.join(rootDir, 'pending');
    this.archiveDir = path.join(rootDir, 'archive');
    this.digestDir = path.join(rootDir, 'digests');
  }

  #ensure(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

  // One entry per LLM instance, keyed by run + node so a re-run of the same
  // node replaces its own entry instead of accumulating duplicates of a node
  // that failed twice and succeeded on the third attempt.
  #entryId(runId, nodeId) {
    return `${String(runId)}__${String(nodeId ?? 'node')}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  #file(id) { return path.join(this.pendingDir, `${id}.json`); }

  /**
   * Record (or merge into) one instance's feedback.
   *
   * `usage` is the mechanical half and always overwrites — it is derived from
   * the log and is simply true. `review` and `missing` are the agent's, and
   * MERGE rather than replace, because an agent may call tool_feedback more
   * than once as it learns different things during a long task.
   */
  record({ runId, nodeId = null, task = null, model = null, usage = null, review = [], missing = [] }) {
    this.#ensure(this.pendingDir);
    const id = this.#entryId(runId, nodeId);
    const existing = this.read(id) ?? {
      id, runId, nodeId, task, model,
      at: new Date().toISOString(),
      usage: [], review: [], missing: []
    };
    const entry = {
      ...existing,
      task: task ?? existing.task,
      model: model ?? existing.model,
      updatedAt: new Date().toISOString(),
      usage: usage ?? existing.usage,
      review: [...existing.review, ...review],
      missing: [...existing.missing, ...missing]
    };
    fs.writeFileSync(this.#file(id), JSON.stringify(entry, null, 2));
    return entry;
  }

  read(id) {
    try { return JSON.parse(fs.readFileSync(this.#file(id), 'utf8')); }
    catch { return null; }
  }

  // Malformed entries are reported rather than thrown past — one bad file must
  // not stop the digest, the same rule the ToolStore and the backlog follow.
  pending() {
    this.problems = [];
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.pendingDir).filter(f => f.endsWith('.json')); } catch { return out; }
    for (const f of files.sort()) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.pendingDir, f), 'utf8'))); }
      catch (err) { this.problems.push({ file: f, error: String(err.message ?? err) }); }
    }
    return out;
  }

  // Everything an instance left behind, with only what a run actually did kept:
  // an entry with no calls and no opinion is noise and is dropped at source.
  static usageFromToolCalls(toolCalls = []) {
    const by = new Map();
    for (const call of toolCalls) {
      const name = call?.tool ?? 'unknown';
      const rec = by.get(name) ?? { tool: name, calls: 0, failures: 0, ms: 0, errors: [] };
      rec.calls += 1;
      rec.ms += Number(call?.ms ?? 0);
      if (call?.ok === false) {
        rec.failures += 1;
        // A couple of samples is enough to see the shape of a failure; the full
        // records are already artifacts under runs/<id>/tools/.
        if (rec.errors.length < 3 && call.error) rec.errors.push(String(call.error).slice(0, 300));
      }
      by.set(name, rec);
    }
    return [...by.values()].sort((a, b) => b.calls - a.calls);
  }

  /**
   * Fold every pending entry into ONE document, grouped so it can be acted on
   * with the right context: per tool (how heavily used, how often it failed,
   * what people said about it) and per missing capability (who wanted it, and
   * what they were doing at the time).
   *
   * Deterministic and free. A model pass over this digest is a reasonable next
   * step — but it should read a hundred grouped contexts, not a hundred
   * scattered files, and that is exactly what this produces.
   */
  digest({ now = new Date() } = {}) {
    const entries = this.pending();
    const tools = new Map();
    const requests = [];

    for (const e of entries) {
      for (const u of e.usage ?? []) {
        const t = tools.get(u.tool) ?? { tool: u.tool, calls: 0, failures: 0, ms: 0, instances: 0, errors: [], notes: [] };
        t.calls += u.calls ?? 0;
        t.failures += u.failures ?? 0;
        t.ms += u.ms ?? 0;
        t.instances += 1;
        for (const err of u.errors ?? []) if (t.errors.length < 6) t.errors.push(err);
        tools.set(u.tool, t);
      }
      for (const r of e.review ?? []) {
        const t = tools.get(r.tool) ?? { tool: r.tool, calls: 0, failures: 0, ms: 0, instances: 0, errors: [], notes: [] };
        t.notes.push({
          rating: r.rating ?? null,
          note: r.note ?? '',
          improvement: r.improvement ?? '',
          from: { runId: e.runId, nodeId: e.nodeId, task: e.task, model: e.model }
        });
        tools.set(r.tool, t);
      }
      for (const m of e.missing ?? []) {
        requests.push({
          want: m.want,
          why: m.why ?? '',
          workaround: m.workaround ?? '',
          from: { runId: e.runId, nodeId: e.nodeId, task: e.task, model: e.model }
        });
      }
    }

    const toolList = [...tools.values()].sort((a, b) =>
      (b.notes.length - a.notes.length) || (b.failures - a.failures) || (b.calls - a.calls));
    // Most-asked-for first: the count IS the argument for building it.
    const wantList = clusterRequests(requests).sort((a, b) => b.requests.length - a.requests.length);

    return {
      id: `digest-${now.toISOString().replace(/[:.]/g, '-')}`,
      at: now.toISOString(),
      entryIds: entries.map(e => e.id),
      instances: entries.length,
      tools: toolList,
      missing: wantList,
      problems: this.problems ?? []
    };
  }

  // The digest as the document a human or a model actually reads. Markdown,
  // because the next step is someone reasoning over it with full context.
  static renderDigest(d) {
    const lines = [
      `# Tool feedback digest — ${d.at}`,
      '',
      `${d.instances} instance(s) reporting, ${d.tools.length} tool(s) used, ${d.missing.length} distinct capability request(s).`,
      ''
    ];

    lines.push('## Tools used', '');
    if (!d.tools.length) lines.push('_No tool use reported._', '');
    for (const t of d.tools) {
      const rate = t.calls ? ` (${((t.failures / t.calls) * 100).toFixed(0)}% failed)` : '';
      lines.push(`### ${t.tool}`, '');
      lines.push(`- ${t.calls} call(s) across ${t.instances} instance(s), ${t.failures} failure(s)${rate}, ${Math.round(t.ms)}ms total`);
      for (const err of t.errors) lines.push(`- error: \`${err.replace(/`/g, "'")}\``);
      for (const n of t.notes) {
        lines.push(`- **${n.rating ?? 'note'}** — ${n.note}${n.improvement ? ` _Improvement: ${n.improvement}_` : ''}`);
        lines.push(`  - from ${n.from.nodeId ?? '?'} in ${n.from.runId}${n.from.task ? ` (task ${n.from.task})` : ''}`);
      }
      lines.push('');
    }

    lines.push('## Missing capabilities', '');
    if (!d.missing.length) lines.push('_Nothing reported missing._', '');
    for (const w of d.missing) {
      lines.push(`### ${w.want}  \`${w.key}\`  ×${w.requests.length}`, '');
      for (const r of w.requests) {
        lines.push(`- ${r.why || r.want}`);
        if (r.workaround) lines.push(`  - worked around it by: ${r.workaround}`);
        lines.push(`  - from ${r.from.nodeId ?? '?'} in ${r.from.runId}${r.from.task ? ` (task ${r.from.task})` : ''}`);
      }
      lines.push('');
    }

    if (d.problems?.length) {
      lines.push('## Unreadable entries', '');
      for (const p of d.problems) lines.push(`- ${p.file}: ${p.error}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * Write the digest and archive exactly the entries it covered.
   *
   * Archiving is scoped to `entryIds` rather than "everything pending", because
   * an instance that reported WHILE the digest was being written must not be
   * swept away unread — the entry it wrote was never in this document.
   */
  writeDigest(d) {
    this.#ensure(this.digestDir);
    const file = path.join(this.digestDir, `${d.id}.md`);
    fs.writeFileSync(file, FeedbackStore.renderDigest(d));
    fs.writeFileSync(path.join(this.digestDir, `${d.id}.json`), JSON.stringify(d, null, 2));

    const archived = [];
    const dest = this.#ensure(path.join(this.archiveDir, d.id));
    for (const id of d.entryIds) {
      const from = this.#file(id);
      try {
        fs.renameSync(from, path.join(dest, `${id}.json`));
        archived.push(id);
      } catch { /* already gone — another digest took it */ }
    }
    return { digest: d, file, archived };
  }

  digests() {
    try {
      return fs.readdirSync(this.digestDir).filter(f => f.endsWith('.md')).sort().reverse();
    } catch { return []; }
  }

  readDigest(name) {
    try { return fs.readFileSync(path.join(this.digestDir, name), 'utf8'); }
    catch { return null; }
  }

  stats() {
    const entries = this.pending();
    return {
      pending: entries.length,
      reviews: entries.reduce((n, e) => n + (e.review?.length ?? 0), 0),
      requests: entries.reduce((n, e) => n + (e.missing?.length ?? 0), 0),
      digests: this.digests().length
    };
  }
}
