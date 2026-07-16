// OpenRouter adapter. OpenAI-compatible chat completions API via fetch.
// The apiKey rides along on the worker object (injected by the main process
// from settings.json) — it is never read from the repo or the environment.
//
// Two calling shapes:
//   { system, prompt }        — classic single-shot (unchanged behavior)
//   { messages, tools? }      — agent loop: full message array + optional
//                               OpenAI function-tool definitions. The raw
//                               assistant message comes back so the loop can
//                               echo tool_calls and read finish_reason.
import { apiError } from './http.js';

export async function openrouterAdapter({ model, system, prompt, messages, tools, maxTokens, apiKey, onText }) {
  if (!apiKey) throw new Error('OpenRouter API key is not set. Add it in Settings, or switch the worker to the "mock" provider.');

  // Tool-using turns stream too (V1 task 12). This used to refuse whenever
  // tools were present, because the agent loop needs the raw tool_calls message
  // back and only the non-streaming response hands one over. That was tolerable
  // while tool use was rare — until the work templates became agentTasks, which
  // put every coding node on this path and made the live panel go blank for
  // exactly the nodes doing the work: real-model runs looked idle again, which
  // is the complaint D10 exists to answer. The loop still gets its message; it
  // is now reassembled from the deltas (see below).
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
    // Ask for the trailing usage chunk. A streamed response carries no token
    // counts unless requested, and this adapter has always read one out of the
    // stream — so without this every streamed call reported null usage and the
    // retrospectives that account for tokens quietly recorded nothing. Now that
    // aiSteps AND agent tasks stream by default (V1 task 8), that was every
    // real-model call. (OpenAI-compatible; confirm against the live API.)
    body.stream_options = { include_usage: true };
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/llm-flow/llm-flow',
      'X-Title': 'LLM Flow'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw apiError('OpenRouter', res, await res.text());
  }

  if (stream) {
    let text = '';
    let usage = null;
    let finishReason = null;
    const frags = new Map(); // tool_call index -> the call being assembled

    for await (const event of sseEvents(res.body)) {
      if (event === '[DONE]') break;
      let chunk;
      try { chunk = JSON.parse(event); } catch { continue; }
      const choice = chunk.choices?.[0];
      let moved = false;

      if (choice?.delta?.content) { text += choice.delta.content; moved = true; }

      // Tool calls arrive in pieces keyed by `index`: id/type/name land once
      // (usually on the first fragment) and `arguments` is a JSON string
      // delivered a few characters at a time, to be concatenated in arrival
      // order. Reassembling them here is what lets a tool-using turn stream and
      // still hand the loop the exact message shape it echoes back.
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

      if (moved) onText(renderTurn(text, frags));
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    // The turn is fully assembled: emit it unthrottled, so its last and most
    // informative state (a tool call WITH its arguments) is what stands. Inside
    // an agent loop nothing else will write it — the next turn just replaces it.
    onText(renderTurn(text, frags), { final: true });

    const toolCalls = [...frags.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    // A stream that delivered nothing at all — no content, no tool call, no
    // finish reason — did not complete: the upstream opened it and dropped it.
    // Returning { text: '' } looked like a successful empty answer, and a live
    // run spent 103s on one, wrote a 0-byte artifact, marked the node done and
    // fed emptiness downstream. Fail instead, marked transient so the retry
    // budget gets a real attempt. A turn that is ONLY tool calls is legitimate.
    if (!text && !toolCalls.length && !finishReason) {
      throw Object.assign(
        new Error('OpenRouter stream ended without any content or a finish reason (upstream cut the response)'),
        { transient: true }
      );
    }
    return {
      text, usage, finishReason,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    };
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    text: choice.message.content ?? '',
    usage: data.usage ?? null,
    finishReason: choice.finish_reason ?? null,
    message: choice.message
  };
}

// A watchable view of the turn in progress, for onText.
//
// The returned `text` stays pure — it is the model's actual content, and the
// agent loop reads it. But a tool-calling turn is often ALL structure and no
// prose: without rendering the calls there would be nothing to watch, which is
// the whole reason this path streams. So the call is surfaced as it assembles,
// arguments and all — you see the file being written as it is written. The
// executor's write once the loop returns is what finally lands, exactly as with
// the text protocol's fenced block (see runAgent's multi-turn note).
function renderTurn(text, frags) {
  const calls = [...frags.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  if (!calls.length) return text;
  const rendered = calls.map(renderCall).join('\n\n');
  return text ? `${text}\n\n${rendered}` : rendered;
}

// `arguments` is a JSON string, so a file's content arrives with its newlines
// escaped — dumped raw it reads as one long \n-littered line, which is watchable
// only in the most literal sense. Once the call is complete the JSON parses, so
// the settled state (which is what the `final` emit shows) renders as real
// lines. Mid-assembly it can't parse yet; show it raw rather than nothing.
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
