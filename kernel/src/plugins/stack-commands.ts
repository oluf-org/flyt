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
import {
  configureBlock, configureContainer, insertNode, moveNode, removeNode,
  unwrapContainer, wrapNode, type ContainerNode, type EditResult, type Slot,
} from '../stack/edit.js';
import type { ContainerKind, SequenceNode, StackNode } from '../stack/types.js';

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
    branch: { enum: ['else'], description: 'Use "else" to address an If container’s alternate branch.' },
  },
  required: ['container', 'index'],
} as const;

function slotFrom(value: JsonValue, what: string): Slot {
  const at = value as { container?: unknown; index?: unknown; branch?: unknown } | null;
  if (!at || typeof at.container !== 'string' || typeof at.index !== 'number') {
    throw new Error(`${what} needs a container id and an index`);
  }
  if (at.branch !== undefined && at.branch !== 'else') throw new Error(`${what} branch can only be "else"`);
  return {
    container: at.container, index: at.index,
    ...(at.branch === 'else' ? { branch: 'else' as const } : {}),
  };
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

function authoredContainer(kind: ContainerKind, id: string, config: Record<string, JsonValue>): ContainerNode {
  const common = { id, children: [], position: { line: 0, path: '' } };
  if (kind === 'sequence') return { kind, ...common };
  if (kind === 'parallel') {
    const value = config['maxParallel'];
    return { kind, ...common, maxParallel: value == null ? null : Number(value) };
  }
  if (kind === 'repeat') return { kind, ...common, count: Number(config['count'] ?? 2) };
  if (kind === 'foreach') {
    if (typeof config['roster'] !== 'string' || !config['roster']) {
      throw new Error('a foreach container needs config.roster naming an upstream list output');
    }
    return { kind, ...common, roster: config['roster'], max: Number(config['max'] ?? 8) };
  }
  if (kind === 'until') {
    if (!config['condition'] || typeof config['condition'] !== 'object' || Array.isArray(config['condition'])) {
      throw new Error('an until container needs config.condition naming a declared body output');
    }
    return {
      kind, ...common,
      condition: config['condition'] as unknown as Extract<ContainerNode, { kind: 'until' }>['condition'],
      max: Number(config['max'] ?? 3),
    };
  }
  if (!config['predicate'] || typeof config['predicate'] !== 'object' || Array.isArray(config['predicate'])) {
    throw new Error('an if container needs config.predicate naming an upstream declared output');
  }
  return {
    kind, ...common,
    predicate: config['predicate'] as unknown as Extract<ContainerNode, { kind: 'if' }>['predicate'],
    else: null,
  };
}

const CONTAINER_CONFIG = {
  type: 'object',
  description: 'Settings owned by this container kind.',
} as const;

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
          outputs: [],
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
    {
      name: 'stack:configure-container',
      description: 'Replace the runtime settings owned by a Parallel, Repeat, For each, Until, or If container.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' }, config: CONTAINER_CONFIG },
        required: ['nodeId', 'config'],
      } as unknown as JsonValue,
      async handler(raw) {
        const args = argsOf(raw);
        return settle(configureContainer(stack.get(), nodeId(args), argsOf(args['config'] ?? null)));
      },
    },
    {
      name: 'stack:wrap-block',
      description: 'Wrap an existing block or container in a new control container without changing its position.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          container: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { enum: ['sequence', 'parallel', 'repeat', 'foreach', 'until', 'if'] },
              config: CONTAINER_CONFIG,
            },
            required: ['id', 'kind'],
          },
        },
        required: ['nodeId', 'container'],
      } as unknown as JsonValue,
      async handler(raw) {
        const args = argsOf(raw);
        const spec = argsOf(args['container'] ?? null);
        const id = spec['id'];
        const kind = spec['kind'];
        if (typeof id !== 'string' || !id) throw new Error('a container needs an "id"');
        if (!['sequence', 'parallel', 'repeat', 'foreach', 'until', 'if'].includes(String(kind))) {
          throw new Error('a container "kind" is sequence, parallel, repeat, foreach, until, or if');
        }
        const config = spec['config'] == null ? {} : argsOf(spec['config']);
        return settle(wrapNode(stack.get(), nodeId(args), authoredContainer(kind as ContainerKind, id, config)));
      },
    },
    {
      name: 'stack:unwrap-container',
      description: 'Remove a control container while keeping its children in the same position.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
      } as unknown as JsonValue,
      async handler(raw) {
        return settle(unwrapContainer(stack.get(), nodeId(argsOf(raw))));
      },
    },
  ];

  const disposers = commands.map(command => ctx.commands.register(command));
  return () => { for (const dispose of disposers) dispose(); };
}
