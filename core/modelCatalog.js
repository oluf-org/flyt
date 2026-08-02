// The model catalog (SETTINGS-MODELS-PLAN §2, phase P1). A model is a RECORD,
// not a bare string id: price, context, tier, release date and training policy
// all live here, in one bundled, hand-editable, diffable file (Principle 1,
// D28: immutable bundled data → projectRoot).
//
// core/modelSource.js derives CURATED_MODELS from this file so every existing
// caller (models:list, Settings, pickers) keeps working unchanged during the
// transition. electron/main.js merges OpenRouter's live pricing on top of
// these records (merge rule: bundled wins name/tier/training, live wins
// price/contextLength).
//
// Hand-maintenance contract: prices, release dates and training policies are
// verified by a human when the file is bumped (`npm run catalog -- check`
// prints upstream drift). The app NEVER asserts a training policy it cannot
// cite — every non-'unknown' training.policy carries a `source` URL, enforced
// by tests/modelCatalog.test.js.

// Tier: curated, opinionated (open question Q1, assumed curated with a
// price-derived fallback for unknown OpenRouter ids).
export const TIERS = ['frontier', 'balanced', 'fast', 'reasoning', 'legacy'];

// The five-value training-policy enum (SETTINGS-MODELS-PLAN §2). Pill labels
// and colours are a renderer concern; the values below are the contract.
//   no-train         provider states inputs/outputs are not used for training
//   opt-out-default  not trained on unless you opt in, per account setting
//   opt-in-default   trained on unless you opt out, per account setting
//   account-governed the subscription case: governed by the user's own provider
//                    account settings, which the app cannot read (G7)
//   unknown          aggregator route or unverified — never guess
export const TRAINING_POLICIES = ['no-train', 'opt-out-default', 'opt-in-default', 'account-governed', 'unknown'];

export const MODEL_CATALOG = [
  // --- Anthropic (API, per-token) -------------------------------------------
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    providers: ['anthropic', 'claude-code'],
    family: 'Claude',
    tier: 'balanced',
    releasedAt: '2026-02-24',
    contextLength: 200_000,
    maxOutput: 64_000,
    price: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://www.anthropic.com/legal/commercial-terms'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    providers: ['anthropic', 'claude-code'],
    family: 'Claude',
    tier: 'frontier',
    releasedAt: '2025-11-24',
    contextLength: 200_000,
    maxOutput: 64_000,
    price: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://www.anthropic.com/legal/commercial-terms'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    providers: ['anthropic', 'claude-code'],
    family: 'Claude',
    tier: 'fast',
    releasedAt: '2025-10-15',
    contextLength: 200_000,
    maxOutput: 64_000,
    price: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
    caps: { tools: true, vision: true, reasoning: false, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://www.anthropic.com/legal/commercial-terms'
    },
    deprecated: false,
    aliasOf: null
  },
  // A dated snapshot id, folded onto its rolling alias (record shape §2).
  {
    id: 'claude-sonnet-5-20260224',
    name: 'Claude Sonnet 5 (2026-02-24 snapshot)',
    providers: ['anthropic', 'claude-code'],
    family: 'Claude',
    tier: 'balanced',
    releasedAt: '2026-02-24',
    contextLength: 200_000,
    maxOutput: 64_000,
    price: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://www.anthropic.com/legal/commercial-terms'
    },
    deprecated: false,
    aliasOf: 'claude-sonnet-5'
  },

  // --- OpenAI (API, per-token) ------------------------------------------------
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    providers: ['openai', 'codex'],
    family: 'GPT',
    tier: 'frontier',
    releasedAt: '2025-12-11',
    contextLength: 400_000,
    maxOutput: 128_000,
    price: { input: 1.75, output: 14.00, cacheRead: 0.175, cacheWrite: null },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://openai.com/enterprise-privacy/'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    providers: ['openai'],
    family: 'GPT',
    tier: 'balanced',
    releasedAt: '2025-08-07',
    contextLength: 400_000,
    maxOutput: 128_000,
    price: { input: 1.25, output: 10.00, cacheRead: 0.125, cacheWrite: null },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://openai.com/enterprise-privacy/'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    providers: ['openai'],
    family: 'GPT',
    tier: 'fast',
    releasedAt: '2025-08-07',
    contextLength: 400_000,
    maxOutput: 128_000,
    price: { input: 0.25, output: 2.00, cacheRead: 0.025, cacheWrite: null },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://openai.com/enterprise-privacy/'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'o4',
    name: 'o4 (reasoning)',
    providers: ['openai'],
    family: 'o-series',
    tier: 'reasoning',
    releasedAt: '2025-11-20',
    contextLength: 200_000,
    maxOutput: 100_000,
    price: { input: 1.10, output: 4.40, cacheRead: 0.275, cacheWrite: null },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'no-train',
      scope: 'api',
      note: 'API inputs and outputs are not used to train models.',
      source: 'https://openai.com/enterprise-privacy/'
    },
    deprecated: false,
    aliasOf: null
  },

  // --- Codex CLI (ChatGPT subscription, plan-priced) ---------------------------
  // Subscription entries carry a plan price, not per-token numbers (§2): the
  // cost column renders "your plan's limits", never a dollar figure.
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    providers: ['codex'],
    family: 'GPT',
    tier: 'frontier',
    releasedAt: '2025-12-15',
    contextLength: 400_000,
    maxOutput: 128_000,
    price: { kind: 'plan', plan: 'ChatGPT Plus / Pro / Business' },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'account-governed',
      scope: 'subscription',
      note: 'Subscription data use is set by the user\'s own OpenAI account settings; the app cannot read them.',
      source: 'https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance'
    },
    deprecated: false,
    aliasOf: null
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex mini',
    providers: ['codex'],
    family: 'GPT',
    tier: 'fast',
    releasedAt: '2025-11-13',
    contextLength: 400_000,
    maxOutput: 128_000,
    price: { kind: 'plan', plan: 'ChatGPT Plus / Pro / Business' },
    caps: { tools: true, vision: true, reasoning: true, streaming: true },
    training: {
      policy: 'account-governed',
      scope: 'subscription',
      note: 'Subscription data use is set by the user\'s own OpenAI account settings; the app cannot read them.',
      source: 'https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance'
    },
    deprecated: false,
    aliasOf: null
  },

  // --- Kimi / Moonshot ---------------------------------------------------------
  // `keyKind` marks which endpoint the id is valid on (platform vs. the Kimi
  // Code subscription endpoint), mirroring the previous CURATED_MODELS field.
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    providers: ['kimi'],
    family: 'Kimi',
    tier: 'frontier',
    releasedAt: '2026-05-12',
    contextLength: 256_000,
    maxOutput: 32_000,
    price: { input: 0.80, output: 3.20, cacheRead: null, cacheWrite: null },
    caps: { tools: true, vision: false, reasoning: true, streaming: true },
    training: { policy: 'unknown', scope: 'api', note: '', source: null },
    deprecated: false,
    aliasOf: null,
    keyKind: 'platform'
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    providers: ['kimi'],
    family: 'Kimi',
    tier: 'balanced',
    releasedAt: '2026-01-27',
    contextLength: 256_000,
    maxOutput: 32_000,
    price: { input: 0.60, output: 2.50, cacheRead: null, cacheWrite: null },
    caps: { tools: true, vision: false, reasoning: false, streaming: true },
    training: { policy: 'unknown', scope: 'api', note: '', source: null },
    deprecated: false,
    aliasOf: null,
    keyKind: 'platform'
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding (Kimi Code subscription)',
    providers: ['kimi'],
    family: 'Kimi',
    tier: 'balanced',
    releasedAt: '2026-03-10',
    contextLength: 256_000,
    maxOutput: 32_000,
    price: { kind: 'plan', plan: 'Kimi Code subscription' },
    caps: { tools: true, vision: false, reasoning: false, streaming: true },
    training: { policy: 'unknown', scope: 'subscription', note: '', source: null },
    deprecated: false,
    aliasOf: null,
    keyKind: 'code'
  }
];

// --- Lookups -----------------------------------------------------------------

const BY_ID = new Map(MODEL_CATALOG.map(m => [m.id, m]));

export function catalogEntry(id) {
  return BY_ID.get(id) ?? null;
}

// Dated snapshot ids fold onto their rolling alias (§2 aliasOf). Returns the
// canonical record for any id the catalog knows, or null for unknown ids.
export function resolveCatalogId(id) {
  const entry = BY_ID.get(id);
  if (!entry) return null;
  if (!entry.aliasOf) return entry;
  return BY_ID.get(entry.aliasOf) ?? entry;
}

// The models a provider can offer, in the shape CURATED_MODELS always had
// ({ id, name, supportsTools, keyKind? }). Aliases are folded away — pickers
// offer the rolling id, not dated snapshots. Subscription providers get the
// "(subscription)" name suffix their old curated lists carried.
export function modelsForProvider(provider, { subscriptionSuffix = false } = {}) {
  return MODEL_CATALOG
    .filter(m => !m.aliasOf && m.providers.includes(provider))
    .map(m => ({
      id: m.id,
      name: subscriptionSuffix ? `${m.name} (subscription)` : m.name,
      supportsTools: Boolean(m.caps?.tools),
      ...(m.keyKind ? { keyKind: m.keyKind } : {})
    }));
}

// --- Merge: bundled catalog + OpenRouter live data (§2) -----------------------
//
// Merge rule: the bundled record wins on name/tier/training (curated,
// human-verified); the live record wins on price/contextLength (OpenRouter
// reports current pricing, which the bundled file cannot track). `releasedAt`
// comes from live (`created`, unix seconds) when the bundled file doesn't say.
export function mergeModelRecords(bundled, live) {
  if (!bundled) return live ?? null;
  if (!live) return bundled;
  return {
    ...bundled,
    name: bundled.name,
    tier: bundled.tier,
    training: bundled.training,
    price: live.price ?? bundled.price,
    contextLength: live.contextLength ?? bundled.contextLength,
    releasedAt: bundled.releasedAt ?? live.releasedAt ?? null
  };
}

// OpenRouter ids are namespaced ('anthropic/claude-sonnet-5'); a live id maps
// onto a bundled record when its second segment is a bundled id served by a
// matching provider. Returns the bundled id or null.
export function bundledIdForOpenRouterId(openRouterId) {
  const seg = String(openRouterId ?? '').split('/');
  if (seg.length !== 2) return null;
  const candidate = seg[1];
  const entry = resolveCatalogId(candidate);
  return entry ? entry.id : null;
}

// --- Validation (tests/modelCatalog.test.js is the enforcer) ------------------

// Structural validation, provider-agnostic: returns a list of human-readable
// problems. The test additionally checks serve-consistency against the adapter
// registry, which this pure module does not import.
export function validateCatalog({ knownProviders }) {
  const problems = [];
  const seen = new Set();
  for (const m of MODEL_CATALOG) {
    const at = `catalog record "${m.id}"`;
    if (!m.id || typeof m.id !== 'string') problems.push(`${at}: missing id`);
    if (seen.has(m.id)) problems.push(`${at}: duplicate id`);
    seen.add(m.id);
    if (!m.name) problems.push(`${at}: missing name`);
    if (!Array.isArray(m.providers) || m.providers.length === 0) {
      problems.push(`${at}: providers must be a non-empty array`);
    } else {
      for (const p of m.providers) {
        if (!knownProviders.includes(p)) problems.push(`${at}: unknown provider "${p}"`);
      }
    }
    if (!TIERS.includes(m.tier)) problems.push(`${at}: unknown tier "${m.tier}"`);
    if (!m.training || !TRAINING_POLICIES.includes(m.training.policy)) {
      problems.push(`${at}: unknown training policy`);
    } else if (m.training.policy !== 'unknown' && !m.training.source) {
      // The one rule this file exists to enforce: never assert a training
      // policy the app cannot cite.
      problems.push(`${at}: training policy "${m.training.policy}" has no source URL`);
    }
    if (m.aliasOf && !BY_ID.has(m.aliasOf)) problems.push(`${at}: aliasOf "${m.aliasOf}" is not a catalog id`);
    if (m.price && m.price.kind !== 'plan') {
      for (const k of ['input', 'output']) {
        if (m.price[k] != null && (typeof m.price[k] !== 'number' || m.price[k] < 0)) {
          problems.push(`${at}: price.${k} is not a non-negative number`);
        }
      }
    }
  }
  return problems;
}
