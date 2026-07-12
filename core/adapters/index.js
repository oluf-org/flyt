// Unified worker adapter. Every node calls a model through this one
// signature; providers are interchangeable implementations behind it.
// Adding OpenAI / local models later = add a file here + a config entry.
//
//   callModel({ provider, model, system, prompt, maxTokens, apiKey }) ->
//     { text, model, provider, usage, durationMs }
import { anthropicAdapter } from './anthropic.js';
import { openrouterAdapter } from './openrouter.js';
import { mockAdapter } from './mock.js';

const providers = {
  anthropic: anthropicAdapter,
  openrouter: openrouterAdapter,
  mock: mockAdapter
};

export function registerProvider(name, adapter) {
  providers[name] = adapter;
}

export async function callModel({ provider, model, system, prompt, maxTokens = 4096, apiKey }) {
  const adapter = providers[provider];
  if (!adapter) throw new Error(`Unknown provider "${provider}". Available: ${Object.keys(providers).join(', ')}`);
  const started = Date.now();
  const result = await adapter({ model, system, prompt, maxTokens, apiKey });
  return { ...result, provider, model, durationMs: Date.now() - started };
}
