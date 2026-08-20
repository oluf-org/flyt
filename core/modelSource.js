// Multi-provider settings model + model-source resolution (DESIGN-SPEC.md §6
// §1–§2). Pure functions, no Electron imports — the main process wires them to
// settings.json and the adapter registry, and the unit tests exercise them
// directly.
//
// settings.json shape (userData, never the repo):
//   providers:       { anthropic: { apiKey }, openai: { apiKey },
//                      kimi: { apiKey, keyKind }, openrouter: { apiKey } }
//   providerPriority: ['anthropic', 'openai', 'kimi', 'openrouter', 'mock']
//   activeModels:    [{ id, source: 'auto' | providerId, enabled: bool, pinned: bool }]
//   workers:         { executor: { provider, model } }   (unchanged)

// Subscription providers (DESIGN-SPEC.md §6): connected not by a saved
// key but by the vendor CLI's own sign-in (Claude Code / Codex CLI), gated
// behind an explicit opt-in in Settings. They sit right after their API-key
// sibling in the default priority: a saved key wins, the subscription is the
// fallback — reorderable like any provider.
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];
export const PROVIDER_IDS = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter', 'mock'];
export const KEYED_PROVIDERS = PROVIDER_IDS.filter(p => p !== 'mock' && !SUBSCRIPTION_PROVIDERS.includes(p));
// OpenRouter is first because the app's value-first defaults live there: it is
// the only connected source that can serve the free and low-cost shortlist.
// Users can still reorder this in Settings, and an existing saved order wins.
export const DEFAULT_PRIORITY = ['openrouter', 'anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'mock'];

// The compact pickers should be useful before somebody curates a personal
// list. Keep the value-first OpenRouter roster visible by default: free models
// first, then inexpensive workhorses and stronger escalation choices.
export const DEFAULT_PINNED_MODELS = [
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', source: 'openrouter', enabled: true, pinned: true },
  { id: 'z-ai/glm-5.2:free', source: 'openrouter', enabled: true, pinned: true },
  { id: '~deepseek/deepseek-v4-flash-latest', source: 'openrouter', enabled: true, pinned: true },
  { id: 'deepseek/deepseek-v4-pro-0813', source: 'openrouter', enabled: true, pinned: true },
  { id: 'z-ai/glm-5.3', source: 'openrouter', enabled: true, pinned: true },
  { id: 'x-ai/grok-4.6', source: 'openrouter', enabled: true, pinned: true },
  { id: 'moonshotai/kimi-k3', source: 'openrouter', enabled: true, pinned: true }
];

// Curated per-provider model lists (DESIGN-SPEC.md §6): anthropic/openai/kimi
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
// works in Settings rather than three nodes into a run (DESIGN-SPEC.md §6).
export const TEST_MODELS = {
  anthropic: 'claude-haiku-4-5',
  'claude-code': 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  codex: 'gpt-5.1-codex-mini',
  kimiPlatform: 'kimi-k2.6',
  kimiCode: 'kimi-for-coding',
  openrouter: '~deepseek/deepseek-v4-flash-latest'
};

// Load-time normalization + migration. The legacy single `openrouterApiKey`
// field moves into providers.openrouter.apiKey once and is deleted
// (DESIGN-SPEC.md §6). Missing collections get their defaults; unknown entries
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

  // Missing means a fresh profile and gets the small, opinionated default.
  // An explicit [] remains empty, so a person can unpin everything and have
  // that choice survive a restart. Existing entries predate `pinned`; treating
  // them as pinned preserves the choices those users already made.
  const rawModels = Array.isArray(s.activeModels) ? s.activeModels : DEFAULT_PINNED_MODELS;
  s.activeModels = rawModels
    .filter(m => m && typeof m.id === 'string' && m.id.trim())
    .map(m => ({
      id: m.id.trim(),
      source: PROVIDER_IDS.includes(m.source) ? m.source : 'auto',
      enabled: m.enabled !== false,
      pinned: m.pinned !== false
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

  // DECISIONS.md D36: catalog facts learned at fetch time, and named model
  // sets. Both are additive — settings written before D36 simply have none.
  s.modelFacts = normalizeModelFacts(s.modelFacts);
  s.modelPopularity = normalizeModelPopularity(s.modelPopularity);
  s.modelSets = normalizeModelSets(s.modelSets);
  // The loop's band→model map (DESIGN-SPEC.md §8). Normalized here so a hand-edited
  // settings.json cannot put a non-string, an empty id, or a band that is not a
  // band into the one structure the supervisor reads per attempt.
  s.loopModels = normalizeLoopModels(s.loopModels);
  return s;
}

export const LOOP_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeLoopModels(raw) {
  const out = {};
  for (const band of LOOP_LEVELS) {
    const id = raw?.[band];
    if (typeof id === 'string' && id.trim()) out[band] = id.trim();
  }
  return out;
}

// --- Model facts (DECISIONS.md D36) ----------------------------------------------
// The OpenRouter catalog already answers "what does this cost, how much can it
// read, can it call tools" — the app used to render those into a <datalist>
// and throw them away. Picking a model for a lane is a cost decision, so the
// numbers are kept beside the active-model registry and shown wherever a model
// is chosen. Persisted so they survive a restart without a re-fetch.

// Catalog prices are per-token USD strings ('0.000003'). Everyone quotes
// per-million, so that is what gets stored — a price nobody counts zeros in.
// Four decimals: the cheapest models really do cost $0.015/M.
export function usdPerMillion(perToken) {
  // An empty string is "no price stated", not free — and Number('') is 0, so
  // the guard has to come before the coercion.
  if (typeof perToken === 'string') { if (!perToken.trim()) return null; }
  else if (typeof perToken !== 'number') return null;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e4) / 1e4;
}

// The OpenRouter /models payload reduced to the catalog entry the app uses.
// Lives here rather than in the IPC handler so the field mapping is testable
// without a live key.
export function catalogFromOpenRouter(payload) {
  return (payload?.data ?? [])
    .filter(m => m && typeof m.id === 'string' && m.id.trim())
    .map(m => ({
      id: m.id.trim(),
      name: m.name ?? m.id.trim(),
      contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
      supportsTools: (m.supported_parameters || []).includes('tools'),
      inUsdPerM: usdPerMillion(m.pricing?.prompt),
      outUsdPerM: usdPerMillion(m.pricing?.completion)
    }));
}

// OpenRouter's rankings dataset is model-shaped rather than creator-shaped:
// one row per top model per UTC bucket. Reduce it here so the renderer gets a
// compact, deterministic creator ranking and never has to add decimal strings
// with lossy floating-point arithmetic.
export function popularityFromOpenRouter(payload) {
  const totals = new Map();
  for (const row of payload?.data ?? []) {
    const slug = typeof row?.model_permaslug === 'string' ? row.model_permaslug.trim() : '';
    const slash = slug.indexOf('/');
    if (slash <= 0 || slug === 'other') continue;
    const creator = slug.slice(0, slash).replace(/^~/, '').trim().toLowerCase();
    if (!creator) continue;
    let tokens;
    try { tokens = BigInt(row.total_tokens); } catch { continue; }
    if (tokens < 0n) continue;
    totals.set(creator, (totals.get(creator) ?? 0n) + tokens);
  }
  const creators = [...totals.entries()]
    .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] > b[1] ? -1 : 1))
    .map(([key, totalTokens]) => ({ key, totalTokens: totalTokens.toString() }));
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  return {
    creators,
    asOf: typeof meta.as_of === 'string' ? meta.as_of : null,
    startDate: typeof meta.start_date === 'string' ? meta.start_date : null,
    endDate: typeof meta.end_date === 'string' ? meta.end_date : null
  };
}

export function normalizeModelPopularity(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.creators)) return null;
  const totals = new Map();
  for (const entry of raw.creators) {
    const key = typeof entry?.key === 'string' ? entry.key.trim().replace(/^~/, '').toLowerCase() : '';
    if (!key) continue;
    let tokens;
    try { tokens = BigInt(entry.totalTokens); } catch { continue; }
    if (tokens < 0n) continue;
    totals.set(key, (totals.get(key) ?? 0n) + tokens);
  }
  if (!totals.size) return null;
  const creators = [...totals.entries()]
    .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] > b[1] ? -1 : 1))
    .map(([key, totalTokens]) => ({ key, totalTokens: totalTokens.toString() }));
  return {
    creators,
    asOf: typeof raw.asOf === 'string' ? raw.asOf : null,
    startDate: typeof raw.startDate === 'string' ? raw.startDate : null,
    endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null
  };
}

// One catalog entry reduced to the facts a picker shows. Absent fields are
// omitted rather than stored as null — "unknown" and "free" must not look the
// same in a price column.
export function modelFactsOf(m) {
  if (!m || typeof m.id !== 'string' || !m.id.trim()) return null;
  const f = {};
  if (typeof m.name === 'string' && m.name.trim() && m.name.trim() !== m.id.trim()) f.name = m.name.trim();
  if (Number.isFinite(m.contextLength) && m.contextLength > 0) f.contextLength = m.contextLength;
  if (typeof m.supportsTools === 'boolean') f.supportsTools = m.supportsTools;
  if (Number.isFinite(m.inUsdPerM)) f.inUsdPerM = m.inUsdPerM;
  if (Number.isFinite(m.outUsdPerM)) f.outUsdPerM = m.outUsdPerM;
  return f;
}

// Merge a fetched catalog into the stored facts. A later fetch wins for the
// ids it covers; ids it does not mention keep what we already knew, so
// fetching one provider's catalog never blanks another's prices.
export function factsFromCatalog(list, prev = {}) {
  const out = { ...normalizeModelFacts(prev) };
  for (const m of list ?? []) {
    const f = modelFactsOf(m);
    if (f && Object.keys(f).length) out[m.id.trim()] = f;
  }
  return out;
}

export function normalizeModelFacts(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const f = modelFactsOf({ id, ...(v && typeof v === 'object' ? v : {}) });
    if (f && Object.keys(f).length) out[id.trim()] = f;
  }
  return out;
}

// --- Model sets (DECISIONS.md D36) -------------------------------------
// A named, reusable list of model ids: one thing to pick in a fan-out, a mode
// or a comparison, instead of N pickers. Shape:
//   modelSets: { <setId>: { name, models: [id, ...] } }
// The id is stable (it is what a flow refers to); the name is what you renamed
// it to. An empty set is legal — you create one, then fill it.

export const MODEL_SET_MAX = 24;

export function modelSetId(name) {
  return String(name ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function normalizeModelSets(raw) {
  const out = {};
  for (const [key, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const id = modelSetId(key);
    if (!id || out[id]) continue;
    // A bare array is accepted as shorthand for { models } — hand-edited
    // settings.json is a supported way in, like every other file in this app.
    const models = Array.isArray(v) ? v : Array.isArray(v?.models) ? v.models : null;
    if (!models) continue;
    out[id] = {
      name: typeof v?.name === 'string' && v.name.trim() ? v.name.trim() : id,
      models: [...new Set(models.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()))].slice(0, MODEL_SET_MAX)
    };
  }
  return out;
}

// The ids a set actually contributes right now: members that are still active
// models. A set that names a model you later removed shrinks rather than
// resolving to something that cannot run.
export function resolveModelSet(modelSets, setId, activeModels = []) {
  const set = normalizeModelSets(modelSets)[modelSetId(setId)];
  if (!set) return [];
  const usable = new Set(activeModels.filter(m => m && m.enabled !== false).map(m => m.id));
  return set.models.filter(id => usable.has(id));
}

// --- Starter set (DECISIONS.md D36) ----------------------------------------------
// The four models a first-time user needs before the app can do anything
// interesting: something cheap to iterate with, something strong to reason
// with, something with room to read a whole repo, and one that is none of
// those — the wildcard the fan-out lanes exist for (D36/B6).
export const STARTER_ROLES = [
  { id: 'fast', label: 'Fast & cheap', hint: 'drafts, routing, cheap iterations' },
  { id: 'reasoner', label: 'Strong reasoner', hint: 'planning, hard analysis, judging' },
  { id: 'reader', label: 'Long context', hint: 'reading whole repos and long outputs' },
  { id: 'wildcard', label: 'Wildcard', hint: 'a different lab — divergence is the point' }
];

// A nudge, not a hardcoding: these ids win their role when the live catalog
// still carries them, and the catalog-driven heuristic below covers every case
// where it does not (renamed, withdrawn, or a catalog we have never seen).
const STARTER_PREFERRED = {
  fast: ['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash'],
  reasoner: ['anthropic/claude-opus-4.5', 'openai/gpt-5.2', 'anthropic/claude-sonnet-4.5'],
  reader: ['google/gemini-2.5-pro', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5.2'],
  wildcard: ['x-ai/grok-4', 'deepseek/deepseek-chat', 'moonshotai/kimi-k2', 'qwen/qwen3-max']
};

// A per-role budget ceiling, so "strong reasoner" cannot quietly propose the
// $75/M outlier to somebody who has had an API key for ninety seconds.
const STARTER_CEILING_USD_PER_M = 12;

const vendorOf = id => (String(id).includes('/') ? String(id).split('/')[0] : String(id).split('-')[0]);

// Deterministic: same catalog in, same four models out. Tool support is
// required — a model the agent loop cannot give tools to is not a starter
// model — and no two roles come from the same vendor while an alternative
// exists, because a "wildcard" from the same lab is not a wildcard.
export function proposeStarterSet(catalog = []) {
  const pool = catalog.filter(m => m && typeof m.id === 'string' && m.id.trim() && m.supportsTools !== false);
  if (!pool.length) return [];
  const byId = new Map(pool.map(m => [m.id, m]));
  const priced = m => (Number.isFinite(m.inUsdPerM) ? m.inUsdPerM : Infinity);
  const ctx = m => (Number.isFinite(m.contextLength) ? m.contextLength : 0);
  // A price we were never told is not a price over the ceiling. The curated
  // per-provider lists carry no pricing at all, and excluding them outright
  // left the strong/wildcard roles empty for anyone without an OpenRouter key.
  const affordable = m => !(Number.isFinite(m.inUsdPerM) && m.inUsdPerM > STARTER_CEILING_USD_PER_M);

  const picks = [];
  const usedIds = new Set();
  const usedVendors = new Set();

  const heuristic = {
    // Cheapest that can still hold a real brief.
    fast: cands => [...cands].sort((a, b) => priced(a) - priced(b) || ctx(b) - ctx(a))
      .find(m => ctx(m) >= 32_000) ?? [...cands].sort((a, b) => priced(a) - priced(b))[0],
    // Price is the market's proxy for capability — the dearest under the
    // ceiling. Unpriced models sort last here, so a known-strong model wins
    // whenever the catalog told us anything at all.
    reasoner: cands => [...cands].filter(affordable)
      .sort((a, b) => (priced(b) === Infinity ? -1 : priced(a) === Infinity ? 1 : priced(b) - priced(a)) || ctx(b) - ctx(a))[0],
    // Most room to read, cheapest at equal room.
    reader: cands => [...cands].sort((a, b) => ctx(b) - ctx(a) || priced(a) - priced(b))[0],
    // Anything decent from a lab the other three did not come from.
    wildcard: cands => [...cands].filter(affordable)
      .sort((a, b) => ctx(b) - ctx(a) || priced(a) - priced(b))[0]
  };

  for (const role of STARTER_ROLES) {
    const fresh = m => !usedIds.has(m.id);
    const novel = m => fresh(m) && !usedVendors.has(vendorOf(m.id));
    const preferred = (STARTER_PREFERRED[role.id] ?? []).map(id => byId.get(id)).filter(Boolean);
    const pick =
      preferred.find(novel) ??
      heuristic[role.id](pool.filter(novel)) ??
      preferred.find(fresh) ??
      heuristic[role.id](pool.filter(fresh)) ??
      null;
    if (!pick) continue;
    usedIds.add(pick.id);
    usedVendors.add(vendorOf(pick.id));
    picks.push({ role: role.id, label: role.label, hint: role.hint, id: pick.id, facts: modelFactsOf(pick) ?? {} });
  }
  return picks;
}

// The resolution rule (DESIGN-SPEC.md §6), as a closure over the live
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
// How many providers an auto route may try after the first one fails. Bounded
// on purpose (WR-05): unattended fallback that walks the whole priority list is
// a way to spend a budget on a misconfiguration, and each attempt is a real
// call on a real bill.
export const MAX_AUTO_FALLBACKS = 2;

/**
 * The next providers an AUTO-routed call may try after an infrastructure
 * failure (WR-05).
 *
 * "Pinned means pinned": a worker naming its own provider gets an empty list.
 * An explicit source must fail with a remedy rather than silently spend
 * somewhere the user did not choose — possibly on a different bill. Only a
 * worker that said `auto` asked to be routed, and only that one may be
 * re-routed.
 *
 * `tried` prevents cycling back onto a provider that has already failed.
 */
export function autoFallbackTargets(worker, config, { tried = [], limit = MAX_AUTO_FALLBACKS } = {}) {
  if (worker?.provider !== 'auto') return [];
  const modelId = worker.model;
  const priority = config?.providerPriority ?? DEFAULT_PRIORITY;
  // Excluded by BOTH names: the id in the priority list, and the concrete
  // provider/model the resolver returns. They are normally the same, but a
  // resolver that maps two list entries onto one target would otherwise hand
  // back the target that just failed and burn an attempt re-proving it.
  const seen = new Set();
  const seenTargets = new Set();
  for (const t of tried) {
    if (typeof t === 'string') seen.add(t);
    else if (t?.provider) { seen.add(t.provider); seenTargets.add(`${t.provider}/${t.model}`); }
  }
  const out = [];
  for (const provider of priority) {
    if (out.length >= limit) break;
    if (seen.has(provider)) continue;
    // The same connected/can-serve rules source resolution uses — asked of the
    // resolver rather than re-implemented, so eligibility cannot drift.
    let target;
    try { target = config?.resolveModelSource?.(modelId, provider); }
    catch { continue; } // not connected, or cannot serve this id
    if (!target?.provider) continue;
    const key = `${target.provider}/${target.model}`;
    if (seenTargets.has(key)) continue;
    seen.add(provider);
    seenTargets.add(key);
    out.push(target);
  }
  return out;
}

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
