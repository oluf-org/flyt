import React from 'react';
import { diffOverrides } from './flowTypes.js';

// The Configs panel (CONFIGS-COMPARE P1): one card per config on the open
// flow, each showing its diff against Default (the flow as authored on the
// canvas) as badges, with Run / Duplicate / Edit / Delete actions. Anchored
// at the "modes" chip in the flow header — the chip toggles it. The panel and
// the YAML editor are two views of the same modes: block: every action goes
// through the normal flow-change path, so undo, autosave and lint apply.

// A mode id slugged from a human name ("GPT-5 · strict" -> "gpt-5-strict").
export function slugConfigId(name) {
  const slug = String(name ?? '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

function ConfigCard({ id, mode, badges, isLaunchTarget, isEditTarget, onRun, onDuplicate, onEdit, onDelete }) {
  const name = mode.name || id;
  return (
    <div className={'config-card' + (isEditTarget ? ' editing' : '')}>
      <div className="config-card-head">
        <span className="config-card-name">{name}</span>
        {mode.derivedFrom && (
          <span className="config-card-lineage" title={`Duplicated/promoted from "${mode.derivedFrom}" (lineage only — the full override map is stored here)`}>
            ↳ {mode.derivedFrom}
          </span>
        )}
      </div>
      {mode.description && <div className="config-card-desc">{mode.description}</div>}
      <div className="config-badges">
        {badges.length
          ? badges.map((b, i) => (
              <span key={i} className={'config-badge' + (b.kind === 'change' ? '' : ' warn')} title={b.text}>{b.text}</span>
            ))
          : <span className="config-badge neutral">same as Default</span>}
      </div>
      <div className="config-card-actions">
        <button type="button" className="primary mini" onClick={() => onRun(id)} title="Point the run panel at this config and open it">Run</button>
        <button type="button" className="ghost mini" onClick={() => onDuplicate(id)} title="Copy this config's full override map under a new name">Duplicate</button>
        <button type="button" className="ghost mini" onClick={() => onEdit(id)} title="Edit this config in the Inspector — select a node to change its overrides">
          {isEditTarget ? 'Editing…' : 'Edit'}
        </button>
        <button
          type="button"
          className="ghost mini danger"
          onClick={() => onDelete(id)}
          title={isLaunchTarget
            ? 'This config is the run panel\'s selected launch target — deleting clears that selection'
            : 'Delete this config'}
        >Delete</button>
      </div>
    </div>
  );
}

export default function ConfigsPanel({
  flow, resolved,
  launchTargetId = null,   // the tab's selected launch mode on THIS flow (delete guard)
  editModeId = null,       // the Inspector's current config edit target
  onRun, onDuplicate, onEdit, onDelete, onNew, onClose
}) {
  const modes = flow.modes ?? {};
  const ids = Object.keys(modes);
  return (
    <div className="configs-panel" role="dialog" aria-label="Configs">
      <div className="configs-panel-head">
        <span className="section-label">Configs</span>
        <span className="configs-panel-sub">
          Named override bundles of “{flow.name}”. Default is the flow as drawn on the canvas; badges show what each config changes.
        </span>
        <div className="toolbar-spacer" />
        <button type="button" className="ghost mini" onClick={onNew} title="Create an empty config, then edit it in the Inspector">＋ New</button>
        <button type="button" className="link" onClick={onClose} aria-label="Close configs panel">✕</button>
      </div>
      <div className="configs-panel-body">
        {ids.length === 0 && (
          <div className="muted" style={{ padding: '8px 4px' }}>
            No configs yet — press ＋ New, or duplicate/promote one from a run.
          </div>
        )}
        {ids.map(id => (
          <ConfigCard
            key={id}
            id={id}
            mode={modes[id]}
            badges={diffOverrides(resolved, modes[id]?.overrides)}
            isLaunchTarget={launchTargetId === id}
            isEditTarget={editModeId === id}
            onRun={onRun}
            onDuplicate={onDuplicate}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}
