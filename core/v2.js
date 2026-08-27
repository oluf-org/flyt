// The v2 flag (D62).
//
// One flag gates the whole v2 stack — the Cordis kernel, the seams, the
// session log as the canonical record, and the Work/Build/Trace surfaces when
// they arrive. It defaults OFF, and with it off the shipping app must behave
// exactly as it did before any of that existed.
//
// "Behaves exactly as before" is not a promise you keep by intending to. It is
// kept by never importing the v2 tree at all: `bootKernel` below is the only
// door, it is a DYNAMIC import, and it is not opened when the flag is off. A
// test can watch that door.
//
// Precedence, most specific first — the call, the environment, the settings,
// then the default. A machine driving a loop is often not the machine whose
// settings.json holds the answer, which is the same reason the loop's models
// and reviewer are nameable at the call.

/** How the flag was decided, so a diagnostic can say why. */
export const V2_SOURCES = ['call', 'env', 'settings', 'default'];

/**
 * Is v2 on, and who said so.
 *
 * @param {object} [options]
 * @param {boolean|null} [options.call] — an explicit choice at the call site (`--v2`, `--no-v2`).
 * @param {object} [options.settings] — the saved settings (`settings.v2`).
 * @param {object} [options.env] — the environment (`FLYT_V2`).
 * @returns {{ enabled: boolean, source: 'call'|'env'|'settings'|'default' }}
 */
export function v2Flag({ call = null, settings = null, env = process.env } = {}) {
  if (call === true || call === false) return { enabled: call, source: 'call' };

  const raw = env?.FLYT_V2;
  if (raw !== undefined && raw !== '') {
    // An environment variable is a string, and "0"/"false"/"off" mean off.
    // Reading any non-empty value as true is how FLYT_V2=0 turns a feature on.
    const off = ['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
    return { enabled: !off, source: 'env' };
  }

  if (typeof settings?.v2 === 'boolean') return { enabled: settings.v2, source: 'settings' };
  return { enabled: true, source: 'default' };
}

/** Convenience: just the answer. */
export const isV2Enabled = options => v2Flag(options).enabled;

/**
 * Boot the v2 kernel, if the flag is on.
 *
 * The import is dynamic and conditional on purpose: with the flag off, no v2
 * module is loaded, so v2 cannot change the behaviour of a v1 run by existing.
 * That is the whole content of "ships behind a flag".
 *
 * @param {object} [options]
 * @param {boolean|null} [options.call] — an explicit choice at the call site.
 * @param {object} [options.settings] — the saved settings.
 * @param {object} [options.env] — the environment.
 * @param {string} [options.profile] — which surface profile to compose.
 * @param {string} [options.runsRoot] — where session logs live.
 * @param {'ask'|'smart'|'always'} [options.approvalMode] — how this surface approves.
 * @param {Function} [options.onReviewReady] — synchronously attach the host review surface before startup plugins install.
 * @param {Function} [options.load] — the importer, injectable so a test can watch the door.
 * @returns {Promise<null|{ kernel: object, ctx: object, dispose: Function }>} null when the flag is off.
 */
export async function bootKernel({
  call = null, settings = null, env = process.env,
  profile = 'flyt-cli', runsRoot = null, approvalMode = 'ask',
  onReviewReady = null,
  load = () => import('#kernel')
} = {}) {
  const flag = v2Flag({ call, settings, env });
  if (!flag.enabled) return null;

  const kernelModule = await load();
  const { createKernel, loadComposition, PROFILES, builtinImporter } = kernelModule;

  const kernel = createKernel({ profile });
  const profileEntries = (PROFILES[profile] ?? PROFILES['flyt-cli']).map(entry => {
    if (entry.id === 'sessions' && runsRoot) return { ...entry, config: { root: runsRoot } };
    // The surface's approval mode is a property of WHO is watching, and the
    // caller knows that; the profile only says what the default is.
    if (entry.id === 'approvals') return { ...entry, config: { ...(entry.config ?? {}), mode: approvalMode } };
    return entry;
  });

  const { entries } = loadComposition({ profile, profileEntries });
  const prepared = {
    kernel, ctx: kernel.ctx, pluginReviews: kernel.pluginReviews,
    install: (pluginEntries, installOptions) => kernel.install(pluginEntries, installOptions),
    // Host-only projection of the RPC service. Renderers receive the cloned
    // rows this returns, never the Cordis context or an invoke capability.
    uiExtensions: {
      list(point = null) {
        const rpc = kernel.ctx.uiExtensions;
        if (!rpc) return [];
        const response = rpc.invoke({ method: 'ui.list', params: point ? { point } : {} });
        if (!response.ok) throw new Error(response.error.message);
        return response.result;
      },
      subscribe(listener) {
        return kernel.ctx.on('ui-extensions/change', listener);
      },
    },
    dispose: () => kernel.dispose(), source: flag.source, profile,
  };
  try {
    // This hook is deliberately synchronous: the host attaches its listener
    // and returns, then startup installation may publish a pending review. It
    // gives UI code the coordinator before boot's promise can be parked on it.
    if (typeof onReviewReady === 'function') onReviewReady(prepared);
    await kernel.install(entries, { import: builtinImporter });
  } catch (error) {
    await kernel.dispose();
    throw error;
  }

  return prepared;
}
