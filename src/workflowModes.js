// What a mode IS, in the renderer.
//
// One workflow is one graph. Its modes are named settings over that graph — a
// mode may change the configuration of blocks that already exist, and nothing
// else. Low, Medium and High are three ways to run Pipeline, not three
// Pipelines; a different shape is a different workflow, which is what Build's
// Duplicate is for.
//
// Two consequences follow, and they are the reason this file exists rather
// than the rule being restated in each surface:
//
//   1. A workflow that declares modes ALWAYS runs in one of them. There is no
//      fourth, unnamed way to run a stack that has three named ones, so an
//      absent choice resolves to the default rather than meaning "no mode".
//   2. The default is the mode marked `default: true` in the file, and failing
//      that the first one written.
//
// The kernel's `defaultPresetId` says the same thing about a parsed stack, and
// the runner applies it. This is its renderer-side twin, because the renderer
// has no kernel. `tests/workflowUx.test.js` holds the two to being one rule.
//
// It lives outside `src/v2/` so the composer can import it without a non-v2
// module reaching into the lazily-loaded shell.

/**
 * A workflow's modes, however the caller happens to hold them.
 *
 * The chat picker gets them as a list over IPC and Build gets the parsed
 * mapping. Both are the same modes.
 */
export function workflowModes(flow) {
  const raw = flow?.presets ?? flow?.modes ?? [];
  const rows = Array.isArray(raw)
    ? raw.filter(Boolean).map(row => ({ ...row, id: String(row.id) }))
    : Object.entries(raw).map(([id, preset]) => ({ ...(preset ?? {}), id }));
  return rows.map(row => ({
    ...row,
    name: row.name || row.id,
    description: row.description ?? '',
    overrides: row.overrides ?? {},
    default: row.default === true,
  }));
}

/** The mode a workflow runs in when nobody picked one, or null when it has none. */
export function defaultModeId(flow) {
  const modes = workflowModes(flow);
  if (!modes.length) return null;
  return (modes.find(mode => mode.default) ?? modes[0]).id;
}
