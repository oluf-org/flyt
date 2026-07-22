// Anthropic adapter. Uses the raw Messages API via fetch — no SDK needed.
//
// The key follows the BYO-key contract (D18): whatever the caller passes wins,
// because that is the key the user saved in the app and callModel has always
// forwarded it. Reading only process.env — as this did — meant a key entered in
// the app was silently dropped and every Anthropic run failed as unconfigured.
// ANTHROPIC_API_KEY remains a fallback for running from a shell.
import { sseEvents, apiError, abortError } from './http.js';

export async function anthropicAdapter({ model, system, prompt, maxTokens, apiKey, onText, signal }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key is not set. Add it in Settings, or set ANTHROPIC_API_KEY.');

  const stream = Boolean(onText);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      ...(stream ? { stream: true } : {})
    }),
    // RUN-CONTROL: optional cooperative cancellation (stop()).
    ...(signal ? { signal } : {})
  });

  if (!res.ok) {
    throw apiError('Anthropic', res, await res.text());
  }

  if (stream) {
    let text = '';
    let usage = null;
    for await (const event of sseEvents(res.body)) {
      if (signal?.aborted) throw abortError(); // RUN-CONTROL stop mid-stream
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
    onText(text, { final: true }); // the consumer must not throttle the last state away
    return { text, usage };
  }

  const data = await res.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: data.usage ?? null
  };
}

// PROVIDERS-PLAN §2: Anthropic serves claude-* ids only.
anthropicAdapter.canServe = modelId => String(modelId).startsWith('claude-');
