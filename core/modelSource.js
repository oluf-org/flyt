// Multi-provider settings model + model-source resolution (PROVIDERS-PLAN
// §1–§2). Pure functions, no Electron imports — the main process wires them to
// settings.json and the adapter registry, and the unit tests exercise them
// directly.
//
// settings.json shape (userData, never the repo):
//   providers:       { anthropic: { apiKey }, openai: { apiKey },
//                      kimi: { apiKey, keyKind }, openrouter: { apiKey } }
//   providerPriority: ['anthropic', 'openai', 'kimi', 'openrouter', 'mock']
//   activeModels:    [{ id, source: 'auto' | providerId, enabled: bool }]
//   workers:         { executor: { provider, model } }   (unchanged)

// Subscription providers (SUBSCRIPTION-AUTH-GUIDE): connected not by a saved
// key but by the vendor CLI's own sign-in (Claude Code / Codex CLI), gated
// behind an explicit opt-in in Settings. They sit right after their API-key
// sibling in the default priority: a saved key wins, the subscription is the
// fallback — reorderable like any provider.
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];
export const PROVIDER_IDS = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter', 'mock'];
export const KEYED_PROVIDERS = PROVIDER_IDS.filter(p => p !== 'mock' && !SUBSCRIPTION_PROVIDERS.includes(p));
export const DEFAULT_PRIORITY = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter', 'mock'];

// Curated per-provider model lists (PROVIDERS-PLAN §4): anthropic/openai/kimi
// model endpoints are inconsistent, so a short static list + the free-text
// field covers it. OpenRouter keeps its live catalog fetch. `keyKind` on a
// Kimi entry marks which endpoint the id is valid on.
export const CURATED_MODELS = {
  anthropic: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supportsTools: true },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', supportsTools: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsTools: true }
  ],
  openai: [
    { id: 'gpt-5.2', name: 'GPT-5.2', supportsTools: true },
    { id: 'gpt-5', name: 'GPT-5', supportsTools: true },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', supportsTools: true },
    { id: 'o4', name: 'o4 (reasoning)', supportsTools: true }
  ],
  kimi: [
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsTools: true, keyKind: 'platform' },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsTools: true, keyKind: 'platform' },
    { id: 'kimi-for-coding', name: 'Kimi for Coding (Kimi Code subscription)', supportsTools: true, keyKind: 'code' }
  ],
  // The subscription runtimes serve the same frontier ids as their API
  // siblings (the priority walk decides who takes a call), plus the
  // codex-tuned models only the Codex CLI reaches.
  'claude-code': [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (subscription)', supportsTools: true },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (subscription)', supportsTools: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (subscription)', supportsTools: true }
  ],
  codex: [
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (subscription)', supportsTools: true },
    { id: 'gpt-5.2', name: 'GPT-5.2 (subscription)', supportsTools: true },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex mini (subscription)', supportsTools: true }
  ]
};

// One cheap model per provider for the Settings "Test" button: proves the key
// works in Settings rather than three nodes into a run (PROVIDERS-PLAN §4).
export const TEST_MODELS = {
  anthropic: 'claude-haiku-4-5',
  'claude-code': 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  codex: 'gpt-5.1-codex-mini',
  kimiPlatform: 'kimi-k2.6',
  kimiCode: 'kimi-for-coding',
  openrouter: 'openai/gpt-4o-mini'
};

// Load-time normalization + migration. The legacy single `openrouterApiKey`
// field moves into providers.openrouter.apiKey once and is deleted
// (PROVIDERS-PLAN §1). Missing collections get their defaults; unknown entries
// are dropped rather than carried.
export function migrateSettings(raw) {
  const s = { ...(raw ?? {}) };
  s.providers = { ...(s.providers ?? {}) };
  for (const p of Object.keys(s.providers)) {
    if (!KEYED_PROVIDERS.includes(p)) delete s.providers[p];
  }
  if (typeof s.openrouterApiKey === 'string' && s.openrouterApiKey.trim()) {
    // The providers map is canonical: the legacy value only fills a gap.
    if (!s.providers.openrouter?.apiKey) {
      s.providers.openrouter = { ...(s.providers.openrouter ?? {}), apiKey: s.openrouterApiKey.trim() };
    }
  }
  delete s.openrouterApiKey;

  // Priority: known ids only, every provider present exactly once.
  const seen = Array.isArray(s.providerPriority) ? s.providerPriority.filter(p => PROVIDER_IDS.includes(p)) : [];
  s.providerPriority = [...new Set([...seen, ...DEFAULT_PRIORITY])];

  s.activeModels = (Array.isArray(s.activeModels) ? s.activeModels : [])
    .filter(m => m && typeof m.id === 'string' && m.id.trim())
    .map(m => ({
      id: m.id.trim(),
      source: PROVIDER_IDS.includes(m.source) ? m.source : 'auto',
      enabled: m.enabled !== false
    }));

  if (s.providers.kimi && s.providers.kimi.keyKind !== 'code') {
    s.providers.kimi = { ...s.providers.kimi, keyKind: 'platform' };
  }

  // Subscription providers: { enabled, home?, cliPath? } per provider. enabled
  // is the explicit opt-in gate (the Claude card carries a usage warning);
  // home/cliPath are the optional account-selection and binary overrides.
  const subs = {};
  for (const p of SUBSCRIPTION_PROVIDERS) {
    const raw = s.subscriptions?.[p];
    if (!raw || typeof raw !== 'object') continue;
    const entry = { enabled: raw.enabled === true };
    if (typeof raw.home === 'string' && raw.home.trim()) entry.home = raw.home.trim();
    if (typeof raw.cliPath === 'string' && raw.cliPath.trim()) entry.cliPath = raw.cliPath.trim();
    subs[p] = entry;
  }
  s.subscriptions = subs;
  return s;
}

// The resolution rule (PROVIDERS-PLAN §2), as a closure over the live
// settings. A pinned source with a key wins; otherwise walk the priority list,
// skipping providers with no key and providers that can't serve the id, and
// take the first hit. No match fails fast with a settings-pointing error, in
// the same style as the adapters' missing-key errors.
export function createResolver({ hasKey, canServe, priority }) {
  return function resolveModelSource(modelId, pinned = null) {
    if (pinned && pinned !== 'auto') {
      if (hasKey(pinned)) return { provider: pinned, model: modelId };
      throw new Error(
        `Model "${modelId}" is pinned to ${pinned}, but that provider has no API key or sign-in. ` +
        `Add one in Settings → Providers, or switch the model's source to Auto.`
      );
    }
    const order = (typeof priority === 'function' ? priority() : priority) ?? DEFAULT_PRIORITY;
    for (const p of order) {
      if (!hasKey(p)) continue;
      if (!canServe(p, modelId)) continue;
      return { provider: p, model: modelId };
    }
    throw new Error(
      `No connected provider can serve "${modelId}". ` +
      `Add a key in Settings → Providers, or pick a model your connected providers can serve.`
    );
  };
}

// Call-time target for one worker object, used by the flow runner and the
// executor wherever they previously read config.providerKeys[worker.provider].
// A worker whose provider is 'auto' (picked from the active-models list) is
// resolved through the main process's resolver — priority walk, pin override,
// key + keyKind stamping. Anything else keeps the legacy lookup.
export function resolveCallTarget(worker, config) {
  if (worker?.provider === 'auto' && typeof config?.resolveModelSource === 'function') {
    return config.resolveModelSource(worker.model);
  }
  return {
    provider: worker.provider,
    model: worker.model,
    apiKey: config?.providerKeys?.[worker.provider] ?? null,
    ...(worker.keyKind ? { keyKind: worker.keyKind } : {})
  };
}
