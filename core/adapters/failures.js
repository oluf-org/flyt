// Adapter failure classification (WR-05).
//
// The production failure: the default planning attempt died with `spawn EPERM`
// before the Codex CLI could do any model work at all. That is not a model
// problem, not a prompt problem and not a capability problem — it is the
// binary refusing to launch. But every adapter error arrived as an
// indistinguishable `Error`, so:
//
//   - auto routing could not tell "this runtime cannot start, try the next
//     provider" from "this model answered badly, trying another is pointless";
//   - the diagnostics could not name a remedy, because it did not know what
//     kind of failure it was looking at.
//
// So failures get stable codes and a remedy that names the setting to change.
// Codes are a closed vocabulary: they are logged, matched on, and shown, and a
// free-text `reason` would be re-parsed by everything downstream.
//
// Pure and dependency-free — no network, no Electron, no fs.

export const FAILURE_CODES = [
  'auth',                // no credential, expired sign-in, 401/403
  'capability',          // the provider cannot serve this model id / feature
  'credit',              // the account cannot pay for this request (402)
  'quota',               // rate limited or over a plan limit — waiting helps
  'network',             // transient transport failure
  'runtime-missing',     // the vendor CLI is not installed / not on PATH
  'runtime-permission',  // the binary exists but will not launch (EPERM/EACCES)
  'protocol',            // the runtime ran but its output could not be read
  'timeout',             // no answer within the deadline
  'cancelled',           // the user stopped it
  'unknown'
];

// Failures that are about the RUNTIME rather than the request: trying the same
// call on another provider is a reasonable next move, because nothing about the
// prompt or the model choice was at fault. This is the only set auto routing is
// allowed to fall through on — see `mayFallThrough`.
const INFRASTRUCTURE = new Set(['runtime-missing', 'runtime-permission']);

// Failures worth retrying on the SAME target after a wait. Distinct from the
// set above: a rate limit is not a reason to change provider mid-run, and an
// EPERM will never resolve itself by waiting.
// `quota` belongs here now that `credit` has been split out of it. A rate limit
// clears on its own and an empty account does not, and while the two shared one
// code neither could be retried honestly: waiting on a 402 is a loop that never
// ends, and refusing to wait on a 429 throws away a call that would have worked.
const TRANSIENT = new Set(['network', 'timeout', 'quota']);

/**
 * Failures no amount of retrying, escalating or waiting will resolve.
 *
 * A human has to add credit, sign in, install something, or pick a different
 * model. Until they do, every further attempt fails identically — so the honest
 * response is to stop and say so ONCE, not to work down the queue proving it
 * against every task in turn.
 *
 * This is the set that was missing on 2026-08-24. An OpenRouter balance ran out
 * mid-loop; the loop read each 402 as the task failing, counted the attempt,
 * escalated a rung, retried, escalated again, and parked five tasks with
 * reasons describing work that had never run. One of them climbed from `medium`
 * to `xhigh` across six attempts without receiving a single model call.
 */
const NEEDS_HUMAN = new Set(['auth', 'credit', 'capability', 'runtime-missing', 'runtime-permission']);

export const isInfrastructureFailure = code => INFRASTRUCTURE.has(code);
export const isTransientFailure = code => TRANSIENT.has(code);
export const needsHuman = code => NEEDS_HUMAN.has(code);

/**
 * Is this failure the WORK's fault?
 *
 * Never. Every code in this vocabulary describes a call that did not complete,
 * which means nothing the task asked for was ever judged. Whether the work was
 * any good is decided elsewhere — by gates, by review, by whether the workspace
 * changed — and those are not adapter errors.
 *
 * It reads as a constant because it IS one, and it is written down as a
 * function because the call sites are the point: anything about to charge an
 * attempt, spend a rung of the effort ladder, or write a `blockedReason` that
 * describes the work has to ask this first, and get "no".
 */
export const blamesTask = () => false;

/**
 * May an auto-routed call try the next eligible provider after this failure?
 *
 * Only for an `auto` source, and only for an infrastructure failure. "Pinned
 * means pinned" (DESIGN-SPEC.md §6): an explicit source must fail with a
 * remedy rather than silently spend somewhere the user did not choose —
 * possibly on a different bill.
 */
export function mayFallThrough(code, source) {
  if (!source || source === 'auto') return isInfrastructureFailure(code);
  return false;
}

// Keep a message short, single-line and free of anything key-shaped. These
// strings reach logs, retrospectives and the UI.
const SECRET = /(bearer\s+\S+|\b(?:sk|pk)-[A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|token|password|secret|authorization)["'\s]*[:=]["'\s]*[^\s,;"']+)/gi;

export function sanitizeFailureDetail(value, max = 240) {
  const clean = String(value ?? '')
    .replace(SECRET, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const REMEDIES = {
  auth: provider => `Sign in again for ${provider} (Settings → Providers), or add an API key.`,
  capability: (provider, model) => `${provider} cannot serve "${model}". Pick a model it supports, or change the model's source.`,
  credit: provider => `${provider} will not serve this request because the account cannot pay for it. `
    + 'Add credit, lower the token budget, or move to a model that costs nothing. Waiting will not clear it.',
  quota: provider => `${provider} is rate limited or over a plan limit. Wait and try again, or use another provider.`,
  network: provider => `Could not reach ${provider}. Check the connection and try again.`,
  protocol: provider => `${provider} ran but its output could not be read. Update the CLI, or use the API provider instead.`,
  timeout: provider => `${provider} did not answer within the deadline. Raise the timeout or use a faster model.`,
  cancelled: () => 'The run was stopped.',
  unknown: provider => `${provider} failed for an unrecognized reason — see the run log.`
};
// The dashed codes are assigned by key: a hyphen cannot appear in an object
// literal's bare identifier position.
REMEDIES['runtime-missing'] = (provider, _model, exe) =>
  `The ${provider} CLI could not be found${exe ? ` ("${exe}")` : ''}. Install it, or set its path in Settings → Providers → ${provider}.`;
REMEDIES['runtime-permission'] = (provider, _model, exe) =>
  `The ${provider} CLI exists but would not launch${exe ? ` ("${exe}")` : ''} — a permission or blocked-executable problem. `
  + `Check that the file is executable and not blocked by policy, or set a different path in Settings → Providers → ${provider}.`;

/**
 * Classify one adapter error into a stable code plus an actionable remedy.
 *
 * Reads the structured signals first (a code the adapter attached, an errno
 * from `spawn`, an HTTP status) and only falls back to matching the message,
 * because message text is the least stable thing a vendor gives us.
 *
 * @returns {{code, remedy, detail, retryable, infrastructure, provider, model}}
 */
export function classifyAdapterError(err, { provider = 'the provider', model = null, executable = null } = {}) {
  const message = String(err?.message ?? err ?? '');
  const errno = err?.code ?? err?.errno ?? null;
  const status = Number(err?.status ?? err?.statusCode ?? 0);

  let code = 'unknown';
  if (err?.failureCode && FAILURE_CODES.includes(err.failureCode)) {
    code = err.failureCode;                       // an adapter already decided
  } else if (err?.aborted || err?.name === 'AbortError' || /\baborted\b/i.test(message)) {
    code = 'cancelled';
  } else if (errno === 'ENOENT') {
    code = 'runtime-missing';
  } else if (errno === 'EPERM' || errno === 'EACCES') {
    code = 'runtime-permission';
  } else if (errno === 'ETIMEDOUT' || /timed out/i.test(message)) {
    code = 'timeout';
  } else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(errno)) {
    code = 'network';
  } else if (status === 401 || status === 403 || /\b(unauthorized|forbidden|invalid api key|not signed in|log ?in)\b/i.test(message)) {
    code = 'auth';
  } else if (status === 402
    || /\b(requires? more credits?|can only afford|insufficient (?:credit|funds|balance)|out of credit|payment required|add credits|negative balance)\b/i.test(message)) {
    // Distinct from `quota` because the responses are opposite: waiting fixes a
    // rate limit and never fixes an empty account. OpenRouter's 402 reads
    // "This request requires more credits, or fewer max_tokens. You requested
    // up to 12288 tokens, but can only afford 1411" — which matched none of the
    // old wording, so it classified `unknown`, and a loop charged it to the
    // task: five tasks parked in one session with their effort ladders spent,
    // for a failure that never reached a model.
    code = 'credit';
  } else if (status === 429 || /\b(rate limit|too many requests|quota)\b/i.test(message)) {
    code = 'quota';
  } else if (status === 404 || /\b(unknown model|model not found|does not support|unsupported)\b/i.test(message)) {
    code = 'capability';
  } else if (status >= 500 || /\b(socket hang up|network|fetch failed)\b/i.test(message)) {
    code = 'network';
  } else if (/could not launch|is the CLI installed/i.test(message)) {
    code = 'runtime-missing';
  } else if (/\b(unexpected end of json|could not parse|malformed|unknown variant)\b/i.test(message)) {
    code = 'protocol';
  }

  const remedy = REMEDIES[code]?.(provider, model, executable) ?? null;
  return {
    code,
    provider, model,
    remedy,
    detail: sanitizeFailureDetail(message),
    retryable: isTransientFailure(code),
    infrastructure: isInfrastructureFailure(code)
  };
}

/** Attach a classification to an error so it survives being re-thrown. */
export function withFailureCode(err, code, { executable = null } = {}) {
  if (err && FAILURE_CODES.includes(code) && !err.failureCode) {
    err.failureCode = code;
    if (executable) err.executable = executable;
  }
  return err;
}

// --- a tool call nothing could parse ---------------------------------------

// --- Unparsable tool-call markup -------------------------------------------
//
// Some models emit their NATIVE tool-call syntax as ordinary message content
// instead of through the API's tool_calls field. This adapter only assembles
// choice.delta.tool_calls / message.tool_calls, so such a turn records zero
// tool calls, none of them run, and the raw markup flows downstream as if it
// were the deliverable (observed on deepseek-v4-flash: an interrogate node
// delivered `<｜DSML｜tool_calls>` as its specification).
//
// This is detection only, deliberately NOT recovery: parsing a dialect we do
// not speak well enough to execute is how a wrong tool call gets made
// confidently. What callers get is `result.unparsedToolCall` — the dialect
// name — so the failure is VISIBLE (GOALS principle 5) rather than silent.
//
// The separator below is U+FF5C FULLWIDTH VERTICAL LINE (｜), not an ASCII
// pipe. Written from memory this detection once matched nothing, because the
// remembered string used ASCII '|'. The literals here come from the run that
// exhibited the failure; do not "fix" them back to ASCII.
//
// Quoted markup must not fire: prose that EXPLAINS these dialects (this
// repository's own source, tests and docs are full of the words `tool_call`
// and `<invoke`) is a legitimate answer. Fenced code blocks and inline code
// spans are stripped before matching — a real attempted call arrives as bare
// markup, not wrapped in backticks.
export const UNPARSED_TOOL_DIALECTS = [
  // DeepSeek DSML: <｜DSML｜tool_calls> … <｜DSML｜invoke name="...">
  ['deepseek-dsml', /<\u{FF5C}(?:DSML\u{FF5C})?(?:tool_calls?|invoke)\b|<\u{FF5C}DSML\u{FF5C}/u],
  // Hermes / Qwen / several open-weight families. The opening tag alone is not
  // enough: a real emission is followed by its JSON payload, and a sentence
  // ABOUT the format writes "<tool_call>...</tool_call>" with an ellipsis. This
  // repository's own prose does exactly that, and a run reading it must not
  // report itself broken.
  ['hermes-qwen-tool-call', /<\s*tool_calls?\s*>\s*[[{]/i],
  // Anthropic-style XML. Already specific — the attribute has to be there.
  ['anthropic-xml-invoke', /<\s*function_calls\s*>|<\s*invoke\s+name\s*=\s*["']/i],
  // Llama 3.x (ASCII pipes here). Same rule: a real one is followed by the call
  // it is tagging, prose by a full stop or a comma.
  ['llama3-python-tag', /<\|python_tag\|>\s*[\w{[("']/]
];

// Returns the NAME of the first dialect whose markup appears as live content,
// or null when the text is clean. Cheap exit first: no '<', nothing to find.
export function unparsedToolDialect(text) {
  const s = String(text ?? '');
  if (!s.includes('<')) return null;
  const live = s
    .replace(/```[\s\S]*?(?:```|$)/g, '\n') // fenced blocks (incl. unclosed)
    .replace(/`[^`\n]*`/g, ' ');            // inline code spans
  for (const [dialect, re] of UNPARSED_TOOL_DIALECTS) {
    if (re.test(live)) return dialect;
  }
  return null;
}
