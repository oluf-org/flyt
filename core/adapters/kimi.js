// Kimi adapter. One provider, two key kinds (DESIGN-SPEC.md §6):
//
//   platform — pay-as-you-go key from platform.moonshot.ai. Standard
//              OpenAI-compatible endpoint, models like kimi-k2.7-code.
//   code     — subscription key (sk-kimi-*) issued by a Kimi membership's
//              "Kimi Code" benefit. ONLY accepted at api.kimi.com/coding, and
//              that endpoint authorizes only requests carrying a recognized
//              coding-agent User-Agent — without one it answers 403. Model id
//              kimi-for-coding is valid here (and only here).
//
// Both kinds speak the same OpenAI-compatible chat-completions protocol, so
// the shared factory handles both; only the base URL and headers differ. The
// kind arrives on the call as `keyKind`, stamped by the main process from
// settings.providers.kimi.keyKind (default 'platform').
import { openaiCompatible } from './http.js';
import { applyKimiRequest, kimiReplay } from './transforms/kimi.js';

const platform = openaiCompatible({
  provider: 'Kimi',
  baseUrl: 'https://api.moonshot.ai/v1/chat/completions',
  keyHelp: 'Add it in Settings → Providers (platform key from platform.moonshot.ai).',
  extendBody: applyKimiRequest,
  extractReplay: kimiReplay,
});

const code = openaiCompatible({
  provider: 'Kimi',
  baseUrl: 'https://api.kimi.com/coding/v1/chat/completions',
  headers: { 'User-Agent': 'claude-code/0.1.0' }, // required by the Kimi Code endpoint
  keyHelp: 'Add it in Settings → Providers (Kimi Code key from your Kimi membership).',
  extendBody: applyKimiRequest,
  extractReplay: kimiReplay,
});

export async function kimiAdapter(args) {
  return (args.keyKind === 'code' ? code : platform)(args);
}

// DESIGN-SPEC.md §6: Kimi serves kimi-* (and moonshot-* legacy ids).
kimiAdapter.canServe = modelId => /^(kimi-|moonshot-)/.test(String(modelId));
