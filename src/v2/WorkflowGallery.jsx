// Build's landing: every workflow in the project, and the three verbs that
// make another one.
//
// Build used to open straight into whichever stack the host happened to have
// loaded, which meant the answer to "what else is in here?" was a search box on
// another destination and the answer to "make me a new one" was a text editor.
// A destination whose first screen is one document is a destination you can
// only use if you already know what is in it.
//
// The organizing line is the one the runner draws: a workflow marked
// `launchable` is offered in chat, and everything else is a piece other stacks
// use. Grouping by that means the list answers "what can I run" without anyone
// having to open a file to find out.
//
// Modes are shown here rather than only inside the editor because they are part
// of what a workflow IS. Pipeline is one graph with three settings profiles
// over it, not three workflows, and a gallery that hid them would be inviting
// somebody to duplicate it three times.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { changedLabel, galleryRows } from './workflowGalleryModel.js';
import './workflowGalleryStyles.css';

function Icon({ name, size = 16 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5H6a2 2 0 0 0-2 2v9" /></>,
    edit: <><path d="M4 20h4l10-10-4-4L4 16z" /><path d="m14 6 4 4" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    warn: <><path d="M12 4 3 20h18z" /><path d="M12 10v4M12 17h.01" /></>,
  };
  return <svg className="wg-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name] ?? paths.plus}
  </svg>;
}

function ModeChips({ presets = [] }) {
  if (!presets.length) {
    return <p className="wg-modes none">One way to run — no modes.</p>;
  }
  return (
    <div className="wg-modes" aria-label="Modes">
      {presets.map(preset => (
        <span key={preset.id} className={'wg-mode' + (preset.default ? ' is-default' : '')}
          title={[preset.description, preset.default ? 'Runs when nobody picks a mode.' : '',
            preset.targets?.length ? `Changes: ${preset.targets.join(', ')}` : '']
            .filter(Boolean).join(' ')}>
          {preset.name || preset.id}
          {preset.default && <em>default</em>}
        </span>
      ))}
    </div>
  );
}

function WorkflowCard({ row, active, onEdit, onDuplicate }) {
  return (
    <article className={'wg-card' + (active ? ' active' : '') + (row.error ? ' broken' : '')}>
      <button type="button" className="wg-card-open" onClick={() => onEdit(row.id)}
        aria-label={`Edit ${row.name || row.id}`}>
        <header>
          <h3>{row.name || row.id}</h3>
          {active && <span className="wg-open-badge">open</span>}
        </header>
        <code className="wg-card-id">{row.id}</code>
        {row.error
          ? <p className="wg-card-error"><Icon name="warn" size={13} />{row.error}</p>
          : <p className="wg-card-desc">{row.description || 'No description yet.'}</p>}
        <ModeChips presets={row.presets ?? []} />
      </button>
      <footer>
        <span className="wg-card-meta">
          {Number.isFinite(row.blockCount) ? `${row.blockCount} step${row.blockCount === 1 ? '' : 's'}` : 'unreadable'}
          {row.updatedAt ? ` · ${changedLabel(row.updatedAt)}` : ''}
        </span>
        <span className="wg-card-acts">
          <button type="button" className="wg-ghost" onClick={() => onDuplicate(row)}>
            <Icon name="copy" size={14} />Duplicate
          </button>
          <button type="button" className="wg-solid" onClick={() => onEdit(row.id)}>
            <Icon name="edit" size={14} />Edit
          </button>
        </span>
      </footer>
    </article>
  );
}

/**
 * New and Duplicate, which are the same dialog because they are the same act
 * with a different starting point. The id is derived from the name by the
 * host — asking a person to name a file twice is asking them to keep two
 * things in sync forever.
 */
function CreateDialog({ from = null, busy = false, error = '', onSubmit, onClose }) {
  const [name, setName] = useState(from ? `${from.name || from.id} copy` : '');
  const [description, setDescription] = useState('');
  const field = useRef(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const submit = event => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    onSubmit({ name: name.trim(), description: description.trim(), from: from?.id ?? null });
  };
  return (
    <div className="wg-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="wg-dialog" role="dialog" aria-modal="true" aria-labelledby="wg-dialog-title"
        onMouseDown={event => event.stopPropagation()} onSubmit={submit}>
        <span className="section-label">{from ? 'DUPLICATE' : 'NEW WORKFLOW'}</span>
        <h2 id="wg-dialog-title">{from ? `Copy “${from.name || from.id}”` : 'Name the workflow'}</h2>
        <p className="wg-dialog-copy">
          {from
            ? 'The copy carries the same steps, settings and modes. Change the copy freely — the original is untouched.'
            : 'It starts with one step and is launchable from chat. Add steps from the palette, and modes when one workflow needs more than one way to run.'}
        </p>
        <label>
          <span>Name</span>
          <input ref={field} value={name} onChange={event => setName(event.target.value)}
            placeholder="Review a change" maxLength={64} />
        </label>
        {!from && <label>
          <span>Description <small>optional</small></span>
          <input value={description} onChange={event => setDescription(event.target.value)}
            placeholder="What it is for, in one line" maxLength={140} />
        </label>}
        {error && <p className="wg-dialog-error" role="alert">{error}</p>}
        <div className="wg-dialog-acts">
          <button type="button" className="wg-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="wg-solid" disabled={!name.trim() || busy}>
            {busy ? 'Working…' : from ? 'Duplicate' : 'Create workflow'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * @param stacks — the host's stack rows. Absent, the gallery says the project
 *   has no workflows, which is a true thing to say and a different thing from
 *   a broken Build.
 * @param activeId — the workflow Build currently has open, marked so returning
 *   to the gallery does not lose where you were.
 * @param onOpen — open one for editing.
 * @param onCreate — `{ name, description, from }`; `from` makes it a duplicate.
 */
export default function WorkflowGallery({
  stacks = [], activeId = null, onOpen = null, onCreate = null, busy = false, error = '',
}) {
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const rows = useMemo(() => galleryRows(stacks, query), [stacks, query]);
  const launchable = rows.filter(row => row.launchable);
  const internal = rows.filter(row => !row.launchable);

  const create = async input => {
    try {
      await onCreate?.(input);
      setDialog(null);
    } catch { /* the host's message is rendered by the caller */ }
  };

  const section = (title, hint, list) => list.length > 0 && (
    <section className="wg-section">
      <header><h2>{title}</h2><p>{hint}</p><span>{list.length}</span></header>
      <div className="wg-grid">
        {list.map(row => (
          <WorkflowCard key={row.id} row={row} active={row.id === activeId}
            onEdit={id => onOpen?.(id)} onDuplicate={target => setDialog({ from: target })} />
        ))}
      </div>
    </section>
  );

  return (
    <div className="workflow-gallery" data-v2>
      <header className="wg-head">
        <div>
          <p className="wg-eyebrow">Build</p>
          <h1>Workflows</h1>
          <p className="wg-lede">
            One workflow is one graph of steps. Modes are named settings over that graph —
            the same steps, run harder or lighter — so a change of shape is a new workflow
            and a change of effort is a mode.
          </p>
        </div>
        <div className="wg-head-acts">
          <label className="wg-search">
            <Icon name="search" size={15} />
            <input type="search" value={query} placeholder="Search workflows and modes"
              onChange={event => setQuery(event.target.value)} aria-label="Search workflows" />
          </label>
          <button type="button" className="wg-new" onClick={() => setDialog({ from: null })} disabled={!onCreate}>
            <Icon name="plus" size={16} />New workflow
          </button>
        </div>
      </header>

      {/* One place at a time: while the dialog is open it is the dialog that
          reports the refusal, and a banner repeating it behind the backdrop is
          the same sentence twice. */}
      {error && !dialog && <p className="wg-error" role="alert">{error}</p>}

      {!stacks.length ? (
        <div className="wg-empty">
          <p className="section-label">NOTHING HERE YET</p>
          <h2>This project has no workflows.</h2>
          <p>Make one and it becomes a choice in chat straight away.</p>
          <button type="button" className="wg-solid big" onClick={() => setDialog({ from: null })} disabled={!onCreate}>
            <Icon name="plus" size={16} />New workflow
          </button>
        </div>
      ) : !rows.length ? (
        <p className="wg-none">Nothing matches “{query}”.</p>
      ) : (
        <div className="wg-body">
          {section('Launchable', 'Offered in chat. Pick one, pick its mode, and run.', launchable)}
          {section('Internal', 'Not offered in chat — pieces other workflows and the Loop use.', internal)}
        </div>
      )}

      {dialog && <CreateDialog from={dialog.from} busy={busy} error={error}
        onSubmit={create} onClose={() => setDialog(null)} />}
    </div>
  );
}
