// The plugin manager: one list, one detail pane, and no button that does not
// do the thing it says.
//
// Every verb here is a real call into the host and a real write to
// `~/.flyt/cordis.patch.yml`, so every one of them can be slow and can fail.
// That is why the pane carries busy and error states per action rather than
// optimistically redrawing: a plugin whose `configure` rejected is still
// mounted with the old configuration, and a screen that has already moved on
// has told a lie that only shows up at the next restart.
//
// The judgements — removable, configurable, what a removal costs — live in
// `pluginManager.js` so they can be argued with in a test.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  configChanged, configDraft, filterPlugins, parseConfigDraft, pluginActions,
  pluginConfigurable, pluginProvenance, pluginRemovable, pluginShelves, pluginStatus,
  removalConsequence,
} from './pluginManager.js';
import { PluginContributionSection } from './PluginContributionView.jsx';
import './pluginManagerStyles.css';

const PRESENT_TENSE = { configure: 'Saving…', restart: 'Restarting…', uninstall: 'Removing…' };

/** A small labelled fact. Absent values are omitted rather than drawn empty. */
function Fact({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

function Chips({ values = [], empty = null, tone = 'neutral' }) {
  if (!values.length) return empty ? <span className="pm-none">{empty}</span> : null;
  return <span className="pm-chips">{values.map(value => (
    <span className={`pm-chip tone-${tone}`} key={value}>{value}</span>
  ))}</span>;
}

/**
 * The one confirmation Flyt owns.
 *
 * Not `window.confirm`: it cannot say what the removal costs, it cannot be
 * styled to look like it belongs to this app, and it blocks the process while
 * it is open. This says the consequence in the sentence above the button, which
 * is the only part of a confirmation anybody reads.
 */
function ConfirmRemoval({ plugin, consequence, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = event => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return (
    <div className="pm-confirm-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <div className="pm-confirm" role="alertdialog" aria-modal="true"
        aria-labelledby="pm-confirm-title" aria-describedby="pm-confirm-body"
        onMouseDown={event => event.stopPropagation()}>
        <h2 id="pm-confirm-title">Uninstall {plugin.name}?</h2>
        <p id="pm-confirm-body">{consequence}</p>
        <p className="pm-confirm-specifier mono">{plugin.specifier}</p>
        <footer>
          <button type="button" ref={cancelRef} className="pm-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="pm-btn tone-danger" disabled={busy} onClick={onConfirm}>
            {busy ? 'Removing…' : 'Uninstall'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The configuration editor. Validated on every keystroke, saved only when valid. */
function ConfigEditor({ plugin, busy, onCancel, onSave }) {
  const [draft, setDraft] = useState(() => configDraft(plugin));
  useEffect(() => { setDraft(configDraft(plugin)); }, [plugin.id]);
  const parsed = parseConfigDraft(draft);
  const dirty = configChanged(plugin, draft);
  return (
    <section className="pm-config" aria-label={`${plugin.name} configuration`}>
      <header>
        <h3>Configuration</h3>
        <p>
          Mapped over whatever the composition layers already set for
          {' '}<code className="mono">{plugin.id}</code>. Saved to this machine’s preferences, so it survives a restart.
        </p>
      </header>
      <textarea
        className="mono"
        spellCheck={false}
        value={draft}
        disabled={busy}
        aria-label="Plugin configuration, as JSON"
        aria-invalid={!parsed.ok}
        onChange={event => setDraft(event.target.value)}
      />
      <div className="pm-config-foot">
        <p className={parsed.ok ? 'pm-config-hint' : 'pm-config-error'} role={parsed.ok ? undefined : 'alert'}>
          {parsed.ok
            ? (dirty ? 'Valid. Saving remounts the plugin with these settings.' : 'No changes yet.')
            : parsed.error}
        </p>
        <div className="pm-config-actions">
          <button type="button" className="pm-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="pm-btn tone-primary" disabled={busy || !parsed.ok || !dirty}
            onClick={() => onSave(parsed.value)}>
            {busy ? 'Saving…' : 'Save and remount'}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * @param plugins — the installed catalog, as the host publishes it.
 * @param api — `{ configure, restart, uninstall }`. Absent, the manager is a
 *   readable inspector and says so, which is what it should be when the host
 *   offers no lifecycle methods rather than a screen of dead buttons.
 * @param selectedId / onSelect — controlled selection, so the Library catalog
 *   can hand a plugin over without this component owning where it came from.
 */
export default function PluginManager({
  plugins = [], api = null, uiExtensions = [], selectedId = null, onSelect = null,
  onRefresh = null,
}) {
  const [query, setQuery] = useState('');
  const [ownSelection, setOwnSelection] = useState(null);
  const [showBuiltins, setShowBuiltins] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const listRef = useRef(null);

  const shelves = useMemo(() => pluginShelves(plugins), [plugins]);
  const visible = useMemo(() => shelves.map(shelf => ({
    ...shelf,
    matches: filterPlugins(shelf.rows, query),
  })), [shelves, query]);
  const flat = useMemo(
    () => visible.flatMap(shelf => (shelf.id === 'builtin' && !showBuiltins && !query ? [] : shelf.matches)),
    [visible, showBuiltins, query],
  );

  const chosen = selectedId ?? ownSelection;
  const selected = plugins.find(plugin => plugin.id === chosen) ?? null;
  const select = id => { setEditing(false); setFailure(null); setReceipt(null); (onSelect ?? setOwnSelection)(id); };

  // A selection that survives its plugin is a detail pane describing something
  // that is no longer installed — which is exactly what an uninstall leaves
  // behind if nothing clears it.
  useEffect(() => {
    if (chosen && !plugins.some(plugin => plugin.id === chosen)) select(null);
  }, [plugins, chosen]);

  const run = async (action, act) => {
    setBusy(action);
    setFailure(null);
    setReceipt(null);
    try {
      await act();
      setEditing(false);
      setConfirming(false);
      setReceipt({ action, at: Date.now() });
      await onRefresh?.();
    } catch (error) {
      setFailure({ action, message: String(error?.message ?? error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') });
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  };

  const act = (action, plugin) => {
    if (!api) return;
    if (action === 'configure') { setFailure(null); setReceipt(null); setEditing(open => !open); return; }
    if (action === 'uninstall') { setFailure(null); setReceipt(null); setConfirming(true); return; }
    run('restart', () => api.restart(plugin.id));
  };

  // Up/down moves through the list the way every other list in this app does,
  // without making each row a tab stop of its own.
  const onListKey = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (!flat.length) return;
    event.preventDefault();
    const index = flat.findIndex(plugin => plugin.id === chosen);
    const next = event.key === 'ArrowDown'
      ? Math.min(index < 0 ? 0 : index + 1, flat.length - 1)
      : Math.max(index < 0 ? 0 : index - 1, 0);
    select(flat[next].id);
    listRef.current?.querySelector(`[data-plugin-id="${flat[next].id}"]`)?.focus();
  };

  return (
    <div className="pm" data-v2>
      <aside className="pm-list" aria-label="Installed plugins">
        <div className="pm-list-head">
          <input
            className="pm-search"
            type="search"
            value={query}
            placeholder="Search plugins"
            aria-label="Search installed plugins"
            onChange={event => setQuery(event.target.value)}
          />
        </div>
        <div className="pm-shelves" ref={listRef} onKeyDown={onListKey}>
          {visible.map(shelf => {
            const collapsed = shelf.id === 'builtin' && !showBuiltins && !query;
            return (
              <section className="pm-shelf" key={shelf.id}>
                <header>
                  {shelf.id === 'builtin' ? (
                    <button type="button" className="pm-shelf-toggle" aria-expanded={!collapsed}
                      onClick={() => setShowBuiltins(open => !open)}>
                      <span className="pm-caret" aria-hidden="true" data-open={!collapsed} />
                      {shelf.label}<span className="pm-shelf-count">{shelf.matches.length}</span>
                    </button>
                  ) : (
                    <span className="pm-shelf-label">{shelf.label}<span className="pm-shelf-count">{shelf.matches.length}</span></span>
                  )}
                </header>
                {!collapsed && shelf.matches.length === 0 && (
                  <p className="pm-shelf-empty">{query ? `Nothing here matches “${query}”.` : shelf.note}</p>
                )}
                {!collapsed && shelf.matches.length > 0 && (
                  <ul>
                    {shelf.matches.map(plugin => {
                      const status = pluginStatus(plugin);
                      return (
                        <li key={plugin.id}>
                          <button
                            type="button"
                            data-plugin-id={plugin.id}
                            className={'pm-row' + (plugin.id === chosen ? ' selected' : '')}
                            style={{ '--depth': plugin.depth }}
                            aria-current={plugin.id === chosen ? 'true' : undefined}
                            onClick={() => select(plugin.id)}
                          >
                            <span className={`pm-dot tone-${status.tone}`} aria-hidden="true" />
                            <span className="pm-row-text">
                              <strong>{plugin.name}</strong>
                              <span className="mono">{plugin.specifier}</span>
                            </span>
                            {status.state !== 'active' && <span className={`pm-row-state tone-${status.tone}`}>{status.label}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </aside>

      {!selected ? (
        <section className="pm-detail pm-detail-empty">
          <div>
            <h2>{plugins.length} plugin{plugins.length === 1 ? '' : 's'} composed</h2>
            <p>
              Pick one to see what it contributes, where it came from, and what it was mounted with.
              Plugins add blocks, tools, skills and UI; Flyt’s own services are on the second shelf and
              can be inspected but not removed.
            </p>
          </div>
        </section>
      ) : (
        <section className="pm-detail" aria-label={`${selected.name} details`}>
          {(() => {
            const status = pluginStatus(selected);
            const provenance = pluginProvenance(selected);
            const removable = pluginRemovable(selected);
            const configurable = pluginConfigurable(selected);
            const actions = api ? pluginActions(selected) : [];
            const contributions = uiExtensions.filter(row => row?.pluginId === selected.id
              && row?.contribution?.point === 'library-entry');
            return (
              <>
                <header className="pm-detail-head">
                  <div className="pm-detail-title">
                    <span className="section-label">{selected.group ? 'Plugin group' : 'Plugin'}</span>
                    <h2>{selected.name}</h2>
                    <p className="mono pm-specifier">{selected.specifier}</p>
                  </div>
                  <span className={`pm-status tone-${status.tone}`}>
                    <span className={`pm-dot tone-${status.tone}`} aria-hidden="true" />{status.label}
                  </span>
                </header>

                <p className="pm-desc">{selected.description || 'This plugin does not describe itself.'}</p>

                <p className={`pm-state-note tone-${status.tone}`}>{status.detail}</p>

                {failure && (
                  <div className="pm-alert" role="alert">
                    <div>
                      <strong>{failure.action === 'configure' ? 'The configuration was not saved.'
                        : failure.action === 'uninstall' ? 'It was not removed.' : 'It did not restart.'}</strong>
                      <p>{failure.message}</p>
                    </div>
                    <button type="button" className="pm-btn" onClick={() => setFailure(null)}>Dismiss</button>
                  </div>
                )}
                {receipt && !failure && (
                  <p className="pm-receipt" role="status">
                    {receipt.action === 'configure' ? 'Saved, and remounted with the new configuration.'
                      : receipt.action === 'restart' ? 'Restarted.' : 'Removed.'}
                  </p>
                )}

                <dl className="pm-facts">
                  <Fact label="Entry id"><code className="mono">{selected.id}</code></Fact>
                  <Fact label="Composed by">{provenance.label}<small>{provenance.detail}</small></Fact>
                  <Fact label="Contributes">
                    <Chips values={selected.contributes ?? []} empty="Nothing yet — it mounts, but registers no blocks, tools or skills." tone="accent" />
                  </Fact>
                  <Fact label="Requires">
                    <Chips values={selected.inject ?? []} empty="Nothing. It mounts on its own." />
                  </Fact>
                  {selected.parentId && <Fact label="Inside">
                    <button type="button" className="pm-link" onClick={() => select(selected.parentId)}>{selected.parentId}</button>
                  </Fact>}
                </dl>

                {contributions.map(row => (
                  <PluginContributionSection key={`${row.pluginId}:${row.contribution.id}`}
                    contribution={row.contribution} pluginId={row.pluginId} />
                ))}

                {api ? (
                  <div className="pm-actions">
                    {actions.map(action => (
                      <button
                        key={action.id}
                        type="button"
                        className={`pm-btn tone-${action.tone}` + (action.id === 'configure' && editing ? ' pressed' : '')}
                        title={action.hint}
                        disabled={Boolean(busy)}
                        aria-expanded={action.id === 'configure' ? editing : undefined}
                        onClick={() => act(action.id, selected)}
                      >
                        {busy === action.id ? PRESENT_TENSE[action.id] : action.label}
                      </button>
                    ))}
                    {!removable.ok && <p className="pm-locked">{removable.reason}</p>}
                    {!configurable.ok && removable.ok && <p className="pm-locked">{configurable.reason}</p>}
                  </div>
                ) : (
                  <p className="pm-locked">
                    This host offers no plugin lifecycle methods, so the manager can show what is
                    installed and nothing more.
                  </p>
                )}

                {editing && configurable.ok && (
                  <ConfigEditor
                    plugin={selected}
                    busy={busy === 'configure'}
                    onCancel={() => setEditing(false)}
                    onSave={config => run('configure', () => api.configure(selected.id, config))}
                  />
                )}

                {confirming && (
                  <ConfirmRemoval
                    plugin={selected}
                    consequence={removalConsequence(selected, plugins)}
                    busy={busy === 'uninstall'}
                    onCancel={() => setConfirming(false)}
                    onConfirm={() => run('uninstall', () => api.uninstall(selected.id))}
                  />
                )}
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
