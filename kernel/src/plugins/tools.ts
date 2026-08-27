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

/** The single human review pass required when installing a plugin. */
export interface ToolClassificationProposal extends ToolClassification {
  /** Tool being reviewed. */
  name: string;
  /** The capabilities the plugin requested while being installed. */
  requested: readonly string[];
  /** The evidence from which the inference was made. */
  inferredFrom: { seams: readonly string[]; tool: { name: string; description: string } };
  /** What accepting this classification changes. */
  permits: string;
  /** What accepting it still does not permit. */
  doesNotPermit: string;
}

export type PluginReview = (
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
  declarations: Map<string, ToolDefinition>;
}

// Keyed by the contributing fiber, not by a global "installing" boolean: two
// contexts may mount concurrently and a tool must inherit only its own review.
const reviewedFibers = new WeakMap<Fiber, PendingReview>();

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
  const before = new Set(tools.list().map(tool => tool.name));
  const loading = ctx.plugin(plugin as any, config as any);
  // Cordis defers apply() to a microtask. Mark the real fiber before that turn,
  // so a plugin-supplied `source: confirmed` is stripped at register(), never
  // briefly reachable while an async apply() is still running.
  const owner = loading.ctx.fiber;
  const pending: PendingReview = { declarations: new Map() };
  reviewedFibers.set(owner, pending);
  const fiber = await loading;
  const requested = pluginInjections(plugin.inject);
  const seams = requested.filter((name): name is SeamName =>
    (SEAM_NAMES as readonly string[]).includes(name));
  const installed = tools.list().filter(tool => !before.has(tool.name));
  // A plugin cannot smuggle in a grant by supplying a pre-confirmed claim.
  tools.unclassify(installed.map(tool => tool.name));
  const proposals = installed.map(tool => proposalFor(pending.declarations.get(tool.name) ?? tool, requested, seams));
  const decisions = await review.decide(proposals);

  // Validate the whole pass before applying any of it. One attempted loosening
  // must not leave the tools earlier in the list half-classified.
  for (const proposal of proposals) {
    const decided = decisions?.[proposal.name];
    if (decided && !atLeastAsStrict(decided, proposal)) {
      throw new Error(
        `"${proposal.name}" cannot be classified more loosely than it was inferred: `
        + `inferred ${describe(proposal)}, asked for ${describe(decided)}`);
    }
  }
  for (const proposal of proposals) {
    const decided = decisions?.[proposal.name];
    if (decided) tools.classify(proposal.name, decided, seams);
  }
  return fiber;
}

function proposalFor(tool: ToolDefinition, requested: readonly string[], seams: readonly SeamName[]): ToolClassificationProposal {
  const inferred = classifyContributedTool(tool, seams);
  return Object.assign(inferred, {
    name: tool.name,
    requested: [...requested],
    inferredFrom: { seams: [...seams], tool: { name: tool.name, description: tool.description } },
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
  private registered = new Map<string, ToolDefinition>();
  private owners = new Map<string, symbol>();

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  /** Register a tool, owned by the calling plugin's fiber. Emits `tools/change`. */
  register(tool: ToolDefinition): () => void {
    if (!tool?.name) throw new Error('A tool needs a name');
    if (this.registered.has(tool.name)) throw new Error(`A tool named "${tool.name}" is already registered`);
    const registered = this.registered;
    const owners = this.owners;
    const ctx = this.ctx;
    const ownership = Symbol(tool.name);
    const review = reviewedFibers.get(ctx.fiber);
    if (review) review.declarations.set(tool.name, tool);
    const safeTool = review && tool.classification ? { ...tool, classification: undefined } : tool;
    return ctx.effect(() => {
      registered.set(tool.name, safeTool);
      owners.set(tool.name, ownership);
      ctx.emit('tools/change');
      return () => {
        // Classification replaces the stored definition. Ownership is separate
        // so that confirm/edit cannot accidentally make the tool outlive the
        // plugin fiber that contributed it.
        if (owners.get(tool.name) !== ownership) return;
        registered.delete(tool.name);
        owners.delete(tool.name);
        ctx.emit('tools/change');
      };
    }) as () => void;
  }

  /** One tool by name, or undefined. */
  get(toolName: string): ToolDefinition | undefined {
    return this.registered.get(toolName);
  }

  /** Every registered tool, including unclassified ones. */
  list(): ToolDefinition[] {
    return [...this.registered.values()];
  }

  /** Keep plugin claims from becoming an implicit grant during installation. */
  unclassify(names: readonly string[]): void {
    for (const toolName of names) {
      const tool = this.registered.get(toolName);
      if (tool?.classification) this.registered.set(toolName, { ...tool, classification: undefined });
    }
    if (names.length) this.ctx.emit('tools/change');
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
    const tool = this.registered.get(toolName);
    if (!tool || tool.classification) return null;
    return classifyContributedTool(tool, seams);
  }

  /**
   * Apply a classification a human confirmed.
   *
   * Refuses anything looser than the proposal for the same seams: the pass is
   * confirm-or-EDIT, and an edit may make a classification stricter and never
   * weaker. Without that, "edit" is a way to grant by hand what the inference
   * declined to grant, which is the whole thing D57 is guarding.
   */
  classify(toolName: string, decided: ToolClassification, seams: readonly SeamName[] = []): void {
    const tool = this.registered.get(toolName);
    if (!tool) throw new Error(`No tool named "${toolName}" is registered`);
    const floor = classifyContributedTool(tool, seams);
    if (!atLeastAsStrict(decided, floor)) {
      throw new Error(
        `"${toolName}" cannot be classified more loosely than it was inferred: `
        + `inferred ${describe(floor)}, asked for ${describe(decided)}`);
    }
    this.registered.set(toolName, {
      ...tool,
      classification: {
        effect: decided.effect,
        destructive: Boolean(decided.destructive),
        untrustedInput: Boolean(decided.untrustedInput),
        source: 'confirmed',
      },
    });
    this.ctx.emit('tools/change');
  }

  /**
   * Run a call through the gate.
   *
   * `tools/pre-execute` decides first: a denial returns a refusal result and
   * the tool body never runs. Everything a plugin contributes reaches
   * execution through this method and no other.
   */
  async execute(exec: ToolExecution): Promise<ToolResult> {
    const ctx = this.ctx;
    ctx.emit('tool/call', exec);

    const decision: PreToolDecision = await ctx.waterfall(
      'tools/pre-execute', exec, async () => ({ decision: 'allow' }),
    );
    if (decision.decision !== 'allow') {
      // `ask` reaching here unanswered is a denial: a surface that cannot ask
      // has not been given permission, it has failed to obtain it.
      const reason = decision.decision === 'ask'
        ? `${decision.reason} (nobody was available to approve it)`
        : decision.reason;
      return refusal(reason);
    }

    const tool = this.registered.get(exec.call.name);
    if (!tool) return refusal(`there is no tool named "${exec.call.name}"`);

    let result: ToolResult;
    try {
      result = await tool.execute(exec.call.args as JsonValue, exec);
    } catch (err) {
      // A throwing tool is a failed call, not a failed run: the model is told,
      // and gets to decide what to do about it.
      const message = String((err as Error)?.message ?? err);
      result = { content: `Error: ${message}`, error: message };
    }

    const settled: PostToolDecision = await ctx.waterfall(
      'tools/post-execute', exec, result, async () => ({ decision: 'accept', result }),
    );
    return settled.decision === 'accept' ? settled.result : refusal(settled.reason);
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
