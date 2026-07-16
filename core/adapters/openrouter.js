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

  // Stream only the single-shot shape: the agent loop needs the raw
  // tool_calls message back, which the non-streaming response provides.
  const stream = Boolean(onText) && !tools?.length;
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
    for await (const event of sseEvents(res.body)) {
      if (event === '[DONE]') break;
      let chunk;
      try { chunk = JSON.parse(event); } catch { continue; }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        onText(text);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    // A stream that delivered no content AND no finish reason did not complete:
    // the upstream opened it and dropped it. Returning { text: '' } here looked
    // like a successful empty answer — a live run spent 103s on one, wrote a
    // 0-byte artifact, marked the node done and fed emptiness downstream. Fail
    // instead, and mark it transient so the retry budget gets a real attempt.
    if (!text && !finishReason) {
      throw Object.assign(
        new Error('OpenRouter stream ended without any content or a finish reason (upstream cut the response)'),
        { transient: true }
      );
    }
    return { text, usage, finishReason, message: { role: 'assistant', content: text } };
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
