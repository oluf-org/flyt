// OpenRouter adapter. OpenAI-compatible chat completions API via fetch.
// The apiKey rides along on the worker object (injected by the main process
// from settings.json) — it is never read from the repo or the environment.
//
// The whole implementation is the shared openaiCompatible factory in http.js;
// this file is only the endpoint, the identifying headers, and the
// missing-key help text. Behavior (streaming, tool-call reassembly, usage
// chunks, empty-stream guard) is pinned by tests/adapterHttp.test.js.
import { openaiCompatible } from './http.js';
import { APP_NAME } from '../brand.js';
import { applyOpenRouterRequest, openRouterReplay, replayOpenRouterMessage } from './transforms/openrouter.js';

export const openrouterAdapter = openaiCompatible({
  provider: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  headers: {
    'HTTP-Referer': 'https://github.com/olaaxe/flyt',
    'X-Title': APP_NAME
  },
  keyHelp: 'Add it in Settings, or switch the worker to the "mock" provider.',
  extractReplay: openRouterReplay,
  // The Auto Router (DESIGN-SPEC.md §8): `openrouter/auto` with a cost band, so a
  // task asks for a LEVEL and OpenRouter picks a capable model inside it. That
  // is the whole of what a per-model price table would have bought us, kept
  // current by someone who updates it daily.
  //
  // Sent only when a caller asked for routing, so every existing call — a
  // pinned model id, the agent loop, the retrospective turn — produces a byte
  // -identical request to the one it produced before this existed.
  extendBody(body, options) {
    const { routing } = options;
    body.messages = body.messages.map(message => {
      const { replay: _replay, handle: _handle, ...base } = message;
      return { ...base, ...replayOpenRouterMessage(message) };
    });
    applyOpenRouterRequest(body, options);
    if (!routing?.costTier) return;
    body.plugins = [...(body.plugins ?? []), {
      id: 'auto-router',
      cost_tier: routing.costTier,
      ...(routing.allowedModels?.length ? { allowed_models: routing.allowedModels } : {})
    }];
  }
});

// Which model ids this provider can serve (DESIGN-SPEC.md §6): OpenRouter ids
// are always namespaced ('openai/gpt-4o-mini'), so a bare id is never theirs.
openrouterAdapter.canServe = modelId => String(modelId).includes('/');

// Re-exported for the anthropic adapter and any legacy import sites; the
// parser itself lives with the shared machinery in http.js now.
export { sseEvents } from './http.js';
