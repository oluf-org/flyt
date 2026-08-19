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
  'quota',               // out of credit, rate limited, plan exhausted
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
const TRANSIENT = new Set(['network', 'timeout']);

export const isInfrastructureFailure = code => INFRASTRUCTURE.has(code);
export const isTransientFailure = code => TRANSIENT.has(code);

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
  quota: provider => `${provider} is out of quota or rate limited. Wait, raise the limit, or use another provider.`,
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
  } else if (status === 429 || /\b(rate limit|quota|insufficient credit|out of credit|payment required)\b/i.test(message)) {
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
