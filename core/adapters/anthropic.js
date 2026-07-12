// Anthropic adapter. Uses the raw Messages API via fetch — no SDK needed.
// Requires ANTHROPIC_API_KEY in the environment.
export async function anthropicAdapter({ model, system, prompt, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Set it or switch config.json to the "mock" provider.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: data.usage ?? null
  };
}
