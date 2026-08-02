// The call ledger (PIVOT-PLAN §4) — the architectural centre of the pivot.
//
// One immutable file per model call, PER ATTEMPT, written from a wrapper inside
// callModel(). Every provider already funnels through that one chokepoint, so
// no adapter needs to know this module exists; adapters only opt in to wire
// capture by returning a `wire` field, and the ones that can't (the CLI
// delegates) produce an honest degraded record instead of an empty panel.
//
// Three things this fixes, all of them from §4.1:
//
//   1. core/agent.js merged usage across loop iterations, so a node that took
//      six agent turns reported one summed number. The ledger records each
//      turn; the merge survives only as a derived rollup for the retrospective.
//   2. durationMs was measured across ALL retry attempts, so a call that
//      succeeded on attempt 3 reported the backoff sleeps as latency. Records
//      are per attempt and time only that attempt.
//   3. Nothing survived the retrospective. Now the retrospective is a VIEW of
//      the ledger, and the ledger is the truth.
//
// Nothing in here may ever throw into the call path. A ledger that can fail a
// model call is worse than no ledger: the instrument must not break the thing
// it measures.
import { redactWire } from './tools/redact.js';
import { callCost, normalizeUsage } from './callCost.js';

export const CALL_RECORD_VERSION = 1;

// Wire files are capped with head/tail preservation (§4.3). A call with a 200k
// context produces a multi-megabyte body; runs already accumulate forever, and
// megabytes per call is not a thing to add by default.
export const WIRE_LIMIT_BYTES = 256 * 1024;

// wire capture modes:
//   'off'      — no wire files at all
//   'bounded'  — redacted, capped at WIRE_LIMIT_BYTES (the default)
//   'full'     — redacted, uncapped. Opt-in per §4.3; never the default.
export const WIRE_MODES = ['off', 'bounded', 'full'];
export const DEFAULT_WIRE_MODE = 'bounded';

// Why a call has no wire record. Rendered as a stated limitation, never as an
// empty panel (§4.3, "honest holes").
export const WIRE_UNAVAILABLE = {
  cliDelegate: 'cli-delegate',   // the vendor CLI owns the HTTP; there is no wire here
  captureOff: 'capture-off',     // the user turned wire capture off
  adapter: 'adapter-no-capture'  // an adapter that simply doesn't report one
};

// --- bounding ----------------------------------------------------------------

// Serialize a value to JSON text, capped at `limit` bytes with head and tail
// preserved. Mirrors P2's bounded-preview pattern: the middle is what you lose,
// because the shape of a request lives at its edges — model and params at the
// head, the last message and the closing braces at the tail.
export function boundJson(value, limit = WIRE_LIMIT_BYTES) {
  let text;
  try { text = JSON.stringify(value, null, 2); }
  catch { text = JSON.stringify({ error: 'value was not serializable' }, null, 2); }
  if (text == null) text = 'null';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (limit == null || bytes <= limit) return { text, truncated: false, bytes };
  // Two thirds head, one third tail: the head carries the request's identity,
  // the tail carries how it ended.
  const head = Math.floor(limit * 0.66);
  const tail = limit - head - 200;
  const marker = `\n\n… [${bytes - limit} bytes elided by the ${limit}-byte wire cap — `
    + 'set wire capture to "full" in Settings to keep whole bodies] …\n\n';
  const out = text.slice(0, head) + marker + text.slice(-Math.max(tail, 0));
  return { text: out, truncated: true, bytes };
}

// --- the record ---------------------------------------------------------------

// Build one call record. Pure: takes everything it needs, touches no disk.
// Exported so tests can assert the shape without a RunStore.
export function buildCallRecord({
  runId, nodeId = null, taskId = null, role = null,
  provider, model, attempt = 0, retries = 0,
  startedAt, firstTokenAt = null, endedAt,
  usage = null, finishReason = null, protocol = null,
  error = null, prices = null, wire = null, wireUnavailable = null
}) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  const ttftMs = firstTokenAt && Number.isFinite(start)
    ? Math.max(0, Date.parse(firstTokenAt) - start)
    : null; // never 0, never faked — a non-streaming adapter says null (§4.2)

  const norm = normalizeUsage(usage);
  const cost = callCost({ usage, model, prices });

  // Output throughput. Only meaningful once first-token latency is known and
  // there was generation time to divide by; otherwise null rather than a
  // number computed against the wrong denominator.
  let outputTokensPerSec = null;
  if (norm?.outputTokens > 0 && durationMs != null) {
    const genMs = ttftMs != null ? durationMs - ttftMs : durationMs;
    if (genMs > 0) outputTokensPerSec = Math.round((norm.outputTokens / (genMs / 1000)) * 10) / 10;
  }

  return {
    v: CALL_RECORD_VERSION,
    runId: runId ?? null,
    nodeId, taskId, role,
    attempt, retries,
    provider: provider ?? null,
    model: model ?? null,
    startedAt, firstTokenAt, endedAt,
    durationMs, ttftMs, outputTokensPerSec,
    usage: norm,
    rawUsage: usage ?? null,
    cost,
    finishReason: finishReason ?? null,
    protocol: protocol ?? null,
    error: error ? String(error).slice(0, 500) : null,
    ok: !error,
    wire: wire ?? null,
    ...(wireUnavailable ? { wireUnavailable } : {})
  };
}

// --- the recorder --------------------------------------------------------------

// A ledger bound to one run — and, via `for()`, to one node or task.
//
//   const ledger = makeCallLedger(store, runId, { wire: 'bounded', prices });
//   ledger.for({ nodeId: 'implement', role: 'aiStep' })   // hand this to callModel
//
// `record()` returns the written record (or null when nothing was written) and
// swallows every error: see the header.
export function makeCallLedger(store, runId, {
  wire = DEFAULT_WIRE_MODE, prices = null, nodeId = null, taskId = null, role = null,
  onRecord = null, limitBytes = WIRE_LIMIT_BYTES
} = {}) {
  const mode = WIRE_MODES.includes(wire) ? wire : DEFAULT_WIRE_MODE;
  const self = {
    runId, nodeId, taskId, role, wireMode: mode,

    // A view of the same ledger attributed to a different node/task/role.
    for(meta = {}) {
      return makeCallLedger(store, runId, {
        wire: mode, prices, limitBytes, onRecord,
        nodeId: meta.nodeId ?? nodeId,
        taskId: meta.taskId ?? taskId,
        role: meta.role ?? role
      });
    },

    record(fields = {}) {
      try {
        const capture = captureWire(fields.wire, mode, limitBytes);
        const rec = buildCallRecord({
          ...fields,
          runId,
          nodeId: fields.nodeId ?? nodeId,
          taskId: fields.taskId ?? taskId,
          role: fields.role ?? role,
          prices,
          wire: capture.pointer,
          wireUnavailable: capture.unavailable ?? fields.wireUnavailable ?? null
        });
        // writeCallRecord fills the wire pointer in — it is the only thing that
        // knows the sequence number the record landed on.
        const written = store.writeCallRecord(runId, rec, capture.files);
        onRecord?.(written);
        return written;
      } catch {
        // The instrument must never break the thing it measures.
        return null;
      }
    }
  };
  return self;
}

// Turn an adapter's raw wire payload into files + a pointer, redacted and
// bounded. `raw` is { request, response } of plain JSON-able values.
function captureWire(raw, mode, limitBytes) {
  if (mode === 'off') return { pointer: null, files: null, unavailable: WIRE_UNAVAILABLE.captureOff };
  if (!raw || (raw.request == null && raw.response == null)) {
    return { pointer: null, files: null, unavailable: null };
  }
  const limit = mode === 'full' ? null : limitBytes;
  // Redaction is mandatory and happens BEFORE any byte is written (§4.3).
  const req = raw.request == null ? null : boundJson(redactWire(raw.request), limit);
  const res = raw.response == null ? null : boundJson(redactWire(raw.response), limit);
  return {
    pointer: {
      request: null, // filled in once the sequence number is claimed
      response: null,
      truncated: Boolean(req?.truncated || res?.truncated),
      mode,
      bytes: (req?.bytes ?? 0) + (res?.bytes ?? 0)
    },
    files: { request: req?.text ?? null, response: res?.text ?? null },
    unavailable: null
  };
}

// --- rollups -------------------------------------------------------------------

// Fold a run's call records into the numbers a run header shows. Attempts that
// failed still count as calls and still cost money, so they are included;
// `retries` counts them separately so "5 calls, 2 of them retries" is sayable.
export function rollupCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const usages = [];
  const costs = [];
  let retries = 0;
  let errors = 0;
  let wallMs = 0;
  for (const c of list) {
    if (c.usage) usages.push(c.usage);
    if (c.cost) costs.push(c.cost);
    if ((c.attempt ?? 0) > 0) retries += 1;
    if (c.error) errors += 1;
    if (typeof c.durationMs === 'number') wallMs += c.durationMs;
  }
  return { calls: list.length, retries, errors, modelMs: wallMs, usages, costs };
}
