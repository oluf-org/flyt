import type { Context, Fiber } from '@deepseek-ai/cordis';

// Internal capability shared only by the loader and the registry. The loader
// reaches this path after resolving an exact built-in name with Flyt's own
// importer; public `ctx.plugin()` never marks a fiber trusted.
const trustedRoots = new WeakSet<Fiber>();

export async function installTrustedPlugin(
  ctx: Context,
  plugin: unknown,
  config?: unknown,
): Promise<Fiber> {
  const loading = ctx.plugin(plugin as any, config as any);
  trustedRoots.add(loading.ctx.fiber);
  return await loading;
}

export function belongsToTrustedPlugin(fiber: Fiber): boolean {
  let current = fiber;
  while (true) {
    if (trustedRoots.has(current)) return true;
    const parent = current.parent?.fiber;
    if (!parent || parent === current) return false;
    current = parent;
  }
}
