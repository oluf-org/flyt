// The Tool Library board's view model — grouping, filtering and the three
// quiet facts each card shows. Pure functions over tool summaries, kept out of
// the component for the reason src/runList.js and src/compareRun.js are: the
// interesting logic here is "which column, which status, does the filter keep
// it", and none of that should need a DOM to test.
import { isDestructive, effectiveRisk } from './toolTypes.js';
import { categoryOf, sortCategories, UNCATEGORIZED } from '../core/toolCategories.js';

// The card's status. Derived from the record the app already trusts — there is
// no separate `status` field, and there should not be one: a second source of
// truth for "is this tool OK" is a second thing to get out of sync with the
// gate that actually runs.
//
// Deliberately four states and three tones (§15: status is quiet). `ready` is
// --ok, anything asking for attention is --warn, anything switched off is
// --faint. No new hues, no filled badges.
export const TOOL_STATUS = {
  disabled: { id: 'disabled', label: 'disabled', tone: 'faint' },
  review:   { id: 'review',   label: 'needs review', tone: 'warn' },
  gated:    { id: 'gated',    label: 'needs approval', tone: 'warn' },
  ready:    { id: 'ready',    label: 'ready', tone: 'ok' }
};

export function statusOf(tool) {
  if (!tool?.enabled) return TOOL_STATUS.disabled;
  // An imported tool nobody has looked at outranks its own risk claim, because
  // the claim is exactly what has not been reviewed (§12.2).
  if (tool.trust === 'untrusted') return TOOL_STATUS.review;
  if (isDestructive(tool) || effectiveRisk(tool) === 'danger') return TOOL_STATUS.gated;
  return TOOL_STATUS.ready;
}

// The auth chip. Not a stored field — what a tool needs to authenticate is
// visible in how it is defined, and deriving it means a definition and its
// card can never disagree.
export function authOf(tool) {
  if (tool?.provider === 'builtin') return 'local';
  if (tool?.provider === 'mcp') return tool?.source?.server ? `server · ${tool.source.server}` : 'server';
  const blob = JSON.stringify(tool?.http ?? tool ?? {});
  const ref = blob.match(/\$\{secrets\.([A-Za-z0-9_]+)\}/);
  if (ref) return `secret · ${ref[1]}`;
  return 'none';
}

// What the model is actually handed, in the order a reader wants it: required
// first, then alphabetical. Shown as the card's mono parameter line and as the
// wizard's table.
export function parametersOf(tool) {
  const schema = tool?.parameters ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties ?? {})
    .map(([name, spec]) => ({
      name,
      type: Array.isArray(spec?.type) ? spec.type.join('|') : (spec?.type ?? 'any'),
      description: typeof spec?.description === 'string' ? spec.description : '',
      required: required.has(name),
      ...(spec?.default !== undefined ? { default: spec.default } : {}),
      ...(spec?.const !== undefined ? { const: spec.const } : {})
    }))
    .sort((a, b) => (Number(b.required) - Number(a.required)) || a.name.localeCompare(b.name));
}

// Rebuild a JSON Schema from the wizard's editable rows. The inverse of
// parametersOf, so a round trip through the wizard is lossless for everything
// the wizard can express.
export function schemaFromRows(rows = []) {
  const properties = {};
  const required = [];
  for (const row of rows) {
    const name = String(row?.name ?? '').trim();
    if (!name) continue;
    properties[name] = {
      type: row.type === 'enum' ? 'string' : (row.type || 'string'),
      ...(row.description ? { description: row.description } : {}),
      ...(row.default !== undefined && row.default !== '' ? { default: row.default } : {})
    };
    if (row.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

// The filter chips. `all` is not in the list because it is the absence of one.
// These are derived predicates over real fields — there is no usage telemetry
// in Flyt, so the mockup's "unused 30d" has no honest implementation and is
// not offered rather than faked.
export const BOARD_FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'gated', label: 'Needs approval', match: t => statusOf(t).id === 'gated' },
  { id: 'review', label: 'Needs review', match: t => statusOf(t).id === 'review' },
  { id: 'disabled', label: 'Disabled', match: t => !t.enabled }
];

export const filterFor = id => BOARD_FILTERS.find(f => f.id === id) ?? BOARD_FILTERS[0];

// Free-text search across everything a person might type: the id and title
// they remember, the description they half-remember, and the keywords the
// index (§7.1) searches on the agent's behalf. Same corpus as the clerk, so
// what you can find by hand is what an agent can find.
export function matchesQuery(tool, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = [tool.id, tool.title, tool.description, ...(tool.keywords ?? []), ...(tool.effects ?? [])]
    .join(' ').toLowerCase();
  return q.split(/\s+/).every(term => hay.includes(term));
}

// The board: every category in order, each with the tools that survived the
// filter. Empty columns are KEPT — a column that vanishes when you type is a
// column you can no longer drop onto, and the dashed slot is the affordance
// that says "this is where things go".
export function buildBoard({ tools = [], categories = [], query = '', filter = 'all' } = {}) {
  const cols = sortCategories(categories);
  const liveIds = new Set(cols.map(c => c.id));
  const predicate = filterFor(filter).match;
  const buckets = new Map(cols.map(c => [c.id, []]));
  const orphans = [];

  for (const tool of tools) {
    if (!predicate(tool) || !matchesQuery(tool, query)) continue;
    const id = categoryOf(tool, liveIds);
    if (buckets.has(id)) buckets.get(id).push(tool);
    else orphans.push(tool);
  }
  for (const list of buckets.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const columns = cols.map(c => ({ ...c, tools: buckets.get(c.id) ?? [] }));
  // The catch-all column only exists when something is actually in it.
  if (orphans.length) {
    columns.push({ ...UNCATEGORIZED, tools: orphans.sort((a, b) => a.id.localeCompare(b.id)) });
  }
  return columns;
}

// The header count chip. Counts the LIBRARY, not the filtered view — it is
// telling you how big your toolbox is, and a number that moves while you type
// answers a question nobody asked.
export const boardCounts = (tools = [], categories = []) =>
  `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} · ${categories.length} ${categories.length === 1 ? 'category' : 'categories'}`;

// Flat, id-sorted — the List and Grid views, which are the same data without
// the columns. Search and filters apply identically.
export function flatTools({ tools = [], query = '', filter = 'all' } = {}) {
  const predicate = filterFor(filter).match;
  return tools
    .filter(t => predicate(t) && matchesQuery(t, query))
    .sort((a, b) => a.id.localeCompare(b.id));
}
