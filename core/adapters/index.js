// Unified worker adapter. Every node calls a model through this one
// signature; providers are interchangeable implementations behind it.
// Adding OpenAI / local models later = add a file here + a config entry.
//
//   callModel({ provider, model, system, prompt, maxTokens, apiKey,
//               messages?, tools?, onText? }) ->
//     { text, model, provider, usage, durationMs, finishReason?, message? }
// messages/tools are the agent-loop shape (see core/agent.js); adapters that
// don't understand them (mock) simply ignore them.
//
// onText(textSoFar, opts) — incremental output. Adapters that can stream call
// it with the FULL accumulated text after each chunk (not a delta), so a
// transparent retry after a mid-stream failure simply starts over and the
// consumer's last write is always a consistent prefix of the final text.
// Adapters that can't stream never call it; the final result is unchanged.
//
// opts.final marks the LAST emit of a call, and consumers must not throttle it
// away. Consumers throttle on the reasoning that dropping a chunk is safe
// because the caller's own write afterwards is authoritative — true for a
// single-shot call, false inside an agent loop, where each intermediate turn is
// superseded by the NEXT turn rather than by any write. Without a guaranteed
// last emit, a turn's most informative state is exactly the state that gets
// dropped: a tool call's name arrives first and claims the throttle window, and
// its arguments — the part that says what the agent is actually doing — stream
// in behind it and vanish.
import { anthropicAdapter } from './anthropic.js';
import { openrouterAdapter } from './openrouter.js';
import { mockAdapter } from './mock.js';

const providers = {
  anthropic: anthropicAdapter,
  openrouter: openrouterAdapter,
  mock: mockAdapter
};

export function registerProvider(name, adapter) {
  providers[name] = adapter;
}

// Transient failures worth an automatic retry: rate limits (429), timeouts
// (408), server errors (5xx) — adapters embed the HTTP status in the error
// message — and network-level fetch failures.
const TRANSIENT_RE = /\bAPI (408|429|5\d\d)\b|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket/i;
export function isTransientError(err) {
  // An adapter can say so outright, for failures with no status to match on —
  // e.g. a stream that ends having delivered nothing (see openrouter.js).
  if (err?.transient === true) return true;
  return TRANSIENT_RE.test(String(err?.message ?? err));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry policy, overridable per call and from config.json (`retry`).
//
// Five attempts over ~15s of backoff, not three over ~3.3s: rate limits are
// routine rather than exceptional against real providers — a live run was
// refused three times inside 3.3s and gave up while the provider was still
// saying "retry shortly" — and 3.3s is simply not much tolerance to offer. The
// cap bounds a single wait, so a provider asking for an hour cannot park a run
// for one.
export const DEFAULT_RETRY = { attempts: 5, baseMs: 1000, maxMs: 30000 };

// retry: { attempts, baseMs, maxMs } — exponential backoff with jitter between
// attempts, only for transient errors. Permanent errors (401, bad request,
// unknown provider) surface immediately.
//
// onRetry({ attempt, attempts, delayMs, error }) — fires before each backoff
// sleep. Retries are otherwise invisible: a successful call reports a `retries`
// count, but a call that exhausts its budget just throws, so the attempts that
// led there left no trace and "did backoff actually run?" could only be guessed
// from wall-clock timing. Callers log it (V1 task 11).
export async function callModel({ provider, model, system, prompt, maxTokens = 4096, apiKey, messages, tools, retry, onText, onRetry }) {
  const adapter = providers[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(providers).join(', ')}`);
  const attempts = Math.max(1, retry?.attempts ?? DEFAULT_RETRY.attempts);
  const baseMs = retry?.baseMs ?? DEFAULT_RETRY.baseMs;
  const maxMs = retry?.maxMs ?? DEFAULT_RETRY.maxMs;
  const started = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await adapter({ model, system, prompt, maxTokens, apiKey, messages, tools, onText });
      return {
        ...result, provider, model,
        durationMs: Date.now() - started,
        ...(attempt > 0 ? { retries: attempt } : {})
      };
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1 || !isTransientError(err)) throw err;
      // The provider's own Retry-After wins whenever it asks for longer than we
      // guessed — it knows when its window reopens and we don't. Capped, so a
      // hostile or mistaken hint can't park the run indefinitely.
      const backoff = baseMs * 2 ** attempt * (1 + Math.random() * 0.25);
      const hinted = err?.retryAfterMs ?? 0;
      const delayMs = Math.round(Math.min(maxMs, Math.max(backoff, hinted)));
      onRetry?.({
        attempt: attempt + 1, attempts, delayMs,
        retryAfterMs: err?.retryAfterMs ?? null,
        error: String(err?.message ?? err).slice(0, 300)
      });
      await sleep(delayMs);
    }
  }
  throw lastErr; // unreachable, but keeps the control flow explicit
}
