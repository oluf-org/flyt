/**
 * The v2 kernel: a Cordis context, the plugin tree it roots, and its lifecycle.
 *
 * Everything a third-party plugin can touch is typed and lives under this
 * package (D53). Nothing here is imported while the v2 flag is off (D62).
 *
 * @module #kernel
 */
import { Context } from '@deepseek-ai/cordis';

/**
 * Which surface a kernel serves.
 *
 * Composition ships one profile per surface so a Loop worker gets a genuinely
 * narrower plugin tree rather than the same tree with flags off. The profiles
 * are named here; the layering that resolves them is the loader's (`t-0045`).
 */
export type ProfileName = 'flyt-desktop' | 'flyt-cli' | 'flyt-loop-worker';

/** Options accepted by {@link createKernel}. */
export interface KernelOptions {
  /** Base URL relative plugin specifiers resolve against. */
  baseUrl?: string;
  /** The surface profile to compose. Defaults to `flyt-cli`. */
  profile?: ProfileName;
}

/** A booted kernel: its root context, the profile it composed, and teardown. */
export interface Kernel {
  /** The root context. Plugins mount here; seams resolve through it. */
  readonly ctx: Context;
  /** The profile this kernel composed. */
  readonly profile: ProfileName;
  /**
   * Tear the plugin tree down, running every fiber's disposers.
   *
   * Idempotent: disposing twice is not an error, because a caller that
   * crashed halfway through shutdown must be able to finish it.
   */
  dispose(): Promise<void>;
}

/**
 * Boot a kernel.
 *
 * The context is empty on purpose — seams are provided by plugins, never by
 * the kernel itself, so that every consumer resolves a seam the same way
 * whether Flyt or a third party provided it.
 *
 * @param options — base URL and surface profile.
 * @returns the booted kernel.
 */
export function createKernel(options: KernelOptions = {}): Kernel {
  const ctx = new Context();
  const profile = options.profile ?? 'flyt-cli';
  if (options.baseUrl) ctx.baseUrl = options.baseUrl;

  let disposed: Promise<void> | null = null;
  return {
    ctx,
    profile,
    dispose() {
      disposed ??= ctx.fiber.dispose();
      return disposed;
    },
  };
}

export { Context };
