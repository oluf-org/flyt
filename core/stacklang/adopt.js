// Adopt: promote a flow designed in the INSTALLED app into a shipped default.
//
// The round trip this closes (D28): a packaged build keeps its flows in
// userData/flows, because the bundled copy inside app.asar is read-only. So a
// flow you design in the installed app lives outside the repo entirely. Adopt
// copies it back into flows/ and gives it a stable slug id — which is also
// exactly what makes it ship, since electron-builder excludes `flows/flow-*`
// (the ids flow:new mints for scratch work).
//
// Everything here is pure-ish and fs-only so it can be tested without Electron.
import fs from 'node:fs';
import path from 'node:path';
import { parseFlow } from './parse.js';
import { APP_NAME } from '../brand.js';

// electron-builder.yml productName — app.getPath('userData') is
// <platform app-data root>/<productName>. Re-exported rather than re-stated so
// there is exactly one literal in the repo (D29).
export const PRODUCT_NAME = APP_NAME;

// The installed app's flows directory, mirroring Electron's userData rules.
// Kept as an explicit reimplementation rather than a guess: this module runs in
// plain node (the repo CLI), where app.getPath() does not exist.
export function installedFlowsDir({ platform = process.platform, env = process.env, home = null } = {}) {
  const homeDir = home ?? env.HOME ?? env.USERPROFILE ?? '';
  const root =
    platform === 'win32' ? (env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'))
    : platform === 'darwin' ? path.join(homeDir, 'Library', 'Application Support')
    : (env.XDG_CONFIG_HOME || path.join(homeDir, '.config'));
  return path.join(root, PRODUCT_NAME, 'flows');
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

// A flow name -> a stable, shippable id. "Deep Research v2" -> "deep-research-v2".
export function slugFlowId(name) {
  if (typeof name !== 'string') return null;
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// A flow only ships if its id doesn't collide with the scratch-id exclusion in
// electron-builder.yml. Names beginning with the word "flow" are the trap.
export function willShip(id) {
  return SAFE_ID.test(id) && !id.startsWith('flow-');
}

// Rewrite the top-level `id:` line in place. Line-targeted rather than a
// parse/serialize round trip so comments and formatting survive; the result is
// re-parsed before it is returned, so a botched edit can't be written out.
export function reidFlowText(text, newId) {
  if (!SAFE_ID.test(newId)) throw new Error(`Invalid flow id "${newId}"`);
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex(l => /^id:\s/.test(l));
  if (i === -1) throw new Error('flow file has no top-level "id:" line');
  lines[i] = `id: ${newId}`;
  const out = lines.join('\n');
  const parsed = parseFlow(out);
  if (parsed.id !== newId) throw new Error(`re-id failed: file still reports id "${parsed.id}"`);
  return out;
}

// Flows available to adopt, newest first — id, name, and whether the id would
// ship as-is.
export function listFlows(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.flow.yaml')); }
  catch { return []; }
  return files
    .map(f => {
      const full = path.join(dir, f);
      try {
        const flow = parseFlow(fs.readFileSync(full, 'utf8'));
        return { id: flow.id, name: flow.name, file: full, mtime: fs.statSync(full).mtimeMs, ships: willShip(flow.id) };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// Copy <id> from `from` into `to`, re-id'd to `as` (default: a slug of the
// flow's name). Returns what happened; throws rather than overwriting.
export function adoptFlow({ from, to, id, as = null, overwrite = false }) {
  const src = path.join(from, `${id}.flow.yaml`);
  if (!fs.existsSync(src)) throw new Error(`no flow "${id}" in ${from}`);
  const text = fs.readFileSync(src, 'utf8');
  const flow = parseFlow(text);

  const newId = as ?? slugFlowId(flow.name) ?? id;
  if (!SAFE_ID.test(newId)) throw new Error(`"${flow.name}" does not slug to a usable id — pass --as <id>`);

  const dest = path.join(to, `${newId}.flow.yaml`);
  if (fs.existsSync(dest) && !overwrite) {
    throw new Error(`${newId}.flow.yaml already exists in ${to} — pass --force to replace it`);
  }
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(dest, reidFlowText(text, newId), 'utf8');

  // The layout sidecar is keyed by NODE id, so re-id'ing the flow leaves it
  // untouched — only the filename changes.
  const srcLayout = path.join(from, `${id}.layout.json`);
  let layout = false;
  if (fs.existsSync(srcLayout)) {
    fs.writeFileSync(path.join(to, `${newId}.layout.json`), fs.readFileSync(srcLayout, 'utf8'), 'utf8');
    layout = true;
  }
  return { id: newId, from: id, name: flow.name, file: dest, layout, ships: willShip(newId) };
}
