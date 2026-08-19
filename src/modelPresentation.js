const CREATOR_NAMES = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  moonshotai: 'Kimi',
  kimi: 'Kimi',
  google: 'Google',
  'google-ai-studio': 'Google',
  'meta-llama': 'Meta',
  meta: 'Meta',
  'x-ai': 'xAI',
  mistralai: 'Mistral',
  mistral: 'Mistral',
  qwen: 'Qwen',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  mock: 'Dry run'
};

const DIRECT_CREATORS = {
  anthropic: 'anthropic',
  'claude-code': 'anthropic',
  openai: 'openai',
  codex: 'openai',
  kimi: 'kimi',
  mock: 'mock'
};

const CREATOR_ALIASES = {
  moonshotai: 'kimi',
  'google-ai-studio': 'google',
  'meta-llama': 'meta',
  mistralai: 'mistral'
};

function inferDirectCreator(id) {
  if (id.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|o\d|codex)/.test(id)) return 'openai';
  if (/^(kimi-|moonshot-)/.test(id)) return 'kimi';
  if (id.startsWith('mock-')) return 'mock';
  return 'other';
}

export function titleCaseSlug(value) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI');
}

// Provider-qualified ids are a routing detail, not a model name. Split that
// detail once and let every model surface say “OpenAI / GPT 5.2” instead of
// repeating “openai/gpt-5.2” as an opaque path.
export function presentModel(model, fallbackProvider = null) {
  const id = String(model?.id ?? model ?? '').trim();
  const slash = id.indexOf('/');
  // Some catalog entries prefix their provider with `~`. It is metadata, not a
  // distinct creator, so strip it before aliases and grouping are applied.
  const rawCreator = (slash > 0
    ? id.slice(0, slash)
    : (DIRECT_CREATORS[fallbackProvider] ?? fallbackProvider ?? inferDirectCreator(id)))
    .replace(/^~/, '');
  const modelPart = slash > 0 ? id.slice(slash + 1) : id;
  const providerCreator = DIRECT_CREATORS[rawCreator] ?? rawCreator;
  const creatorKey = CREATOR_ALIASES[providerCreator] ?? providerCreator;
  const creatorName = CREATOR_NAMES[creatorKey] ?? titleCaseSlug(creatorKey);
  const catalogName = typeof model?.name === 'string' ? model.name.trim() : '';
  const cleanedCatalogName = catalogName.includes(':') ? catalogName.split(':').slice(1).join(':').trim() : catalogName;
  const name = cleanedCatalogName && cleanedCatalogName !== id ? cleanedCatalogName : titleCaseSlug(modelPart);
  return { id, creatorKey, creatorName, modelPart, name };
}

export function groupModels(models) {
  const groups = new Map();
  for (const model of models ?? []) {
    const view = presentModel(model, model.provider);
    if (!groups.has(view.creatorKey)) groups.set(view.creatorKey, { key: view.creatorKey, name: view.creatorName, models: [] });
    groups.get(view.creatorKey).models.push({ ...model, presentation: view });
  }
  return [...groups.values()]
    .map(group => ({ ...group, models: group.models.sort((a, b) => a.presentation.name.localeCompare(b.presentation.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function popularGroupKeys(popularity, availableGroups, limit = 8) {
  const totals = new Map();
  for (const creator of popularity?.creators ?? []) {
    let tokens;
    try { tokens = BigInt(creator.totalTokens); } catch { continue; }
    const key = presentModel({ id: `${creator.key}/_popularity` }).creatorKey;
    totals.set(key, (totals.get(key) ?? 0n) + tokens);
  }
  const available = new Set((availableGroups ?? []).map(group => group.key));
  return [...totals.entries()]
    .filter(([key]) => available.has(key))
    .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : (a[1] > b[1] ? -1 : 1))
    .slice(0, limit)
    .map(([key]) => key);
}
