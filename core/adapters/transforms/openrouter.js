/** OpenRouter compatibility transforms, kept separate from first-party OpenAI. */
import { applyOpenAIRequest } from './openai.js';

export function applyOpenRouterRequest(body, options = {}) {
  applyOpenAIRequest(body, options);
  if (options.requireParameters) body.provider = { ...body.provider, require_parameters: true };
  if (options.reasoning?.effort) body.reasoning = { effort: options.reasoning.effort };
  return body;
}

export function openRouterReplay(message) {
  const items = message?.reasoning_details ?? [];
  if (!Array.isArray(items) || !items.length) return null;
  return { provider: 'openrouter', items, required: true, protection: 'provider-dependent' };
}

export function replayOpenRouterMessage(message) {
  if (message?.replay?.provider !== 'openrouter' || !message.replay.items?.length) return {};
  return { reasoning_details: message.replay.items };
}
