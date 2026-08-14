import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DND_MIME, dndOrchestrator, dndFanout, dndTemplate } from './FlowCanvas.jsx';

// The node picker: the familiar "add node" panel of node editors (n8n,
// Node-RED, Blueprints). Search-first, grouped, every row both click-to-add
// and drag-onto-canvas. Rendered as an overlay inside the canvas area; the
// parent owns open/close and the actual add.
//
// Groups: the built-in containers (Orchestrator, Fan-out) under "Structural",
// then Node Library
// templates grouped by their category (uncategorized templates land in
// "General"). Filtering matches name, description, and category.

const ORCH_ITEM = {
  key: 'orchestrator',
  icon: '▦',
  name: 'Orchestrator',
  description: 'AI container — plans autonomously and runs the nodes inside its box',
  spec: () => dndOrchestrator()
};

// The other container (D36 B5): same box, but the children come from a lane
// list you wrote rather than from a model's plan.
const FANOUT_ITEM = {
  key: 'fanout',
  icon: '⋔',
  name: 'Fan-out',
  description: 'One brief, N deliberately different takes — one lane per model, run in parallel',
  spec: () => dndFanout()
};

function groupTemplates(templates) {
  const groups = new Map();
  for (const t of templates) {
    const g = t.category?.trim() || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({
      key: t.id,
      icon: t.icon || '✦',
      name: t.name,
      description: t.description || 'Node Library template',
      spec: () => dndTemplate(t.id)
    });
  }
  // Named groups alphabetically; General (the uncategorized bucket) last.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'General') - (b === 'General') || a.localeCompare(b))
    .map(([label, items]) => ({ label, items }));
}

export default function NodePicker({ templates, onAdd, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = it => !q
      || it.name.toLowerCase().includes(q)
      || it.description.toLowerCase().includes(q);
    const out = [];
    const structural = [ORCH_ITEM, FANOUT_ITEM].filter(match);
    if (structural.length) out.push({ label: 'Structural', items: structural });
    for (const g of groupTemplates(templates)) {
      const items = g.items.filter(match);
      if (items.length) out.push({ label: g.label, items });
    }
    return out;
  }, [templates, query]);

  // Flat list for keyboard navigation.
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('.picker-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const add = item => { onAdd(item.spec()); };
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); add(flat[active]); }
  };

  let rowIndex = -1;
  return (
    <div className="node-picker" role="dialog" aria-label="Add a node" onKeyDown={onKeyDown}>
      <div className="picker-search">
        <span className="picker-search-icon" aria-hidden>⌕</span>
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search nodes…"
          aria-label="Search nodes"
        />
        <button className="link" onClick={onClose} aria-label="Close node picker" title="Close (Esc)">✕</button>
      </div>
      <div className="picker-list" ref={listRef}>
        {sections.map(section => (
          <div className="picker-group" key={section.label}>
            <div className="picker-group-label">{section.label}</div>
            {section.items.map(it => {
              rowIndex += 1;
              const idx = rowIndex;
              return (
                <div
                  key={it.key}
                  role="button"
                  tabIndex={-1}
                  className={'picker-row' + (idx === active ? ' active' : '')}
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.setData(DND_MIME, JSON.stringify(it.spec()));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => add(it)}
                  onMouseEnter={() => setActive(idx)}
                  title={`${it.name} — click to add, or drag onto the canvas`}
                >
                  <span className="picker-row-icon">{it.icon}</span>
                  <span className="picker-row-text">
                    <span className="picker-row-name">{it.name}</span>
                    <span className="picker-row-desc">{it.description}</span>
                  </span>
                  <span className="picker-row-grip" aria-hidden>⠿</span>
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && <div className="picker-empty">No nodes match “{query}”.</div>}
      </div>
      <div className="picker-foot">
        <span>Click to add · drag onto the canvas · drop onto a box to fill it</span>
        <kbd>↑↓</kbd><kbd>↵</kbd><kbd>esc</kbd>
      </div>
    </div>
  );
}
