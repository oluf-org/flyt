/**
 * The v2 kernel: a Cordis context, the plugin tree it roots, and its lifecycle.
 *
 * Everything a third-party plugin can touch is typed and lives under this
 * package (D53). Nothing here is imported while the v2 flag is off (D62).
 *
 * @module #kernel
 */
import { Context } from '@deepseek-ai/cordis';
import { PluginHost, type Importer, type InstalledPlugin } from './loader/index.js';
import type { Entry } from './loader/compose.js';
import { PluginReviewCoordinator } from './plugins/tools.js';

export * from './seams/index.js';
export * from './loader/index.js';
export * from './profiles.js';
export * from './events.js';
export type * from './types.js';
export * from './stack/index.js';
export * from './blocks/types.js';
export * from './blocks/run.js';
export * from './session/jsonl.js';
export * from './session/events.js';
export * from './session/projection.js';
export * from './session/children.js';
export * from './session/index.js';
export * from './fs/transactional-patches.js';
export * from './api/contract.js';
export * from './config/layers.js';
export * from './plugins/interceptions.js';
export * from './security/permissions.js';
export * from './workers/profiles.js';
export * from './tools/scheduler.js';
export * from './tools/progress.js';
export * as sessionJsonl from './plugins/session-jsonl.js';
export * as flytTools from './plugins/tools.js';
export * as flytApprovals from './plugins/approvals.js';
export * as flytSkills from './plugins/skills.js';
export * as flytUiExtensions from './plugins/ui-extensions.js';
export * as flytApi from './plugins/commands.js';
export * as flytStackCommands from './plugins/stack-commands.js';
export * as flytBlocks from './plugins/blocks.js';
export * as flytStackRunner from './plugins/stack-runner.js';
export * as flytRunProjection from './plugins/run-projection.js';
export * as flytFs from './plugins/fs.js';
export * as flytExecutionWorldLocal from './plugins/execution-world-local.js';
export { createLocalExecutionWorld } from './plugins/execution-world-local.js';
export { createFsSeam } from './seams/fs.js';
export { createLocalSubprocess } from './plugins/subprocess-local.js';
export { createSandboxPolicy, capabilityRequest } from './plugins/sandbox-policy.js';
export { createLocalSandbox, defaultSandboxFacts, macSeatbeltProfile } from './plugins/sandbox-local.js';
export { createScreenedShell } from './plugins/shell-screened.js';
export { scrubbedParentEnv, layeredEnv, isCredentialEnvName } from './sandbox/environment.js';
export * as flytAdapters from './plugins/llm-adapters.js';
export * as flytBlocksCore from './plugins/blocks-core.js';
export * as flytBlocksJudgement from './plugins/blocks-judgement.js';
export * as flytBlocksInquiry from './plugins/blocks-inquiry.js';
export * as flytBlocksLoop from './plugins/blocks-loop.js';
export * as flytWorkerProfiles from './plugins/worker-profiles.js';
export {
  taskGraphBlock, executeTaskGraph, parseTaskGraphPlan, taskGraphRepairPrompt, degradeTaskGraphPlan,
  TASK_GRAPH_SCHEMA, PARALLELISM_LEVELS,
} from './plugins/blocks-task-graph.js';
export {
  workBlock, researchBlock,
  LOOP_CEILING, RESEARCH_CEILING, WORK_SYSTEM,
} from './plugins/blocks-core.js';
export { routeOf } from './plugins/llm-adapters.js';
export {
  ModelCapabilityRegistry, defaultModelCapabilityRegistry, unknownCapability, manageContextBudget, describeInspectedCalls,
} from './models/capabilities.js';
export { TOOL_CALL_STATES, assertToolTransition, normalizeToolCall, reconcileToolCallStates, terminalToolState } from './tool-call-state.js';
export type {
  Fact, FactConfidence, ModelCapabilityProfile, RequestValueResolution,
  ContextBudgetBreakdown, ContextBudgetDecision, ContextPolicyAction,
} from './models/capabilities.js';
export type { ToolCallState, ToolStateTransition, ReconciledToolCall } from './tool-call-state.js';
export { StackRunner } from './plugins/stack-runner.js';
export type { StackSource, StackRunnerConfig } from './plugins/stack-runner.js';
export { BlockRegistry, missingBlocks } from './plugins/blocks.js';
export { registerStackCommands } from './plugins/stack-commands.js';
export type { StackHandle } from './plugins/stack-commands.js';
export { UiExtensionRegistry } from './plugins/ui-extensions.js';

/**
 * Which surface a kernel serves.
 *
 * Composition ships one profile per surface so a Loop worker gets a genuinely
 * narrower plugin tree rather than the same tree with flags off. The profiles
 * are named here; the layering that resolves them is the loader's (`t-0045`).
 */
export type ProfileName = 'flyt-desktop' | 'flyt-cli' | 'flyt-loop-worker';

/** Options accepted by {@link createKernel}. */
export interface KernelOptions {
  /** Base URL relative plugin specifiers resolve against. */
  baseUrl?: string;
  /** The surface profile to compose. Defaults to `flyt-cli`. */
  profile?: ProfileName;
}

/** A booted kernel: its root context, the profile it composed, and teardown. */
export interface Kernel {
  /** The root context. Plugins mount here; seams resolve through it. */
  readonly ctx: Context;
  /** The profile this kernel composed. */
  readonly profile: ProfileName;
  /** The one pending attended plugin review, observable by the host UI. */
  readonly pluginReviews: PluginReviewCoordinator;
  /** Addressable catalog and lifecycle operations for mounted Cordis fibers. */
  readonly plugins: {
    list(): InstalledPlugin[];
    get(id: string): InstalledPlugin | undefined;
    configure(id: string, config: unknown): Promise<void>;
    restart(id: string): Promise<void>;
    uninstall(id: string): Promise<void>;
    subscribe(listener: () => void): () => void;
  };
  /** Install package rows through this surface's attended/unattended policy. */
  install(entries: readonly Entry[], options?: { import?: Importer }): Promise<string[]>;
  /**
   * Tear the plugin tree down, running every fiber's disposers.
   *
   * Idempotent: disposing twice is not an error, because a caller that
   * crashed halfway through shutdown must be able to finish it.
   */
  dispose(): Promise<void>;
}

/**
 * Boot a kernel.
 *
 * The context is empty on purpose — seams are provided by plugins, never by
 * the kernel itself, so that every consumer resolves a seam the same way
 * whether Flyt or a third party provided it.
 *
 * @param options — base URL and surface profile.
 * @returns the booted kernel.
 */
export function createKernel(options: KernelOptions = {}): Kernel {
  const ctx = new Context();
  const profile = options.profile ?? 'flyt-cli';
  const pluginReviews = new PluginReviewCoordinator();
  const plugins = new PluginHost(ctx);
  if (options.baseUrl) ctx.baseUrl = options.baseUrl;

  let disposed: Promise<void> | null = null;
  return {
    ctx,
    profile,
    pluginReviews,
    plugins,
    install(entries, installOptions = {}) {
      return plugins.install(entries, {
        ...installOptions,
        // A Loop worker cannot manufacture a human callback. The shared mount
        // path therefore refuses every external package before it executes.
        toolReview: profile === 'flyt-loop-worker' ? undefined : pluginReviews.attendedReview(),
      });
    },
    dispose() {
      disposed ??= ctx.fiber.dispose().finally(() => plugins.clear());
      return disposed;
    },
  };
}

export { Context };
