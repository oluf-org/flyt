// Grants: what a node may reach, and what it actually got (DESIGN-SPEC.md §5).
//
// Two tiers, and the whole safety model rests on the difference:
//
//   CEILING — authored, static, human-reasoned. "This node's children may read
//             the repo and hit the network, but may never run a shell command."
//             One line, legible on the canvas, and nothing below it can widen it.
//   GRANT   — what the node is handed. May be static (today's `tools: [...]`)
//             or decided at run time by the clerk (P7). ALWAYS intersected with
//             the ceiling before binding.
//
// The invariant, restated: no mechanism may grant a tool the authoring surface
// did not already permit. Skills obey it (DESIGN-SPEC.md §5); the clerk must too;
// so must an orchestrator handing tools to nodes it invented.
//
// Migration promise: absent a ceiling, THE CEILING IS THE STATIC GRANT. Every
// flow authored before ceilings existed keeps its exact envelope, and dynamic
// granting is strictly opt-in.
import { TOOL_EFFECTS, RISK_LEVELS, TRUST_TIERS, TOOL_PROVIDERS } from './toolTypes.js';

// A grant/ceiling entry is a tool id, a toolset id, or a selector.
export const SELECTOR = /^(effects|uses|provider|server|trust|risk):(.+)$/;
export const WILDCARD = '*';

const asList = v => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)]);

// --- selectors ---------------------------------------------------------------
// `effects:read` is a SUBSET test, not a membership test: it means "tools whose
// effects lie within {read}", so a ceiling of `effects:read` can never admit a
// tool that also writes. Several effects combine with `+`: `effects:read+network`.
function bySelector(kind, value, library) {
  const want = value.split('+').map(s => s.trim()).filter(Boolean);
  switch (kind) {
    case 'effects': {
      if (want.some(e => !TOOL_EFFECTS.includes(e))) return null;
      const allowed = new Set(want);
      return library.filter(t => (t.effects ?? []).every(e => allowed.has(e)));
    }
    // The membership twin of `effects:`. A CEILING wants the subset test ("may
    // reach nothing beyond these effects"); a GRANT usually wants membership
    // ("anything that can touch the network"). Both exist because using the
    // wrong one is silently too permissive or silently too narrow.
    case 'uses': {
      if (want.some(e => !TOOL_EFFECTS.includes(e))) return null;
      return library.filter(t => want.some(e => (t.effects ?? []).includes(e)));
    }
    case 'provider':
      if (want.some(p => !TOOL_PROVIDERS.includes(p))) return null;
      return library.filter(t => want.includes(t.provider));
    case 'server':
      return library.filter(t => want.includes(t.source?.server));
    case 'trust':
      if (want.some(t => !TRUST_TIERS.includes(t))) return null;
      return library.filter(t => want.includes(t.trust));
    case 'risk':
      if (want.some(r => !RISK_LEVELS.includes(r))) return null;
      return library.filter(t => want.includes(t.risk));
    default:
      return null;
  }
}

// --- toolsets ----------------------------------------------------------------
// include + includeSets (recursively) minus exclude. A cycle resolves to what it
// had reached rather than hanging, and is reported — a bad set must degrade the
// grant, never wedge the run.
function expandSet(set, ctx, seen, problems) {
  if (seen.has(set.id)) {
    problems.push({ kind: 'cycle', ref: set.id });
    return new Set();
  }
  seen.add(set.id);
  const ids = new Set();
  for (const ref of set.includeSets ?? []) {
    const sub = ctx.setsById.get(ref);
    if (!sub) { problems.push({ kind: 'unknown-set', ref }); continue; }
    for (const id of expandSet(sub, ctx, seen, problems)) ids.add(id);
  }
  for (const ref of set.include ?? []) {
    for (const id of expandRef(ref, ctx, seen, problems)) ids.add(id);
  }
  for (const ref of set.exclude ?? []) {
    for (const id of expandRef(ref, ctx, seen, problems)) ids.delete(id);
  }
  return ids;
}

// One reference → the tool ids it names. Sets are resolved before tool ids:
// a ceiling almost always names a set, and the seeded set ids (`read-only`,
// `repo-write`) cannot collide with a tool id anyway — tool ids never contain
// a hyphen.
export function expandRef(ref, ctx, seen = new Set(), problems = []) {
  const name = String(ref ?? '').trim();
  if (!name) return new Set();
  if (name === WILDCARD) return new Set(ctx.library.map(t => t.id));

  const m = name.match(SELECTOR);
  if (m) {
    const hits = bySelector(m[1], m[2], ctx.library);
    if (!hits) { problems.push({ kind: 'unknown-selector', ref: name }); return new Set(); }
    return new Set(hits.map(t => t.id));
  }
  const set = ctx.setsById.get(name);
  if (set) return expandSet(set, ctx, new Set(seen), problems);
  if (ctx.byId.has(name)) return new Set([name]);

  problems.push({ kind: 'unknown-tool', ref: name });
  return new Set();
}

export function makeContext({ library = [], sets = [] } = {}) {
  return {
    library,
    byId: new Map(library.map(t => [t.id, t])),
    setsById: new Map(sets.map(s => [s.id, s]))
  };
}

// Expand a ceiling/grant expression (a string, a list, or null).
// Returns { ids: Set | null, problems }. `null` ids means "unbounded" — which
// only ever happens for an ABSENT ceiling, and is then replaced by the grant.
export function expandRefs(refs, ctx) {
  const list = asList(refs);
  const problems = [];
  if (list == null) return { ids: null, problems };
  const ids = new Set();
  for (const ref of list) for (const id of expandRef(ref, ctx, new Set(), problems)) ids.add(id);
  return { ids, problems };
}

// --- the resolution itself ---------------------------------------------------
//
// Returns what to bind and, for everything that did not survive, WHY:
//   tools    — ids to bind, in the order the grant asked for them
//   refused  — the grant reached outside the ceiling. Not merely absent: a
//              refusal means something tried to exceed its envelope, and that
//              must be visible (§5.3), so callers surface it as a problem.
//   missing  — named but absent or disabled. Degrades the node, never fatal.
//   ceiling  — the resolved ceiling ids, for logging what refused what.
export function resolveGrant({ grant = null, ceiling = null, library = [], sets = [], ctx = null } = {}) {
  const c = ctx ?? makeContext({ library, sets });
  const grantList = asList(grant);
  const problems = [];

  const ceilingExp = expandRefs(ceiling, c);
  problems.push(...ceilingExp.problems);

  // No ceiling ⇒ the ceiling IS the static grant (and a node with neither is
  // bounded only by the library, exactly as before ceilings existed).
  let ceilingIds = ceilingExp.ids;
  if (ceilingIds == null) {
    ceilingIds = grantList == null ? null : expandRefs(grantList, c).ids;
  }

  // An absent grant means "everything the ceiling allows".
  const requested = grantList == null
    ? [...(ceilingIds ?? c.library.map(t => t.id))]
    : grantList;

  const tools = [];
  const refused = [];
  const missing = [];
  const seen = new Set();

  for (const ref of requested) {
    const expanded = expandRef(ref, c, new Set(), problems);
    if (!expanded.size && !c.byId.has(ref)) {
      // expandRef already recorded unknown-tool/unknown-selector; a set that
      // legitimately resolves to nothing is not a problem.
      if (!c.setsById.has(ref) && !SELECTOR.test(ref) && ref !== WILDCARD) {
        missing.push({ tool: ref, reason: 'unknown' });
      }
      continue;
    }
    for (const id of expanded) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (ceilingIds && !ceilingIds.has(id)) { refused.push({ tool: id, reason: 'ceiling' }); continue; }
      const tool = c.byId.get(id);
      if (!tool) { missing.push({ tool: id, reason: 'unknown' }); continue; }
      if (tool.enabled === false) { missing.push({ tool: id, reason: 'disabled' }); continue; }
      tools.push(id);
    }
  }

  return { tools, refused, missing, ceiling: ceilingIds ? [...ceilingIds] : null, problems };
}

// An orchestrator's children inherit ITS ceiling, narrowed further by their own.
// A child can never widen its parent's envelope — the hole that would otherwise
// open the moment planning became tool-aware is a node that decides what other
// nodes may do deciding they may do more than it may (§6.3).
//
// Returns a ceiling expression: a resolved id list, or null when neither side
// declares one.
export function narrowCeiling(parentCeiling, childCeiling, ctx) {
  const parent = expandRefs(parentCeiling, ctx).ids;
  const child = expandRefs(childCeiling, ctx).ids;
  if (parent == null) return childCeiling ?? null;
  // Inheriting verbatim keeps the canvas legible: a child that declared
  // nothing shows "repo-write", not the six ids that happens to mean today.
  if (child == null) return parentCeiling;
  return [...child].filter(id => parent.has(id));
}

// Does `grant` fit inside `ceiling`? The lint rule's question, answered once so
// the linter and the runtime cannot disagree about it.
export function grantExceedsCeiling({ grant, ceiling, ctx }) {
  if (grant == null || ceiling == null) return [];
  return resolveGrant({ grant, ceiling, ctx }).refused.map(r => r.tool);
}
