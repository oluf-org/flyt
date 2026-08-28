// What one loop worker is doing right now, as a pure projection
// (DECISIONS.md D45).
//
// A Loop worker's kernel session is bridged into the same `run:update` channel
// as a daily workflow by core/api.js and core/engine.js. `src/runStreams.js`
// turns either snapshot into live token streams, so this module remains a
// rearrangement of one protocol rather than a second Loop-only activity feed:
// actually wants when they look at a working card:
//
//   is it thinking or is it working  → currentNode + the last tool call
//   what has it tried               → toolCalls, newest first
//   what has it changed             → files, from work:diff
//   should I worry                  → stalled, from the heartbeat's idle clock
//
// Pure, testable, no DOM, no fetch — the same split as runStreams.js and
// runProgress.js.
import { activeStreams } from './runStreams.js';
// A pure merge over plain objects — the same import src/App.jsx makes for the
// same reason. "The renderer does not import core" is about IPC and the
// filesystem, not about a function that adds two objects together; a second
// copy of the patch protocol is how two views drift into disagreeing.
import { mergeSnapshot } from '../core/snapshotDiff.js';
import { runProgress } from './runProgress.js';
import { nodeLabel } from './flowTypes.js';

// Mirrored from core/heartbeat.js DEFAULT_THRESHOLDS.silentMs. The renderer
// does not import core (DECISIONS.md D45), and this number changes
// about as often as the supervisor does. If that one moves, this comment is the
// reason to move this one — the same convention `LEVELS` in LoopPage.jsx uses.
export const SILENT_MS = 10 * 60 * 1000;

// How many tool calls a card shows before it becomes a log rather than a card.
const TOOL_CALL_LIMIT = 12;

/**
 * One in-flight worker, opened up.
 *
 * `snapshot` is the run's snapshot (possibly patched forward by
 * core/snapshotDiff.js); `heartbeat` is the supervisor's entry for the task.
 * Either may be missing — a card that has just been expanded has a heartbeat
 * and no snapshot yet, and that state has to render rather than throw.
 */
export function workerView(snapshot, heartbeat = null, { diff = null, gates = null, now = Date.now() } = {}) {
  const idleMs = heartbeat?.idleMs ?? 0;
  return {
    // Reused verbatim, never forked: the live-output panel already handles
    // pinning, several streams at once, and stick-to-bottom, and a second
    // implementation of that is a second set of bugs.
    streams: activeStreams(snapshot),
    currentNode: currentNode(snapshot),
    toolCalls: toolCalls(snapshot),
    gates: gateResults(gates),
    files: filesFromDiff(diff),
    progress: runProgress(snapshot, now),
    // The supervisor's own judgement, restated where a person is looking.
    stalled: idleMs >= SILENT_MS,
    idleMs,
    // What the supervisor has ALREADY tried, so "should I step in" has an
    // answer that is not just the age of the task.
    interventions: heartbeat?.interventions ?? []
  };
}

/**
 * The one-line "now:" for a collapsed row.
 *
 * This is the highest-value line in the phase and the cheapest: it answers "is
 * it thinking or is it working" for a person who does not want to expand
 * anything, which is most people most of the time.
 */
export function nowLine(view) {
  if (!view) return null;
  const node = view.currentNode?.label ?? null;
  const call = view.toolCalls?.[0] ?? null;
  if (!node && !call) return null;
  if (!call) return node;
  // The tool name plus its subject: "read_file core/api.js" says more than
  // "read_file", and it is the difference between watching a worker and
  // watching a spinner.
  const tool = call.argsPreview ? `${call.name} ${call.argsPreview}` : call.name;
  return node ? `${node} · ${tool}` : tool;
}

/**
 * What is active in the run, or null.
 *
 * Null rather than a placeholder: "nothing is active" is a real state — between
 * nodes, or while a gate runs — and a card that renders "—" for it is claiming
 * to know something it does not.
 */
export function currentNode(snapshot) {
  if (!snapshot) return null;
  const status = snapshot.meta?.nodeStatus ?? {};
  for (const n of snapshot.flow?.nodes ?? []) {
    if (status[n.id] !== 'active') continue;
    return { id: n.id, label: nodeLabel(n), status: 'active', type: n.type ?? null };
  }
  // A run with no flow (the classic shape) or one whose work is all in tasks:
  // the running task IS the current node as far as a reader is concerned.
  const task = (snapshot.tasks?.tasks ?? []).find(t => t.status === 'running');
  return task ? { id: task.id, label: task.title || task.id, status: 'active', type: 'agentTask' } : null;
}

/**
 * Every tool call the run has made, newest first.
 *
 * Assembled from the retrospectives because that is where the finished record
 * lives; a call in flight has not been written anywhere yet, which is honest —
 * the streams panel is what shows the turn that is happening.
 */
export function toolCalls(snapshot, limit = TOOL_CALL_LIMIT) {
  const out = [];
  for (const [node, retro] of Object.entries(snapshot?.retrospectives ?? {})) {
    for (const call of retro?.toolCalls ?? []) {
      out.push({
        node,
        name: call.tool,
        argsPreview: argsPreview(call.tool, call.args),
        ok: call.ok !== false,
        ms: call.ms ?? null,
        ...(call.error ? { error: call.error } : {}),
        ...(call.handle ? { handle: call.handle } : {})
      });
    }
  }
  // Newest first. The array is built in retrospective order, which is the order
  // the calls happened, so reversing is enough and no timestamp is invented.
  return out.reverse().slice(0, limit);
}

/**
 * The one argument worth reading, per tool.
 *
 * A generic `JSON.stringify(args).slice(0, 40)` produces `{"path":"src/ap…` on
 * every row — the same eleven characters of noise before the only part anyone
 * wanted. So each tool names its subject, and everything else falls back to the
 * first string argument.
 */
export function argsPreview(tool, args) {
  if (!args || typeof args !== 'object') return null;
  const pick = {
    read_file: 'path', write_file: 'path', create_file: 'path', edit_file: 'path',
    glob: 'pattern', bash: 'command', run_gate: 'command',
    read_task: 'id', update_task: 'id', why_blocked: 'id', read_run: 'runId',
    web_fetch: 'url', web_search: 'query', search_references: 'query',
    enqueue_task: 'title', create_task: 'title', ask_human: 'question'
  }[tool];
  const value = pick ? args[pick] : Object.values(args).find(v => typeof v === 'string');
  if (typeof value !== 'string' || !value.trim()) return null;
  const one = value.trim().replace(/\s+/g, ' ');
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/**
 * The file list, parsed out of a unified diff.
 *
 * `work:diff` returns the diff TEXT (core/worktree.js), not a summary, so the
 * counting happens here. A file list beats a diff blob on a card: "it has
 * touched four files, two of them tests" is a glance, and the hunks are one
 * click away for when it is not.
 */
export function filesFromDiff(diff) {
  if (!diff || typeof diff !== 'string') return [];
  const files = [];
  let current = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], added: 0, removed: 0, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // `+++`/`---` are headers, not content; counting them inflates every file
    // by one add and one remove, which is exactly the sort of quiet wrongness
    // that makes a number worse than no number.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { current.added++; current.hunks.push(line); }
    else if (line.startsWith('-')) { current.removed++; current.hunks.push(line); }
    else if (line.startsWith('@@') || line.startsWith(' ')) current.hunks.push(line);
  }
  return files.map(f => ({ ...f, hunk: f.hunks.join('\n') , hunks: undefined }))
    .map(({ hunks, ...rest }) => rest); // eslint-disable-line no-unused-vars
}

/** The gate results from `work:verify`, flattened for display. */
export function gateResults(verify) {
  if (!verify) return null;
  return {
    ok: verify.ok === true,
    ...(verify.reason ? { reason: verify.reason } : {}),
    results: (verify.results ?? []).map(r => ({
      command: r.command,
      status: r.status,
      code: r.code ?? null,
      ms: r.ms ?? null,
      // The tail only: a failing suite puts its summary at the bottom, and a
      // card is not where a full transcript belongs.
      output: tail(r.output, 40)
    })),
    declared: verify.gates ?? []
  };
}

function tail(text, lines) {
  const all = String(text ?? '').split('\n');
  return all.length <= lines ? all.join('\n') : all.slice(-lines).join('\n');
}

/**
 * Apply a `run:update` payload to a snapshot the view is holding.
 *
 * The patch protocol is `{ runId, rev, base, patch|full }`. Two rules, both of
 * which are bugs if they are missing:
 *
 *   - a patch whose `base` is not the rev we hold is DROPPED, and the caller is
 *     told to re-fetch. Applying it would silently produce a snapshot that
 *     never existed.
 *   - re-applying the same rev is a no-op, so a duplicated push (two cards
 *     expanded, one channel) cannot double anything.
 */
export function applyPatch(held, payload) {
  const rev = held?.rev ?? 0;
  const snapshot = held?.snapshot ?? null;
  if (!payload) return { snapshot, rev, refetch: false };
  if (payload.full) return { snapshot: payload.full, rev: payload.rev ?? 0, refetch: false };
  if (!snapshot) return { snapshot, rev, refetch: true };
  if (payload.rev != null && payload.rev <= rev) return { snapshot, rev, refetch: false };
  if (payload.base != null && payload.base !== rev) return { snapshot, rev, refetch: true };
  return { snapshot: mergeSnapshot(snapshot, payload.patch), rev: payload.rev ?? rev + 1, refetch: false };
}
