import React, { useEffect, useRef, useState } from 'react';
import { sigil, miniTopo } from './sigil.js';

// The deck switcher (4.2): held Ctrl+Tab deals every open project as a card —
// name, live state, the active flow's topology, and the latest run's sigil.
// App owns the open/advance/commit state machine (fed by the main process's
// before-input-event stream); this component renders it and adds pointer +
// arrow-key operation. A <dialog> so the overlay is top-layer and its
// ::backdrop is the app's one sanctioned blur.
export default function TabDeck({ order, index, tabs, onPick, onCancel, onNav }) {
  const dialogRef = useRef(null);
  const cardRefs = useRef([]);
  const [cards, setCards] = useState(null); // id -> deck data, enriched async

  useEffect(() => {
    dialogRef.current?.showModal();
    let alive = true;
    // The card extras (latest run, topology) come from files; the deck opens
    // instantly on tab names and enriches when the read lands.
    window.flyt.deckData?.()
      .then(list => { if (alive) setCards(new Map(list.map(c => [c.id, c]))); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Keep DOM focus on the highlighted card so Enter/Space activate it and
  // screen readers track the cycling.
  useEffect(() => { cardRefs.current[index]?.focus(); }, [index]);

  return (
    <dialog
      ref={dialogRef}
      className="tab-deck"
      aria-label="Switch project"
      onCancel={e => { e.preventDefault(); onCancel(); }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); onNav(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); onNav(-1); }
      }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="deck-cards">
        {order.map((id, i) => {
          const tab = tabs.find(t => t.id === id);
          const card = cards?.get(id);
          const liveN = card?.live ?? tab?.live ?? 0;
          const run = card?.latestRun ?? null;
          return (
            <button
              key={id}
              ref={el => { cardRefs.current[i] = el; }}
              type="button"
              className={'deck-card' + (i === index ? ' focused' : '')}
              style={{ '--deal': i }}
              onClick={() => onPick(id)}
              title={tab?.folder ?? 'Scratch'}
            >
              <div className="deck-topo" dangerouslySetInnerHTML={{ __html: miniTopo(card?.topo, 84) }} />
              <div className="deck-name">{tab?.name ?? id}</div>
              <div className="deck-status">
                {liveN > 0
                  ? <span className="deck-live">{liveN === 1 ? 'running' : `${liveN} running`}</span>
                  : <span className="deck-idle">idle</span>}
                {run && <span className={'deck-badge deck-stage-' + run.stage}>{run.stage.replace(/_/g, ' ')}</span>}
              </div>
              {run && (
                <div className="deck-run" title={run.name}>
                  <span className="deck-sigil" dangerouslySetInnerHTML={{ __html: sigil(run.id, 26) }} />
                  <span className="deck-run-name">{run.name}</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="deck-hint mono">Ctrl held · Tab cycles · release switches · Esc cancels</div>
    </dialog>
  );
}
