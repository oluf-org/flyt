// Default model priorities (node rework): which model a node should use when
// neither the node nor config.categoryWorkers pins one, given the node's task
// kind, its effort level, and which providers actually have keys.
//
// Pure data + pure functions, no Electron imports — resolveWorker
// (core/flowRunner.js) calls pickDefaultWorker with the runtime config, and
// the unit tests exercise the tables directly.
//
// The rankings encode the mid-2026 consensus from public benchmarks and
// comparisons (SWE-bench Verified, LiveCodeBench, GPQA/AIME, provider pricing;
// see the sources in the node-rework notes):
//   - Anthropic leads agentic coding and produces the cleanest code/prose;
//     Opus is the flagship, Sonnet the balanced default, Haiku the light tier.
//   - OpenAI is the strongest reasoning-per-dollar (o4, GPT-5.2) and very
//     strong multilingual — preferred for translation and heavy evaluation.
//   - Kimi K2.7-code is the budget agentic coder (5-7x cheaper than frontier
//     closed models at competitive SWE-bench); K2.6 is its general model.
//   - OpenRouter mirrors the same frontier models, so a user with only an
//     OpenRouter key still reaches the per-task best pick.
//
// Two layers, per the rework spec:
//   PROVIDER_MODEL_PRIORITY — per provider: ranked model ids per kind × effort,
//     so a user with ONE provider still gets that provider's best option.
//   PROVIDER_ORDER — the general cross-provider preference per kind × effort.
// pickDefaultWorker walks PROVIDER_ORDER, skips providers without keys, and
// takes the first provider's top-ranked model.

import { DEFAULT_EFFORT, EFFORT_LEVELS } from '../src/flowTypes.js';

export const TASK_KINDS = ['code', 'docs', 'planning', 'evaluation', 'analysis', 'translation', 'general'];

// --- Per-provider rankings (first entry = best for that kind/effort) --------
export const PROVIDER_MODEL_PRIORITY = {
  anthropic: {
    code: {
      low: ['claude-haiku-4-5', 'claude-sonnet-5'],
      medium: ['claude-sonnet-5', 'claude-opus-4-5'],
      high: ['claude-opus-4-5', 'claude-sonnet-5']
    },
    docs: {
      low: ['claude-haiku-4-5'],
      medium: ['claude-sonnet-5', 'claude-haiku-4-5'],
      high: ['claude-sonnet-5', 'claude-opus-4-5']
    },
    planning: {
      low: ['claude-sonnet-5', 'claude-haiku-4-5'],
      medium: ['claude-sonnet-5', 'claude-opus-4-5'],
      high: ['claude-opus-4-5', 'claude-sonnet-5']
    },
    evaluation: {
      low: ['claude-haiku-4-5', 'claude-sonnet-5'],
      medium: ['claude-sonnet-5'],
      high: ['claude-opus-4-5', 'claude-sonnet-5']
    },
    analysis: {
      low: ['claude-haiku-4-5', 'claude-sonnet-5'],
      medium: ['claude-sonnet-5'],
      high: ['claude-opus-4-5', 'claude-sonnet-5']
    },
    translation: {
      low: ['claude-haiku-4-5'],
      medium: ['claude-sonnet-5', 'claude-haiku-4-5'],
      high: ['claude-sonnet-5', 'claude-opus-4-5']
    },
    general: {
      low: ['claude-haiku-4-5'],
      medium: ['claude-sonnet-5'],
      high: ['claude-opus-4-5', 'claude-sonnet-5']
    }
  },
  openai: {
    code: {
      low: ['gpt-5-mini', 'gpt-5'],
      medium: ['gpt-5.2', 'gpt-5'],
      high: ['gpt-5.2', 'o4']
    },
    docs: {
      low: ['gpt-5-mini'],
      medium: ['gpt-5', 'gpt-5-mini'],
      high: ['gpt-5.2', 'gpt-5']
    },
    planning: {
      low: ['gpt-5', 'gpt-5-mini'],
      medium: ['gpt-5.2', 'gpt-5'],
      high: ['o4', 'gpt-5.2']
    },
    evaluation: {
      low: ['gpt-5-mini', 'gpt-5'],
      medium: ['gpt-5.2', 'gpt-5'],
      high: ['o4', 'gpt-5.2']
    },
    analysis: {
      low: ['gpt-5-mini', 'gpt-5'],
      medium: ['gpt-5.2', 'gpt-5'],
      high: ['o4', 'gpt-5.2']
    },
    translation: {
      low: ['gpt-5-mini'],
      medium: ['gpt-5', 'gpt-5.2'],
      high: ['gpt-5.2', 'gpt-5']
    },
    general: {
      low: ['gpt-5-mini'],
      medium: ['gpt-5', 'gpt-5.2'],
      high: ['gpt-5.2', 'o4']
    }
  },
  // Platform-key ids. A Kimi-Code subscription key can only serve
  // 'kimi-for-coding' — kimiModelsFor() swaps these lists out for it.
  kimi: {
    code: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.7-code', 'kimi-k2.6'],
      high: ['kimi-k2.7-code']
    },
    docs: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.6']
    },
    planning: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.7-code', 'kimi-k2.6']
    },
    evaluation: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.7-code', 'kimi-k2.6']
    },
    analysis: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.6']
    },
    translation: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.6']
    },
    general: {
      low: ['kimi-k2.6'],
      medium: ['kimi-k2.6'],
      high: ['kimi-k2.6']
    }
  },
  // Codex CLI (ChatGPT subscription): the codex-tuned models are its best
  // agentic pick; plain GPT-5.2 covers the general kinds.
  codex: {
    code: {
      low: ['gpt-5.1-codex-mini', 'gpt-5.2-codex'],
      medium: ['gpt-5.2-codex', 'gpt-5.2'],
      high: ['gpt-5.2-codex']
    },
    docs: {
      low: ['gpt-5.1-codex-mini'],
      medium: ['gpt-5.2', 'gpt-5.1-codex-mini'],
      high: ['gpt-5.2']
    },
    planning: {
      low: ['gpt-5.2'],
      medium: ['gpt-5.2', 'gpt-5.2-codex'],
      high: ['gpt-5.2-codex', 'gpt-5.2']
    },
    evaluation: {
      low: ['gpt-5.1-codex-mini', 'gpt-5.2'],
      medium: ['gpt-5.2'],
      high: ['gpt-5.2-codex', 'gpt-5.2']
    },
    analysis: {
      low: ['gpt-5.1-codex-mini', 'gpt-5.2'],
      medium: ['gpt-5.2'],
      high: ['gpt-5.2', 'gpt-5.2-codex']
    },
    translation: {
      low: ['gpt-5.1-codex-mini'],
      medium: ['gpt-5.2'],
      high: ['gpt-5.2']
    },
    general: {
      low: ['gpt-5.1-codex-mini'],
      medium: ['gpt-5.2'],
      high: ['gpt-5.2', 'gpt-5.2-codex']
    }
  },
  // OpenRouter mirrors the frontier models under vendor-prefixed ids, so it
  // simply inherits the cross-provider ranking.
  openrouter: {
    code: {
      low: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2', 'moonshotai/kimi-k2.7'],
      high: ['anthropic/claude-opus-4-5', 'openai/gpt-5.2']
    },
    docs: {
      low: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5'],
      high: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2']
    },
    planning: {
      low: ['anthropic/claude-sonnet-5', 'openai/gpt-5'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2'],
      high: ['anthropic/claude-opus-4-5', 'openai/o4']
    },
    evaluation: {
      low: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2'],
      high: ['openai/o4', 'anthropic/claude-opus-4-5']
    },
    analysis: {
      low: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5.2'],
      high: ['anthropic/claude-opus-4-5', 'openai/o4']
    },
    translation: {
      low: ['openai/gpt-5-mini', 'anthropic/claude-haiku-4-5'],
      medium: ['openai/gpt-5', 'anthropic/claude-sonnet-5'],
      high: ['openai/gpt-5.2', 'anthropic/claude-sonnet-5']
    },
    general: {
      low: ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini'],
      medium: ['anthropic/claude-sonnet-5', 'openai/gpt-5'],
      high: ['anthropic/claude-opus-4-5', 'openai/gpt-5.2']
    }
  }
};

// --- General (cross-provider) preference per kind × effort ------------------
// Every keyed provider appears in every list, so a user with only one or two
// providers always lands on the best option those providers offer.
export const PROVIDER_ORDER = {
  code: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'kimi', 'openai', 'openrouter'],
    high: ['anthropic', 'openai', 'kimi', 'openrouter']
  },
  docs: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'openai', 'kimi', 'openrouter'],
    high: ['anthropic', 'openai', 'kimi', 'openrouter']
  },
  planning: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'openai', 'kimi', 'openrouter'],
    high: ['openai', 'anthropic', 'kimi', 'openrouter']
  },
  evaluation: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'openai', 'kimi', 'openrouter'],
    high: ['openai', 'anthropic', 'kimi', 'openrouter']
  },
  analysis: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'openai', 'kimi', 'openrouter'],
    high: ['anthropic', 'openai', 'kimi', 'openrouter']
  },
  translation: {
    low: ['openai', 'anthropic', 'kimi', 'openrouter'],
    medium: ['openai', 'anthropic', 'kimi', 'openrouter'],
    high: ['openai', 'anthropic', 'kimi', 'openrouter']
  },
  general: {
    low: ['anthropic', 'openai', 'kimi', 'openrouter'],
    medium: ['anthropic', 'openai', 'kimi', 'openrouter'],
    high: ['anthropic', 'openai', 'kimi', 'openrouter']
  }
};

// The Claude subscription serves the same models with the same ranking as the
// Anthropic API — only the transport differs.
PROVIDER_MODEL_PRIORITY['claude-code'] = PROVIDER_MODEL_PRIORITY.anthropic;

// Slot each subscription runtime right after its API sibling in every
// cross-provider list: a user with both prefers the metered key by default
// (predictable billing, no plan limits burned); a subscription-only user still
// lands on the same per-kind best pick.
for (const kind of Object.values(PROVIDER_ORDER)) {
  for (const [effort, order] of Object.entries(kind)) {
    kind[effort] = order.flatMap(p =>
      p === 'anthropic' ? [p, 'claude-code'] : p === 'openai' ? [p, 'codex'] : [p]);
  }
}

// Roles that map straight to a task kind; categories refine work nodes.
const ROLE_KIND = {
  'plan': 'planning', 'plan-start': 'planning', 'split': 'planning',
  'plan-eval': 'evaluation', 'step-eval': 'evaluation', 'final-eval': 'evaluation',
  'feedback-review': 'evaluation', 'verify': 'evaluation', 'stitch': 'evaluation',
  'combine': 'evaluation', 'evaluation': 'evaluation',
  'analyze': 'analysis',
  'translate': 'translation'
};
const CATEGORY_KIND = {
  'Code general': 'code', 'Code design': 'code', 'Test-creation': 'code',
  'documentation': 'docs'
};

// The task kind of a runtime node ({ type, data }); total.
export function taskKindOf(node) {
  if (node?.type === 'orchestrator') return 'planning';
  const d = node?.data ?? {};
  if (d.category && CATEGORY_KIND[d.category]) return CATEGORY_KIND[d.category];
  if (d.role && ROLE_KIND[d.role]) return ROLE_KIND[d.role];
  if (d.role === 'execute' || node?.type === 'agentTask') return 'code';
  return 'general';
}

const clampEffort = e => (EFFORT_LEVELS.includes(e) ? e : DEFAULT_EFFORT);

// A Kimi-Code subscription key serves exactly one model.
function kimiModels(kind, effort, keyKind) {
  if (keyKind === 'code') return ['kimi-for-coding'];
  return PROVIDER_MODEL_PRIORITY.kimi[kind]?.[effort] ?? [];
}

// The ranked models one provider offers for a kind/effort (exported for the
// tests and for any UI that wants to explain the default).
export function providerModelsFor(provider, kind, effort, { kimiKeyKind } = {}) {
  const k = TASK_KINDS.includes(kind) ? kind : 'general';
  const e = clampEffort(effort);
  if (provider === 'kimi') return kimiModels(k, e, kimiKeyKind);
  return PROVIDER_MODEL_PRIORITY[provider]?.[k]?.[e] ?? [];
}

/**
 * Plan the route for an unpinned node, showing the work (WR-04).
 *
 * The defect this closes: `createResolver` walked the user's
 * `settings.providerPriority` when resolving an auto source, while this picker
 * started from its own hard-coded `PROVIDER_ORDER`. Reordering providers in
 * Settings therefore changed some calls and the renderer's preview, but left
 * unpinned default workers on the built-in order — two silent winners for one
 * question.
 *
 * The two concerns compose in one direction only:
 *
 *   the USER'S provider priority answers "which connected provider first";
 *   the per-provider model rankings answer "which of that provider's models
 *   for this task kind and effort".
 *
 * `PROVIDER_ORDER`'s per-kind cross-provider preference is now only the
 * fallback for a config that states no user order — Settings must be truthful,
 * so a per-kind table cannot quietly outrank what the user arranged.
 *
 * Returns the considered candidates and why each was skipped, so the renderer
 * preview, `flyt doctor`, the node-start log and the actual call can all read
 * ONE record instead of each re-deriving the answer.
 */
export function planDefaultRoute(node, config) {
  const keys = config?.providerKeys ?? {};
  const kind = taskKindOf(node);
  const effort = clampEffort(node?.data?.effort);
  const userOrder = Array.isArray(config?.providerPriority)
    ? config.providerPriority.filter(p => typeof p === 'string' && p.trim())
    : null;
  const order = userOrder?.length
    ? userOrder
    : (PROVIDER_ORDER[kind]?.[effort] ?? PROVIDER_ORDER.general[DEFAULT_EFFORT]);
  const source = userOrder?.length ? 'settings-priority' : 'default-order';

  const candidates = [];
  for (const provider of order) {
    if (!keys[provider]) {
      candidates.push({ provider, skipped: 'not connected' });
      continue;
    }
    const models = providerModelsFor(provider, kind, effort, { kimiKeyKind: config?.kimiKeyKind });
    if (!models.length) {
      candidates.push({ provider, skipped: `no ranked model for ${kind}/${effort}` });
      continue;
    }
    candidates.push({ provider, model: models[0], chosen: true });
    return {
      provider, model: models[0], kind, effort, order: source, candidates,
      reason: `highest-ranked ${kind}/${effort} model on the first connected provider in ${
        source === 'settings-priority' ? 'your Settings order' : 'the default order'}`
    };
  }
  return {
    provider: null, model: null, kind, effort, order: source, candidates,
    reason: Object.keys(keys).length
      ? 'no connected provider offers a model for this task kind and effort'
      : 'no provider is connected'
  };
}

// The default worker for a node, or null when no connected provider has an
// entry (the caller then falls back to the configured executor default).
// config needs: providerKeys (provider -> key), optional providerPriority
// (the user's order) and kimiKeyKind.
export function pickDefaultWorker(node, config) {
  const keys = config?.providerKeys;
  if (!keys || !Object.keys(keys).length) return null;
  const route = planDefaultRoute(node, config);
  return route.provider ? { provider: route.provider, model: route.model } : null;
}
