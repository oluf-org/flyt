// The Library destination: everything installed, and the plugins that install it.
//
// Two views, one page. The catalog answers "what can I use here" across all six
// kinds at once — the question the four old screens could not answer without
// knowing which of them to open first. The manager answers "what is installed,
// and what is it doing" for the one kind that has a lifecycle.
//
// They are views rather than destinations because they are the same question at
// two depths: pressing Manage on a plugin in the catalog moves to the manager
// with that plugin already open, and that continuity is the reason the plugin
// manager lives here at all instead of behind a fifth rail icon.
import React, { useEffect, useState } from 'react';
import Library from './Library.jsx';
import PluginManager from './PluginManager.jsx';
import { SearchProvidersSection } from '../Settings.jsx';
import './libraryPageStyles.css';

const VIEWS = [
  { id: 'catalog', label: 'Catalog', hint: 'Search every installed kind at once' },
  { id: 'plugins', label: 'Plugins', hint: 'Inspect, configure and remove what is composed' },
];

export default function LibraryPage({
  sources = {}, plugins = [], pluginApi = null, uiExtensions = [], onAct = null,
  onRefreshPlugins = null, initialView = 'catalog', initialSettings = null,
}) {
  const [view, setView] = useState(initialView);
  const [selectedPlugin, setSelectedPlugin] = useState(null);
  const [settings, setSettings] = useState(initialSettings);
  const [settingsError, setSettingsError] = useState('');

  useEffect(() => {
    if (view !== 'plugins' || settings) return;
    let live = true;
    window.flyt.getSettings()
      .then(value => { if (live) setSettings(value); })
      .catch(error => { if (live) setSettingsError(String(error?.message ?? error)); });
    return () => { live = false; };
  }, [view, settings]);

  const rows = plugins.length ? plugins : (sources.plugins ?? []);
  const failing = rows.filter(row => row.state === 'failed').length;
  const waiting = rows.filter(row => row.state === 'pending').length;

  // A plugin opened from the catalog is the same plugin, seen closer. Anything
  // else stays with whoever owns it — Build opens stacks, the editor inserts
  // blocks — and this page does not pretend to know how.
  const act = entry => {
    if (entry?.kind === 'plugin') {
      setSelectedPlugin(entry.id);
      setView('plugins');
      return;
    }
    onAct?.(entry);
  };

  return (
    <div className="library-page" data-v2>
      <header className="library-page-head">
        <div>
          <p className="library-eyebrow">Library</p>
          <h1>Everything this project can use</h1>
          <p className="library-lede">
            Workflows, blocks, plugins, tools, skills and models — one search across all of them.
            Plugins are where the rest of this list comes from.
          </p>
        </div>
        <nav className="library-views" aria-label="Library view">
          {VIEWS.map(item => (
            <button
              key={item.id}
              type="button"
              className={'library-view' + (view === item.id ? ' active' : '')}
              aria-pressed={view === item.id}
              title={item.hint}
              onClick={() => setView(item.id)}
            >
              {item.label}
              {item.id === 'plugins' && rows.length > 0 && (
                <span className={'library-view-count' + (failing ? ' attention' : '')}>
                  {failing || rows.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* One line, and only when there is something to say. A banner that is
          always present is a banner nobody reads on the day it matters. */}
      {view === 'catalog' && (failing > 0 || waiting > 0) && (
        <button type="button" className={'library-notice' + (failing ? ' bad' : '')}
          onClick={() => { setSelectedPlugin(null); setView('plugins'); }}>
          {failing > 0
            ? `${failing} plugin${failing === 1 ? '' : 's'} failed to start.`
            : `${waiting} plugin${waiting === 1 ? ' is' : 's are'} waiting for a service.`}
          <span>Open the plugin manager →</span>
        </button>
      )}

      <div className="library-page-body">
        {view === 'catalog'
          ? <Library sources={sources} onAct={act} uiExtensions={uiExtensions} />
          : <div className="library-plugins-view">
              <div className="library-web-search">
                {settings
                  ? <SearchProvidersSection searchProviders={settings.searchProviders} save={async patch => {
                      const next = await window.flyt.setSettings(patch);
                      setSettings(next);
                      return next;
                    }} />
                  : <p className="muted">{settingsError || 'Loading web-search providers…'}</p>}
              </div>
              <PluginManager
                plugins={rows}
                api={pluginApi}
                uiExtensions={uiExtensions}
                selectedId={selectedPlugin}
                onSelect={setSelectedPlugin}
                onRefresh={onRefreshPlugins}
              />
            </div>}
      </div>
    </div>
  );
}
