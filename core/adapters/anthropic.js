// Anthropic adapter. Uses the raw Messages API via fetch — no SDK needed.
// Requires ANTHROPIC_API_KEY in the environment.
import { sseEvents } from './openrouter.js';

export async function anthropicAdapter({ model, system, prompt, maxTokens, onText }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Set it or switch config.json to the "mock" provider.');

  const stream = Boolean(onText);
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
      messages: [{ role: 'user', content: prompt }],
      ...(stream ? { stream: true } : {})
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  if (stream) {
    let text = '';
    let usage = null;
    for await (const event of sseEvents(res.body)) {
      let msg;
      try { msg = JSON.parse(event); } catch { continue; }
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
        text += msg.delta.text;
        onText(text);
      }
      if (msg.type === 'message_start' && msg.message?.usage) usage = msg.message.usage;
      if (msg.type === 'message_delta' && msg.usage) usage = { ...usage, ...msg.usage };
      if (msg.type === 'error') throw new Error(`Anthropic API stream error: ${JSON.stringify(msg.error).slice(0, 500)}`);
    }
    return { text, usage };
  }

  const data = await res.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: data.usage ?? null
  };
}
