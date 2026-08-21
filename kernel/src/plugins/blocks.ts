/**
 * `flyt-blocks` — the registry a stack's `use` resolves through.
 *
 * The same shape as `flyt-tools`, and for the same reason: there is one place a
 * block can come from, so there is one place to look when a stack names one
 * that is not there.
 *
 * @module #kernel/plugins/blocks
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import {
  BLOCK_CATEGORIES, USE_PATTERN,
  type BlockDefinition, type BlocksService,
} from '../blocks/types.js';
import { isContainer, type StackNode } from '../stack/types.js';

/** Cordis plugin name. */
export const name = 'flyt-blocks';

/**
 * The registry.
 *
 * A Cordis `Service`, so `this.ctx` inside a method is the CALLER's context and
 * a registration is owned by the fiber that made it. Ordinary private fields,
 * never `#private` ones: cordis derives a per-caller view with
 * `Object.create(this)`, through which `#private` state is unreachable.
 */
export class BlockRegistry extends Service implements BlocksService {
  private registered = new Map<string, BlockDefinition>();

  constructor(ctx: Context) {
    super(ctx, 'blocks');
  }

  /**
   * Contribute a block, owned by the calling plugin's fiber.
   *
   * Through `ctx.effect()`, so it goes when the plugin that contributed it
   * unloads. Phase 0 learned this the expensive way: a registration made
   * without it outlives the plugin that made it, and the caller finds out by
   * calling into a torn-down world.
   */
  register(block: BlockDefinition): () => void {
    if (!block?.use) throw new Error('A block needs a "use" — the id a stack names it with');
    if (!USE_PATTERN.test(block.use)) {
      throw new Error(`"${block.use}" is not a usable block id. Ids are lower case, `
        + 'and read `plugin:block` or `block`.');
    }
    if (typeof block.execute !== 'function') throw new Error(`Block "${block.use}" has no execute`);
    if (!BLOCK_CATEGORIES.includes(block.category)) {
      throw new Error(`Block "${block.use}" has no category. There is: ${BLOCK_CATEGORIES.join(', ')}.`);
    }
    const existing = this.registered.get(block.use);
    if (existing) {
      // Named rather than silently replaced: two plugins claiming one id is an
      // installation problem, and the install screen is where it gets fixed.
      throw new Error(`A block named "${block.use}" is already installed`);
    }
    const registered = this.registered;
    const ctx = this.ctx;
    return ctx.effect(() => {
      registered.set(block.use, block);
      ctx.emit('blocks/change');
      return () => {
        if (registered.get(block.use) !== block) return;
        registered.delete(block.use);
        ctx.emit('blocks/change');
      };
    }) as () => void;
  }

  /** One block, or undefined. The parser's `use` is a string until it comes through here. */
  resolve(use: string): BlockDefinition | undefined {
    return this.registered.get(use);
  }

  /** One block, or a refusal that names what there is instead. */
  require(use: string, where = ''): BlockDefinition {
    const found = this.registered.get(use);
    if (found) return found;
    const installed = [...this.registered.keys()].sort();
    const site = where ? ` (${where})` : '';
    throw new Error(installed.length
      ? `No installed plugin contributes a block named "${use}"${site}. Installed: ${installed.join(', ')}.`
      : `No installed plugin contributes a block named "${use}"${site}, and no blocks are installed at all.`);
  }

  /** Every installed block. What the library lists. */
  list(): BlockDefinition[] {
    return [...this.registered.values()].sort((a, b) => a.use.localeCompare(b.use));
  }
}

/**
 * The blocks a tree names that nobody installed.
 *
 * Separate from the registry because it is a question about a STACK, asked of
 * the registry — the editor asks it to draw a missing block as missing (t-0074)
 * and the runner asks it before starting, so a stack fails at block 1 rather
 * than at block 9 after paying for the first eight.
 *
 * @param blocks — the registry.
 * @param root — any node; the whole subtree is walked.
 * @returns `{ id, use }` for each block whose type is not installed, in tree order.
 */
export function missingBlocks(
  blocks: BlocksService,
  root: StackNode,
): { id: string; use: string }[] {
  const out: { id: string; use: string }[] = [];
  const visit = (node: StackNode): void => {
    if (node.kind === 'block') {
      if (!blocks.resolve(node.use)) out.push({ id: node.id, use: node.use });
      return;
    }
    if (isContainer(node)) for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/**
 * Provide `ctx.blocks`.
 *
 * @param ctx — the context to provide in.
 */
export function apply(ctx: Context): void {
  new BlockRegistry(ctx);
}
