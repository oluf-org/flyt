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

/**
 * @param sources — `{ stacks, blocks, plugins, tools, skills, models, modelFacts }`.
 *   Whatever the host has; an absent kind contributes nothing and is named as
 *   empty rather than silently missing.
 * @param onAct — called with the entry when its action is used. Absent, the
 *   rows are readable and inert, which is what a library with nowhere to put
 *   things should be.
 */
export default function Library({ sources = {}, onAct = null }) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState([]);

  const { entries, empty } = useMemo(() => libraryEntries(sources), [sources]);
  const { matches, facets, total } = useMemo(
    () => librarySearch(entries, query, { kinds }),
    [entries, query, kinds],
  );

  const toggle = kind => setKinds(k => (k.includes(kind) ? k.filter(x => x !== kind) : [...k, kind]));

  return (
    <div className="library" data-v2>
      <input
        className="lib-search"
        type="search"
        value={query}
        placeholder="Search stacks, blocks, plugins, tools, skills and models"
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
            {kind}
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

      <ul className="lib-results">
        {matches.map(m => (
          <li key={`${m.kind}:${m.id}`} className="lib-row" data-kind={m.kind}>
            <span className="lib-kind">{m.kind}</span>
            <span className="lib-title">
              {m.title}
              <span className="mono lib-id">{m.id}</span>
            </span>
            <span className="lib-desc">{m.description}</span>
            {m.detail?.unclassified && (
              // A tool in no toolset cannot be reached by any ceiling (D57).
              // Showing it as ordinary invites somebody to plan around it.
              <span className="lib-warn" title="In no toolset, so no ceiling can reach it">unclassified</span>
            )}
            {m.detail?.requiresTools?.length > 0 && (
              // A skill REQUESTS tools (D58); a human grants them. The grant
              // moment should be loud, and this is where loud starts.
              <span className="lib-warn" title="This skill asks for tools a human must grant">
                asks for {m.detail.requiresTools.join(', ')}
              </span>
            )}
            <button
              type="button"
              className="lib-act"
              disabled={!onAct}
              onClick={() => onAct?.(m)}
            >
              {VERB[m.action] ?? m.action}
            </button>
          </li>
        ))}
      </ul>

      {empty.length > 0 && (
        <p className="lib-empty muted">
          Nothing installed of: {empty.join(', ')}.
        </p>
      )}
      {total > matches.length && <p className="muted">{total} in total.</p>}
    </div>
  );
}
