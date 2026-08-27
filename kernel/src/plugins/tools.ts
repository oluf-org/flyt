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
import { Service, type Context } from '@deepseek-ai/cordis';
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

/**
 * Install a plugin only when a human review callback is supplied. The plugin is
 * left installed on a refusal, but its tools remain unclassified and therefore
 * unreachable. A missing callback is an unattended install and is refused
 * before the plugin is allowed to run.
 */
export async function installPlugin(
  ctx: Context,
  plugin: { name?: string; inject?: readonly string[] },
  review?: PluginReview,
): Promise<unknown> {
  if (!review) throw new Error('Refused: installing a plugin requires a human classification review');
  const tools = ctx.tools;
  const before = new Set(tools.list().map(tool => tool.name));
  const fiber = await ctx.plugin(plugin as any);
  const requested = [...(plugin.inject ?? [])];
  const seams = requested.filter((name): name is SeamName =>
    (SEAM_NAMES as readonly string[]).includes(name));
  const installed = tools.list().filter(tool => !before.has(tool.name));
  // A plugin cannot smuggle in a grant by supplying a pre-confirmed claim.
  tools.unclassify(installed.map(tool => tool.name));
  const proposals = installed.map(tool => proposalFor(tool, requested, seams));
  const decisions = await review(proposals);
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
    inferredFrom: { seams: [...requested], tool: { name: tool.name, description: tool.description } },
    permits: `${describe(inferred)} capability for this tool when a ceiling names it`,
    doesNotPermit: 'execution, a toolset, or access through a ceiling until separately granted',
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

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  /** Register a tool, owned by the calling plugin's fiber. Emits `tools/change`. */
  register(tool: ToolDefinition): () => void {
    if (!tool?.name) throw new Error('A tool needs a name');
    if (this.registered.has(tool.name)) throw new Error(`A tool named "${tool.name}" is already registered`);
    const registered = this.registered;
    const ctx = this.ctx;
    return ctx.effect(() => {
      registered.set(tool.name, tool);
      ctx.emit('tools/change');
      return () => {
        if (registered.get(tool.name) !== tool) return;
        registered.delete(tool.name);
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
    this.registered.set(toolName, { ...tool, classification: { ...decided, source: 'confirmed' } });
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
