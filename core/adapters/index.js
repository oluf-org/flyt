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
import { openaiAdapter } from './openai.js';
import { kimiAdapter } from './kimi.js';
import { mockAdapter } from './mock.js';
// Subscription (CLI-delegation) providers: the vendor's own CLI is spawned as
// the authenticated runtime — Flyt never holds a token
// (SUBSCRIPTION-AUTH-GUIDE). Same callModel contract as every other adapter.
import { claudeCodeAdapter } from './claudeCode.js';
import { codexAdapter } from './codexCli.js';
import { abortError, isAbortError } from './http.js';

// RUN-CONTROL: re-exported so callers (runner, tests) classify unwind errors
// the same way the retry loop below does.
export { abortError, isAbortError };

const providers = {
  anthropic: anthropicAdapter,
  'claude-code': claudeCodeAdapter,
  openrouter: openrouterAdapter,
  openai: openaiAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
  mock: mockAdapter
};

export function registerProvider(name, adapter) {
  providers[name] = adapter;
}

// Can this provider serve this model id? Each adapter declares its own rule
// (PROVIDERS-PLAN §2); resolveModelSource walks providerPriority with it.
export function canServe(provider, modelId) {
  const adapter = providers[provider];
  return adapter?.canServe ? Boolean(adapter.canServe(modelId)) : false;
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

// A stalled provider is not an abort — it is a transient failure that the retry
// budget should engage on (PIVOT-PLAN §5.2, verification item 5). Marked
// `transient` so isTransientError() classifies it without string matching, and
// `timedOut` so a caller can tell "the provider went quiet" from "the user
// pressed stop".
export function timeoutError(ms) {
  return Object.assign(
    new Error(`The model call exceeded its ${ms}ms timeout and was aborted`),
    { transient: true, timedOut: true }
  );
}

// One signal that fires when the caller's signal fires OR the timer expires.
// DESIGN-SPEC §11.1 recorded the gap this closes: an AbortSignal is threaded
// everywhere, but nothing ever fired it on a timer, so a provider that simply
// stopped answering hung a node forever (a live run sat for 347 seconds). The
// timer lives here because this is where the ledger lives — one wrapper, one
// place that knows a call's real start and real end.
function withTimeout(outer, timeoutMs) {
  const finite = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!finite && !outer) return { signal: undefined, done: () => {}, timedOut: () => false };
  if (!finite) return { signal: outer, done: () => {}, timedOut: () => false };
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; ctl.abort(); }, timeoutMs);
  const onOuter = () => ctl.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  if (outer?.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    done() { clearTimeout(timer); outer?.removeEventListener('abort', onOuter); },
    timedOut: () => fired
  };
}

// A backoff sleep that a stop() can cut short: resolves normally, rejects
// with an AbortError the moment the signal fires. No signal = plain sleep.
const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (!signal) return resolve(sleep(ms));
  if (signal.aborted) return reject(abortError());
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
  const onAbort = () => { cleanup(); reject(abortError()); };
  const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

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
// ledger (optional, PIVOT-PLAN §4.2) — a bound recorder from
// core/callLedger.js. One record per ATTEMPT is written from inside the loop
// below, which is why a call that failed twice before succeeding leaves three
// records rather than one: retries stop being invisible.
//
// timeoutMs (optional, §5.2) — abort the attempt if the provider goes quiet.
// Counted per attempt, so the budget is "how long may ONE try take", not "how
// long may the whole retry sequence take".
export async function callModel({ provider, model, system, prompt, maxTokens = 4096, apiKey, messages, tools, retry, onText, onRetry, signal, ledger = null, timeoutMs = null, protocol = null, ...rest }) {
  const adapter = providers[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(providers).join(', ')}`);
  const attempts = Math.max(1, retry?.attempts ?? DEFAULT_RETRY.attempts);
  const baseMs = retry?.baseMs ?? DEFAULT_RETRY.baseMs;
  const maxMs = retry?.maxMs ?? DEFAULT_RETRY.maxMs;
  // Total wall time INCLUDING backoff, kept separately: it is a real number
  // about the call, it just isn't latency (§4.1.2).
  const callStarted = Date.now();
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // RUN-CONTROL: a stop that landed between attempts (or before the first)
    // ends the call immediately — an abort is never retried below either.
    if (signal?.aborted) throw abortError();
    // §4.1.2: `started` lives INSIDE the loop. Measured outside it, a call that
    // succeeded on attempt 3 reported its backoff sleeps as provider latency,
    // and every latency number in the app was silently wrong.
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    // Time-to-first-token comes free: adapters already call onText with the
    // accumulated text, so the wrapper timestamps the first invocation.
    // Non-streaming adapters never call it and report ttftMs: null.
    let firstTokenAt = null;
    const timedOnText = onText
      ? (text, opts) => { firstTokenAt ??= new Date().toISOString(); return onText(text, opts); }
      : undefined;
    const gate = withTimeout(signal, timeoutMs);
    const wireWanted = Boolean(ledger) && ledger.wireMode !== 'off';
    try {
      // Extra fields (rest — e.g. kimi's keyKind, stamped by the main process)
      // pass straight through to the adapter; callers never handle them.
      const result = await adapter({
        model, system, prompt, maxTokens, apiKey, messages, tools,
        onText: timedOnText, signal: gate.signal, captureWire: wireWanted, ...rest
      });
      ledger?.record({
        provider, model, attempt, retries: attempt,
        startedAt, firstTokenAt, endedAt: new Date().toISOString(),
        usage: result.usage ?? null,
        finishReason: result.finishReason ?? null,
        protocol: protocol ?? (tools?.length ? 'native' : null),
        wire: result.wire ?? null,
        wireUnavailable: result.wireUnavailable ?? null
      });
      return {
        ...result, provider, model,
        durationMs: Date.now() - started,     // this attempt only
        totalMs: Date.now() - callStarted,    // including every backoff sleep
        ...(attempt > 0 ? { retries: attempt } : {})
      };
    } catch (rawErr) {
      // A timeout reaches here as the AbortError our own timer caused. Convert
      // it back into what it actually is before anything classifies it.
      const err = (gate.timedOut() && isAbortError(rawErr) && !signal?.aborted)
        ? Object.assign(timeoutError(timeoutMs), { cause: rawErr })
        : rawErr;
      lastErr = err;
      ledger?.record({
        provider, model, attempt, retries: attempt,
        startedAt, firstTokenAt, endedAt: new Date().toISOString(),
        usage: err?.usage ?? null,
        finishReason: null,
        protocol: protocol ?? (tools?.length ? 'native' : null),
        wire: err?.wire ?? null,
        wireUnavailable: err?.wireUnavailable ?? null,
        error: err?.message ?? String(err)
      });
      // An abort is a deliberate stop, not a transient failure: no retry.
      if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
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
      await sleepAbortable(delayMs, signal);
    } finally {
      // The timer must not outlive its attempt: a call that returned in 200ms
      // would otherwise leave a 120-second handle holding the process open.
      gate.done();
    }
  }
  throw lastErr; // unreachable, but keeps the control flow explicit
}
