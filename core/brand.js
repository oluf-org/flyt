// The brand, in one place (D29). Flyt is the app; a *flow* is still the thing
// you build in it, so nothing here touches the domain vocabulary — `.flow.yaml`,
// `stacklang`, `StackRunner` and friends keep their names deliberately.
//
// Everything that names the product should import from here rather than
// repeating a literal, so the next rename is a three-line edit instead of an
// archaeology exercise. The two files that CANNOT import it — package.json and
// electron-builder.yml, which are data, not code — are pinned by
// tests/brand.test.js instead.

export const APP_NAME = 'Flyt';              // display: titles, dialogs, docs
export const APP_ID   = 'com.olaaxe.flyt';   // electron appId / bundle id
export const APP_SLUG = 'flyt';              // npm name, storage prefix, tmp dirs

// Log prefix used by the main process and the adapters: `[flyt] ...`.
export const LOG_TAG = `[${APP_SLUG}]`;

// Where settings.json lives, matching Electron's app.getPath('userData') for
// this app name. The desktop app gets it from Electron; every other front door
// — the CLI, the HTTP server — has to compute it, and MUST agree, or the key
// you typed into Settings is invisible to the loop you start from a terminal.
export function defaultUserDataDir({ platform = process.platform, env = process.env, home = null } = {}) {
  const dir = home ?? env.HOME ?? env.USERPROFILE ?? '.';
  if (platform === 'win32') return `${env.APPDATA ?? `${dir}/AppData/Roaming`}/${APP_SLUG}`;
  if (platform === 'darwin') return `${dir}/Library/Application Support/${APP_SLUG}`;
  return `${env.XDG_CONFIG_HOME ?? `${dir}/.config`}/${APP_SLUG}`;
}

// The per-project config directory written into the user's own repo, next to
// .git (D15/D22). Renamed from `.llmflow/` in D29; the legacy directory is
// still read (and adopted on first write) so existing projects keep working.
export const CONFIG_DIR = `.${APP_SLUG}`;

// --- Pre-D29 identifiers -------------------------------------------------
// This file is the ONLY place the old brand may still be written down, and
// tests/brand.test.js exempts it on exactly that basis: every legacy literal is
// here, in the open, tied to the migration that consumes it. Nothing else in
// the repo should name the old brand.
//
// The one unavoidable exception is index.html's pre-paint theme bootstrap — it
// runs before any module loads and so cannot import this file. That line is
// tagged `brand-legacy` for the test.

export const LEGACY_CONFIG_DIR = '.llmflow';
// Electron's userData directory name, which differed between the two builds:
// packaged used electron-builder's productName, dev used package.json `name`.
export const LEGACY_APP_DIRS = ['LLM Flow', 'llm-flow'];
// localStorage prefix: `llmflow-theme`, `llmflow.col.left`, and friends.
export const LEGACY_STORAGE_PREFIX = 'llmflow';

// Pre-cutover stack vocabulary. These names are read only while adopting an
// existing project on its first stack write (D52/D62).
export const LEGACY_FLOWS_DIR = 'flows';
export const LEGACY_FLOW_EXTENSION = '.flow.yaml';
export const LEGACY_FLOW_NODES_KEY = 'nodes';
export const LEGACY_FLOW_GRAPH_KEY = 'flow';
export const LEGACY_RUNNER_NAME = 'FlowRunner';
export const LEGACY_LANGUAGE_NAME = 'flowlang';
