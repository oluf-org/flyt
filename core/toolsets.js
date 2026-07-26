// Toolsets: named, reusable bundles of tools (TOOLS-PLAN §4.2), stored as
// tools/sets/<id>.json beside the library itself.
//
// A ceiling wants to say "the repo, read-only" once, not list six tool ids and
// then go stale the moment a seventh lands. A set is that name; a SELECTOR
// (`effects:read`) is the same idea computed from the record, which is why the
// seeded sets below lean on selectors rather than enumerating ids.
export const SET_ID = /^[a-z][a-z0-9-]*$/;

// The sets every install starts with. Deliberately few: a vocabulary you can
// hold in your head beats a taxonomy you have to look up.
export const SEED_TOOLSETS = [
  {
    id: 'none',
    title: 'No tools',
    description: 'Nothing. A node with this ceiling can only think and write its own output.',
    include: []
  },
  {
    id: 'read-only',
    title: 'Read-only',
    description: 'Everything that observes and changes nothing — reading files, re-reading an earlier tool result.',
    include: ['effects:read']
  },
  {
    id: 'repo-write',
    title: 'Repo (read + write)',
    description: 'Read, and modify files in the bound workspace. No shell.',
    include: ['read-only', 'effects:write'],
    exclude: ['bash']
  },
  {
    id: 'repo-full',
    title: 'Repo (read + write + shell)',
    description: 'Everything repo-write allows, plus running commands. The shell is not path-confined — expect the approval gate.',
    includeSets: ['repo-write'],
    include: ['bash']
  },
  {
    id: 'web',
    title: 'Web',
    description: 'Reaching the network: fetching pages and searching. Empty until the v1 catalog lands (P4).',
    // `uses:` not `effects:` — this set is "anything that CAN reach the
    // network", not "anything whose effects stay within {network}", which
    // would sweep in every read-only tool.
    include: ['uses:network']
  }
];

// Fill defaults and drop anything malformed; throws only on an unusable id,
// for the same reason normalizeTool does — without an id there is nothing to
// show a reason against.
export function normalizeToolset(def = {}) {
  const id = String(def.id ?? '').trim();
  if (!SET_ID.test(id)) {
    throw new Error(`Invalid toolset id ${JSON.stringify(def.id ?? null)} — lowercase letters, digits and hyphens, starting with a letter.`);
  }
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
  return {
    id,
    title: String(def.title ?? '').trim() || id,
    description: String(def.description ?? '').trim(),
    include: list(def.include),
    includeSets: list(def.includeSets),
    exclude: list(def.exclude),
    ...(def.source ? { source: def.source } : { source: { kind: 'builtin' } })
  };
}
