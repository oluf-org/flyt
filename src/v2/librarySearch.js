// One search over every kind (t-0078).
//
// Pure, and it does not know where an entry came from. `libraryEntries.js`
// converts each registry; this ranks and filters. That split is what lets a
// seventh kind be added without touching the search, and what lets this be
// tested with six lines of fixture instead of six registries.

import { KINDS } from './libraryEntries.js';

/** Where a query matched, best first. The ranking is these three, in order. */
export const FIELDS = ['title', 'tags', 'description'];

const norm = value => String(value ?? '').toLowerCase();

/**
 * Where, if anywhere, this entry matched.
 *
 * @returns the field name, or null. Title beats tags beats description, and
 *   nothing clever beyond that: a search whose order a person cannot predict
 *   is a search they stop trusting.
 */
export function matchField(entry, query) {
  const q = norm(query).trim();
  if (!q) return 'title'; // an empty query matches everything, equally
  if (norm(entry.title).includes(q) || norm(entry.id).includes(q)) return 'title';
  if ((entry.tags ?? []).some(t => norm(t).includes(q))) return 'tags';
  if (norm(entry.description).includes(q)) return 'description';
  return null;
}

/**
 * Facet counts over a result set.
 *
 * Every kind is counted, including the ones with nothing in them. A facet that
 * disappears when it is empty cannot answer "are there any plugins matching
 * this", which is the question somebody is asking when they click it.
 */
export function facetsOf(matches) {
  const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const m of matches) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  return counts;
}

/**
 * Search the library.
 *
 * @param entries — from `libraryEntries()`.
 * @param query — free text. Empty returns everything, so the library browses.
 * @param options.kinds — facets to narrow by. Empty or absent means all of
 *   them; a facet NARROWS the same result set rather than searching again,
 *   which is why the counts come from the unnarrowed matches.
 * @param options.limit — keep the first N after ranking.
 * @returns `{ matches, facets, total }`.
 */
export function librarySearch(entries = [], query = '', { kinds = [], limit = null } = {}) {
  const unknown = entries.filter(e => !KINDS.includes(e?.kind));
  if (unknown.length) {
    // A seventh kind appearing silently is how a faceted list stops being
    // faceted: it would be searchable, invisible to every facet, and nobody
    // would notice until somebody asked why the counts did not add up.
    throw new Error(`Not a library kind: ${[...new Set(unknown.map(e => e?.kind))].join(', ')}.`
      + ` There is: ${KINDS.join(', ')}.`);
  }

  const scored = [];
  for (const entry of entries) {
    const field = matchField(entry, query);
    if (!field) continue;
    scored.push({ ...entry, matched: field, rank: FIELDS.indexOf(field) });
  }
  // Ties break alphabetically so the order is stable between renders. A list
  // that reshuffles when nothing changed reads as a bug even when it is not.
  scored.sort((a, b) => a.rank - b.rank
    || a.kind.localeCompare(b.kind)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id));

  // Counted BEFORE the facet narrows, because a facet count of zero is an
  // answer and a facet count computed after its own filter is always its own
  // total.
  const facets = facetsOf(scored);
  const wanted = new Set(kinds.filter(Boolean));
  const narrowed = wanted.size ? scored.filter(e => wanted.has(e.kind)) : scored;

  return {
    matches: Number.isFinite(limit) ? narrowed.slice(0, limit) : narrowed,
    facets,
    total: narrowed.length,
  };
}
