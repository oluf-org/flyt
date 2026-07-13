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
export async function openrouterAdapter({ model, system, prompt, messages, tools, maxTokens, apiKey }) {
  if (!apiKey) throw new Error('OpenRouter API key is not set. Add it in Settings, or switch the worker to the "mock" provider.');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages ?? [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ]
  };
  if (tools?.length) body.tools = tools;

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
    const errBody = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${errBody.slice(0, 500)}`);
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
