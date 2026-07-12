// OpenRouter adapter. OpenAI-compatible chat completions API via fetch.
// The apiKey rides along on the worker object (injected by the main process
// from settings.json) — it is never read from the repo or the environment.
export async function openrouterAdapter({ model, system, prompt, maxTokens, apiKey }) {
  if (!apiKey) throw new Error('OpenRouter API key is not set. Add it in Settings, or switch the worker to the "mock" provider.');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/llm-flow/llm-flow',
      'X-Title': 'LLM Flow'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    text: message.content ?? '',
    usage: data.usage ?? null
  };
}
