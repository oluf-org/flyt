import React, { useEffect, useRef } from 'react';

// The project tab strip (D22, tabs demo A): one tab per open project, living
// in the custom titlebar between the brand and the document name. Anatomy per
// the riding defaults (T10–T12): folder-name label, unsaved dot from
// saveState, live-run micro-indicator, hover ×, middle-click close, drag
// reorder, ＋ → the recents/folder-picker page (T15). Overflow is
// Chrome-style: tabs shrink to a floor, then the strip scrolls (CSS).
export default function TabStrip({ tabs, activeId, live, saveState, onSelect, onClose, onReorder, onNewTab }) {
  const dragId = useRef(null);

  const dragOver = overId => e => {
    e.preventDefault(); // required for the drop cursor
    const from = dragId.current;
    if (!from || from === overId) return;
    const ids = tabs.map(t => t.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(overId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, from);
    onReorder(ids);
  };

  return (
    <div className="tab-strip" role="tablist" aria-label="Projects">
      {tabs.map(t => {
        const active = t.id === activeId;
        const liveN = live[t.id] ?? 0;
        const dirty = active && saveState !== 'saved';
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={'tab' + (active ? ' active' : '')}
            title={t.folder ?? 'Scratch — flows run unbound, or pick a workspace per run'}
            draggable
            onDragStart={e => { dragId.current = t.id; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={dragOver(t.id)}
            onDragEnd={() => { dragId.current = null; }}
            onClick={() => onSelect(t.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id); }
            }}
            // Middle-click close, the browser reflex. onAuxClick so the click
            // doesn't also select the tab.
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={e => { if (e.button === 1) onClose(t.id); }}
          >
            {liveN > 0 && (
              <span
                className="tab-live"
                title={liveN === 1 ? 'A run is executing' : `${liveN} runs are executing`}
                aria-label={`${liveN} live run${liveN === 1 ? '' : 's'}`}
              />
            )}
            <span className="tab-label">{t.name}</span>
            {dirty && (
              <span
                className={'tab-dirty' + (saveState === 'failed' ? ' failed' : '')}
                title={saveState === 'failed' ? 'Save failed' : 'Saving…'}
              />
            )}
            <button
              className="tab-close"
              onClick={e => { e.stopPropagation(); onClose(t.id); }}
              aria-label={`Close ${t.name}`}
              title="Close tab (runs keep executing)"
              tabIndex={-1}
            >✕</button>
          </div>
        );
      })}
      <button className="tab-new" onClick={onNewTab} title="Open a project… " aria-label="Open a project">＋</button>
    </div>
  );
}

// The ＋ page (T15): recents plus the folder picker, as an overlay page. The
// scratch tab is offered only while it isn't already open — the default
// project is a singleton like any folder (T5).
export function NewTabPage({ recents, scratchOpen, onOpenFolder, onOpenRecent, onOpenScratch, onRemoveRecent, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="newtab-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="newtab-page" role="dialog" aria-label="Open a project">
        <div className="newtab-head">
          <div className="inspector-title">
            <h2>Open a project</h2>
            <div className="node-sub">a tab is a folder — its runs live with it</div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="newtab-actions">
          <button className="primary" onClick={onOpenFolder}>Open folder…</button>
          {!scratchOpen && (
            <button onClick={onOpenScratch} title="An unbound tab — runs stay in the app's own runs folder">
              Scratch tab
            </button>
          )}
        </div>
        <div className="newtab-recents">
          <span className="section-label">Recent</span>
          {recents.length === 0 && <div className="muted">Projects you open will be listed here.</div>}
          {recents.map(r => (
            <div
              key={r.folder}
              className={'recent-row' + (r.exists ? '' : ' missing')}
              role="button"
              tabIndex={r.exists ? 0 : -1}
              title={r.exists ? r.folder : `${r.folder} — folder not found`}
              onClick={() => r.exists && onOpenRecent(r.folder)}
              onKeyDown={e => {
                if (r.exists && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpenRecent(r.folder); }
              }}
            >
              <span className="recent-name">{r.name}</span>
              <span className="recent-path mono">{r.folder}</span>
              {!r.exists && <span className="recent-missing">missing</span>}
              <button
                className="link"
                onClick={e => { e.stopPropagation(); onRemoveRecent(r.folder); }}
                aria-label={`Remove ${r.name} from recents`}
                title="Remove from recents"
              >✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
