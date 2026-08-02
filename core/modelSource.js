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
//
// Since SETTINGS-MODELS-PLAN §2 (P1) the lists are DERIVED from the bundled
// model catalog (core/modelCatalog.js) — a model is a record there, and this
// export keeps the long-standing { id, name, supportsTools, keyKind? } shape
// so models:list and every existing caller keep working unchanged. The
// subscription runtimes serve the same frontier ids as their API siblings
// (the priority walk decides who takes a call), plus the codex-tuned models
// only the Codex CLI reaches.
import { modelsForProvider } from './modelCatalog.js';

export const CURATED_MODELS = {
  anthropic: modelsForProvider('anthropic'),
  openai: modelsForProvider('openai'),
  kimi: modelsForProvider('kimi'),
  'claude-code': modelsForProvider('claude-code', { subscriptionSuffix: true }),
  codex: modelsForProvider('codex', { subscriptionSuffix: true })
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

  // User state over the model catalog (SETTINGS-MODELS-PLAN §3). All of it is
  // defaulted and none of it is required; unknown shapes are dropped.
  // favouriteModels: ordered shortlist, deduped. seenModels: id → first time
  // this install saw it (the NEW-badge ledger). acknowledgedModels: the ids
  // the user has explicitly cleared via settings:markSeen — kept separate from
  // seenModels so a badge can outlive one settings read and expire on its own
  // 21-day clock (see stampSeenModels/computeNewModelIds below).
  s.favouriteModels = [...new Set((Array.isArray(s.favouriteModels) ? s.favouriteModels : [])
    .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const seenModels = {};
  if (s.seenModels && typeof s.seenModels === 'object') {
    for (const [id, ts] of Object.entries(s.seenModels)) {
      if (id.trim() && typeof ts === 'string' && ts.trim()) seenModels[id] = ts;
    }
  }
  s.seenModels = seenModels;
  s.acknowledgedModels = [...new Set((Array.isArray(s.acknowledgedModels) ? s.acknowledgedModels : [])
    .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  s.modelGrouping = ['provider', 'tier', 'cost'].includes(s.modelGrouping) ? s.modelGrouping : 'provider';
  s.showAllModels = s.showAllModels === true;

  // The mock provider's settings (G8). `enabled` gates mock out of every
  // picker; the rest is authoring state consumed by core/adapters/mock.js via
  // runtimeConfig.mock (P4 wires the adapter; the state lands here first).
  const rawMock = (s.mock && typeof s.mock === 'object') ? s.mock : {};
  const perRole = {};
  if (rawMock.perRole && typeof rawMock.perRole === 'object') {
    for (const [role, text] of Object.entries(rawMock.perRole)) {
      if (typeof role === 'string' && role.trim() && typeof text === 'string') perRole[role] = text;
    }
  }
  s.mock = {
    enabled: rawMock.enabled === true,
    mode: ['roles', 'custom', 'echo', 'error'].includes(rawMock.mode) ? rawMock.mode : 'roles',
    customResponse: typeof rawMock.customResponse === 'string' ? rawMock.customResponse : '',
    perRole,
    latencyMs: Number.isFinite(rawMock.latencyMs) && rawMock.latencyMs >= 0 ? Math.min(rawMock.latencyMs, 60_000) : 700,
    streaming: rawMock.streaming !== false,
    failureRate: Number.isFinite(rawMock.failureRate) ? Math.min(Math.max(rawMock.failureRate, 0), 1) : 0
  };
  return s;
}

// --- NEW-model badges (SETTINGS-MODELS-PLAN §3, G4) ---------------------------
//
// Computed in the main process, never the renderer. seenModels is the ledger
// (id → first-seen ISO timestamp); acknowledgedModels is what the user has
// cleared by expanding the containing group (settings:markSeen). A badge shows
// while an id is fresh (< 21 days) and unacknowledged; the first run ever
// stamps AND acknowledges everything, because a fresh install where all 40
// models glow NEW is noise, not information.
export const NEW_MODEL_WINDOW_DAYS = 21;
const DAY_MS = 86_400_000;

// Stamp newly discovered catalog ids into seenModels. First run ever
// (seenModels empty): stamp and acknowledge everything. Returns the updated
// maps and whether anything changed (so the caller persists only on change).
export function stampSeenModels(catalogIds, seenModels, acknowledgedModels = [], now = new Date()) {
  const seen = { ...(seenModels ?? {}) };
  const ack = [...new Set(acknowledgedModels ?? [])];
  const firstRun = Object.keys(seen).length === 0;
  const iso = now.toISOString();
  let changed = false;
  for (const id of catalogIds) {
    if (!(id in seen)) { seen[id] = iso; changed = true; }
    if (firstRun && !ack.includes(id)) { ack.push(id); changed = true; }
  }
  return { seenModels: seen, acknowledgedModels: ack, firstRun, changed };
}

// The badge list, derived: stamped within the window and not acknowledged.
// Pure — the renderer's `newModelIds` is this function's output.
export function computeNewModelIds(catalogIds, seenModels, acknowledgedModels = [], now = new Date()) {
  const seen = seenModels ?? {};
  const ack = new Set(acknowledgedModels ?? []);
  const nowMs = now.getTime();
  return catalogIds.filter(id => {
    if (ack.has(id) || !(id in seen)) return false;
    const stampMs = Date.parse(seen[id]);
    return Number.isFinite(stampMs) && (nowMs - stampMs) < NEW_MODEL_WINDOW_DAYS * DAY_MS;
  });
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
  const withMock = t =>
    t.provider === 'mock' && config?.mock ? { ...t, mock: config.mock } : t;
  if (worker?.provider === 'auto' && typeof config?.resolveModelSource === 'function') {
    return withMock(config.resolveModelSource(worker.model));
  }
  return withMock({
    provider: worker.provider,
    model: worker.model,
    apiKey: config?.providerKeys?.[worker.provider] ?? null,
    ...(worker.keyKind ? { keyKind: worker.keyKind } : {})
  });
}
