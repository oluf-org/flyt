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
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue, ToolResult } from '../types.js';
import type { ToolDefinition, ToolsSeam } from '../seams/tools.js';
import type { PostToolDecision, PreToolDecision, ToolExecution } from '../events.js';
import { provideSeam } from '../seams/index.js';

/** Cordis plugin name. */
export const name = 'flyt-tools';

/** How a refusal reaches the model: as a tool result, in the model's own channel. */
export function refusal(reason: string): ToolResult {
  return { content: `Refused: ${reason}`, error: reason };
}

/**
 * Provide `ctx.tools`.
 *
 * @param ctx — the context to provide in.
 * @returns a disposer withdrawing the seam.
 */
export function apply(ctx: Context): () => void {
  const registered = new Map<string, ToolDefinition>();

  const seam: ToolsSeam = {
    register(tool) {
      if (!tool?.name) throw new Error('A tool needs a name');
      if (registered.has(tool.name)) throw new Error(`A tool named "${tool.name}" is already registered`);
      registered.set(tool.name, tool);
      ctx.emit('tools/change');
      return () => {
        if (registered.get(tool.name) === tool) {
          registered.delete(tool.name);
          ctx.emit('tools/change');
        }
      };
    },

    get(toolName) { return registered.get(toolName); },

    list() { return [...registered.values()]; },

    async execute(exec: ToolExecution): Promise<ToolResult> {
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

      const tool = registered.get(exec.call.name);
      if (!tool) return refusal(`there is no tool named "${exec.call.name}"`);

      let result: ToolResult;
      try {
        result = await tool.execute(exec.call.args as JsonValue, exec);
      } catch (err) {
        // A throwing tool is a failed call, not a failed run: the model is
        // told, and gets to decide what to do about it.
        result = { content: `Error: ${String((err as Error)?.message ?? err)}`, error: String((err as Error)?.message ?? err) };
      }

      const settled: PostToolDecision = await ctx.waterfall(
        'tools/post-execute', exec, result, async () => ({ decision: 'accept', result }),
      );
      return settled.decision === 'accept' ? settled.result : refusal(settled.reason);
    },
  };

  return provideSeam(ctx, 'tools', seam);
}
