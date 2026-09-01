/** Kimi OpenAI-compatible fields, isolated because endpoint support differs. */
export function applyKimiRequest(body, { responseFormat, toolChoice } = {}) {
  if (responseFormat?.schema) body.response_format = {
    type: 'json_schema',
    json_schema: { name: responseFormat.name, schema: responseFormat.schema, strict: responseFormat.strict !== false },
  };
  if (toolChoice) body.tool_choice = toolChoice;
  return body;
}

export function kimiReplay(message) {
  const items = message?.reasoning_details ?? [];
  return Array.isArray(items) && items.length
    ? { provider: 'kimi', items, required: true, protection: 'provider-dependent' }
    : null;
}
