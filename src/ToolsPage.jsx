import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ToolCopilot from './ToolCopilot.jsx';
import ToolWizard from './ToolWizard.jsx';
import { buildBoard, flatTools, statusOf, authOf, parametersOf, BOARD_FILTERS } from './toolBoard.js';
import { categoryOf } from '../core/toolCategories.js';

// The Tool Library page (TOOLS-PLAN §15) — three regions: the copilot that
// authors, the board that files, and the wizard sheet that edits.
//
// The board's columns are categories, and a category is presentation only: it
// carries no grant semantics and no hue. What a tool may DO is `effects`,
// `risk` and `trust`, all of which the card shows as quiet text. That is why
// dragging a card between columns is safe — it moves a card, never a
// permission.

const VIEWS = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'grid', label: 'Grid' }
];

export default function ToolsPage({
  board, models, activeModels, mockEnabled, copilotWorker, onCopilotWorker,
  onReload, searchSignal, newToolSignal, copilotSignal
}) {
  const { tools = [], categories = [] } = board ?? {};
  const [view, setView] = useState('board');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [wizard, setWizard] = useState(null);       // null | { seed }
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [newCategory, setNewCategory] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [notice, setNotice] = useState('');
  const [copilotFocus, setCopilotFocus] = useState(0);
  const searchRef = useRef(null);
  const boardRef = useRef(null);

  const existingIds = useMemo(() => tools.map(t => t.id), [tools]);
  const columns = useMemo(() => buildBoard({ tools, categories, query, filter }), [tools, categories, query, filter]);
  const flat = useMemo(() => flatTools({ tools, query, filter }), [tools, query, filter]);
  const liveIds = useMemo(() => new Set(categories.map(c => c.id)), [categories]);
  const selected = tools.find(t => t.id === selectedId) ?? null;

  // --- shortcuts, driven from the app shell so they work from the toolbar too
  useEffect(() => { if (searchSignal) searchRef.current?.focus(); }, [searchSignal]);
  useEffect(() => { if (newToolSignal) setWizard({ seed: null }); }, [newToolSignal]);
  useEffect(() => { if (copilotSignal) setCopilotFocus(n => n + 1); }, [copilotSignal]);

  const flash = msg => { setNotice(msg); setTimeout(() => setNotice(''), 2600); };

  // --- writes. Every one is optimistic in the UI and reconciled by onReload:
  // the file is the source of truth, so the board redraws from what actually
  // landed rather than from what we hoped would.
  const saveTool = async def => {
    await window.flyt.saveTool(def);
    await onReload();
    setSelectedId(def.id);
    setWizard(null);
    flash(`${def.id} saved to the library.`);
  };

  const move = async (id, categoryId) => {
    if (!id) return;
    const tool = tools.find(t => t.id === id);
    if (!tool || categoryOf(tool, liveIds) === categoryId) return;
    await window.flyt.setToolCategory(id, categoryId);
    await onReload();
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) { setAddingCategory(false); return; }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) { setAddingCategory(false); return; }
    await window.flyt.saveToolCategory({ id, name, icon: '·', order: categories.length });
    setNewCategory('');
    setAddingCategory(false);
    await onReload();
  };

  const removeCategory = async id => {
    if (!window.confirm(`Delete the "${id}" column?\n\nIts tools stay in the library and fall back to an automatic placement.`)) return;
    await window.flyt.deleteToolCategory(id);
    await onReload();
  };

  const toggleEnabled = async tool => {
    await window.flyt.setToolEnabled(tool.id, !tool.enabled);
    await onReload();
  };

  const deleteTool = async tool => {
    const builtin = tool.provider === 'builtin';
    const msg = builtin
      ? `"${tool.id}" is a built-in — its run() lives in source, so deleting the file only makes the library write it back. Disable it instead?`
      : `Delete the tool "${tool.id}"?\n\nFlows granting it will log tool_missing and run without it.`;
    if (builtin) { if (window.confirm(msg)) toggleEnabled(tool); return; }
    if (!window.confirm(msg)) return;
    await window.flyt.deleteTool(tool.id);
    setSelectedId(null);
    await onReload();
  };

  // --- keyboard navigation across the board. Arrow keys move between cards in
  // reading order; the flat list is already the order the columns render in.
  const ordered = useMemo(() => columns.flatMap(c => c.tools.map(t => t.id)), [columns]);
  const onCardKey = (e, tool) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(tool.id); return; }
    const idx = ordered.indexOf(tool.id);
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!delta || idx < 0) return;
    e.preventDefault();
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, idx + delta))];
    setSelectedId(next);
    boardRef.current?.querySelector(`[data-tool-id="${next}"]`)?.focus();
  };

  const onDrop = useCallback((e, categoryId) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    setDropTarget(null);
    move(id, categoryId);
  }, [dragId, tools, liveIds]);

  return (
    <div
      className={'tools-page' + (wizard ? ' authoring' : '')}
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={async e => {
        // A file dropped ANYWHERE on the page is an import brief for the
        // copilot — the page has one place that turns text into a tool, and
        // making the user find it first would be a puzzle, not a feature.
        if (!e.dataTransfer.files?.length) return;
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        flash(`${file.name} handed to the copilot.`);
        setCopilotFocus(n => n + 1);
        window.dispatchEvent(new CustomEvent('flyt:tool-import', {
          detail: { name: file.name, text: await file.text() }
        }));
      }}
    >
      <ToolCopilot
        models={models}
        activeModels={activeModels}
        mockEnabled={mockEnabled}
        categories={categories}
        existingIds={existingIds}
        worker={copilotWorker}
        onWorkerChange={onCopilotWorker}
        focusSignal={copilotFocus}
        onAddDraft={async draft => { await window.flyt.saveTool(draft); await onReload(); setSelectedId(draft.id); }}
        onEditDraft={draft => setWizard({ seed: draft })}
      />

      <div className="tools-main">
        <div className="tools-toolbar">
          <div className="view-switch" role="tablist" aria-label="Library view">
            {VIEWS.map(v => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                className={'view-btn' + (view === v.id ? ' active' : '')}
                onClick={() => setView(v.id)}
              >{v.label}</button>
            ))}
          </div>

          <div className="tools-filters">
            {BOARD_FILTERS.map(f => (
              <button
                key={f.id}
                type="button"
                className={'tool-chip' + (filter === f.id ? ' on' : '')}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >{f.label}</button>
            ))}
          </div>

          <input
            ref={searchRef}
            className="tools-search"
            value={query}
            placeholder="Search tools…"
            onChange={e => setQuery(e.target.value)}
            aria-label="Search the tool library"
          />

          <span className="tools-hint mono">
            {view === 'board' ? 'drag a card to recategorize' : `${flat.length} shown`}
          </span>
        </div>

        {notice && <div className="tools-notice mono">{notice}</div>}

        {/* Never silent (TOOLS-PLAN §1.3): a file the library could not read is
            a tool that has silently stopped existing, which is exactly the
            failure the whole plan is written against. One bad definition does
            not cost you the other fifty — but you do get told. */}
        {(board?.problems ?? []).length > 0 && (
          <div className="tools-problems">
            <span className="section-label">Could not read</span>
            {board.problems.map(p => (
              <div key={p.file} className="mono">{p.file} — {p.error}</div>
            ))}
          </div>
        )}

        {view === 'board' ? (
          <div className="tool-board" ref={boardRef}>
            {columns.map(col => (
              <section
                key={col.id}
                className={'tool-column' + (dropTarget === col.id ? ' dropping' : '')}
                onDragOver={e => { if (dragId) { e.preventDefault(); setDropTarget(col.id); } }}
                onDragLeave={() => setDropTarget(t => (t === col.id ? null : t))}
                onDrop={e => onDrop(e, col.id)}
              >
                <header className="tool-column-head">
                  <span className="tool-column-icon" aria-hidden="true">{col.icon}</span>
                  <h3>{col.name}</h3>
                  <span className="mono tool-column-count">{col.tools.length}</span>
                  <button
                    className="ghost mini"
                    onClick={() => setWizard({ seed: { categoryId: col.id } })}
                    aria-label={`New tool in ${col.name}`}
                    title={`New tool in ${col.name}`}
                  >＋</button>
                </header>

                <div className="tool-column-body">
                  {col.tools.map(tool => (
                    <ToolCard
                      key={tool.id}
                      tool={tool}
                      selected={tool.id === selectedId}
                      categories={categories}
                      onSelect={() => setSelectedId(tool.id)}
                      onKeyDown={e => onCardKey(e, tool)}
                      onDragStart={e => { setDragId(tool.id); e.dataTransfer.setData('text/plain', tool.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { setDragId(null); setDropTarget(null); }}
                      onMove={cid => move(tool.id, cid)}
                    />
                  ))}
                  <div className="tool-drop-slot" aria-hidden="true">
                    {dragId ? 'drop here' : col.tools.length ? '' : 'empty'}
                  </div>
                </div>
              </section>
            ))}

            <div className="tool-column new">
              {addingCategory ? (
                <input
                  autoFocus
                  value={newCategory}
                  placeholder="Category name"
                  onChange={e => setNewCategory(e.target.value)}
                  onBlur={addCategory}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addCategory();
                    if (e.key === 'Escape') { setNewCategory(''); setAddingCategory(false); }
                  }}
                  aria-label="New category name"
                />
              ) : (
                <button className="tool-new-category" onClick={() => setAddingCategory(true)}>＋ New category</button>
              )}
            </div>
          </div>
        ) : (
          <div className={view === 'grid' ? 'tool-grid' : 'tool-list'}>
            {flat.map(tool => (
              <ToolCard
                key={tool.id}
                tool={tool}
                dense={view === 'list'}
                selected={tool.id === selectedId}
                categories={categories}
                onSelect={() => setSelectedId(tool.id)}
                onKeyDown={e => onCardKey(e, tool)}
                onMove={cid => move(tool.id, cid)}
              />
            ))}
            {flat.length === 0 && <div className="muted">Nothing matches.</div>}
          </div>
        )}

        {selected && (
          <ToolInspector
            tool={selected}
            categories={categories}
            onClose={() => setSelectedId(null)}
            onEdit={() => setWizard({ seed: selected })}
            onToggle={() => toggleEnabled(selected)}
            onDelete={() => deleteTool(selected)}
            onMove={cid => move(selected.id, cid)}
            onDeleteCategory={removeCategory}
          />
        )}
      </div>

      {wizard && (
        <ToolWizard
          seed={wizard.seed}
          categories={categories}
          existingIds={existingIds}
          onCancel={() => setWizard(null)}
          onSave={saveTool}
          onHandToCopilot={() => { setWizard(null); setCopilotFocus(n => n + 1); }}
        />
      )}
    </div>
  );
}

// One card. Three facts, quietly: what it is, what it costs, and whether it
// needs you. Status is text in one of three tones — never a filled badge, and
// never a new hue.
function ToolCard({ tool, selected, categories, dense, onSelect, onKeyDown, onDragStart, onDragEnd, onMove }) {
  const status = statusOf(tool);
  const [menu, setMenu] = useState(false);
  // The card is a WRAPPER, and the thing you click is a real <button> inside
  // it. That split is what lets the drag handle and the "Move to category…"
  // menu coexist with a proper control: a role="button" element containing
  // buttons is interactive nested in interactive, which screen readers and
  // keyboard users both handle badly.
  return (
    <div
      className={'tool-card' + (selected ? ' selected' : '') + (dense ? ' dense' : '')}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={e => { e.preventDefault(); setMenu(true); }}
    >
      <button
        type="button"
        className="tool-card-hit"
        data-tool-id={tool.id}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <span className="tool-card-top">
          <span className="tool-icon-chip" aria-hidden="true">{iconFor(tool)}</span>
          <span className="tool-card-name">
            <strong>{tool.title}</strong>
            <span className="mono tool-card-id">{tool.id}</span>
          </span>
        </span>
        {!dense && tool.description && <span className="tool-card-desc">{tool.description}</span>}
        <span className="tool-card-foot">
          <span className="tool-pill">{authOf(tool)}</span>
          <span className={'tool-status ' + status.tone}>{status.label}</span>
          <span className="mono tool-card-effects">{(tool.effects ?? []).join('·')}</span>
        </span>
      </button>

      {/* The keyboard equivalent of the drag. A board gesture that only exists
          as a mouse gesture is a board half the users can't reorganize. */}
      {menu && (
        <div className="tool-card-menu" onMouseLeave={() => setMenu(false)}>
          <span className="section-label">Move to category…</span>
          {categories.map(c => (
            <button key={c.id} className="ghost mini" onClick={() => { setMenu(false); onMove(c.id); }}>
              {c.icon} {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A tool has no icon field of its own — the record is about capability, not
// presentation — so the card borrows its column's glyph. One less thing to
// author, and the board stays visually coherent by construction.
const iconFor = tool => (tool.provider === 'builtin' ? '◈' : tool.provider === 'mcp' ? '⇄' : '◍');

function ToolInspector({ tool, categories, onClose, onEdit, onToggle, onDelete, onMove, onDeleteCategory }) {
  const params = parametersOf(tool);
  const status = statusOf(tool);
  const category = categories.find(c => c.id === tool.categoryId);
  return (
    <div className="tool-inspector">
      <header className="tool-inspector-head">
        <span className="tool-icon-chip" aria-hidden="true">{iconFor(tool)}</span>
        <div>
          <h3>{tool.title}</h3>
          <span className="mono tool-card-id">tools/{tool.id}.json</span>
        </div>
        <span className={'tool-status ' + status.tone}>{status.label}</span>
        <button className="ghost mini" onClick={onClose} aria-label="Close the inspector">✕</button>
      </header>

      {tool.description && <p className="tool-inspector-desc">{tool.description}</p>}
      {tool.disabledReason && <p className="tool-reply error mono">{tool.disabledReason}</p>}

      <dl className="tool-facts mono">
        <div><dt>provider</dt><dd>{tool.provider}</dd></div>
        <div><dt>effects</dt><dd>{(tool.effects ?? []).join(' · ')}</dd></div>
        <div><dt>risk</dt><dd>{tool.risk}</dd></div>
        <div><dt>trust</dt><dd>{tool.trust}</dd></div>
        <div><dt>scope</dt><dd>{tool.scope}</dd></div>
        <div><dt>auth</dt><dd>{authOf(tool)}</dd></div>
      </dl>

      {params.length > 0 && (
        <pre className="tool-draft-params mono">
          {params.map(p => `${p.name}${p.required ? '' : '?'}: ${p.type}${p.description ? `  — ${p.description}` : ''}`).join('\n')}
        </pre>
      )}

      <div className="tool-inspector-actions">
        <select
          value={tool.categoryId ?? ''}
          onChange={e => onMove(e.target.value || null)}
          aria-label="Category"
        >
          <option value="">(automatic)</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
        <button className="ghost" onClick={onEdit}>Edit</button>
        <button className="ghost" onClick={onToggle}>{tool.enabled ? 'Disable' : 'Enable'}</button>
        <button className="reject" onClick={onDelete}>Delete</button>
      </div>

      {category && (
        <button className="ghost mini tool-inspector-cat" onClick={() => onDeleteCategory(category.id)}>
          Delete the “{category.name}” column
        </button>
      )}
    </div>
  );
}
