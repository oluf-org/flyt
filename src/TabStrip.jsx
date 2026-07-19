import React, { useEffect, useRef, useState } from 'react';

// The project tab strip (D22, tabs demo A): one tab per open project, living
// in the custom titlebar between the brand and the document name. Anatomy per
// the riding defaults (T10–T12): folder-name label, unsaved dot from
// saveState, live-run micro-indicator, hover ×, middle-click close, drag
// reorder, ＋ → the recents/folder-picker page (T15). Overflow is
// Chrome-style: tabs shrink to a floor, then the strip scrolls (CSS).
export default function TabStrip({ tabs, activeId, live, saveState, onSelect, onClose, onReorder, onNewTab, onRename, onAdopt }) {
  const dragId = useRef(null);
  // Inline rename (LANDER-PLAN §6): double-click a tab's label to rename the
  // project. Commit on Enter/blur, cancel on Esc; a blank name is ignored.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef(null);
  const cancelled = useRef(false);
  // Right-click tab menu (Rename / Move to folder… / Close).
  const [menu, setMenu] = useState(null); // { id, x, y } | null

  useEffect(() => {
    if (!editingId) return;
    const el = editRef.current;
    if (el) { el.focus(); el.select(); }
  }, [editingId]);

  // Close the context menu on Esc or any click/scroll elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = e => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const menuTab = menu ? tabs.find(t => t.id === menu.id) : null;

  const startRename = t => { cancelled.current = false; setDraft(t.name); setEditingId(t.id); };
  const commitRename = () => {
    const id = editingId;
    setEditingId(null);
    if (cancelled.current) { cancelled.current = false; return; }
    const name = draft.trim();
    if (name) onRename?.(id, name);
  };

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
        const editing = editingId === t.id;
        return (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={'tab' + (active ? ' active' : '') + (editing ? ' editing' : '')}
            title={editing ? undefined : (t.folder ?? `${t.name} — an app-managed project (double-click to rename)`)}
            draggable={!editing}
            onDragStart={e => { dragId.current = t.id; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={dragOver(t.id)}
            onDragEnd={() => { dragId.current = null; }}
            onClick={() => !editing && onSelect(t.id)}
            onDoubleClick={() => startRename(t)}
            onContextMenu={e => { e.preventDefault(); setMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
            onKeyDown={e => {
              if (editing) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(t.id); }
              else if (e.key === 'F2') { e.preventDefault(); startRename(t); }
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
            {editing ? (
              <input
                ref={editRef}
                className="tab-rename"
                value={draft}
                maxLength={60}
                onChange={e => setDraft(e.target.value)}
                onClick={e => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
                }}
                aria-label={`Rename ${t.name}`}
              />
            ) : (
              <span className="tab-label">{t.name}</span>
            )}
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

      {menu && menuTab && (
        <div
          className="tab-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button role="menuitem" className="tab-menu-item" onClick={() => { setMenu(null); startRename(menuTab); }}>
            Rename
          </button>
          {menuTab.kind === 'appdata' && (
            <button role="menuitem" className="tab-menu-item" onClick={() => { setMenu(null); onAdopt?.(menuTab.id); }}>
              Move to folder…
            </button>
          )}
          <div className="tab-menu-sep" role="separator" />
          <button role="menuitem" className="tab-menu-item" onClick={() => { setMenu(null); onClose(menuTab.id); }}>
            Close tab
          </button>
        </div>
      )}
    </div>
  );
}

// The ＋ page (T15): recents plus the folder picker, as an overlay page. The
// scratch tab is retired (L6) — unbound work now lives in an auto-created
// appdata project the projectless lander makes, so this page only opens real
// folders.
export function NewTabPage({ recents, onOpenFolder, onOpenRecent, onRemoveRecent, onClose }) {
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
