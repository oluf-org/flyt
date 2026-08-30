// Turning six registries into one list of library entries (t-0076).
//
// The search itself (`librarySearch.js`) knows nothing about where an entry
// came from — it ranks and filters `{ kind, id, title, description, tags,
// action }` and stops there. This is the other side: one converter per kind,
// each reading only what that kind ALREADY PUBLISHES.
//
// That constraint is the whole design. A block publishes its title,
// description and category because the registry made those part of the
// definition; a tool publishes a description and a schema because it has to;
// a model publishes its context length and price because the catalog does. A
// second description written here for the library's benefit would be a
// description that goes stale the first time the real one changed, and nothing
// would notice — which is exactly what the four lists this replaces did.
//
// A kind with nothing in it produces no entries and is still a kind. The
// library says "no plugins installed" rather than rendering an empty shelf
// that looks like a loading state, and it can only do that if the absence is
// data rather than the absence of data.

/** The kinds a library entry can be. Closed, because a facet over free text narrows nothing. */
export const KINDS = ['stack', 'block', 'plugin', 'tool', 'skill', 'model'];

const clean = value => (typeof value === 'string' ? value.trim() : '');

/** One entry, normalised. `action` is what you would DO with it. */
function entry({ kind, id, title, description = '', tags = [], action, detail = null }) {
  return {
    kind,
    id: String(id),
    title: clean(title) || String(id),
    description: clean(description),
    tags: [...new Set(tags.map(clean).filter(Boolean))],
    action,
    detail,
  };
}

/** Blocks, from `ctx.blocks.list()`. */
export function fromBlocks(blocks) {
  const list = typeof blocks?.list === 'function' ? blocks.list() : [];
  return list.map(b => entry({
    kind: 'block',
    id: b.use,
    title: b.title,
    description: b.description,
    // The category is a facet in its own right and a tag here, so one search
    // finds "every judgement block" without the caller knowing categories exist.
    tags: [b.category, ...(b.ceiling ?? [])],
    action: 'insert',
    detail: { category: b.category, settings: b.settings, ceiling: b.ceiling ?? null },
  }));
}

/** Tools, from the tool library. A tool's schema is its description of itself. */
export function fromTools(tools = []) {
  return tools.map(t => entry({
    kind: 'tool',
    id: t.id ?? t.name,
    title: t.title || t.id || t.name,
    description: t.description,
    tags: [...(t.effects ?? []), t.risk, t.scope].filter(Boolean),
    action: 'inspect',
    // Unclassified is worth surfacing here rather than only at the gate: a
    // tool in no toolset cannot be reached by any ceiling (D57), and a library
    // that shows it as ordinary invites somebody to plan around it.
    detail: {
      effects: t.effects ?? [], risk: t.risk ?? null, parameters: t.parameters ?? null,
      unclassified: !t.effects?.length,
    },
  }));
}

/** Stacks, from the stack store's listing. */
export function fromStacks(stacks = []) {
  return stacks.map(s => entry({
    kind: 'stack',
    id: s.id,
    title: s.name || s.id,
    description: s.description,
    tags: s.tags ?? [],
    action: 'open',
    detail: { blocks: s.blockCount ?? null },
  }));
}

/** Plugins, from what the loader composed. */
export function fromPlugins(plugins = []) {
  return plugins.map(p => entry({
    kind: 'plugin',
    id: p.id ?? p.name,
    title: p.name ?? p.id,
    description: p.description,
    // The specifier is searchable because it is what a person has in hand when
    // they are looking for a package they installed rather than a plugin they
    // named. The state is a tag for the same reason: "failed" is a thing to
    // search for on the morning something stopped working.
    tags: [p.source, p.specifier, p.state, ...(p.contributes ?? [])].filter(Boolean),
    // One verb for every installed plugin, and it opens the manager. The verb a
    // row can offer depends on state the row does not carry — built-in, group,
    // failed — so a catalog that guessed would be a catalog whose buttons are
    // refused on press.
    action: p.installed === false ? 'install' : 'manage',
    detail: {
      contributes: p.contributes ?? [],
      installed: p.installed !== false,
      state: p.state ?? 'active',
      builtin: Boolean(p.builtin),
    },
  }));
}

/** Skills, from `.flyt/skills/`. */
export function fromSkills(skills = []) {
  return skills.map(s => entry({
    kind: 'skill',
    id: s.name ?? s.id,
    title: s.title || s.name || s.id,
    description: s.description,
    tags: s.tags ?? [],
    action: 'attach',
    // A skill may REQUEST tools (D58), and the request is part of what it is.
    // Showing it in the library is the point of the amendment: the moment a
    // grant happens should be loud, and it starts here.
    detail: { requiresTools: s.requiresTools ?? [] },
  }));
}

/** Models, from the catalog the app already keeps. */
export function fromModels(models = [], facts = {}) {
  return models.map(m => {
    const id = typeof m === 'string' ? m : (m.id ?? '');
    const fact = facts[id] ?? {};
    return entry({
      kind: 'model',
      id,
      title: fact.name || id,
      description: [
        fact.contextLength ? `${Math.round(fact.contextLength / 1000)}k context` : '',
        fact.supportsTools ? 'tools' : 'no tools',
        Number.isFinite(fact.inUsdPerM) ? `$${fact.inUsdPerM}/$${fact.outUsdPerM} per M` : '',
      ].filter(Boolean).join(' · '),
      tags: [
        typeof m === 'object' ? m.source : null,
        fact.supportsTools ? 'tools' : null,
        fact.inUsdPerM === 0 ? 'free' : null,
      ].filter(Boolean),
      action: 'pin',
      detail: fact,
    });
  });
}

/**
 * Every kind, in one list.
 *
 * Each source is optional and an absent one contributes nothing — a project
 * with no stacks yet is not a broken library, and the caller should not have to
 * assemble empty arrays to say so.
 *
 * @param sources — `{ blocks, tools, stacks, plugins, skills, models, modelFacts }`.
 * @returns entries for `librarySearch`, and the kinds that produced none.
 */
export function libraryEntries(sources = {}) {
  const entries = [
    ...fromStacks(sources.stacks ?? []),
    ...fromBlocks(sources.blocks),
    ...fromPlugins(sources.plugins ?? []),
    ...fromTools(sources.tools ?? []),
    ...fromSkills(sources.skills ?? []),
    ...fromModels(sources.models ?? [], sources.modelFacts ?? {}),
  ];
  const present = new Set(entries.map(e => e.kind));
  return {
    entries,
    // Named rather than inferred from a count of zero, because "nothing
    // installed" and "nothing matched your search" are different sentences and
    // only the first one is about the project.
    empty: KINDS.filter(k => !present.has(k)),
  };
}
