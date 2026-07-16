// Shared HTTP-error shaping for the provider adapters.
//
// A failed call has to carry two things out of the adapter: the status, in the
// message, because isTransientError() classifies on it — and the provider's own
// "come back in N" hint, as data, because guessing a backoff when the server has
// told you exactly when to retry is strictly worse than listening (V1 task 11).

// Returns the hint in ms, or null when the provider didn't give one.
export function parseRetryAfter(res, bodyText) {
  // Standard header, in either of its two legal forms.
  const raw = res?.headers?.get?.('retry-after');
  if (raw != null && raw !== '') {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw); // HTTP-date form
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  // OpenRouter is a gateway: when the UPSTREAM provider rate-limits, the 429 it
  // relays carries that provider's hint in the body, not as a header of its own.
  try {
    const meta = JSON.parse(bodyText)?.error?.metadata;
    for (const v of [meta?.retry_after_seconds, meta?.headers?.['Retry-After']]) {
      const secs = Number(v);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    }
  } catch { /* body wasn't JSON — no hint to find */ }
  return null;
}

export function apiError(provider, res, bodyText) {
  const err = new Error(`${provider} API ${res.status}: ${String(bodyText).slice(0, 500)}`);
  const after = parseRetryAfter(res, bodyText);
  if (after != null) err.retryAfterMs = after;
  return err;
}
