// Pure routing for the v2 shell (t-0073). Kept free of React so the contract
// is testable in node:test without a renderer. Shell.jsx is a thin view over
// these functions; the whole "three destinations, routing, run carried" rule
// lives here so a test can hold the renderer to it.
//
// Work, Build and Models are permanent destinations. Trace is not a peer — it appears
// when a run is addressed and it is that run's record (D60), so it is a
// property of a location, not a place to go.

/** Permanent destinations. Trace is deliberately not one. */
export const WORK = 'work';
export const BUILD = 'build';
export const MODELS = 'models';

export const DESTINATIONS = Object.freeze([WORK, BUILD, MODELS]);

/** A location in the shell: a destination plus an optional addressed run. */
export const INITIAL = Object.freeze({ dest: WORK, run: null });

/** Trace is shown iff a run is addressed, from anywhere. */
export function traceOf(location) {
  return location?.run ? { run: location.run } : null;
}

/** Navigate to a permanent destination, carrying the run address through so
 *  moving between Work and Build never loses the run being watched. */
export function navigate(location, to) {
  return { dest: to, run: location?.run ?? null };
}

/** Every permanent destination is reachable from every other in one hop. */
export const adjacent = from => DESTINATIONS.filter(d => d !== from.dest);

/** Heading copy for a destination. */
export function heading(dest) {
  if (dest === BUILD) return 'Build';
  if (dest === MODELS) return 'Models';
  if (dest === WORK) return 'Work';
  return null;
}

/** A thin, judgement-proof view of where the shell stands. */
export function state(location) {
  return {
    dest: location?.dest ?? WORK,
    run: location?.run ?? null,
    trace: traceOf(location),
    surface: location?.dest === BUILD ? 'build' : location?.dest === MODELS ? 'models' : 'work',
  };
}
/**
 * Which location the shell renders: the host's, when a host is driving, and
 * otherwise its own.
 *
 * A one-line decision, extracted because it was wrong and nothing could see it.
 * `Shell.jsx` defaulted its `location` prop to `INITIAL` and then wrote
 * `location ?? own` — so the fallback could never fire, its own state was
 * written and never read, and every click set a value nothing rendered. Every
 * routing test passed, because they call `navigate()` and never mount the
 * component. Found by clicking Build in a browser and watching the heading
 * stay on Work.
 *
 * @param controlled — the host's location, or null/undefined when there is no host.
 * @param own — the shell's own state.
 */
export function resolveLocation(controlled, own) {
  return controlled ?? own ?? INITIAL;
}
