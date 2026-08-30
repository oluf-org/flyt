// The machine's standing plugin preferences, on disk.
//
// `~/.flyt/cordis.patch.yml` is the `home` layer of the four-layer composition
// (kernel/src/loader/compose.ts): bundles, then the profile, then this, then
// the CLI overlay. A later layer replaces a row BY ID, which is the whole
// reason this file can express "configured differently" and "switched off"
// without owning the row it is talking about.
//
// Everything the plugin manager does at runtime has to land here as well, or it
// is not a change — it is a change until the next restart, which is worse than
// no button at all. `PluginHost.configure/restart/uninstall` move the live
// Cordis fiber; these functions move the reason it was there.
//
// Removal is two different edits depending on where the row came from, and the
// installed record already says which: `source` is the layer that introduced
// it. A row this file introduced is deleted outright — deleting it restores the
// state before somebody added it. A row a bundle or profile introduced cannot
// be deleted from here at all, so it is disabled instead, which is exactly what
// `disabled` is for: switching a row off without deleting the reason it exists.
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '#kernel/loader/yaml.js';

/** The layer name `loadComposition` gives rows that came from this file. */
export const HOME_LAYER = 'home';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Read the patch, or an empty list when there is none.
 *
 * A missing file is the normal state of a machine nobody has configured, not an
 * error. A malformed one IS an error: silently starting from an empty list
 * would throw away whatever a person wrote by hand the moment they press Save.
 */
export function readPluginPatch(file) {
  if (!file || !fs.existsSync(file)) return [];
  const parsed = parseYaml(fs.readFileSync(file, 'utf8'));
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`${file}: a composition patch is a list of entries`);
  for (const entry of parsed) {
    if (!isPlainObject(entry)) throw new Error(`${file}: an entry must be a mapping`);
    if (!entry.id) throw new Error(`${file}: every entry needs an id`);
  }
  return parsed;
}

const NEEDS_QUOTES = /^$|^[-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^\s|^(true|false|null|yes|no|on|off|~)$/i;

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  // A number-shaped string that round-trips as a number is a different value,
  // so it is quoted too. Guessing here is how "id: 007" becomes 7.
  if (NEEDS_QUOTES.test(text) || /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(text) || text.includes('\n')) {
    // YAML's double-quoted scalar takes JSON's escapes, so JSON.stringify is
    // the escaper rather than three hand-written replaces that each have to be
    // right about backslashes.
    return JSON.stringify(text);
  }
  return text;
}

const keys = value => Object.keys(value).filter(key => value[key] !== undefined);

/** `key: value`, block style, as lines. Mappings and lists open a nested block. */
function keyed(key, value, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    return value.length ? [`${pad}${scalar(key)}:`, ...items(value, indent + 1)] : [`${pad}${scalar(key)}: []`];
  }
  if (isPlainObject(value)) {
    const fields = keys(value);
    return fields.length
      ? [`${pad}${scalar(key)}:`, ...fields.flatMap(field => keyed(field, value[field], indent + 1))]
      : [`${pad}${scalar(key)}: {}`];
  }
  return [`${pad}${scalar(key)}: ${scalar(value)}`];
}

/** A block sequence, as lines. A mapping item hangs its first key off the dash. */
function items(list, indent) {
  const pad = '  '.repeat(indent);
  return list.flatMap(item => {
    if (isPlainObject(item)) {
      const fields = keys(item);
      if (!fields.length) return [`${pad}- {}`];
      // The dash occupies the first two columns of what would be the key's
      // indent, so the rest of the mapping lines up under it without a second
      // rule about where a nested block starts.
      const lines = fields.flatMap(field => keyed(field, item[field], indent + 1));
      return [`${pad}- ${lines[0].trimStart()}`, ...lines.slice(1)];
    }
    if (Array.isArray(item)) return item.length ? [`${pad}-`, ...items(item, indent + 1)] : [`${pad}- []`];
    return [`${pad}- ${scalar(item)}`];
  });
}

/** The patch, as the YAML text the loader reads back. */
export function serializePluginPatch(entries = []) {
  const header = '# Flyt plugin preferences for this machine.\n'
    + '# The `home` layer of the plugin composition: rows here patch what the\n'
    + '# profile and package bundles compose, by id. Edited by the plugin\n'
    + '# manager, and safe to edit by hand.\n';
  // An empty patch is the comments and nothing else. `[]` is the obvious way to
  // write it, and the loader's parser does not accept a flow sequence at the
  // document root — it would write a file it could not read back, which is the
  // one failure mode a preferences file must not have.
  if (!entries.length) return header;
  return `${header}${items(entries, 0).join('\n')}\n`;
}

function writePatch(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializePluginPatch(entries), 'utf8');
  return entries;
}

/**
 * Apply one change to the row `id`, preserving everything else about it.
 *
 * @param file — the patch path.
 * @param row — `{ id, name }` from the installed record. `name` is the import
 *   specifier, and it is written only when this file has to introduce the row:
 *   restating a specifier the bundle already owns would pin it here for good.
 * @param patch — the fields to set. `undefined` deletes a field.
 */
function amend(file, row, patch) {
  const entries = readPluginPatch(file);
  const index = entries.findIndex(entry => entry.id === row.id);
  const base = index >= 0 ? entries[index] : { id: row.id, name: row.name };
  const next = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  if (index >= 0) entries[index] = next; else entries.push(next);
  return writePatch(file, entries);
}

/** Remember a plugin's configuration, so the next boot composes it. */
export function persistPluginConfig(file, row, config) {
  return amend(file, row, { config, disabled: undefined });
}

/**
 * Remember that a plugin is gone.
 *
 * A row this file introduced is deleted; any other row is disabled, because
 * this layer cannot remove what a bundle or profile composed — it can only
 * patch it. Both are "uninstalled" to the person who pressed the button, and
 * only one of them is a lie about where the row came from.
 */
export function persistPluginRemoval(file, row) {
  if (row?.source === HOME_LAYER) {
    const remaining = readPluginPatch(file).filter(entry => entry.id !== row.id);
    return writePatch(file, remaining);
  }
  return amend(file, row, { disabled: true });
}

/** Undo a removal: the row composes again at the next boot. */
export function persistPluginRestore(file, row) {
  return amend(file, row, { disabled: undefined });
}
