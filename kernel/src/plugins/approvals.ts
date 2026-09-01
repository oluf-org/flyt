/**
 * `flyt-approvals` — the ceiling and the approval mode, bound to the gate.
 *
 * Everything a plugin contributes arrives here on the same footing as a
 * built-in tool. The order of the checks is the policy, and it is deliberately
 * the strictest-first:
 *
 * 1. **Unclassified is unreachable.** A tool nobody has classified is in no
 *    toolset, so no ceiling can name it (D57). Inference proposes; a human
 *    confirms; and confirmation is still not a grant.
 * 2. **The ceiling is static.** A block's ceiling is decided before the run;
 *    children narrow it and never widen it. A tool not in it is refused
 *    whatever the approval mode says, because approval answers "may this run
 *    now", not "may this exist".
 * 3. **Then the mode decides**: `always` proceeds unattended, `smart` proceeds
 *    for a call it can screen as safe, and `ask` lets a classified local read
 *    through while putting anything with side effects or untrusted input to a
 *    person. "Ask permission" protects the project; it must not make an agent
 *    ask before it can even inspect the project.
 *
 * A mode of `ask` with nobody to ask is a denial. That is the whole reason the
 * decision type has three cases instead of two.
 *
 * @module #kernel/plugins/approvals
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolExecution } from '../events.js';
import { evaluatePermission } from '../security/permissions.js';

/** Ask a person. Resolving false, or never being provided, is a refusal. */
export type AskHuman = (exec: ToolExecution, reason: string) => Promise<boolean>;

/** What the screen thinks of one call. */
export interface Verdict {
  risk: 'safe' | 'caution' | 'danger';
  reason: string;
}

/** How this surface approves. */
export interface ApprovalsConfig {
  /** `ask` pauses for side effects, `smart` pauses for what it cannot clear, `always` is unattended. */
  mode?: 'ask' | 'smart' | 'always';
  /** Who to ask. Absent means nobody is there — which turns `ask` into `deny`. */
  ask?: AskHuman;
  /** The screen `smart` consults. Absent means the built-in one below. */
  screen?: (exec: ToolExecution, classification: Classification) => Verdict | Promise<Verdict>;
  /** Interaction-only tools (for example an attended ask-human turn) that do not need a second approval before they can ask. */
  bypass?: string[];
}

interface Classification {
  effect: 'read' | 'write' | 'shell';
  destructive: boolean;
  untrustedInput: boolean;
}

/** Cordis plugin name. */
export const name = 'flyt-approvals';

/** It gates the registry, so it needs the registry. */
export const inject = ['tools'];

/**
 * The screen of last resort.
 *
 * Reading is safe, writing wants a look, and anything that can destroy or
 * reach a shell is not something to wave through while nobody is watching. A
 * screen that cannot decide says `caution`, never `safe` — the failure
 * direction is a question, not a permission.
 */
function defaultScreen(_exec: ToolExecution, classification: Classification): Verdict {
  if (classification.effect === 'shell') return { risk: 'danger', reason: 'it can run shell commands' };
  if (classification.destructive) return { risk: 'danger', reason: 'it can destroy something it did not create' };
  if (classification.effect === 'write') return { risk: 'caution', reason: 'it writes to the workspace' };
  if (classification.untrustedInput) return { risk: 'caution', reason: 'its result carries text from outside the workspace' };
  return { risk: 'safe', reason: 'it only reads' };
}

/**
 * Bind the ceiling and the approval mode onto `tools/pre-execute`.
 *
 * @param ctx — the context to listen in.
 * @param config — the surface's approval mode and who it can ask.
 * @returns a disposer removing the gate.
 */
export function apply(ctx: Context, config: ApprovalsConfig = {}): () => void {
  const mode = config.mode ?? 'ask';
  const screen = config.screen ?? defaultScreen;

  return ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const tool = ctx.tools.get(exec.call.name);
    if (!tool) return { decision: 'deny', reason: `there is no tool named "${exec.call.name}"` };

    if (!tool.classification) {
      return {
        decision: 'deny',
        reason: `"${tool.name}" is unclassified, so it is in no toolset and no ceiling can reach it`,
      };
    }

    if (!exec.ceiling.includes(tool.name)) {
      return {
        decision: 'deny',
        reason: `"${tool.name}" is not in this block's ceiling`,
      };
    }

    // Resource policy is deliberately inside classification + ceiling. No
    // saved approval or later allow can make an unreachable tool reachable.
    if (exec.permissionPolicy) {
      const resource = evaluatePermission(exec.permissionPolicy, {
        action: tool.name, effect: tool.classification.effect, args: exec.call.args,
      });
      if (resource.decision === 'deny') return { decision: 'deny', reason: resource.reason };
      if (resource.decision === 'ask') return ask(exec, `${tool.name}: ${resource.reason}`);
    }

    if (config.bypass?.includes(tool.name)) return next();

    if (mode === 'always') return next();

    if (mode === 'smart') {
      const verdict = await screen(exec, tool.classification);
      if (verdict.risk === 'safe') return next();
      return ask(exec, `${tool.name}: ${verdict.reason}`);
    }

    // The desktop describes Ask permission as pausing before writes and shell
    // commands. Keep that promise here. This is deliberately narrower than
    // simply checking `effect === "read"`: a connector may be read-only yet
    // return untrusted external text, which still deserves a person's look in
    // the conservative mode.
    const verdict = await screen(exec, tool.classification);
    if (verdict.risk === 'safe') return next();

    return ask(exec, `${tool.name}: ${verdict.reason}`);
  });

  async function ask(exec: ToolExecution, reason: string): Promise<PreToolDecision> {
    if (!config.ask) return { decision: 'ask', reason };
    return (await config.ask(exec, reason))
      ? { decision: 'allow' }
      : { decision: 'deny', reason: `${reason} — refused` };
  }
}
