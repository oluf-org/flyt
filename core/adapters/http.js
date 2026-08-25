// Shared HTTP machinery for the provider adapters.
//
// A failed call has to carry two things out of the adapter: the status, in the
// message, because isTransientError() classifies on it — and the provider's own
// "come back in N" hint, as data, because guessing a backoff when the server has
// told you exactly when to retry is strictly worse than listening (V1 task 11).
//
// This module also hosts openaiCompatible(), the single implementation behind
// every OpenAI-compatible chat-completions provider (openrouter, openai, kimi):
// same body shape, same streaming/tool-call reassembly, different base URL and
// auth headers. Add a provider = one small file calling the factory.

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

// Cooperative cancellation (RUN-CONTROL): the runner threads an AbortSignal
// down through callModel; adapters pass it to fetch and check it between
// stream events. The error is marked both ways callers test for it — the
// DOM-style name 'AbortError' (what fetch itself throws on abort) and an
// `aborted` flag — so retry logic and run-control recognize it without
// string matching.
export function abortError(message = 'The model call was aborted') {
  return Object.assign(new Error(message), { name: 'AbortError', aborted: true });
}
export function isAbortError(err) {
  return Boolean(err?.aborted || err?.name === 'AbortError');
}

// The dialect table and its detector live in ./failures.js, so EVERY adapter
// is covered rather than only the HTTP ones. Detection sitting here meant the
// mock adapter, the CLI-delegate adapters and any registered provider got
// none of it. Re-exported because this is where callers found them first.
import { unparsedToolDialect } from './failures.js';
export { UNPARSED_TOOL_DIALECTS, unparsedToolDialect } from './failures.js';

// Parse an SSE byte stream into the `data:` payload strings.
export async function* sseEvents(readable) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readable) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

// One adapter implementation for every OpenAI-compatible chat-completions API.
//
//   openaiCompatible({ provider, baseUrl, headers?, keyHelp?, envKey? }) ->
//     adapter({ model, system, prompt, messages?, tools?, maxTokens, apiKey, onText?, signal? })
//
// - provider: display name used in error messages ('OpenRouter', 'OpenAI', 'Kimi').
// - headers: extra request headers (OpenRouter's referer/title; Kimi Code's
//   coding-agent User-Agent, which that endpoint requires).
// - keyHelp: where the user gets a key, appended to the missing-key error.
// - envKey: optional environment-variable fallback for shell use (BYO-key
//   contract unchanged — a caller-supplied key always wins).
//
// Two calling shapes:
//   { system, prompt }        — classic single-shot
//   { messages, tools? }      — agent loop: full message array + optional
//                               OpenAI function-tool definitions. The raw
//                               assistant message comes back so the loop can
//                               echo tool_calls and read finish_reason.
// - extendBody(body, params): a hook for provider-specific request fields, so
//   an extension one provider offers (OpenRouter's routing plugins) lives in
//   that provider's file instead of leaking into the shared factory every
//   provider uses.
export function openaiCompatible({ provider, baseUrl, headers = {}, keyHelp = 'Add it in Settings.', envKey = null, extendBody = null }) {
  return async function openaiCompatibleAdapter({ model, system, prompt, messages, tools, maxTokens, apiKey, onText, signal, ...rest }) {
    const key = apiKey || (envKey ? process.env[envKey] : null);
    if (!key) throw new Error(`${provider} API key is not set. ${keyHelp}`);

    // Tool-using turns stream too (V1 task 12): the loop still gets its raw
    // message; it is reassembled from the deltas below.
    const stream = Boolean(onText);
    const body = {
      model,
      max_tokens: maxTokens,
      messages: messages ?? [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    };
    if (tools?.length) body.tools = tools;
    if (stream) {
      body.stream = true;
      // Ask for the trailing usage chunk — a streamed response carries no token
      // counts unless requested, and streamed calls are the default now, so
      // without this every streamed call reported null usage.
      body.stream_options = { include_usage: true };
    }

    extendBody?.(body, { model, ...rest });

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body),
      // RUN-CONTROL: optional cooperative cancellation (stop()). fetch rejects
      // with an AbortError when it fires; the stream loop below checks it too.
      ...(signal ? { signal } : {})
    });

    if (!res.ok) {
      throw apiError(provider, res, await res.text());
    }

    if (stream) {
      let text = '';
      // Reasoning tokens are content the model produced and was charged for,
      // and until now this adapter threw them away. A reasoning model routinely
      // spends most of a turn here — measured against deepseek-v4-pro: 6198 of
      // 7628 completion tokens — and emits its `content` only at the end, or
      // (when the budget runs out first) not at all. Dropping the stream meant
      // two failures at once: nothing to show for the minutes the node spent
      // thinking, and a turn that ended in reasoning alone read as "empty
      // response" with no evidence of what actually happened.
      let reasoning = '';
      let usage = null;
      let finishReason = null;
      // Which model actually answered. With the Auto Router the requested id is
      // `openrouter/auto`, so without this every retrospective, log line and
      // ledger entry would say "auto" and nobody could tell what ran.
      let resolvedModel = null;
      const frags = new Map(); // tool_call index -> the call being assembled

      for await (const event of sseEvents(res.body)) {
        // A mid-stream stop: fetch's own abort also rejects this loop, but the
        // explicit check makes the exit deterministic on every runtime.
        if (signal?.aborted) throw abortError();
        if (event === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(event); } catch { continue; }
        const choice = chunk.choices?.[0];
        let moved = false;

        if (choice?.delta?.content) { text += choice.delta.content; moved = true; }

        // OpenRouter normalises every provider's chain-of-thought onto
        // `delta.reasoning`. It counts as PROGRESS (a reasoning model can be
        // 100s into a turn before its first content delta — the idle deadline
        // would otherwise be counting that healthy work as silence) but never
        // as `text`: what the caller returns as the deliverable stays exactly
        // what the model put in `content`.
        if (typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning) {
          reasoning += choice.delta.reasoning;
          moved = true;
        }

        // Tool calls arrive in pieces keyed by `index`: id/type/name land once
        // (usually on the first fragment) and `arguments` is a JSON string
        // delivered a few characters at a time, to be concatenated in arrival
        // order. Reassembling them here is what lets a tool-using turn stream
        // and still hand the loop the exact message shape it echoes back.
        for (const f of choice?.delta?.tool_calls ?? []) {
          const i = f.index ?? 0;
          const call = frags.get(i) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (f.id) call.id = f.id;
          if (f.type) call.type = f.type;
          if (f.function?.name) call.function.name = f.function.name;
          if (f.function?.arguments) call.function.arguments += f.function.arguments;
          frags.set(i, call);
          moved = true;
        }

        if (moved) onText(renderTurn(text, frags, reasoning));
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.model) resolvedModel = chunk.model;
      }

      // The turn is fully assembled: emit it unthrottled, so its last and most
      // informative state (a tool call WITH its arguments) is what stands.
      onText(renderTurn(text, frags, reasoning), { final: true });

      const toolCalls = [...frags.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
      // Zero parsed tool calls + known native markup in the content = the model
      // tried to act and the harness did not understand it. Surface the dialect
      // on the result; only when something DID parse is silence correct.
      const unparsedToolCall = toolCalls.length ? null : unparsedToolDialect(text);

      // A stream that delivered nothing at all — no content, no tool call, no
      // finish reason — did not complete: the upstream opened it and dropped it.
      // Returning { text: '' } looked like a successful empty answer. Fail
      // instead, marked transient so the retry budget gets a real attempt. A
      // turn that is ONLY tool calls is legitimate.
      if (!text && !toolCalls.length && !reasoning && !finishReason) {
        throw Object.assign(
          new Error(`${provider} stream ended without any content or a finish reason (upstream cut the response)`),
          { transient: true }
        );
      }
      return {
        text, reasoning, usage, finishReason, resolvedModel,
        ...(unparsedToolCall ? { unparsedToolCall } : {}),
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        }
      };
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error(`${provider} returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
    const unparsedToolCall = choice.message.tool_calls?.length
      ? null : unparsedToolDialect(choice.message.content);
    return {
      text: choice.message.content ?? '',
      reasoning: typeof choice.message.reasoning === 'string' ? choice.message.reasoning : '',
      usage: data.usage ?? null,
      finishReason: choice.finish_reason ?? null,
      // See the streaming branch: the Auto Router answers as a different model
      // than the one requested, and that is the only place it says which.
      resolvedModel: data.model ?? null,
      ...(unparsedToolCall ? { unparsedToolCall } : {}),
      message: choice.message
    };
  };
}

// Marks the watch view as thinking rather than answering. Exported because the
// renderer needs to tell the two apart to style them differently, and because
// a test asserting "reasoning never leaks into the deliverable" needs the
// string it is looking for.
export const THINKING_MARKER = '⟢ thinking…\n\n';

// A watchable view of the turn in progress, for onText.
//
// The returned `text` stays pure — it is the model's actual content, and the
// agent loop reads it. But a tool-calling turn is often ALL structure and no
// prose: without rendering the calls there would be nothing to watch, which is
// the whole reason this path streams. So the call is surfaced as it assembles,
// arguments and all — you see the file being written as it is written.
//
// Reasoning is the same argument one step earlier. A thinking model produces
// nothing watchable for a minute or more before its first content delta, so the
// node read as hung and got cancelled by hand — twice in one evening, both
// times on healthy runs. It is shown ONLY while there is nothing better: the
// moment real content or a tool call exists, that replaces it, and the caller's
// final write is authoritative either way.
function renderTurn(text, frags, reasoning = '') {
  const calls = [...frags.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  if (!calls.length) return text || (reasoning ? THINKING_MARKER + reasoning : '');
  const rendered = calls.map(renderCall).join('\n\n');
  return text ? `${text}\n\n${rendered}` : rendered;
}

// `arguments` is a JSON string, so a file's content arrives with its newlines
// escaped — dumped raw it reads as one long \n-littered line. Once the call is
// complete the JSON parses, so the settled state (which is what the `final`
// emit shows) renders as real lines. Mid-assembly it can't parse yet; show it
// raw rather than nothing.
function renderCall(c) {
  const name = c.function.name || '…';
  const args = c.function.arguments;
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const body = Object.entries(parsed)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
      return `→ ${name}\n${body}`;
    }
  } catch { /* still assembling — not valid JSON yet */ }
  return `→ ${name}(${args})`;
}
