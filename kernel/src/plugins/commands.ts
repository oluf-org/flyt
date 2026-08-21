/**
 * `flyt-api` — the command surface, and the reason there is only one.
 *
 * Every Build operation is available to an agent here, and every agent
 * operation renders in the editor as it happens (D63). A command only a human
 * can reach, or only an agent can reach, is a bug in this seam — which is the
 * same argument the tool registry makes about execution: there is no second
 * path, so there is no second set of rules.
 *
 * What that buys concretely: a block a model inserted animates the way a
 * dragged one does, because the editor is listening to the same event either
 * way and the event carries the same record.
 *
 * @module #kernel/plugins/commands
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { CommandCaller, CommandDefinition, CommandsSeam } from '../seams/commands.js';

/** Cordis plugin name. */
export const name = 'flyt-api';

/**
 * The command map.
 *
 * A Cordis `Service`, so `this.ctx` inside a method is the CALLER's context and
 * a registration is owned by the fiber that made it. Ordinary private fields,
 * never `#private` ones: cordis derives a per-caller view with
 * `Object.create(this)`, through which `#private` state is unreachable.
 */
export class CommandMap extends Service implements CommandsSeam {
  private registered = new Map<string, CommandDefinition>();

  constructor(ctx: Context) {
    super(ctx, 'commands');
  }

  /**
   * Register a command, owned by the calling plugin's fiber.
   *
   * Through `ctx.effect()`, so it goes when the plugin that contributed it
   * unloads. A command that outlives its plugin is a command whose handler
   * closes over a torn-down world, and the caller finds out by calling it.
   */
  register(command: CommandDefinition): () => void {
    if (!command?.name) throw new Error('A command needs a name');
    if (typeof command.handler !== 'function') throw new Error(`Command "${command.name}" has no handler`);
    if (this.registered.has(command.name)) {
      throw new Error(`A command named "${command.name}" is already registered`);
    }
    const registered = this.registered;
    const ctx = this.ctx;
    return ctx.effect(() => {
      registered.set(command.name, command);
      return () => {
        if (registered.get(command.name) !== command) return;
        registered.delete(command.name);
      };
    }) as () => void;
  }

  /** Every command — for a library that lists them and a model that may call them. */
  list(): CommandDefinition[] {
    return [...this.registered.values()];
  }

  /**
   * Invoke one.
   *
   * The caller is recorded, never inferred: "an agent did this" is the first
   * question anyone asks about a change they did not make, and a surface that
   * has to guess the answer will guess it wrong exactly when it matters.
   */
  async invoke(commandName: string, args: JsonValue = null, caller: CommandCaller = 'human'): Promise<JsonValue> {
    const command = this.registered.get(commandName);
    if (!command) {
      const known = [...this.registered.keys()].sort();
      throw new Error(known.length
        ? `There is no command "${commandName}". There is: ${known.join(', ')}.`
        : `There is no command "${commandName}", and none are registered.`);
    }
    const ctx = this.ctx;
    const at = new Date().toISOString();
    let result: JsonValue;
    try {
      result = await command.handler(args ?? null);
    } catch (err) {
      // The failure is announced too. An edit that was attempted and refused is
      // a thing the editor has to stop animating, and a thing a person watching
      // an agent work needs to see.
      ctx.emit('commands/invoke', {
        name: commandName, caller, args: args ?? null, at,
        error: String((err as Error)?.message ?? err),
      });
      throw err;
    }
    ctx.emit('commands/invoke', { name: commandName, caller, args: args ?? null, at, result });
    return result;
  }
}

/**
 * Provide `ctx.commands`.
 *
 * @param ctx — the context to provide in.
 */
export function apply(ctx: Context): void {
  new CommandMap(ctx);
}
