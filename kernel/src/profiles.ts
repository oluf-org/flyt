/**
 * One profile per surface.
 *
 * A profile is the layer that says which rows this surface composes. It is why
 * a Loop worker can be a genuinely narrower tree instead of the same tree with
 * flags off: the worker's profile does not contain the rows a worker has no
 * business running, so nothing downstream has to remember to check.
 *
 * These lists grow one phase at a time — Phase 0 has a session log, a tool
 * registry and a gate, and that is all there is to compose. The invariant that
 * has to hold at every size is the one {@link assertNarrower} checks: a
 * narrower surface never gains a row a broader one lacks.
 *
 * @module #kernel/profiles
 */
import type { Entry } from './loader/compose.js';
import type { ProfileName } from './index.js';

/**
 * Specifiers for the plugins Flyt bundles.
 *
 * Logical names, resolved by {@link builtinImporter}, in the same shape as
 * `cordis:group`. A profile that named a file path would break the moment the
 * kernel is packaged.
 */
export const BUILTIN = {
  sessionJsonl: 'flyt:session-jsonl',
  tools: 'flyt:tools',
  approvals: 'flyt:approvals',
  skills: 'flyt:skills',
  commands: 'flyt:api',
} as const;

const BUILTIN_NAMES = new Set<string>(Object.values(BUILTIN));

/** Trust is an exact shipped identity, never a forgeable package-name prefix. */
export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/** Resolve `flyt:*` specifiers to the bundled plugin modules. */
export async function builtinImporter(name: string): Promise<unknown> {
  switch (name) {
    case BUILTIN.sessionJsonl: return import('./plugins/session-jsonl.js');
    case BUILTIN.tools: return import('./plugins/tools.js');
    case BUILTIN.approvals: return import('./plugins/approvals.js');
    case BUILTIN.skills: return import('./plugins/skills.js');
    case BUILTIN.commands: return import('./plugins/commands.js');
    default: return import(name);
  }
}

/**
 * The desktop: a person is present, so `ask` can reach one.
 */
const DESKTOP: Entry[] = [
  { id: 'sessions', name: BUILTIN.sessionJsonl },
  { id: 'tools', name: BUILTIN.tools },
  { id: 'skills', name: BUILTIN.skills },
  { id: 'commands', name: BUILTIN.commands },
  { id: 'approvals', name: BUILTIN.approvals, config: { mode: 'ask' } },
];

/**
 * The CLI: the same tree. A terminal can still ask, and `--approval` chooses
 * how much it asks.
 */
const CLI: Entry[] = [
  { id: 'sessions', name: BUILTIN.sessionJsonl },
  { id: 'tools', name: BUILTIN.tools },
  { id: 'skills', name: BUILTIN.skills },
  { id: 'commands', name: BUILTIN.commands },
  { id: 'approvals', name: BUILTIN.approvals, config: { mode: 'ask' } },
];

/**
 * The Loop worker: nobody is there.
 *
 * `always` is not "approve everything" — the ceiling still refuses everything
 * it refuses, and an unclassified tool is still unreachable. It means the gate
 * does not stop to ask a question nobody will answer.
 */
const LOOP_WORKER: Entry[] = [
  { id: 'sessions', name: BUILTIN.sessionJsonl },
  { id: 'tools', name: BUILTIN.tools },
  { id: 'skills', name: BUILTIN.skills },
  { id: 'commands', name: BUILTIN.commands },
  { id: 'approvals', name: BUILTIN.approvals, config: { mode: 'always' } },
];

/** The shipped profiles, by name. */
export const PROFILES: Record<ProfileName, Entry[]> = {
  'flyt-desktop': DESKTOP,
  'flyt-cli': CLI,
  'flyt-loop-worker': LOOP_WORKER,
};

/**
 * Check that one profile is no broader than another.
 *
 * The direction that matters: a Loop worker gaining a row the desktop does not
 * have is authority appearing where nobody is watching. Convenience may narrow
 * authority and must never widen it, and this is where that is enforced for
 * composition.
 *
 * @param broad — the profile that may have more.
 * @param narrow — the profile that must not.
 * @returns the ids `narrow` does not contain.
 * @throws when `narrow` contains a row `broad` does not.
 */
export function assertNarrower(broad: readonly Entry[], narrow: readonly Entry[]): string[] {
  const broadIds = new Set(broad.map(e => e.id));
  const extra = narrow.filter(e => !broadIds.has(e.id)).map(e => e.id);
  if (extra.length) {
    throw new Error(`the narrower profile contains rows the broader one does not: ${extra.join(', ')}`);
  }
  const narrowIds = new Set(narrow.map(e => e.id));
  return broad.filter(e => !narrowIds.has(e.id)).map(e => e.id);
}
