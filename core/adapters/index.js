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
// onText(textSoFar) — incremental output. Adapters that can stream call it
// with the FULL accumulated text after each chunk (not a delta), so a
// transparent retry after a mid-stream failure simply starts over and the
// consumer's last write is always a consistent prefix of the final text.
// Adapters that can't stream never call it; the final result is unchanged.
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
  return TRANSIENT_RE.test(String(err?.message ?? err));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// retry: { attempts, baseMs } — exponential backoff with jitter between
// attempts, only for transient errors. Permanent errors (401, bad request,
// unknown provider) surface immediately.
export async function callModel({ provider, model, system, prompt, maxTokens = 4096, apiKey, messages, tools, retry, onText }) {
  const adapter = providers[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(providers).join(', ')}`);
  const attempts = Math.max(1, retry?.attempts ?? 3);
  const baseMs = retry?.baseMs ?? 1000;
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
      await sleep(baseMs * 2 ** attempt * (1 + Math.random() * 0.25));
    }
  }
  throw lastErr; // unreachable, but keeps the control flow explicit
}
