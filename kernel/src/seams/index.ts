/**
 * The eight capability seams.
 *
 * A seam is a service definition, a provider, and consumers that never know
 * which provider they got. That last part is the whole idea: it is why
 * worktree isolation can become a provider of `ctx.fs` instead of a special
 * case threaded through the runner, and why a Loop worker can be composed as a
 * narrower tree rather than the same tree with flags off.
 *
 * @module #kernel/seams
 */
import type { Context } from '@deepseek-ai/cordis';

import type { SessionsSeam } from './sessions.js';
import type { ToolsSeam } from './tools.js';
import type { LlmSeam } from './llm.js';
import type { FsSeam } from './fs.js';
import type { ShellSeam } from './shell.js';
import type { AgentsSeam } from './agents.js';
import type { CommandsSeam } from './commands.js';
import type { SandboxSeam } from './sandbox.js';

export type * from './sessions.js';
export type * from './tools.js';
export type * from './llm.js';
export type * from './fs.js';
export type * from './shell.js';
export type * from './agents.js';
export type * from './commands.js';
export type * from './sandbox.js';
// Typed host RPC declarations, not a ninth dsh capability seam.
export * from './ui-extensions.js';

/** Seam name to seam interface. The map a provider is checked against. */
export interface Seams {
  sessions: SessionsSeam;
  tools: ToolsSeam;
  llm: LlmSeam;
  fs: FsSeam;
  shell: ShellSeam;
  agents: AgentsSeam;
  commands: CommandsSeam;
  sandbox: SandboxSeam;
}

/**
 * Every seam name, as data.
 *
 * A test asserts this list against the {@link Seams} map, so a seam that is
 * declared and never provided — or provided and never declared — is a build
 * error rather than a discovery six months later.
 */
export const SEAM_NAMES = [
  'sessions',
  'tools',
  'llm',
  'fs',
  'shell',
  'agents',
  'commands',
  'sandbox',
] as const satisfies readonly (keyof Seams)[];

/** One of the eight. */
export type SeamName = (typeof SEAM_NAMES)[number];

/**
 * Provide a seam implementation in this context.
 *
 * Scoped to the calling fiber: when the plugin that provided it unloads, the
 * seam goes with it, and a consumer that injected it stops rather than holding
 * a dead reference.
 *
 * @param ctx — the context to provide in.
 * @param name — which seam.
 * @param impl — the provider.
 * @returns a disposer that withdraws the provider.
 */
export function provideSeam<K extends SeamName>(ctx: Context, name: K, impl: Seams[K]): () => void {
  const dispose = ctx.provide(name, impl);
  return () => { void dispose(); };
}
