// Anthropic adapter. Uses the raw Messages API via fetch — no SDK needed.
//
// The key follows the BYO-key contract (D18): whatever the caller passes wins,
// because that is the key the user saved in the app and callModel has always
// forwarded it. Reading only process.env — as this did — meant a key entered in
// the app was silently dropped and every Anthropic run failed as unconfigured.
// ANTHROPIC_API_KEY remains a fallback for running from a shell.
import { sseEvents, apiError, abortError } from './http.js';

// captureWire (optional, PIVOT-PLAN §4.3): return the literal request and
// response for the call ledger. Redaction and size bounds are the ledger's job,
// not the adapter's — one place decides what reaches disk.
export async function anthropicAdapter({ model, system, prompt, maxTokens, apiKey, onText, signal, captureWire = false }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key is not set. Add it in Settings, or set ANTHROPIC_API_KEY.');

  const stream = Boolean(onText);
  const url = 'https://api.anthropic.com/v1/messages';
  const reqHeaders = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  };
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    ...(stream ? { stream: true } : {})
  };
  const wireRequest = captureWire ? { url, method: 'POST', headers: reqHeaders, body } : null;

  const res = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(body),
    // RUN-CONTROL: optional cooperative cancellation (stop()).
    ...(signal ? { signal } : {})
  });

  if (!res.ok) {
    const bodyText = await res.text();
    const err = apiError('Anthropic', res, bodyText);
    if (captureWire) {
      let parsed; try { parsed = JSON.parse(bodyText); } catch { parsed = String(bodyText).slice(0, 20000); }
      err.wire = { request: wireRequest, response: { status: res.status, body: parsed } };
    }
    throw err;
  }

  if (stream) {
    let text = '';
    let usage = null;
    let stopReason = null;
    for await (const event of sseEvents(res.body)) {
      if (signal?.aborted) throw abortError(); // RUN-CONTROL stop mid-stream
      let msg;
      try { msg = JSON.parse(event); } catch { continue; }
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
        text += msg.delta.text;
        onText(text);
      }
      if (msg.type === 'message_start' && msg.message?.usage) usage = msg.message.usage;
      if (msg.type === 'message_delta') {
        if (msg.usage) usage = { ...usage, ...msg.usage };
        if (msg.delta?.stop_reason) stopReason = msg.delta.stop_reason;
      }
      if (msg.type === 'error') {
        const err = new Error(`Anthropic API stream error: ${JSON.stringify(msg.error).slice(0, 500)}`);
        if (captureWire) err.wire = { request: wireRequest, response: { kind: 'stream-error', error: msg.error } };
        throw err;
      }
    }
    onText(text, { final: true }); // the consumer must not throttle the last state away
    return {
      text, usage, finishReason: stopReason,
      ...(captureWire
        ? { wire: { request: wireRequest, response: { kind: 'assembled-stream', status: res.status, text, usage, stop_reason: stopReason } } }
        : {})
    };
  }

  const data = await res.json();
  return {
    text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: data.usage ?? null,
    finishReason: data.stop_reason ?? null,
    ...(captureWire ? { wire: { request: wireRequest, response: { kind: 'body', status: res.status, body: data } } } : {})
  };
}

// PROVIDERS-PLAN §2: Anthropic serves claude-* ids only.
anthropicAdapter.canServe = modelId => String(modelId).startsWith('claude-');
