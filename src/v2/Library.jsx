// The library (t-0076): one search, every kind.
//
// Four lists become one. Finding a thing should not require knowing which of
// four screens it lives on — that complaint is where the whole surfaces rewrite
// started, and it is the only thing this has to fix.
//
// Facets narrow the same result set rather than searching again, and a facet
// with no matches is still shown with a zero: "there are no plugins matching
// this" is an answer, and a facet that disappears when it is empty cannot give
// it. A kind with nothing INSTALLED says so separately, because "nothing
// installed" and "nothing matched" are different sentences and only the first
// one is about the project.
import React, { useMemo, useState } from 'react';
import { KINDS, libraryEntries } from './libraryEntries.js';
import { librarySearch } from './librarySearch.js';
import { PluginContributionSection } from './PluginContributionView.jsx';
import './libraryStyles.css';

/** What each action says on its button. The verb is the whole point of the row. */
const VERB = {
  open: 'Open',
  insert: 'Insert',
  install: 'Install',
  configure: 'Configure',
  inspect: 'Inspect',
  attach: 'Attach',
  pin: 'Pin',
};

const KIND_LABEL = {
  stack: 'Workflows',
  block: 'Blocks',
  plugin: 'Plugins',
  tool: 'Tools',
  skill: 'Skills',
  model: 'Models',
};

/**
 * @param sources — `{ stacks, blocks, plugins, tools, skills, models, modelFacts }`.
 *   Whatever the host has; an absent kind contributes nothing and is named as
 *   empty rather than silently missing.
 * @param onAct — called with the entry when its action is used. Absent, the
 *   rows are readable and inert, which is what a library with nowhere to put
 *   things should be.
 */
export default function Library({ sources = {}, onAct = null, uiExtensions = [] }) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState([]);

  const { entries, empty } = useMemo(() => libraryEntries(sources), [sources]);
  const { matches, facets, total } = useMemo(
    () => librarySearch(entries, query, { kinds }),
    [entries, query, kinds],
  );
  const groups = useMemo(() => KINDS.map(kind => ({
    kind, rows: matches.filter(entry => entry.kind === kind),
  })).filter(group => group.rows.length), [matches]);

  const toggle = kind => setKinds(k => (k.includes(kind) ? k.filter(x => x !== kind) : [...k, kind]));

  return (
    <div className="library" data-v2>
      <input
        className="lib-search"
        type="search"
        value={query}
        placeholder="Search the workflow library"
        onChange={e => setQuery(e.target.value)}
        aria-label="Search the library"
      />

      <div className="lib-facets" role="group" aria-label="Narrow by kind">
        {KINDS.map(kind => (
          <button
            key={kind}
            type="button"
            className={'lib-facet' + (kinds.includes(kind) ? ' on' : '') + (facets[kind] ? '' : ' none')}
            onClick={() => toggle(kind)}
            aria-pressed={kinds.includes(kind)}
          >
            {KIND_LABEL[kind]}
            <span className="lib-count">{facets[kind]}</span>
          </button>
        ))}
      </div>

      {matches.length === 0 && (
        <p className="muted">
          {entries.length === 0
            ? 'Nothing is installed yet.'
            : `Nothing matches “${query}”.`}
        </p>
      )}

      <div className="lib-status-line">
        {matches.length > 0 && <div className="lib-summary"><strong>{matches.length}</strong><span>{matches.length === 1 ? 'item' : 'items'} shown</span></div>}
        {empty.length > 0 && <p className="lib-empty muted">Not installed: {empty.map(kind => KIND_LABEL[kind]).join(', ')}.</p>}
      </div>

      <div className="lib-groups">{groups.map(group => <section className="lib-group" key={group.kind} data-kind={group.kind}>
        <header><h2>{KIND_LABEL[group.kind]}</h2><span>{group.rows.length}</span></header>
        <ul className="lib-results">{group.rows.map(m => (
          <li key={`${m.kind}:${m.id}`} className="lib-row" data-kind={m.kind}>
            <span className="lib-kind" aria-hidden="true">{m.kind.slice(0, 2)}</span>
            <span className="lib-title">
              <strong>{m.title}</strong>
              <span className="mono lib-id">{m.id}</span>
            </span>
            <span className="lib-desc">{m.description}</span>
            <span className="lib-meta">
              {m.detail?.unclassified && (
                <span className="lib-warn" title="In no toolset, so no ceiling can reach it">unclassified</span>
              )}
              {m.detail?.requiresTools?.length > 0 && (
                <span className="lib-warn" title="This skill asks for tools a human must grant">
                  asks for {m.detail.requiresTools.join(', ')}
                </span>
              )}
            </span>
            <button type="button" className="lib-act" disabled={!onAct} onClick={() => onAct?.(m)}>
              {VERB[m.action] ?? m.action}
            </button>
          </li>
        ))}</ul>
      </section>)}</div>

      {total > matches.length && <p className="muted">{total} in total.</p>}
      {uiExtensions.filter(row => row?.contribution?.point === 'library-entry').map(row =>
        <PluginContributionSection key={`${row.pluginId}:${row.contribution.id}`}
          contribution={row.contribution} pluginId={row.pluginId} />)}
    </div>
  );
}
