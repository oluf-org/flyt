// OpenAI adapter. The same OpenAI-compatible chat-completions shape as
// OpenRouter, pointed at api.openai.com — the shared factory does the work.
// BYO-key contract: the caller's key wins; OPENAI_API_KEY is only a shell
// fallback (same pattern as the anthropic adapter).
import { openaiCompatible } from './http.js';

export const openaiAdapter = openaiCompatible({
  provider: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1/chat/completions',
  keyHelp: 'Add it in Settings → Providers, or set OPENAI_API_KEY.',
  envKey: 'OPENAI_API_KEY'
});

// PROVIDERS-PLAN §2: OpenAI serves gpt-* chat models and the o-series
// reasoners (o1/o3/o4/…). Everything else belongs to someone else.
openaiAdapter.canServe = modelId => /^(gpt-|o\d)/.test(String(modelId));
