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
  uiExtensions: 'flyt:ui-extensions',
  blocks: 'flyt:blocks',
  blocksCore: 'flyt:blocks-core',
  blocksDelivery: 'flyt:blocks-delivery',
  blocksTaskGraph: 'flyt:blocks-task-graph',
  blocksJudgement: 'flyt:blocks-judgement',
  blocksInquiry: 'flyt:blocks-inquiry',
  blocksLoop: 'flyt:blocks-loop',
  runProjection: 'flyt:run-projection',
  fs: 'flyt:fs',
  executionWorldLocal: 'flyt:execution-world-local',
  adapters: 'flyt:llm-adapters',
  stackRunner: 'flyt:stack-runner',
  workerProfiles: 'flyt:worker-profiles',
  interceptions: 'flyt:interceptions',
} as const;

export interface BuiltinMetadata {
  name: string;
  description: string;
  contributes: string[];
}

const BUILTIN_METADATA: Record<string, BuiltinMetadata> = {
  [BUILTIN.sessionJsonl]: { name: 'Session log', description: 'Append-only JSONL run sessions.', contributes: ['sessions'] },
  [BUILTIN.tools]: { name: 'Tool registry', description: 'Tool registration, classification, and execution policy boundary.', contributes: ['tools'] },
  [BUILTIN.approvals]: { name: 'Approval policy', description: 'Applies the active approval mode to tool execution.', contributes: ['policy'] },
  [BUILTIN.skills]: { name: 'Skill registry', description: 'Lifecycle-owned skill contributions.', contributes: ['skills'] },
  [BUILTIN.commands]: { name: 'Command registry', description: 'Typed commands shared by human and agent callers.', contributes: ['commands'] },
  [BUILTIN.uiExtensions]: { name: 'UI extensions', description: 'Validated, data-only UI extension declarations.', contributes: ['ui'] },
  [BUILTIN.blocks]: { name: 'Block registry', description: 'Canonical resolution for every stack block use.', contributes: ['blocks'] },
  [BUILTIN.blocksCore]: { name: 'Core blocks', description: 'Core work and transformation blocks.', contributes: ['blocks'] },
  [BUILTIN.blocksDelivery]: { name: 'Delivery workflows', description: 'Evidence-bound changes, diagnosis, reviews, research, planning and milestone delivery.', contributes: ['blocks'] },
  [BUILTIN.blocksTaskGraph]: { name: 'Plan & dispatch', description: 'Agent-planned task graphs with bounded dependency scheduling.', contributes: ['blocks'] },
  [BUILTIN.blocksJudgement]: { name: 'Judgement blocks', description: 'Evaluation, comparison, refinement, and checkpoint blocks.', contributes: ['blocks'] },
  [BUILTIN.blocksInquiry]: { name: 'Inquiry blocks', description: 'Question and inquiry blocks.', contributes: ['blocks'] },
  [BUILTIN.blocksLoop]: { name: 'Loop blocks', description: 'Loop handoff blocks.', contributes: ['blocks'] },
  [BUILTIN.runProjection]: { name: 'Run projection', description: 'Materialises durable session events into run artifacts.', contributes: ['runs'] },
  [BUILTIN.fs]: { name: 'Filesystem seam', description: 'Binds plugin file access to one workspace root.', contributes: ['filesystem'] },
  [BUILTIN.executionWorldLocal]: { name: 'Local execution world', description: 'Coherent policy-bound filesystem, sandbox, shell, and subprocess providers.', contributes: ['filesystem', 'shell', 'subprocess', 'sandbox'] },
  [BUILTIN.adapters]: { name: 'LLM adapters', description: 'Routes kernel model requests to configured providers.', contributes: ['models'] },
  [BUILTIN.stackRunner]: { name: 'Stack runner', description: 'Executes registered blocks from canonical stacks.', contributes: ['runner'] },
  [BUILTIN.workerProfiles]: { name: 'Worker profiles', description: 'Reusable generated-worker configuration and policy.', contributes: ['workers'] },
  [BUILTIN.interceptions]: { name: 'Interceptions', description: 'Ordered typed observation and trusted request mutation hooks.', contributes: ['hooks'] },
};

const BUILTIN_NAMES = new Set<string>(Object.values(BUILTIN));

/** Trust is an exact shipped identity, never a forgeable package-name prefix. */
export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

export function builtinMetadata(name: string): BuiltinMetadata | null {
  const found = BUILTIN_METADATA[name];
  return found ? { ...found, contributes: [...found.contributes] } : null;
}

/** Resolve `flyt:*` specifiers to the bundled plugin modules. */
export async function builtinImporter(name: string): Promise<unknown> {
  switch (name) {
    case BUILTIN.sessionJsonl: return import('./plugins/session-jsonl.js');
    case BUILTIN.tools: return import('./plugins/tools.js');
    case BUILTIN.approvals: return import('./plugins/approvals.js');
    case BUILTIN.skills: return import('./plugins/skills.js');
    case BUILTIN.commands: return import('./plugins/commands.js');
    case BUILTIN.uiExtensions: return import('./plugins/ui-extensions.js');
    case BUILTIN.blocks: return import('./plugins/blocks.js');
    case BUILTIN.blocksCore: return import('./plugins/blocks-core.js');
    case BUILTIN.blocksDelivery: return import('./plugins/blocks-delivery.js');
    case BUILTIN.blocksTaskGraph: return import('./plugins/blocks-task-graph.js');
    case BUILTIN.blocksJudgement: return import('./plugins/blocks-judgement.js');
    case BUILTIN.blocksInquiry: return import('./plugins/blocks-inquiry.js');
    case BUILTIN.blocksLoop: return import('./plugins/blocks-loop.js');
    case BUILTIN.runProjection: return import('./plugins/run-projection.js');
    case BUILTIN.fs: return import('./plugins/fs.js');
    case BUILTIN.executionWorldLocal: return import('./plugins/execution-world-local.js');
    case BUILTIN.adapters: return import('./plugins/llm-adapters.js');
    case BUILTIN.stackRunner: return import('./plugins/stack-runner.js');
    case BUILTIN.workerProfiles: return import('./plugins/worker-profiles.js');
    case BUILTIN.interceptions: return import('./plugins/interceptions.js');
    default: return import(name);
  }
}

const BLOCKS: Entry[] = [
  { id: 'worker-profiles', name: BUILTIN.workerProfiles },
  { id: 'interceptions', name: BUILTIN.interceptions },
  { id: 'blocks', name: BUILTIN.blocks },
  { id: 'blocks-core', name: BUILTIN.blocksCore },
  { id: 'blocks-delivery', name: BUILTIN.blocksDelivery },
  { id: 'blocks-task-graph', name: BUILTIN.blocksTaskGraph },
  { id: 'blocks-judgement', name: BUILTIN.blocksJudgement },
  { id: 'blocks-inquiry', name: BUILTIN.blocksInquiry },
  { id: 'blocks-loop', name: BUILTIN.blocksLoop },
];

/**
 * The desktop: a person is present, so `ask` can reach one.
 */
const DESKTOP: Entry[] = [
  { id: 'sessions', name: BUILTIN.sessionJsonl },
  { id: 'tools', name: BUILTIN.tools },
  { id: 'skills', name: BUILTIN.skills },
  { id: 'commands', name: BUILTIN.commands },
  { id: 'ui-extensions', name: BUILTIN.uiExtensions },
  ...BLOCKS,
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
  ...BLOCKS,
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
  ...BLOCKS,
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
