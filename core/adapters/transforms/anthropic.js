/** Anthropic Messages request/response transforms. */

export function anthropicMessages(messages, fallbackPrompt = '') {
  const source = Array.isArray(messages) && messages.length
    ? messages.filter(message => message.role !== 'system')
    : [{ role: 'user', content: fallbackPrompt }];
  return source.map(message => {
    if (message.role === 'tool') return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? message.toolCallId ?? '', content: String(message.content ?? '') }],
    };
    const replay = message.replay?.provider === 'anthropic' ? message.replay.items : [];
    const content = [
      ...replay,
      ...(message.tool_calls ?? message.toolCalls ?? []).map(call => ({
        type: 'tool_use', id: call.id, name: call.function?.name ?? call.name,
        input: parseObject(call.function?.arguments ?? call.args),
      })),
      ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
    ];
    return { role: message.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : [{ type: 'text', text: '' }] };
  });
}

export function anthropicTools(tools = []) {
  return tools.map(tool => ({
    name: tool.function?.name ?? tool.name,
    description: tool.function?.description ?? tool.description ?? '',
    input_schema: tool.function?.parameters ?? tool.parameters ?? { type: 'object' },
  }));
}

export function normalizeAnthropicContent(content = []) {
  const toolCalls = [];
  const replay = [];
  let text = '';
  let reasoning = '';
  for (const block of content) {
    if (block?.type === 'text') text += block.text ?? '';
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      reasoning += block.thinking ?? '';
      replay.push(block);
    }
    if (block?.type === 'tool_use') toolCalls.push({
      id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    });
  }
  return {
    text, reasoning, toolCalls,
    replay: replay.length ? { provider: 'anthropic', items: replay, required: true, protection: 'signed' } : null,
  };
}

const parseObject = raw => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try { const value = JSON.parse(String(raw ?? '{}')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
};
