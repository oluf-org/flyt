/**
 * `flyt-stack-commands` — the four stack edits, as commands.
 *
 * This is where D63 stops being an intention. The editor does not call
 * `moveNode`; it invokes `stack:move-block`, and so does a model, and the
 * event that comes back out is the same record either way. There is no code
 * path a human can reach that an agent cannot, because there is only one path.
 *
 * Each command declares a JSON Schema for its arguments, which is what lets a
 * model call it as a tool without anything writing a second description of the
 * same operation.
 *
 * @module #kernel/plugins/stack-commands
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '../types.js';
import type { CommandDefinition } from '../seams/commands.js';
import { configureBlock, insertNode, moveNode, removeNode, type EditResult, type Slot } from '../stack/edit.js';
import type { SequenceNode, StackNode } from '../stack/types.js';

/** Cordis plugin name. */
export const name = 'flyt-stack-commands';

/**
 * Where the tree being edited lives.
 *
 * A held reference rather than a parameter on every command: the editor and an
 * agent are editing the SAME stack, and an operation that took the tree as an
 * argument would let them edit two.
 */
export interface StackHandle {
  get(): SequenceNode;
  /** Called with the result of an accepted edit. */
  set(root: SequenceNode): void;
}

const SLOT = {
  type: 'object',
  properties: {
    container: { type: 'string', description: 'The id of the sequence or parallel it goes into.' },
    index: { type: 'integer', minimum: 0, description: 'Position among that container’s children; its child count means "last".' },
  },
  required: ['container', 'index'],
} as const;

function slotFrom(value: JsonValue, what: string): Slot {
  const at = value as { container?: unknown; index?: unknown } | null;
  if (!at || typeof at.container !== 'string' || typeof at.index !== 'number') {
    throw new Error(`${what} needs a container id and an index`);
  }
  return { container: at.container, index: at.index };
}

function argsOf(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('this command takes a mapping of arguments');
  }
  return value as Record<string, JsonValue>;
}

function nodeId(args: Record<string, JsonValue>): string {
  const id = args['nodeId'];
  if (typeof id !== 'string' || !id) throw new Error('"nodeId" names the block or container to act on');
  return id;
}

/**
 * Register the four edits against a stack.
 *
 * @param ctx — the context to register in; the disposers are owned by its fiber.
 * @param stack — the tree being edited.
 * @returns a disposer removing all four.
 */
export function registerStackCommands(ctx: Context, stack: StackHandle): () => void {
  // Applied here rather than in each handler so that a command CANNOT settle
  // without the tree it produced becoming the tree: an edit that returned a
  // record the editor animated while the stack stayed as it was is the exact
  // disagreement containment exists to make impossible.
  const settle = (result: EditResult): JsonValue => {
    stack.set(result.root);
    return result.change as unknown as JsonValue;
  };

  const commands: CommandDefinition[] = [
    {
      name: 'stack:insert-block',
      description: 'Put a block into a container at a position.',
      parameters: {
        type: 'object',
        properties: {
          block: {
            type: 'object',
            description: 'The block: an id, and the `use` naming a block type a plugin contributed.',
            properties: {
              id: { type: 'string' },
              use: { type: 'string' },
              title: { type: 'string' },
              config: { type: 'object' },
            },
            required: ['id', 'use'],
          },
          at: SLOT,
        },
        required: ['block', 'at'],
      } as unknown as JsonValue,
      async handler(raw) {
        const args = argsOf(raw);
        const spec = argsOf(args['block'] ?? null);
        if (typeof spec['id'] !== 'string' || typeof spec['use'] !== 'string') {
          throw new Error('a block needs an "id" and a "use"');
        }
        const block: StackNode = {
          kind: 'block',
          id: spec['id'],
          use: spec['use'],
          title: typeof spec['title'] === 'string' ? spec['title'] : null,
          config: (spec['config'] ?? {}) as Record<string, JsonValue>,
          // Authored rather than parsed, so there is no line to point at. The
          // path is filled in when the stack is next written and read back.
          position: { line: 0, path: '' },
        };
        return settle(insertNode(stack.get(), block, slotFrom(args['at'] ?? null, '"at"')));
      },
    },
    {
      name: 'stack:move-block',
      description: 'Move a block or container to another position. The index reads against the stack as it is now.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, to: SLOT },
        required: ['nodeId', 'to'],
      } as unknown as JsonValue,
      async handler(raw) {
        const args = argsOf(raw);
        return settle(moveNode(stack.get(), nodeId(args), slotFrom(args['to'] ?? null, '"to"')));
      },
    },
    {
      name: 'stack:remove-block',
      description: 'Take a block or container out. A container takes its children with it.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
      } as unknown as JsonValue,
      async handler(raw) {
        return settle(removeNode(stack.get(), nodeId(argsOf(raw))));
      },
    },
    {
      name: 'stack:configure-block',
      description: 'Replace a block’s settings, whole. What they mean is the block’s business.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, config: { type: 'object' } },
        required: ['nodeId', 'config'],
      } as unknown as JsonValue,
      async handler(raw) {
        const args = argsOf(raw);
        return settle(configureBlock(stack.get(), nodeId(args), argsOf(args['config'] ?? null)));
      },
    },
  ];

  const disposers = commands.map(command => ctx.commands.register(command));
  return () => { for (const dispose of disposers) dispose(); };
}
