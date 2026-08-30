// What the plugin manager knows, without React.
//
// The manager's whole job is to be honest about one list, so the judgements it
// makes — is this removable, what is this waiting for, what breaks if it goes —
// live out here where a test can hold them. `PluginManager.jsx` is the view.
//
// Every function reads only what `InstalledPlugin` already publishes
// (kernel/src/loader/host.ts). Nothing here infers capability from a name or a
// description: a plugin's reach is decided at the trust review and by the
// block ceilings, never by a list that is trying to draw a card.

/** Which lifecycle states the host can report. Closed, so an unknown one is loud. */
export const PLUGIN_STATES = ['active', 'pending', 'failed'];

/** The verbs the manager can offer. Closed for the same reason the states are. */
export const PLUGIN_ACTIONS = ['configure', 'restart', 'uninstall'];

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The status pill: what this row is doing, and whether that is a problem.
 *
 * `pending` is Cordis's word for a fiber whose injected services are not all
 * present. It is not an error and it is not "installing" — the plugin is
 * mounted and waiting, and saying so names something a person can act on
 * (install what it injects) instead of leaving them watching a spinner.
 */
export function pluginStatus(plugin) {
  const state = PLUGIN_STATES.includes(plugin?.state) ? plugin.state : 'active';
  if (state === 'failed') {
    return {
      state, tone: 'err', label: 'Failed',
      detail: text(plugin?.error) || 'The last lifecycle call failed and gave no reason.',
    };
  }
  if (state === 'pending') {
    const waiting = (plugin?.inject ?? []).filter(Boolean);
    return {
      state, tone: 'warn', label: 'Waiting',
      detail: waiting.length
        ? `Mounted, but held until every service it needs exists: ${waiting.join(', ')}.`
        : 'Mounted, but held until the services it needs exist.',
    };
  }
  return { state, tone: 'ok', label: 'Active', detail: 'Running, and its contributions are live.' };
}

/**
 * Where this row came from, in words.
 *
 * `source` is the composition layer that last introduced the row, which is the
 * only answer to "why is this plugin here" that does not require reading four
 * files. The layer names come from `loadComposition`.
 */
export function pluginProvenance(plugin) {
  const source = text(plugin?.source);
  if (source === 'home') return { label: 'This machine', detail: 'Added in ~/.flyt/cordis.patch.yml.' };
  if (source === 'cli') return { label: 'Command line', detail: 'Named at launch; it is not saved anywhere.' };
  if (source.startsWith('bundle:')) {
    return { label: source.slice(7), detail: 'Composed by an installed package that ships plugin rows.' };
  }
  if (source.startsWith('profile:')) {
    return { label: source.slice(8), detail: 'Part of the profile this surface composes.' };
  }
  return { label: source || 'Runtime', detail: 'Mounted at runtime.' };
}

/**
 * Whether this row may be removed, and why not when it may not.
 *
 * Built-ins are the services the surface is made of — the block registry, the
 * tool gate, the approval policy. Removing one leaves a window with nothing
 * behind it, so the manager inspects them and stops there. A group is removed
 * through the rows inside it, because that is how it was composed.
 */
export function pluginRemovable(plugin) {
  // Group first: the host marks every group `builtin` because there is no
  // module behind it, so asking about `builtin` first told a person their own
  // group was part of Flyt.
  if (plugin?.group) {
    return { ok: false, reason: 'A group is composed from the rows inside it. Remove those instead.' };
  }
  if (plugin?.builtin) {
    return { ok: false, reason: 'This is part of Flyt itself. It can be inspected, not removed.' };
  }
  return { ok: true, reason: null };
}

/** Whether this row has a configuration the manager may edit. */
export function pluginConfigurable(plugin) {
  if (plugin?.group) {
    return { ok: false, reason: 'A group holds child rows, not settings. Configure the rows inside it.' };
  }
  if (plugin?.builtin) {
    return { ok: false, reason: 'Built-in rows are configured by the profile that composes them.' };
  }
  return { ok: true, reason: null };
}

/**
 * The buttons this row gets, in order, most-expected first.
 *
 * Context-sensitive because the alternative — every verb on every row, most of
 * them refused on press — teaches people that the buttons are decoration. A
 * failed row leads with Retry because retrying is what you came to do.
 */
export function pluginActions(plugin) {
  const configurable = pluginConfigurable(plugin);
  const removable = pluginRemovable(plugin);
  const status = pluginStatus(plugin);
  const out = [];
  // Flyt's own services get no verbs at all. Restarting the tool registry or
  // the approval policy disposes the gate every running block is checked
  // against; "inspect only" has to mean the whole lifecycle, not just removal.
  const lifecycle = !plugin?.builtin && !plugin?.group;
  if (lifecycle && status.state === 'failed') {
    out.push({ id: 'restart', label: 'Retry', tone: 'primary', hint: 'Mount it again and report what happens.' });
  } else if (lifecycle) {
    out.push({ id: 'restart', label: 'Restart', tone: 'default', hint: 'Dispose and mount this plugin again.' });
  }
  if (configurable.ok) {
    out.push({
      id: 'configure',
      label: 'Configure',
      tone: status.state === 'failed' ? 'default' : 'primary',
      hint: 'Edit the configuration this plugin was mounted with.',
    });
  }
  if (removable.ok) {
    out.push({ id: 'uninstall', label: 'Uninstall', tone: 'danger', hint: 'Remove it here and from this machine’s preferences.' });
  }
  // Ordered by what you came for, not by what the record happens to allow.
  const rank = { configure: 0, restart: 1, uninstall: 2 };
  if (status.state !== 'failed') out.sort((a, b) => rank[a.id] - rank[b.id]);
  return out;
}

/**
 * What stops working if this row goes, said as a sentence rather than a shrug.
 *
 * The confirmation dialog is the last place anybody reads before an
 * irreversible-feeling action, so it names the contributions that disappear and
 * the children that go with them.
 */
export function removalConsequence(plugin, rows = []) {
  const children = rows.filter(row => row.parentId === plugin?.id);
  const contributes = (plugin?.contributes ?? []).filter(Boolean);
  const parts = [];
  if (contributes.length) {
    parts.push(`Its ${contributes.join(', ')} stop being available to every workflow in this project.`);
  } else {
    parts.push('It stops running.');
  }
  if (children.length) {
    parts.push(`${children.length} plugin${children.length === 1 ? '' : 's'} inside it `
      + `(${children.map(row => row.name ?? row.id).join(', ')}) ${children.length === 1 ? 'goes' : 'go'} with it.`);
  }
  parts.push(pluginProvenance(plugin).label === 'This machine'
    ? 'Its row is deleted from ~/.flyt/cordis.patch.yml.'
    : 'It is switched off in ~/.flyt/cordis.patch.yml, so it stays off after a restart.');
  return parts.join(' ');
}

/**
 * The list, in tree order, each row knowing how deep it sits.
 *
 * The host already returns installation/tree order, so this only computes the
 * depth a group's children are drawn at. Re-sorting would lose the one thing
 * the order carries: what was composed inside what.
 */
export function pluginTree(plugins = []) {
  const depths = new Map();
  return plugins.map(plugin => {
    const depth = plugin.parentId && depths.has(plugin.parentId) ? depths.get(plugin.parentId) + 1 : 0;
    depths.set(plugin.id, depth);
    return { ...plugin, depth };
  });
}

/**
 * Which shelf a row belongs on.
 *
 * A group is marked `builtin` by the host because there is no module behind it,
 * not because Flyt ships it — so shelving on `builtin` alone put a group on one
 * shelf and the plugins inside it on the other, and the child's indent then
 * pointed at a parent that was not there. A group belongs with what it
 * contains.
 */
const isFlytService = plugin => Boolean(plugin?.builtin) && !plugin?.group;

/**
 * The two shelves the list is drawn on.
 *
 * Flyt's own services are most of the tree and none of the reason anybody
 * opened this screen, so they go second and stay collapsible. Splitting them
 * out is not hiding them: an installed plugin you can act on and a service the
 * app is made of are different kinds of thing, and one list makes them look
 * like peers.
 */
export function pluginShelves(plugins = []) {
  const rows = pluginTree(plugins);
  return [
    {
      id: 'installed',
      label: 'Installed',
      note: 'Nothing composed on top of Flyt yet.',
      rows: rows.filter(row => !isFlytService(row)),
    },
    {
      id: 'builtin',
      label: 'Part of Flyt',
      note: 'The services this surface is made of. Inspect only.',
      rows: rows.filter(isFlytService),
    },
  ];
}

/** Free-text narrowing over the fields a person would actually type. */
export function filterPlugins(rows = [], query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(row => [row.name, row.id, row.specifier, row.description, ...(row.contributes ?? [])]
    .some(field => String(field ?? '').toLowerCase().includes(q)));
}

/**
 * The configuration, as the text the editor starts from.
 *
 * An absent config is `{}` rather than an empty box: a plugin mounted with no
 * configuration and a plugin whose configuration failed to load look identical
 * in an empty textarea, and only one of them is safe to press Save on.
 */
export function configDraft(plugin) {
  const config = plugin?.config;
  if (config === undefined || config === null) return '{}';
  try { return JSON.stringify(config, null, 2); } catch { return '{}'; }
}

/**
 * Read the editor back.
 *
 * There is no configuration schema on `InstalledPlugin` yet, so this validates
 * shape rather than meaning: it must parse, and it must be a mapping, because
 * that is what every layer of the composition merges. Guessing further would be
 * inventing a contract the host has not published.
 */
export function parseConfigDraft(source) {
  const trimmed = String(source ?? '').trim();
  if (!trimmed) return { ok: true, value: null, error: null };
  let value;
  try { value = JSON.parse(trimmed); } catch (error) {
    return { ok: false, value: null, error: String(error?.message ?? error) };
  }
  if (value === null) return { ok: true, value: null, error: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, error: 'A plugin configuration is a mapping of settings, not a list or a bare value.' };
  }
  return { ok: true, value, error: null };
}

/** Whether the draft differs from what the plugin is actually mounted with. */
export function configChanged(plugin, source) {
  const parsed = parseConfigDraft(source);
  if (!parsed.ok) return true;
  const current = plugin?.config === undefined ? null : plugin.config;
  return JSON.stringify(parsed.value) !== JSON.stringify(current);
}
