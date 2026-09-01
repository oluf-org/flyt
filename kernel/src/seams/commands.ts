/**
 * `ctx.commands` — one code path, two callers.
 *
 * Every Build operation is available to an agent here, and every agent
 * operation renders in the editor as it happens (D63). A command that only a
 * human can reach, or only an agent can reach, is a bug in this seam.
 *
 * @module #kernel/seams/commands
 */
import type { JsonValue } from '../types.js';

/** A registered command. */
export interface CommandDefinition {
  /** Namespaced, e.g. `stack:insert-block`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments, so a model can call it as a tool. */
  parameters?: JsonValue;
  /** Canonical request schema. `parameters` remains its compatibility alias. */
  request?: JsonValue;
  /** Successful response schema. */
  response?: JsonValue;
  /** Structured error payload schema for HTTP/IPC/CLI adapters. */
  error?: JsonValue;
  /** Event payload schemas emitted by this operation. */
  events?: Readonly<Record<string, JsonValue>>;
  handler(args: JsonValue): Promise<JsonValue>;
}

/** Who asked. Recorded on every invocation, because "an agent did this" is the first question. */
export type CommandCaller = 'human' | 'agent';

/** The seam. Provider: `flyt-api`, over the same command map the CLI and the renderer use. */
export interface CommandsSeam {
  /** Register a command; the disposer removes it. */
  register(command: CommandDefinition): () => void;
  /** Every command, for a library that lists them and a model that may call them. */
  list(): CommandDefinition[];
  /** Invoke one. The caller is recorded, not inferred. */
  invoke(name: string, args?: JsonValue, caller?: CommandCaller): Promise<JsonValue>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: CommandsSeam;
  }
}
