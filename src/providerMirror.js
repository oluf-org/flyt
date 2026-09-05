// A renderer-side mirror of the adapters' canServe rules and the provider
// order. Presentational only — the main process stays the authority for actual
// resolution (core/modelSource.js). It exists so a picker can say "no
// connected provider can serve this" at the point of choosing rather than
// three nodes into a run (D36 P0.5).
//
// Settings.jsx owned a private copy of this; the model pickers need the same
// answer, and two copies of a rule that must agree is one too many.

export const PROVIDER_ORDER = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter'];

// Providers whose "connection" is the vendor CLI's own sign-in, not a key.
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];

const SERVE = {
  anthropic: id => id.startsWith('claude-'),
  'claude-code': id => id.startsWith('claude-'),
  openai: id => /^(gpt-|o\d)/.test(id),
  codex: id => /^(gpt-|o\d|codex)/.test(id),
  kimi: id => /^(kimi-|moonshot-)/.test(id),
  openrouter: id => id.includes('/')
};

export const canServe = (provider, id) => SERVE[provider]?.(String(id ?? '')) ?? false;

// Which connected provider would serve this id right now: a pinned source when
// it holds, otherwise the priority walk. null means nothing would — the
// `unrouted` state.
export function routeFor(id, { providers = {}, providerPriority = PROVIDER_ORDER, source = 'auto' } = {}) {
  const connected = p => Boolean(providers?.[p]?.hasKey);
  if (source && source !== 'auto') {
    return connected(source) && canServe(source, id) ? source : null;
  }
  return (providerPriority ?? PROVIDER_ORDER).find(p => connected(p) && canServe(p, id)) ?? null;
}
