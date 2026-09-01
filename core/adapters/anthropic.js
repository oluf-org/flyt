// Anthropic adapter. Uses the raw Messages API via fetch — no SDK needed.
//
// The key follows the BYO-key contract (D18): whatever the caller passes wins,
// because that is the key the user saved in the app and callModel has always
// forwarded it. Reading only process.env — as this did — meant a key entered in
// the app was silently dropped and every Anthropic run failed as unconfigured.
// ANTHROPIC_API_KEY remains a fallback for running from a shell.
import { sseEvents, apiError, abortError } from './http.js';
import { anthropicMessages, anthropicTools, normalizeAnthropicContent } from './transforms/anthropic.js';

export async function anthropicAdapter({ model, system, prompt, messages, tools, maxTokens, apiKey, onText, signal, reasoning, toolChoice, onTransport }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key is not set. Add it in Settings, or set ANTHROPIC_API_KEY.');

  const stream = Boolean(onText);
  const systemText = [system, ...(messages ?? []).filter(message => message.role === 'system').map(message => message.content)]
    .filter(Boolean).join('\n\n');
  const body = {
    model,
    max_tokens: maxTokens,
    ...(systemText ? { system: systemText } : {}),
    messages: Array.isArray(messages) && messages.length
      ? anthropicMessages(messages, prompt)
      : [{ role: 'user', content: prompt }],
    ...(tools?.length ? { tools: anthropicTools(tools) } : {}),
    ...(toolChoice ? { tool_choice: anthropicToolChoice(toolChoice) } : {}),
    ...(reasoning?.effort && reasoning.effort !== 'none' ? { thinking: { type: 'enabled', budget_tokens: reasoningBudget(reasoning.effort, maxTokens) } } : {}),
    ...(stream ? { stream: true } : {}),
  };
  onTransport?.({ phase: 'dispatch', at: new Date().toISOString() });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    // RUN-CONTROL: optional cooperative cancellation (stop()).
    ...(signal ? { signal } : {})
  });
  onTransport?.({ phase: 'headers', at: new Date().toISOString(), status: res.status });

  if (!res.ok) {
    throw apiError('Anthropic', res, await res.text());
  }

  if (stream) {
    let text = '';
    let reasoningText = '';
    let usage = null;
    let finishReason = null;
    const blocks = new Map();
    for await (const event of sseEvents(res.body)) {
      if (signal?.aborted) throw abortError(); // RUN-CONTROL stop mid-stream
      let msg;
      try { msg = JSON.parse(event); } catch { continue; }
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
        text += msg.delta.text;
        onText(text, { telemetry: { contentChars: text.length, reasoningChars: reasoningText.length } });
      }
      if (msg.type === 'content_block_start') blocks.set(msg.index ?? 0, structuredClone(msg.content_block ?? {}));
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'thinking_delta') {
        reasoningText += msg.delta.thinking ?? '';
        const block = blocks.get(msg.index ?? 0) ?? { type: 'thinking', thinking: '' };
        block.thinking = String(block.thinking ?? '') + String(msg.delta.thinking ?? '');
        blocks.set(msg.index ?? 0, block);
        onText(text || `⟢ thinking…\n\n${reasoningText}`, { telemetry: { contentChars: text.length, reasoningChars: reasoningText.length } });
      }
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'signature_delta') {
        const block = blocks.get(msg.index ?? 0) ?? { type: 'thinking', thinking: reasoningText };
        block.signature = String(block.signature ?? '') + String(msg.delta.signature ?? '');
        blocks.set(msg.index ?? 0, block);
      }
      if (msg.type === 'content_block_delta' && msg.delta?.type === 'input_json_delta') {
        const block = blocks.get(msg.index ?? 0) ?? { type: 'tool_use', id: '', name: '', input_json: '' };
        block.input_json = String(block.input_json ?? '') + String(msg.delta.partial_json ?? '');
        blocks.set(msg.index ?? 0, block);
      }
      if (msg.type === 'message_start' && msg.message?.usage) usage = msg.message.usage;
      if (msg.type === 'message_delta') {
        if (msg.usage) usage = { ...usage, ...msg.usage };
        if (msg.delta?.stop_reason) finishReason = msg.delta.stop_reason === 'tool_use' ? 'tool_calls' : msg.delta.stop_reason;
      }
      if (msg.type === 'error') throw new Error(`Anthropic API stream error: ${JSON.stringify(msg.error).slice(0, 500)}`);
    }
    onText(text, { final: true }); // the consumer must not throttle the last state away
    const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => {
      if (block.type === 'tool_use' && block.input_json !== undefined) {
        try { return { ...block, input: JSON.parse(block.input_json || '{}') }; }
        catch { return { ...block, input: { _unparsed: block.input_json } }; }
      }
      return block;
    });
    const normalized = normalizeAnthropicContent(content);
    return {
      text, reasoning: reasoningText, usage, finishReason,
      ...(normalized.replay ? { replay: normalized.replay } : {}),
      message: { role: 'assistant', content: text || null, ...(normalized.toolCalls.length ? { tool_calls: normalized.toolCalls } : {}) },
    };
  }

  const data = await res.json();
  const normalized = normalizeAnthropicContent(data.content);
  return {
    text: normalized.text,
    reasoning: normalized.reasoning,
    usage: data.usage ?? null,
    finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason,
    ...(normalized.replay ? { replay: normalized.replay } : {}),
    message: { role: 'assistant', content: normalized.text || null, ...(normalized.toolCalls.length ? { tool_calls: normalized.toolCalls } : {}) },
  };
}

const reasoningBudget = (effort, maxTokens) => {
  const ratio = { low: .2, medium: .4, high: .6, xhigh: .75, max: .85 }[effort] ?? .4;
  return Math.max(1_024, Math.min(Math.floor(maxTokens * ratio), Math.max(1_024, maxTokens - 1_024)));
};

const anthropicToolChoice = choice => {
  if (choice === 'required') return { type: 'any' };
  const name = choice?.function?.name ?? choice?.name;
  return name ? { type: 'tool', name } : choice;
};

// DESIGN-SPEC.md §6: Anthropic serves claude-* ids only.
anthropicAdapter.canServe = modelId => String(modelId).startsWith('claude-');
