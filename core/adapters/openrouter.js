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

export const openrouterAdapter = openaiCompatible({
  provider: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  headers: {
    'HTTP-Referer': 'https://github.com/olaaxe/flyt',
    'X-Title': APP_NAME
  },
  keyHelp: 'Add it in Settings, or switch the worker to the "mock" provider.'
});

// Which model ids this provider can serve (PROVIDERS-PLAN §2): OpenRouter ids
// are always namespaced ('openai/gpt-4o-mini'), so a bare id is never theirs.
openrouterAdapter.canServe = modelId => String(modelId).includes('/');

// Re-exported for the anthropic adapter and any legacy import sites; the
// parser itself lives with the shared machinery in http.js now.
export { sseEvents } from './http.js';
