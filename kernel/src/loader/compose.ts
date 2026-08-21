/**
 * Four layers, one plugin tree.
 *
 * Composition follows dsh's layering exactly — **bundles, then the profile
 * patch, then the home patch, then the CLI overlay** — and a later layer
 * replaces a row by id. That is what makes a Loop worker a genuinely narrower
 * tree rather than the same tree with flags off: the worker's profile removes
 * rows, and nothing downstream has to remember to check a flag.
 *
 * Every row remembers which layer last touched it, because "why is this plugin
 * here" is the question a composition file cannot answer on its own.
 *
 * @module #kernel/loader/compose
 */
import type { YamlValue } from './yaml.js';

/** One row of the plugin tree. */
export interface Entry {
  /** Stable across layers: this is what a patch replaces. */
  id: string;
  /** The module specifier to import, or `cordis:group` for a nested list. */
  name: string;
  /** Plugin config, or — for a group — the child rows. */
  config?: YamlValue | Entry[];
  /** True when this row's config is a child entry list. */
  group?: boolean;
  /** Service names this row isolates for its children. */
  isolate?: Record<string, boolean>;
  /** Services the row requires; it stays unloaded while one is missing. */
  inject?: string[];
  /** A later layer can switch a row off without deleting the reason it existed. */
  disabled?: boolean;
}

/** A layer, named so the explanation can say where a row came from. */
export interface Layer {
  /** `bundle:@flyt/blocks-core`, `profile:flyt-loop-worker`, `home`, `cli`. */
  source: string;
  entries: Entry[];
}

/** One row of the resolved tree, with its provenance. */
export interface ResolvedEntry extends Entry {
  /** The layer that introduced this row. */
  from: string;
  /** Every layer that touched it, in order. */
  touchedBy: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge one row's config over another's.
 *
 * Objects merge key by key so a patch can change one setting without restating
 * the row. Arrays and scalars replace, because a patch that says `[a]` means
 * `[a]` — "append" and "replace" cannot both be the default, and silently
 * appending is the one that produces a tree nobody wrote.
 */
function mergeConfig(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = mergeConfig(out[key], value);
  return out;
}

function mergeEntry(base: ResolvedEntry, patch: Entry, source: string): ResolvedEntry {
  const merged: ResolvedEntry = {
    ...base,
    ...patch,
    id: base.id,
    touchedBy: [...base.touchedBy, source],
  };
  if (base.group && patch.group !== false && Array.isArray(patch.config)) {
    // A group's children are themselves rows, patched by id.
    merged.config = compose([
      { source: base.from, entries: (base.config as Entry[]) ?? [] },
      { source, entries: patch.config as Entry[] },
    ], { keepDisabled: true });
  } else {
    merged.config = mergeConfig(base.config, patch.config) as YamlValue;
  }
  return merged;
}

/**
 * Resolve the layers into one tree.
 *
 * @param layers — bundles first, then the patches, then the overlay.
 * @param options — `keepDisabled` returns disabled rows too, for an explanation.
 * @returns the resolved rows, in the order they were first introduced.
 */
export function compose(layers: readonly Layer[], options: { keepDisabled?: boolean } = {}): ResolvedEntry[] {
  const byId = new Map<string, ResolvedEntry>();

  for (const layer of layers) {
    for (const entry of layer.entries ?? []) {
      if (!entry?.id) throw new Error(`${layer.source}: every entry needs an id`);
      if (!entry.name && !byId.has(entry.id)) {
        throw new Error(`${layer.source}: entry "${entry.id}" is new here, so it needs a name`);
      }
      const existing = byId.get(entry.id);
      byId.set(entry.id, existing
        ? mergeEntry(existing, entry, layer.source)
        : { ...entry, from: layer.source, touchedBy: [layer.source] });
    }
  }

  const rows = [...byId.values()];
  return options.keepDisabled ? rows : rows.filter(row => !row.disabled);
}

/**
 * Why the tree looks like this.
 *
 * One line per row, including the ones a later layer switched off — a row that
 * vanished is exactly the thing somebody is looking for when they ask why a
 * plugin did not load.
 *
 * @param layers — the same layers `compose` was given.
 * @returns human-readable lines, in tree order.
 */
export function explain(layers: readonly Layer[]): string[] {
  return compose(layers, { keepDisabled: true }).map(row => {
    const trail = row.touchedBy.join(' -> ');
    return `${row.disabled ? '- ' : '  '}${row.id} (${row.name}) from ${trail}`;
  });
}
