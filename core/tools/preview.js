// Tool-result previews: what the MODEL sees when the full result is on disk
// (TOOLS-PLAN §13). The full, untruncated result lives in
// runs/<id>/tools/<seq>-<tool>.json; the context gets a bounded preview plus a
// handle it can pass to read_tool_result.
//
// The `json` preview is structure-PRESERVING: keys survive, long values are
// cut. A model that can see the shape of what it got can ask for the part it
// needs; one handed `"…"` cannot, and guesses instead. This is also the
// injection bound named in §12.6 — a megabyte of adversarial tool output never
// gets inlined into a prompt.

export const DEFAULT_MAX_PREVIEW_CHARS = 2000;

// Longest a single string may be before it is cut. Derived from the overall
// budget so one enormous field can't crowd out every other key.
const stringBudget = max => Math.max(120, Math.floor(max / 2));


// Returns { value, truncated }. `value` is the ORIGINAL object when nothing
// needed cutting — identity matters: a small result must reach the model (and
// the retrospective, and the tests) exactly as the tool returned it.
export function previewResult(result, { preview = 'json', maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS } = {}) {
  if (preview === 'none') return { value: null, truncated: result !== undefined };
  if (result === undefined || result === null) return { value: result ?? null, truncated: false };

  if (preview === 'text') {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return text.length <= maxPreviewChars
      ? { value: result, truncated: false }
      : { value: headTail(text, maxPreviewChars), truncated: true };
  }

  if (preview === 'image') {
    // The bytes are never inlined; the handle is how you get them.
    const { data, bytes, ...rest } = result ?? {};
    return { value: { ...rest, ...(bytes ? { bytes } : {}) }, truncated: data !== undefined };
  }

  // json (default): cheap size check first — most results are small and must
  // pass through untouched.
  const serialized = safeStringify(result);
  if (serialized !== null && serialized.length <= maxPreviewChars) return { value: result, truncated: false };
  const state = { truncated: false, budget: maxPreviewChars, strings: stringBudget(maxPreviewChars) };
  const value = shrink(result, state, 0);
  return { value, truncated: state.truncated || serialized === null };
}

// Head + tail, because the interesting part of a long output is usually at one
// end or the other — a stack trace's cause is at the top, a test run's verdict
// at the bottom.
function headTail(text, max) {
  const half = Math.max(60, Math.floor((max - 40) / 2));
  return `${text.slice(0, half)}\n…[${text.length - half * 2} characters omitted]…\n${text.slice(-half)}`;
}

const MAX_ARRAY_ITEMS = 20;

function shrink(value, state, depth) {
  if (depth > 12) { state.truncated = true; return '…[nested too deeply]'; }
  if (typeof value === 'string') {
    const limit = Math.min(state.strings, Math.max(120, state.budget));
    if (value.length <= limit) { state.budget -= value.length; return value; }
    state.truncated = true;
    state.budget -= limit;
    // Head AND tail even inside a structured result: this is what a captured
    // stdout looks like, and the verdict of a test run is at the bottom.
    return headTail(value, limit);
  }
  if (Array.isArray(value)) {
    const keep = value.slice(0, MAX_ARRAY_ITEMS).map(v => shrink(v, state, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.truncated = true;
      keep.push(`…[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return keep;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, state, depth + 1)]));
  }
  return value;
}

// JSON.stringify throws on a circular result and returns undefined for a
// function/symbol — either way we cannot size it, so the caller treats it as
// oversized and previews it structurally.
function safeStringify(value) {
  try { return JSON.stringify(value) ?? null; } catch { return null; }
}

// The line appended after a truncated result so the model knows the rest
// exists and how to reach it. Written in the imperative, because a model that
// reads "full result: <path>" tends to try read_file on it.
export function handleNote({ handle, path: artifactPath, bytes }) {
  return `[truncated — ${bytes.toLocaleString('en-US')} bytes total. Full result: ${artifactPath}.` +
    ` Call read_tool_result with handle "${handle}" (optionally a jsonPath like "$.stdout") to read more.]`;
}
