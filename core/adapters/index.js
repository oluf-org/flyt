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
//
// opts.toolInputEvents carries the structured start/delta/end lifecycle for
// native tool arguments. It is separate from the rendered text because the
// rendered view is lossy; a durable kernel log needs the exact JSON fragments
// to make a partial call visible and recoverable after a crash.
import { anthropicAdapter } from './anthropic.js';
import { openrouterAdapter } from './openrouter.js';
import { openaiAdapter } from './openai.js';
import { kimiAdapter } from './kimi.js';
import { mockAdapter } from './mock.js';
// Subscription (CLI-delegation) providers: the vendor's own CLI is spawned as
// the authenticated runtime — Flyt never holds a token
// (DESIGN-SPEC.md §6). Same callModel contract as every other adapter.
import { claudeCodeAdapter } from './claudeCode.js';
import { codexAdapter } from './codexCli.js';
import { abortError, isAbortError } from './http.js';
import { withFailureMetadata } from './failures.js';

// RUN-CONTROL: re-exported so callers (runner, tests) classify unwind errors
// the same way the retry loop below does.
export { abortError, isAbortError };

const providers = {
  anthropic: anthropicAdapter,
  'claude-code': claudeCodeAdapter,
  openrouter: openrouterAdapter,
  openai: openaiAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter
};

// The mock adapter is a deterministic test fixture, never a product route.
// Tests opt in at process start; authored production flows cannot reach it.
if (process.env.FLYT_TEST_MOCK_PROVIDER === '1') providers.mock = mockAdapter;

export function registerProvider(name, adapter) {
  providers[name] = adapter;
}

// Can this provider serve this model id? Each adapter declares its own rule
// (DESIGN-SPEC.md §6); resolveModelSource walks providerPriority with it.
export function canServe(provider, modelId) {
  const adapter = providers[provider];
  return adapter?.canServe ? Boolean(adapter.canServe(modelId)) : false;
}

// Whether a provider can participate in Flyt's bounded agent tool loop. Most
// adapters are plain model calls and therefore can use the native or text
// protocol. A delegated coding agent may explicitly opt out when its own tool
// runtime cannot be reconciled with Flyt's ceiling.
export function canUseFlytTools(provider) {
  return providers[provider]?.flytTools !== false;
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

// --- Per-call deadlines (DESIGN-SPEC.md §8) -----------------------------------
//
// Cancellation already existed — RUN-CONTROL threads an AbortSignal into every
// adapter — but nothing ever fired it on time. A provider that opens a
// connection and then goes quiet never errors, so the retry budget never
// engages and the node sits there: seen live at 347s on a node that normally
// took 79-104s. Attended you notice and press stop. Unattended (DESIGN-SPEC.md §8)
// nobody does, and that task is wedged until someone comes home.
//
// The deadline is on PROGRESS, not on total duration. Every onText emission is
// proof the connection is moving, so a legitimately long stream keeps resetting
// its own deadline and only silence counts. A non-streaming call has no
// progress signal, so for it the idle deadline is effectively the whole call —
// which is why the default is generous rather than tight.
//
// A fired deadline is TRANSIENT: it becomes an ordinary retryable failure and
// each attempt gets a fresh deadline. A deliberate stop() is not, and wins the
// race for which of the two happened — see the catch in callModel.
export const DEFAULT_TIMEOUT = { idleMs: 300_000, hardMs: null };

function timeoutError(provider, kind, ms) {
  const secs = Math.round(ms / 1000);
  return Object.assign(
    new Error(kind === 'idle'
      ? `${provider} sent nothing for ${secs}s — the connection stalled (idle timeout)`
      : `${provider} call exceeded its ${secs}s ceiling (hard timeout)`),
    // Transient so the existing classifier retries it, the way it already
    // retries a 408. `timedOut` lets callers tell a deadline from a 5xx.
    { transient: true, timedOut: true, timeoutKind: kind }
  );
}

// A deadline for one attempt. Two enforcement paths on purpose:
//   - aborting `signal`, so the underlying request actually stops and the
//     socket/child process is released rather than left running, and
//   - rejecting `expired`, raced against the adapter, so an adapter that
//     ignores its signal still cannot hold the call open forever. Adapters are
//     pluggable (registerProvider), so "every adapter honors abort" is a
//     property of today's code, not a guarantee to bet supervision on.
function startDeadline({ provider, signal, idleMs, hardMs }) {
  const ctl = new AbortController();
  let idleTimer = null;
  let hardTimer = null;
  let fired = null;
  let rejectExpired = null;
  // Always consumed by the Promise.race below, so a rejection after the race
  // has settled is observed (and ignored) rather than unhandled.
  const expired = new Promise((_, reject) => { rejectExpired = reject; });

  const clear = () => {
    clearTimeout(idleTimer); clearTimeout(hardTimer);
    idleTimer = hardTimer = null;
  };
  const fire = kind => {
    if (fired) return;
    fired = timeoutError(provider, kind, kind === 'idle' ? idleMs : hardMs);
    clear();
    ctl.abort();
    rejectExpired(fired);
  };
  // The caller's own stop: abort downstream, but never as a timeout.
  const onOuterAbort = () => { clear(); ctl.abort(); };

  // Unref'd on purpose: a deadline must not be the reason a process stays
  // alive. While a real call is in flight its socket or child process holds the
  // loop open and the timer fires normally; once nothing else is pending there
  // is nothing left to time out, and a headless `flyt` command should exit
  // rather than linger for the length of the longest deadline it ever armed.
  const arm = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

  const touch = () => {
    if (fired || !idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = arm(() => fire('idle'), idleMs);
  };

  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  touch();
  if (hardMs) hardTimer = arm(() => fire('hard'), hardMs);

  return {
    signal: ctl.signal,
    expired,
    touch,
    get error() { return fired; },
    get timedOut() { return Boolean(fired); },
    // Timers hold the event loop open and a run's controller outlives hundreds
    // of calls, so both are released on every settle — a listener per call left
    // on a long-lived signal is a leak that only shows up on long runs, which
    // is exactly the workload this is for.
    dispose() { clear(); signal?.removeEventListener('abort', onOuterAbort); }
  };
}

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
// timeout: { idleMs, hardMs } — the per-attempt deadline above, overridable per
// call and from config.json (`timeout`). Adapters that supervise their own
// child process (the CLI-delegation providers) opt out of the idle half.
//
// onCall(record) — fires ONCE per settled call (success or final failure) with
// a metadata-only record of what was sent and what came back. This is the
// black box: a run that failed on "empty response" could previously be
// diagnosed only by re-running it, because nothing anywhere recorded the
// finish reason, the token split, or how big the request was. Metadata only,
// by design — the bodies are large, and the sizes are what answer the
// questions actually asked of a failed call.
export async function callModel({ provider, model, system, prompt, maxTokens = 4096, apiKey, messages, tools, retry, timeout, onText, onRetry, onCall, signal, ...rest }) {
  const adapter = providers[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(providers).join(', ')}`);
  const attempts = Math.max(1, retry?.attempts ?? DEFAULT_RETRY.attempts);
  const baseMs = retry?.baseMs ?? DEFAULT_RETRY.baseMs;
  const maxMs = retry?.maxMs ?? DEFAULT_RETRY.maxMs;
  // A self-timed adapter spawns a CLI that can legitimately go quiet for
  // minutes while a child process works (a long `bash` inside claude-code), so
  // an idle deadline there would fail healthy work. It bounds itself
  // (spawnCliCall's own timeoutMs) and still honors the signal, so a stop and
  // any hard ceiling both still reach it.
  const idleMs = adapter.selfTimed ? 0 : (timeout?.idleMs ?? DEFAULT_TIMEOUT.idleMs);
  const hardMs = timeout?.hardMs ?? DEFAULT_TIMEOUT.hardMs;
  const started = Date.now();
  const queuedAt = new Date(started).toISOString();
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // RUN-CONTROL: a stop that landed between attempts (or before the first)
    // ends the call immediately — an abort is never retried below either.
    if (signal?.aborted) throw abortError();
    const deadline = startDeadline({ provider, signal, idleMs, hardMs });
    const attemptStarted = Date.now();
    const transport = { dispatchAt: null, headersAt: null, status: null };
    const onTransport = event => {
      if (event?.phase === 'dispatch') transport.dispatchAt = event.at ?? new Date().toISOString();
      if (event?.phase === 'headers') {
        transport.headersAt = event.at ?? new Date().toISOString();
        transport.status = event.status ?? null;
      }
    };
    // Streaming keeps the deadline alive: each emission proves the connection
    // is moving, so only silence is counted against it.
    // Streamed characters are counted whether or not the caller wanted them,
     // because they are the only evidence of what a call that never returned
     // actually generated — and a generation you were billed for and cannot see
     // is exactly the spend a ceiling has to bound. A runaway planner produced
     // 560,242 lines here, was killed by the liveness watchdog, and recorded no
     // usage, no cost and no ledger line at all: the most expensive call of the
     // night was the one the ledger scored at zero.
    // Whether a call streams at all is decided by whether the ADAPTER is handed
    // an onText, so this must stay undefined when the caller wanted none —
    // making every call stream in order to measure it would change what is sent
    // on the wire to answer a question about cost.
    //
    // onText carries the WHOLE turn so far, not the new piece (http.js
    // renderTurn). So the size of the generation is the largest snapshot seen,
    // never the sum of them: summing counts a 10k answer delivered in 200
    // emissions as a million characters, and this number prices a ledger line.
    let streamedChars = 0;
    let visibleOutputProduced = false, reasoningOutputProduced = false, toolCallProduced = false;
    let firstByteMs = null, firstReasoningMs = null, firstVisibleMs = null, firstToolInputMs = null;
    let lastChunkMs = null, lastStreamAt = null;
    let tokensBeforeFirstVisible = null, tokensBeforeFirstTool = null;
    const streamIdleGaps = [];
    const watched = onText
      ? (text, opts) => {
        const now = Date.now();
        const elapsed = now - attemptStarted;
        const telemetry = opts?.telemetry ?? {};
        if (firstByteMs == null) firstByteMs = elapsed;
        if (lastStreamAt != null && now - lastStreamAt >= 1_000 && streamIdleGaps.length < 20) streamIdleGaps.push(now - lastStreamAt);
        lastStreamAt = now; lastChunkMs = elapsed;
        const rendered = String(text ?? '');
        const reasoningChars = Number(telemetry.reasoningChars) || (rendered.startsWith('⟢ thinking…') ? rendered.length : 0);
        const contentChars = Number(telemetry.contentChars) || ((!rendered.startsWith('⟢ thinking…') && !rendered.trimStart().startsWith('→')) ? rendered.length : 0);
        const toolInputChars = Number(telemetry.toolInputChars) || (rendered.includes('→ ') ? rendered.length : 0);
        visibleOutputProduced ||= contentChars > 0;
        reasoningOutputProduced ||= reasoningChars > 0;
        toolCallProduced ||= toolInputChars > 0 || Boolean(opts?.toolInputEvents?.length);
        if (firstReasoningMs == null && reasoningChars > 0) firstReasoningMs = elapsed;
        if (firstVisibleMs == null && contentChars > 0) {
          firstVisibleMs = elapsed;
          tokensBeforeFirstVisible = Math.round((reasoningChars + contentChars + toolInputChars) / CHARS_PER_TOKEN);
        }
        if (firstToolInputMs == null && toolInputChars > 0) {
          firstToolInputMs = elapsed;
          tokensBeforeFirstTool = Math.round((reasoningChars + contentChars + toolInputChars) / CHARS_PER_TOKEN);
        }
        streamedChars = Math.max(streamedChars, String(text ?? '').length);
        deadline.touch();
        return onText(text, opts);
      }
      : undefined;
    try {
      // Extra fields (rest — e.g. kimi's keyKind, stamped by the main process)
      // pass straight through to the adapter; callers never handle them.
      const result = await Promise.race([
        adapter({ model, system, prompt, maxTokens, apiKey, messages, tools, onText: watched, signal: deadline.signal, onTransport, ...rest }),
        deadline.expired
      ]);
      const settled = {
        ...result, provider, model,
        durationMs: Date.now() - started,
        ...(attempt > 0 ? { retries: attempt } : {})
      };
      // A non-streaming response still has an observed first response time; it
      // simply cannot distinguish first byte from the complete body.
      const responseMs = Date.now() - attemptStarted;
      if (firstByteMs == null) firstByteMs = responseMs;
      if (firstReasoningMs == null && String(result?.reasoning ?? '').length) firstReasoningMs = responseMs;
      if (firstVisibleMs == null && String(result?.text ?? '').length) firstVisibleMs = responseMs;
      if (firstToolInputMs == null && result?.message?.tool_calls?.length) firstToolInputMs = responseMs;
      report(onCall, {
        provider, model, maxTokens, system, prompt, messages, tools, attempt, started, queuedAt, attemptStarted, transport,
        firstByteMs, firstReasoningMs, firstVisibleMs, firstToolInputMs, lastChunkMs,
        tokensBeforeFirstVisible, tokensBeforeFirstTool, streamIdleGaps, ...rest
      }, settled, null);
      return settled;
    } catch (err) {
      // Precedence matters. Aborting the adapter is HOW a deadline is enforced,
      // so a fired deadline arrives here as an AbortError that must not be read
      // as a deliberate stop — but the caller's own signal outranks both, since
      // a stop landing during a timeout is still a stop.
      const ctx = {
        provider, model, maxTokens, system, prompt, messages, tools, attempt, started, queuedAt, attemptStarted, transport, streamedChars,
        visibleOutputProduced, reasoningOutputProduced, toolCallProduced,
        firstByteMs, firstReasoningMs, firstVisibleMs, firstToolInputMs, lastChunkMs,
        tokensBeforeFirstVisible, tokensBeforeFirstTool, streamIdleGaps, ...rest
      };
      if (signal?.aborted) {
        const aborted = isAbortError(err) ? err : abortError();
        report(onCall, ctx, null, aborted);
        throw aborted;
      }
      const failure = withFailureMetadata(deadline.timedOut ? deadline.error : err, {
        provider, model, source: 'provider',
        userInitiated: false, visibleOutputProduced, reasoningOutputProduced, toolCallProduced,
      });
      lastErr = failure;
      // An abort with nobody having asked for one: an adapter's own cancellation.
      if (isAbortError(failure)) { report(onCall, ctx, null, failure); throw failure; }
      // Replaying visible prose or a partially assembled tool call can duplicate
      // side effects at a layer that cannot see the task checkpoint. Reasoning
      // alone is explicitly safe to discard and retry.
      if (attempt === attempts - 1 || !isTransientError(failure)
        || visibleOutputProduced || toolCallProduced) {
        report(onCall, ctx, null, failure);
        throw failure;
      }
      // The provider's own Retry-After wins whenever it asks for longer than we
      // guessed — it knows when its window reopens and we don't. Capped, so a
      // hostile or mistaken hint can't park the run indefinitely.
      const backoff = baseMs * 2 ** attempt * (1 + Math.random() * 0.25);
      const hinted = failure?.retryAfterMs ?? 0;
      const delayMs = Math.round(Math.min(maxMs, Math.max(backoff, hinted)));
      onRetry?.({
        attempt: attempt + 1, attempts, delayMs,
        retryAfterMs: failure?.retryAfterMs ?? null,
        // A timeout is reported as one: "did it stall or did it 429?" is the
        // first question asked of a run that took all morning.
        ...(failure?.timedOut ? { timedOut: true, timeoutKind: failure.timeoutKind } : {}),
        error: String(failure?.message ?? failure).slice(0, 300),
        failure: failure.failure,
      });
      await sleepAbortable(delayMs, signal);
    } finally {
      deadline.dispose();
    }
  }
  throw lastErr; // unreachable, but keeps the control flow explicit
}

// The black-box record for one settled model call (see onCall above).
//
// Everything here answers a question a failed run actually raised and could not
// answer: "was the answer truncated?" (finishReason), "did it spend the whole
// budget thinking?" (reasoningChars / reasoning_tokens vs maxTokens), "was the
// request enormous?" (promptChars), "did it even get to answer?" (contentChars),
// "how long did we wait?" (ms). A reporter that throws must never take the call
// down with it — this is instrumentation, not behavior.
// Four characters to a token is the crude industry rule of thumb, and crude is
// the honest precision here: this only ever prices a call the provider never
// reported on, and every number derived from it is labelled `estimated`.
export const CHARS_PER_TOKEN = 4;

export function callRecord(ctx, result, error) {
  const msgs = ctx.messages ?? null;
  const promptChars = msgs
    ? msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
    : String(ctx.system ?? '').length + String(ctx.prompt ?? '').length;
  return {
    provider: ctx.provider,
    model: ctx.model,
    ...(result?.resolvedModel && result.resolvedModel !== ctx.model ? { servedBy: result.resolvedModel } : {}),
    maxTokens: ctx.maxTokens ?? null,
    requestedOutputBudget: ctx.requestedOutputBudget ?? ctx.maxTokens ?? null,
    effectiveOutputBudget: ctx.effectiveOutputBudget ?? ctx.maxTokens ?? null,
    contextTokens: ctx.contextTokens ?? null,
    contextLimit: ctx.contextLimit ?? null,
    contextUtilization: ctx.contextUtilization ?? null,
    queuedAt: ctx.queuedAt ?? new Date(ctx.started).toISOString(),
    dispatchAt: ctx.transport?.dispatchAt ?? new Date(ctx.attemptStarted ?? ctx.started).toISOString(),
    headersAt: ctx.transport?.headersAt ?? null,
    firstByteAt: ctx.firstByteMs == null ? null : new Date((ctx.attemptStarted ?? ctx.started) + ctx.firstByteMs).toISOString(),
    firstReasoningAt: ctx.firstReasoningMs == null ? null : new Date((ctx.attemptStarted ?? ctx.started) + ctx.firstReasoningMs).toISOString(),
    firstVisibleAt: ctx.firstVisibleMs == null ? null : new Date((ctx.attemptStarted ?? ctx.started) + ctx.firstVisibleMs).toISOString(),
    firstToolCallAt: ctx.firstToolInputMs == null ? null : new Date((ctx.attemptStarted ?? ctx.started) + ctx.firstToolInputMs).toISOString(),
    completedAt: new Date().toISOString(),
    httpStatus: ctx.transport?.status ?? null,
    queueTimeMs: Math.max(0, (ctx.attemptStarted ?? ctx.started) - ctx.started),
    startedAt: new Date(ctx.attemptStarted ?? ctx.started).toISOString(),
    messages: msgs ? msgs.length : 2,
    promptChars,
    tools: Array.isArray(ctx.tools) ? ctx.tools.length : 0,
    toolNames: Array.isArray(ctx.tools) ? ctx.tools.map(tool => tool?.function?.name ?? tool?.name).filter(Boolean).slice(0, 100) : [],
    ms: Date.now() - ctx.started,
    attemptMs: Date.now() - (ctx.attemptStarted ?? ctx.started),
    firstByteMs: ctx.firstByteMs ?? null,
    firstReasoningMs: ctx.firstReasoningMs ?? null,
    firstVisibleMs: ctx.firstVisibleMs ?? null,
    firstToolInputMs: ctx.firstToolInputMs ?? null,
    lastChunkMs: ctx.lastChunkMs ?? null,
    streamIdleGaps: ctx.streamIdleGaps ?? [],
    ...(ctx.tokensBeforeFirstVisible != null ? { tokensBeforeFirstVisible: ctx.tokensBeforeFirstVisible, milestoneTokensEstimated: true } : {}),
    ...(ctx.tokensBeforeFirstTool != null ? { tokensBeforeFirstTool: ctx.tokensBeforeFirstTool, milestoneTokensEstimated: true } : {}),
    ...(ctx.attempt ? { attempts: ctx.attempt + 1 } : {}),
    ...(error
      ? {
        ok: false,
        error: String(error?.message ?? error).slice(0, 400),
        failure: error?.failure ?? null,
        // What it generated before it died, and the token estimate that follows
        // from it. Marked `estimated` at every step so nothing downstream can
        // mistake a guess for a measurement (core/ledger.js costOf) — but a
        // marked guess is the difference between a cap that binds and one that
        // cannot see the spend it exists to stop.
        ...(ctx.streamedChars
          ? {
            streamedChars: ctx.streamedChars,
            estimated: true,
            usage: {
              prompt_tokens: Math.round(promptChars / CHARS_PER_TOKEN),
              completion_tokens: Math.round(ctx.streamedChars / CHARS_PER_TOKEN),
              estimated: true
            }
          }
          : {})
      }
      : {
        ok: true,
        finishReason: result?.finishReason ?? null,
        contentChars: String(result?.text ?? '').length,
        reasoningChars: String(result?.reasoning ?? '').length,
        toolCalls: result?.message?.tool_calls?.length ?? 0,
        ...(result?.cost != null ? { cost: result.cost } : {}),
        ...(result?.unparsedToolCall ? { unparsedToolCall: result.unparsedToolCall } : {}),
        ...(result?.usage ? { usage: result.usage } : {})
      })
  };
}

function report(onCall, ctx, result, error) {
  if (!onCall) return;
  try { onCall(callRecord(ctx, result, error)); } catch { /* instrumentation never fails a call */ }
}
