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
import type { SeamName } from '../seams/index.js';
import { classifyContributedTool, atLeastAsStrict, describe } from './classify.js';

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
