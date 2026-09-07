/** OpenAI Chat Completions request/response transforms. */

export function applyOpenAIRequest(body, { responseFormat, reasoning, toolChoice } = {}) {
  if (responseFormat?.type === 'json_object') body.response_format = { type: 'json_object' };
  if (responseFormat?.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: responseFormat.name,
        ...(responseFormat.description ? { description: responseFormat.description } : {}),
        schema: responseFormat.schema,
        strict: responseFormat.strict !== false,
      },
    };
  }
  if (toolChoice) body.tool_choice = toolChoice;
  if (reasoning?.effort) body.reasoning_effort = reasoning.effort;
  return body;
}

export function openAIReplay(message) {
  const items = message?.reasoning_details ?? message?.reasoning_items ?? [];
  if (!Array.isArray(items) || !items.length) return null;
  return { provider: 'openai', items, required: true, protection: 'encrypted' };
}

export function replayOpenAIMessage(message) {
  if (message?.replay?.provider !== 'openai' || !message.replay.items?.length) return {};
  return { reasoning_details: message.replay.items };
}
