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
  const rawCreator = slash > 0
    ? id.slice(0, slash)
    : (DIRECT_CREATORS[fallbackProvider] ?? fallbackProvider ?? inferDirectCreator(id));
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
