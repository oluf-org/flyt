// Pure routing for the v2 shell (t-0073). Kept free of React so the contract
// is testable in node:test without a renderer. Shell.jsx is a thin view over
// these functions; the whole "permanent destinations, routing, run carried"
// rule lives here so a test can hold the renderer to it.
//
// Work, Build, Library and Models are permanent destinations, reached from the
// navigation rail. Trace is not a peer — it appears when a run is addressed and
// it is that run's record (D60), so it is a property of a location, not a place
// to go.

/** Permanent destinations. Trace is deliberately not one. */
export const WORK = 'work';
export const BUILD = 'build';
export const LIBRARY = 'library';
export const MODELS = 'models';
export const HISTORY = 'history';
export const CHATS = 'chats';
export const GOALS = 'goals';

export const DESTINATIONS = Object.freeze([WORK, BUILD, GOALS, CHATS, LIBRARY, MODELS, HISTORY]);

/**
 * A location in the shell: a destination, an optional addressed run, and an
 * optional addressed workflow.
 *
 * The workflow is to Build what the run is to Trace. Build with no workflow
 * addressed is the gallery — every workflow in the project, and the New button.
 * Build with one addressed is the editor for it. Keeping it in the location
 * rather than in the editor's own state is what makes "leave Build, come back,
 * still editing the same workflow" true without anything remembering it.
 */
export const INITIAL = Object.freeze({ dest: WORK, run: null, workflow: null });

/** Trace is shown iff a run is addressed, from anywhere. */
export function traceOf(location) {
  return location?.run ? { run: location.run } : null;
}

/** Navigate to a permanent destination, carrying the run and the workflow
 *  through so moving between Work and Build never loses either one. */
export function navigate(location, to) {
  return { dest: to, run: location?.run ?? null, workflow: location?.workflow ?? null, ...(location?.goal ? { goal: location.goal } : {}) };
}

/** Address a workflow: Build, editing that one. */
export function openWorkflow(location, id) {
  return { dest: BUILD, run: location?.run ?? null, workflow: id ?? null };
}

/** Let go of the workflow, which is how Build gets back to its gallery. */
export function closeWorkflow(location) {
  return { ...(location ?? INITIAL), dest: BUILD, workflow: null };
}

/**
 * Which of Build's two views a location asks for.
 *
 * One question with one answer, so the renderer cannot decide it differently
 * from the rail, the gallery, and the back button.
 */
export function builderView(location) {
  return location?.workflow ? 'editor' : 'gallery';
}

/** Every permanent destination is reachable from every other in one hop. */
export const adjacent = from => DESTINATIONS.filter(d => d !== from.dest);

/** Heading copy for a destination. */
export function heading(dest) {
  if (dest === GOALS) return 'Goals';
  if (dest === BUILD) return 'Build';
  if (dest === LIBRARY) return 'Library';
  if (dest === MODELS) return 'Models';
  if (dest === HISTORY) return 'Statistics';
  if (dest === CHATS) return 'Chats';
  if (dest === WORK) return 'Work';
  return null;
}

/**
 * What the rail says under each icon, and why you would press it.
 *
 * The hint is the tooltip, and it is the only place the rail explains itself —
 * a four-icon column with no words is a column you have to learn rather than
 * read, and the labels alone cannot say what Build is FOR.
 */
export function hint(dest) {
  if (dest === GOALS) return 'Goals — repeat a workflow toward fixed acceptance criteria';
  if (dest === WORK) return 'Work — run a workflow and watch it';
  if (dest === BUILD) return 'Build — every workflow in this project, and the one you are editing';
  if (dest === LIBRARY) return 'Library — everything installed, and the plugins that install it';
  if (dest === MODELS) return 'Models — the catalog and what each one costs';
  if (dest === HISTORY) return 'Statistics — loops, models and workflow usage';
  if (dest === CHATS) return 'Chats — previous loops and workflows';
  return null;
}

/** A thin, judgement-proof view of where the shell stands. */
export function state(location) {
  const dest = location?.dest ?? WORK;
  return {
    dest,
    run: location?.run ?? null,
    workflow: location?.workflow ?? null,
    trace: traceOf(location),
    surface: DESTINATIONS.includes(dest) ? dest : WORK,
    builder: builderView(location),
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
