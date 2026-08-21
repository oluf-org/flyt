/**
 * `ctx.tools` — the tool registry and the only path to execution.
 *
 * A tool contributed by a third-party plugin arrives **unclassified and
 * ungranted** (D57). Unclassified tools are in no toolset, so no existing
 * stack's ceiling can reach them; classification is not a grant; and a block's
 * children narrow the ceiling, never widen it.
 *
 * @module #kernel/seams/tools
 */
import type { JsonValue, ToolResult } from '../types.js';
import type { ToolExecution } from '../events.js';

/**
 * What we assume a tool does, before anyone decides whether it may.
 *
 * Inference may only err toward restriction: the symptom of a wrong guess must
 * be a tool that refuses and a person who notices.
 */
export interface ToolClassification {
  /** What it does to the world. */
  effect: 'read' | 'write' | 'shell';
  /** True when it can destroy something it did not create. */
  destructive: boolean;
  /** True when its result carries text from outside the workspace. */
  untrustedInput: boolean;
  /** How this classification was arrived at. `inferred` is not confirmation. */
  source: 'declared' | 'inferred' | 'confirmed';
}

/** A registered tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: JsonValue;
  /** Absent until a human confirms one; an unclassified tool cannot be granted. */
  classification?: ToolClassification;
  /** Run one accepted call. Never called for a call the gate refused. */
  execute(args: JsonValue, exec: ToolExecution): Promise<ToolResult>;
}

/** The seam. Providers: `flyt-tools` plus `flyt-approvals` for the gate. */
export interface ToolsSeam {
  /** Register a tool; the disposer unregisters it. Emits `tools/change`. */
  register(tool: ToolDefinition): () => void;
  /** One tool by name, or undefined. */
  get(name: string): ToolDefinition | undefined;
  /** Every registered tool, including unclassified ones. */
  list(): ToolDefinition[];
  /**
   * Run a call through the gate.
   *
   * `tools/pre-execute` decides first: a denial returns a refusal result and
   * the tool body never runs. Everything a plugin contributes reaches
   * execution through this method and no other.
   */
  execute(exec: ToolExecution): Promise<ToolResult>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsSeam;
  }
}
