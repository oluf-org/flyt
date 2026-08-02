// Tool categories: the columns of the Tool Library board (TOOLS-PLAN §15).
// Stored as tools/categories/<id>.json, mirroring tools/sets/ — a subdirectory
// so ToolStore.listFull()'s `*.json` sweep of tools/ never mistakes one for a
// tool.
//
// A category is PRESENTATION, deliberately: it carries no grant semantics, no
// hue, no effect on resolution. `effects`, `risk` and `trust` decide what a
// tool may do; a category only decides which column it sits in. That
// separation is why dragging a card between columns is a safe, undoable
// gesture rather than a privilege change — see §12, which the board must not
// quietly acquire a second vocabulary for.
export const CATEGORY_ID = /^[a-z][a-z0-9-]*$/;

// The columns every install starts with. Six, because a board you can scan
// without scrolling beats a taxonomy that is technically complete. They cover
// the v1 catalog (§10.4/P4) exactly, so a fresh library has no orphans.
export const SEED_CATEGORIES = [
  { id: 'files', name: 'Files', icon: '⌸', order: 0,
    description: 'Reading, searching and editing files in the bound workspace.' },
  { id: 'shell', name: 'Shell', icon: '⌘', order: 1,
    description: 'Running commands. Path confinement does not apply here.' },
  { id: 'web', name: 'Web', icon: '◍', order: 2,
    description: 'Reaching the network — fetching pages, searching.' },
  { id: 'run', name: 'Run', icon: '❖', order: 3,
    description: "Tools confined to the run's own directory: tasks, notes, earlier results." },
  { id: 'utility', name: 'Utility', icon: '✦', order: 4,
    description: 'Small, safe, stateless helpers.' },
  { id: 'human', name: 'Human', icon: '☖', order: 5,
    description: 'Tools that park the run at the awaiting-input gate and ask.' }
];

export const UNCATEGORIZED = {
  id: 'uncategorized', name: 'Uncategorized', icon: '·', order: 999,
  description: 'Tools that have not been filed yet.'
};

// Two placements the record genuinely cannot express, named rather than
// guessed at. `ask_human` and `get_time` are both `read`-effect and `run`-scope
// — identical on every field the app stores — yet one parks the run at a gate
// to ask a person and the other reads the clock. There is no field that
// separates them because there has never been a reason for one, and inventing
// `purpose: '…'` to satisfy a board would be the tail wagging the dog.
//
// A name hint is honest about being a hint: it applies to shipped built-ins
// only, it decides nothing but which column a card starts in, and one drag
// overrides it permanently (the drag writes `categoryId`, which wins).
const PLACEMENT_HINTS = { ask_human: 'human', get_time: 'utility' };

// Where a tool lands before anyone has filed it. Derived from the record the
// app already trusts — effects and scope — rather than stored, so a fresh
// library is sorted on first paint and NO tool file has to be rewritten to get
// there. `categoryId: null` means "derived"; dragging a card is what makes the
// placement explicit and writes it down.
export function defaultCategoryFor(tool = {}) {
  if (PLACEMENT_HINTS[tool.id]) return PLACEMENT_HINTS[tool.id];
  const effects = tool.effects ?? [];
  // Effects first, because they describe reach and reach is what a reader is
  // scanning the board for. Shell before network: a command that curls is a
  // shell problem, not a web one.
  if (effects.includes('shell')) return 'shell';
  if (effects.includes('network')) return 'web';
  // Then scope: anything that cannot leave runs/<id>/ is run bookkeeping.
  if ((tool.scope ?? 'workspace') === 'run') return 'run';
  // Everything left reaches the workspace to read or change it — which is
  // every file tool there is, whether it addresses a path (read_file) or a
  // pattern (glob, grep).
  if (effects.some(e => e === 'read' || e === 'write' || e === 'destructive')) return 'files';
  return 'utility';
}

// The column a tool actually renders in: its own answer when it has one and
// that column still exists, the derived answer otherwise. Callers pass the set
// of live ids so a category deleted out from under a tool degrades to the
// derived placement instead of stranding the card off-board.
export function categoryOf(tool, liveIds) {
  const explicit = tool?.categoryId;
  if (explicit && (!liveIds || liveIds.has(explicit))) return explicit;
  const derived = defaultCategoryFor(tool);
  if (!liveIds || liveIds.has(derived)) return derived;
  return UNCATEGORIZED.id;
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

// Fill defaults and clamp; throws only on an unusable id, for the reason
// normalizeTool does — without an id there is nothing to show a reason against.
export function normalizeCategory(def = {}) {
  const id = str(def.id).trim();
  if (!CATEGORY_ID.test(id)) {
    throw new Error(`Invalid category id ${JSON.stringify(def.id ?? null)} — lowercase letters, digits and hyphens, starting with a letter.`);
  }
  return {
    id,
    name: str(def.name).trim() || id,
    // One glyph. The board conveys category by icon + label + position, never
    // by colour (§15: no per-category hues), so the icon carries real weight
    // and a four-character "icon" would break the 26px chip.
    icon: str(def.icon).trim().slice(0, 2) || '·',
    description: str(def.description).trim(),
    order: Number.isFinite(def.order) ? Math.trunc(def.order) : 0
  };
}

// Stable board order: by `order`, then by name, so two categories that share
// an order (an interrupted reorder, a hand-edited file) still render
// deterministically instead of shuffling between paints.
export const sortCategories = list =>
  [...list].sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
