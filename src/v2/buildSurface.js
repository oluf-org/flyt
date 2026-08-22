// What Build is given to edit, and where it comes from.
//
// One place, so there is one answer. The renderer cannot hold a cordis context
// — the kernel lives in the main process — so the command surface arrives here
// as a bridge with the shape `ctx.commands` has: `invoke(name, args, caller)`
// and a subscription to `commands/invoke`. In tests the real service is passed
// straight in, which is the point: the editor cannot tell the difference, and
// neither can a model (D63).
//
// Until Phase 2 puts stacks on disk (`stacks/<id>.stack.yaml`), a project has
// none, and Build renders an empty editor. That is the honest answer for a
// project with no stacks in it, and it is a different thing from a broken one.

/**
 * Ask the host what Build should edit.
 *
 * @param host — `window.flyt`, or anything with the same shape.
 * @returns `{ stack, blocks, commands }`, or null when the host offers none.
 */
export async function buildSurface(host = globalThis.window?.flyt ?? null) {
  if (typeof host?.v2Build !== 'function') return null;
  try {
    const surface = await host.v2Build();
    return surface?.stack ? surface : null;
  } catch {
    // A host that cannot answer leaves Build empty rather than broken. There is
    // nothing a person can do about it from inside the editor, and an error
    // where a blank canvas belongs reads as the feature being broken.
    return null;
  }
}
