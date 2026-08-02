// web_search: search the web through a configured provider (TOOLS-PLAN §14.3).
//
// The key comes from settings, never from the model, and never from the tool
// definition (§10.3: refs only). With no key configured the tool is DISABLED
// WITH A VISIBLE REASON rather than failing mid-run — a capability that
// silently isn't there is the failure mode this plan keeps designing against.
//
// One provider shape today (Brave's Search API, chosen because it is a plain
// GET with a header key and no SDK — D24). Adding another is a case in
// `endpointFor`, not a new tool.
import { guardedFetch } from './net.js';

const MAX_RESULTS = 10;

export default {
  name: 'web_search',
  title: 'Search the web',
  description: 'Search the web and return ranked results (title, URL, snippet). Use it to find pages worth fetching; use http_fetch to read one. Needs a search provider key in Settings.',
  effects: ['network'],
  risk: 'safe',
  autoExecute: true,
  keywords: ['search', 'web', 'google', 'find', 'lookup', 'research', 'internet'],
  examples: ['search for the current React 19 migration guide', 'find the docs for this error message'],
  result: { preview: 'json', maxPreviewChars: 3000, artifact: true },
  parameters: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'What to search for, in plain words.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `How many results (default 5, max ${MAX_RESULTS}).` }
    }
  },
  async run(args, ctx) {
    const search = ctx?.search ?? null;
    if (!search?.apiKey) {
      throw new Error('No web-search provider is configured. Add a search key in Settings, or use http_fetch against a URL you already know.');
    }
    const limit = Math.min(args.limit ?? 5, MAX_RESULTS);
    const { url, headers } = endpointFor(search, args.query, limit);
    const res = await guardedFetch(url, { headers, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
    if (!res.ok) throw new Error(`Search provider returned ${res.status}.`);
    let payload;
    try { payload = JSON.parse(res.body); }
    catch { throw new Error('Search provider returned a response that was not JSON.'); }
    return { query: args.query, provider: search.provider ?? 'brave', results: normalizeResults(payload).slice(0, limit) };
  }
};

function endpointFor(search, query, limit) {
  const provider = search.provider ?? 'brave';
  if (provider === 'brave') {
    return {
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
      headers: { accept: 'application/json', 'x-subscription-token': search.apiKey }
    };
  }
  throw new Error(`Unknown search provider "${provider}".`);
}

// Providers disagree about envelopes; the shape the model sees does not.
function normalizeResults(payload) {
  const items = payload?.web?.results ?? payload?.results ?? [];
  return items.map(r => ({
    title: r.title ?? r.name ?? '',
    url: r.url ?? r.link ?? '',
    snippet: String(r.description ?? r.snippet ?? '').replace(/<[^>]+>/g, '').trim()
  })).filter(r => r.url);
}
