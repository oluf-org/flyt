/**
 * `flyt-tools` — the registry, and the single path to execution.
 *
 * The registry does not decide anything. It dispatches `tools/pre-execute`
 * before the body and `tools/post-execute` after it, and whoever listens
 * decides. That separation is what lets a third-party plugin's tool reach
 * execution through exactly the gate ours does: there is no second path.
 *
 * @module #kernel/plugins/tools
 */
import { Service, type Context, type Fiber } from '@deepseek-ai/cordis';
import type { JsonValue, ToolResult } from '../types.js';
import type { ToolClassification, ToolDefinition, ToolsSeam } from '../seams/tools.js';
import type { PostToolDecision, PreToolDecision, ToolExecution } from '../events.js';
import { SEAM_NAMES, type SeamName } from '../seams/index.js';
import { classifyContributedTool, atLeastAsStrict, describe } from './classify.js';
import { belongsToTrustedPlugin } from './trusted-install.js';
import {
  compileToolArguments, invalidToolArguments, type ToolArgumentValidator,
} from '../tools/json-schema.js';

/** The single human review pass required when installing a plugin. */
export interface ToolClassificationProposal extends ToolClassification {
  /** Tool being reviewed. */
  name: string;
  /** The capabilities the plugin requested while being installed. */
  requested: readonly string[];
  /** The evidence from which the inference was made. */
  inferredFrom: {
    seams: readonly string[];
    tool: Pick<ToolDefinition, 'name' | 'description' | 'parameters' | 'classification'>;
  };
  /** What accepting this classification changes. */
  permits: string;
  /** What accepting it still does not permit. */
  doesNotPermit: string;
}

export type PluginReview = (
  pluginName: string,
  proposals: readonly ToolClassificationProposal[],
) => Promise<Readonly<Record<string, ToolClassification | null>>> | Readonly<Record<string, ToolClassification | null>>;

export interface AttendedPluginReview {
  /** A literal so an unattended composition cannot accidentally inherit a default. */
  attended: true;
  /** Called exactly once, with every contributed tool in one decision. */
  decide: PluginReview;
}

interface PendingReview {
  /** Original declarations, retained as inference evidence while reach is stripped. */
  declarations: Map<string, RegistrationEvidence>;
}

interface RegistrationEvidence {
  tool: ToolDefinition;
  requested: string[];
  seams: SeamName[];
}

// Keyed by the contributing fiber, not by a global "installing" boolean: two
// contexts may mount concurrently and a tool must inherit only its own review.
const reviewedFibers = new WeakMap<Fiber, PendingReview>();

/** Find the quarantine inherited from any ancestor in this plugin tree. */
function reviewFor(fiber: Fiber): PendingReview | undefined {
  let current = fiber;
  while (true) {
    const review = reviewedFibers.get(current);
    if (review) return review;
    const parent = current.parent?.fiber;
    if (!parent || parent === current) return undefined;
    current = parent;
  }
}

/** A detached public view; callers never receive the registry's own record. */
function copyDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as JsonValue,
    classification: tool.classification ? { ...tool.classification } : undefined,
  };
}

/** Keep the registry-owned record immutable even inside this module. */
function storedDefinition(tool: ToolDefinition): ToolDefinition {
  const stored = copyDefinition(tool);
  if (stored.parameters && typeof stored.parameters === 'object') Object.freeze(stored.parameters);
  if (stored.classification) Object.freeze(stored.classification);
  return Object.freeze(stored) as ToolDefinition;
}

/** Freeze the data inference saw; a plugin must not rewrite the pending facts. */
function snapshotDeclaration(tool: ToolDefinition): ToolDefinition {
  return copyDefinition(tool);
}

export interface PendingPluginReview {
  pluginName: string;
  proposals: readonly ToolClassificationProposal[];
  /** Settle this pass. Returns false when it was already settled. */
  decide(decisions: Readonly<Record<string, ToolClassification | null>>): boolean;
}

/**
 * The attended bridge between kernel installation and Flyt's Build surface.
 * `review` is handed to the installer; `snapshot`/`subscribe` are handed to the
 * host. The install promise does not settle until the visible request settles.
 */
export class PluginReviewCoordinator {
  #pending: PendingPluginReview | null = null;
  #listeners = new Set<() => void>();

  readonly review: AttendedPluginReview = {
    attended: true,
    decide: (pluginName, proposals) => new Promise(resolve => {
      if (this.#pending) throw new Error(`A plugin review for "${this.#pending.pluginName}" is already pending`);
      let settled = false;
      const decide = (decisions: Readonly<Record<string, ToolClassification | null>>) => {
        if (settled) return false;
        settled = true;
        this.#pending = null;
        resolve(decisions);
        this.#emit();
        return true;
      };
      this.#pending = { pluginName, proposals, decide };
      this.#emit();
    }),
  };

  snapshot(): PendingPluginReview | null { return this.#pending; }

  /** A review capability exists only while a real surface is listening. */
  attendedReview(): AttendedPluginReview | undefined {
    return this.#listeners.size ? this.review : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
      // A vanished last surface must not leave an install promise parked. The
      // plugin is already quarantined at this point, so settling as an explicit
      // decline preserves the safe, installed-but-unreachable outcome.
      if (!this.#listeners.size && this.#pending) {
        this.#pending.decide(Object.fromEntries(this.#pending.proposals.map(p => [p.name, null])));
      }
    };
  }

  #emit(): void { for (const listener of this.#listeners) listener(); }
}

/** Cordis accepts injection names as either an array or a keyed config map. */
export function pluginInjections(inject: unknown): string[] {
  if (Array.isArray(inject)) return inject.map(String);
  if (inject && typeof inject === 'object') return Object.keys(inject);
  return [];
}

/**
 * Install a plugin only when a human review callback is supplied. The plugin is
 * left installed on a refusal, but its tools remain unclassified and therefore
 * unreachable. A missing callback is an unattended install and is refused
 * before the plugin is allowed to run.
 */
export async function installPlugin(
  ctx: Context,
  plugin: { name?: string; inject?: readonly string[] | Record<string, unknown> },
  review?: AttendedPluginReview,
  config?: unknown,
): Promise<Fiber> {
  if (!review?.attended || typeof review.decide !== 'function') {
    throw new Error('Refused: installing a tool-capable plugin requires an attended human classification review');
  }
  const tools = ctx.tools;
  if (!tools) throw new Error('Refused: the tool registry must be mounted before external plugins');
  const before = new Set(tools.list().map(tool => tool.name));
  const loading = ctx.plugin(plugin as any, config as any);
  // Cordis defers apply() to a microtask. Mark the real fiber before that turn,
  // so a plugin-supplied `source: confirmed` is stripped at register(), never
  // briefly reachable while an async apply() is still running.
  const owner = loading.ctx.fiber;
  const pending: PendingReview = { declarations: new Map() };
  reviewedFibers.set(owner, pending);
  const fiber = await loading;
  try {
    const requested = pluginInjections(plugin.inject);
    const seams = requested.filter((name): name is SeamName =>
      (SEAM_NAMES as readonly string[]).includes(name));
    const installed = [...pending.declarations.keys()]
      .filter(name => !before.has(name))
      .map(name => tools.get(name))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
    // A plugin cannot smuggle in a grant by supplying a pre-confirmed claim.
    unclassify(tools, installed.map(tool => tool.name));
    if (installed.length) ctx.emit('tools/change');
    const proposals = installed.map(tool => {
      const evidence = pending.declarations.get(tool.name);
      return proposalFor(evidence?.tool ?? tool, evidence?.requested ?? requested, evidence?.seams ?? seams);
    });
    if (!proposals.length) return fiber;
    const decisions = await review.decide(plugin.name ?? 'plugin', proposals);

    // One batch validates against the exact per-tool proposals the human saw,
    // and verifies every registry target before mutating any of them.
    applyClassifications(tools, proposals, decisions);
    if (proposals.some(proposal => Boolean(decisions?.[proposal.name]))) ctx.emit('tools/change');
    return fiber;
  } catch (error) {
    // A thrown/invalid review is an installation failure, not an explicit
    // decline. Do not leave a half-installed fiber outside the host's catalog.
    await fiber.dispose();
    throw error;
  }
}

function proposalFor(tool: ToolDefinition, requested: readonly string[], seams: readonly SeamName[]): ToolClassificationProposal {
  const inferred = classifyContributedTool(tool, seams);
  return Object.assign(inferred, {
    name: tool.name,
    requested: [...requested],
    inferredFrom: {
      seams: [...seams],
      tool: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        classification: tool.classification ? { ...tool.classification } : undefined,
      },
    },
    permits: `makes this ${describe(inferred)} tool eligible for a later, explicit ceiling grant`,
    doesNotPermit: 'execution, membership in a toolset, or addition to any ceiling',
  });
}

/** Cordis plugin name. */
export const name = 'flyt-tools';

/** How a refusal reaches the model: as a tool result, in the model's own channel. */
export function refusal(reason: string): ToolResult {
  return { content: `Refused: ${reason}`, error: reason };
}

interface RegistryState {
  registered: Map<string, ToolDefinition>;
  owners: Map<string, symbol>;
  validators: Map<string, ToolArgumentValidator>;
}

// The mutation capability is module-private. Cordis derives service views with
// proxies/Object.create, so an inherited private symbol is the stable identity
// shared by those views without exposing a mutator on ToolsSeam.
const REGISTRY_STATE = Symbol('flyt.tools.registry-state');

function stateOf(view: object): RegistryState {
  const state = (view as { [REGISTRY_STATE]?: RegistryState })[REGISTRY_STATE];
  if (!state) throw new Error('The tools seam is not Flyt\'s registry');
  return state;
}

function unclassify(tools: ToolsSeam, names: readonly string[]): void {
  const state = stateOf(tools as object);
  for (const toolName of names) {
    const tool = state.registered.get(toolName);
    if (tool?.classification) state.registered.set(toolName, storedDefinition({ ...tool, classification: undefined }));
  }
}

function applyClassifications(
  tools: ToolsSeam,
  proposals: readonly ToolClassificationProposal[],
  decisions: Readonly<Record<string, ToolClassification | null>>,
): void {
  const state = stateOf(tools as object);
  const updates: Array<[string, ToolDefinition]> = [];
  for (const proposal of proposals) {
    const decided = decisions?.[proposal.name];
    if (!decided) continue;
    if (!atLeastAsStrict(decided, proposal)) {
      throw new Error(
        `"${proposal.name}" cannot be classified more loosely than it was inferred: `
        + `inferred ${describe(proposal)}, asked for ${describe(decided)}`);
    }
    const tool = state.registered.get(proposal.name);
    if (!tool) throw new Error(`No tool named "${proposal.name}" is registered`);
    updates.push([proposal.name, storedDefinition({
      ...tool,
      classification: {
        effect: decided.effect,
        destructive: Boolean(decided.destructive),
        untrustedInput: Boolean(decided.untrustedInput),
        source: 'confirmed',
      },
    })]);
  }
  for (const [name, tool] of updates) state.registered.set(name, tool);
}

/**
 * The registry.
 *
 * A Cordis `Service`, so `this.ctx` inside a method is the CALLER's context
 * and a registration is owned by the fiber that made it. Real plugins call
 * `register()` and drop the disposer on the floor — the published
 * `dsh-skill-badge` does exactly that with its own registry — and a tool that
 * outlives the plugin that contributed it is a tool nobody can account for.
 *
 * Ordinary private fields, never `#private` ones: cordis derives a per-caller
 * view with `Object.create(this)`, and `#private` state is unreachable through
 * a derived object.
 */
export class ToolRegistry extends Service implements ToolsSeam {
  constructor(ctx: Context) {
    super(ctx, 'tools');
    Object.defineProperty(this, REGISTRY_STATE, {
      value: { registered: new Map(), owners: new Map(), validators: new Map() } satisfies RegistryState,
    });
  }

  /** Register a tool, owned by the calling plugin's fiber. Emits `tools/change`. */
  register(tool: ToolDefinition): () => void {
    if (!tool?.name) throw new Error('A tool needs a name');
    const { registered, owners, validators } = stateOf(this);
    if (registered.has(tool.name)) throw new Error(`A tool named "${tool.name}" is already registered`);
    const ctx = this.ctx;
    const ownership = Symbol(tool.name);
    const review = reviewFor(ctx.fiber);
    if (review) {
      const requested = pluginInjections(ctx.fiber.inject);
      const seams = requested.filter((name): name is SeamName =>
        (SEAM_NAMES as readonly string[]).includes(name));
      review.declarations.set(tool.name, { tool: snapshotDeclaration(tool), requested, seams });
    }
    // Every plugin fiber is untrusted unless it is inside the attended install
    // quarantine. This closes raw `kernel.ctx.plugin(...)`: it may contribute a
    // tool, but cannot contribute the human decision. Root/kernel registration
    // remains available for Flyt's own composed definitions.
    const quarantined = Boolean(review || (ctx.fiber.runtime && !belongsToTrustedPlugin(ctx.fiber)));
    // Always detach registration from the caller's object and freeze the
    // registry-owned record. Quarantine additionally strips any claimed grant.
    const safeTool = storedDefinition(quarantined ? { ...tool, classification: undefined } : tool);
    // Compile before registration becomes visible. From this point onward the
    // registry can guarantee that every reachable tool has an enforceable
    // parameters schema; unresolved/external refs fail closed here.
    const validateArguments = compileToolArguments(tool.name, safeTool.parameters);
    return ctx.effect(() => {
      registered.set(tool.name, safeTool);
      owners.set(tool.name, ownership);
      validators.set(tool.name, validateArguments);
      ctx.emit('tools/change');
      return () => {
        // Classification replaces the stored definition. Ownership is separate
        // so that confirm/edit cannot accidentally make the tool outlive the
        // plugin fiber that contributed it.
        if (owners.get(tool.name) !== ownership) return;
        registered.delete(tool.name);
        owners.delete(tool.name);
        validators.delete(tool.name);
        ctx.emit('tools/change');
      };
    }) as () => void;
  }

  /** One tool by name, or undefined. */
  get(toolName: string): ToolDefinition | undefined {
    const tool = stateOf(this).registered.get(toolName);
    return tool ? copyDefinition(tool) : undefined;
  }

  /** Every registered tool, including unclassified ones. */
  list(): ToolDefinition[] {
    return [...stateOf(this).registered.values()].map(copyDefinition);
  }

  /**
   * What a registered tool WOULD be classified as, if a human agreed.
   *
   * A proposal, and deliberately not an application. The tool stays
   * unclassified and therefore unreachable — that is not an oversight to be
   * tidied away, it is the mechanism: absence of a classification is what the
   * permission bridge refuses on, and a tool that arrives classified has
   * skipped the only step that was ever going to involve a person.
   *
   * So this answers "what am I being asked to agree to", and nothing else.
   * Applying it is {@link ToolsSeam.classify}, which only a confirmed decision
   * reaches.
   *
   * Returns null for a tool that is already classified: there is nothing to
   * propose about a decision somebody has taken.
   */
  propose(toolName: string, seams: readonly SeamName[] = []): ToolClassification | null {
    const tool = stateOf(this).registered.get(toolName);
    if (!tool || tool.classification) return null;
    return classifyContributedTool(tool, seams);
  }

  /**
   * Run a call through the gate.
   *
   * Arguments are validated first and every diagnostic is returned in one
   * result. `tools/pre-execute` then decides: a denial returns a refusal result
   * and the tool body never runs. Everything a plugin contributes reaches
   * execution through this method and no other.
   */
  async execute(exec: ToolExecution): Promise<ToolResult> {
    const ctx = this.ctx;
    ctx.emit('tool/call', exec);

    const state = stateOf(this);
    const tool = state.registered.get(exec.call.name);
    if (!tool) {
      await exec.onState?.({ callId: exec.call.id, state: 'failed', reason: `there is no tool named "${exec.call.name}"` });
      return refusal(`there is no tool named "${exec.call.name}"`);
    }

    // Validation is a kernel invariant, not a courtesy left to individual
    // tools. It happens before approval so a malformed write cannot wake a
    // person or run a policy screen, and all failures return together in the
    // single tool result the model will see.
    const errors = state.validators.get(exec.call.name)?.(exec.call.args)
      ?? ['args: no compiled parameters schema is available'];
    if (errors.length) {
      await exec.onState?.({ callId: exec.call.id, state: 'failed', reason: 'argument validation failed', diagnostics: [...errors] });
      return invalidToolArguments(exec.call.name, errors);
    }
    await exec.onState?.({ callId: exec.call.id, state: 'validated' });

    let decision: PreToolDecision;
    try {
      decision = await ctx.waterfall(
        'tools/pre-execute', exec, async () => ({ decision: 'allow' }),
      );
    } catch (error) {
      const reason = String((error as Error)?.message ?? error);
      await exec.onState?.({ callId: exec.call.id, state: 'failed', reason: `authorization failed: ${reason}` });
      return refusal(`authorization failed: ${reason}`);
    }
    if (decision.decision !== 'allow') {
      // `ask` reaching here unanswered is a denial: a surface that cannot ask
      // has not been given permission, it has failed to obtain it.
      const reason = decision.decision === 'ask'
        ? `${decision.reason} (nobody was available to approve it)`
        : decision.reason;
      await exec.onState?.({ callId: exec.call.id, state: 'failed', reason: `authorization refused: ${reason}` });
      return refusal(reason);
    }
    await exec.onState?.({ callId: exec.call.id, state: 'authorized' });
    await exec.onState?.({ callId: exec.call.id, state: 'running' });

    let result: ToolResult;
    try {
      result = await tool.execute(exec.call.args as JsonValue, exec);
    } catch (err) {
      // A throwing tool is a failed call, not a failed run: the model is told,
      // and gets to decide what to do about it.
      const message = String((err as Error)?.message ?? err);
      result = { content: `Error: ${message}`, error: message };
    }

    let settled: PostToolDecision;
    try {
      settled = await ctx.waterfall(
        'tools/post-execute', exec, result, async () => ({ decision: 'accept', result }),
      );
    } catch (error) {
      const reason = String((error as Error)?.message ?? error);
      await exec.onState?.({ callId: exec.call.id, state: exec.signal?.aborted ? 'interrupted' : 'failed', reason: `result authorization failed: ${reason}` });
      return refusal(`result authorization failed: ${reason}`);
    }
    const final = settled.decision === 'accept' ? settled.result : refusal(settled.reason);
    const interrupted = exec.signal?.aborted;
    await exec.onState?.({
      callId: exec.call.id,
      state: interrupted ? 'interrupted' : final.error ? 'failed' : 'completed',
      ...(interrupted ? { reason: 'execution was cancelled' } : final.error ? { reason: final.error } : {}),
    });
    return final;
  }
}

/**
 * Provide `ctx.tools`.
 *
 * @param ctx — the context to provide in.
 */
export function apply(ctx: Context): void {
  new ToolRegistry(ctx);
}
