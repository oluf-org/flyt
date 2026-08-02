import React, { useEffect, useState } from 'react';

// *Create node* / *Create flow* — the three doors out of an empty library
// (PIVOT-PLAN §5.1).
//
//   Blank              start from nothing and fill it in
//   Start from a preset  the ten templates and five pipelines that used to be
//                      installed for you, now offered
//   Describe it        the builder writes a draft you commit (§5.4)
//
// The empty library is a cold start, and it is the plan's own named risk. Three
// doors is the answer: verification items 3 and 4 exist because the preset path
// and the manual path must BOTH work independently of the builder.
//
// A preset install is always a COPY. The dialog says what it will add before
// you click, because a flow quietly installing three templates into your
// library is exactly the behaviour the empty library exists to end.

export default function CreateDialog({ kind, onClose, onBlank, onDescribe, onInstalled }) {
  const isFlow = kind === 'flow';
  const [door, setDoor] = useState(null);
  const [presets, setPresets] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    if (door !== 'preset' || presets) return;
    if (!window.flyt?.listPresets) { setError('Presets are only available in the app.'); return; }
    window.flyt.listPresets()
      .then(r => setPresets(isFlow ? r.flows : r.nodes))
      .catch(err => setError(String(err?.message ?? err)));
  }, [door, presets, isFlow]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const install = async preset => {
    setBusy(preset.id);
    setError(null);
    try {
      const r = isFlow
        ? await window.flyt.installFlowPreset(preset.id)
        : await window.flyt.installNodePreset(preset.id);
      if (!r?.ok) { setError(r?.error ?? 'Could not install that preset.'); return; }
      onInstalled?.(isFlow ? r.flowId : r.template.id, r.templates ?? []);
      onClose();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="create-dialog" role="dialog" aria-modal="true" aria-label={isFlow ? 'Create a flow' : 'Create a node'}>
        <header className="create-head">
          <h2>{isFlow ? 'Create a flow' : 'Create a node'}</h2>
          <button className="link" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
        </header>

        {!door && (
          <div className="create-doors">
            <Door
              icon="◻" title="Blank"
              body={isFlow
                ? 'An input and an output, wired together. Build the middle from the palette — the engine primitives are always there.'
                : 'An empty template. Give it a prompt, a model and whatever tools it needs.'}
              onClick={() => { onBlank(); onClose(); }}
            />
            <Door
              icon="▤" title="Start from a preset"
              body={isFlow
                ? 'The five pipelines the app used to install for you. Copied into your flows, yours to edit.'
                : 'The ten templates the app used to install for you. Copied into your library, yours to edit.'}
              onClick={() => setDoor('preset')}
            />
            <Door
              icon="✎" title="Describe it"
              body="Say what you want in plain language. The builder writes a draft you review and commit."
              onClick={() => { onDescribe?.(); onClose(); }}
              disabled={!onDescribe}
              note={!onDescribe ? 'Needs a model — connect a provider in Settings.' : null}
            />
          </div>
        )}

        {door === 'preset' && (
          <div className="create-presets">
            <button className="link back" onClick={() => setDoor(null)}>← All three ways</button>
            {error && <p className="create-error">{error}</p>}
            {!presets && !error && <p className="create-empty">Reading presets…</p>}
            {presets?.length === 0 && <p className="create-empty">No presets are bundled with this build.</p>}
            <ul className="preset-list">
              {(presets ?? []).map(p => (
                <li key={p.id} className={'preset-row' + (p.installed ? ' installed' : '')}>
                  <span className="preset-icon">{p.icon ?? (isFlow ? '◇' : '✦')}</span>
                  <div className="preset-text">
                    <div className="preset-name">
                      {p.name}
                      {p.installed && <span className="preset-have">already in your library</span>}
                    </div>
                    <div className="preset-desc">{p.description || (isFlow ? `${p.nodeCount} nodes` : 'Node template')}</div>
                    {/* Say what else this adds BEFORE the click. */}
                    {isFlow && p.willInstall?.length > 0 && (
                      <div className="preset-needs">
                        also installs {p.willInstall.length} template{p.willInstall.length === 1 ? '' : 's'} it needs:{' '}
                        <span className="mono">{p.willInstall.join(', ')}</span>
                      </div>
                    )}
                  </div>
                  <button
                    className="primary mini"
                    onClick={() => install(p)}
                    disabled={p.installed || busy === p.id}
                  >{p.installed ? 'Installed' : busy === p.id ? 'Adding…' : 'Add'}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Door({ icon, title, body, onClick, disabled = false, note = null }) {
  return (
    <button type="button" className="create-door" onClick={onClick} disabled={disabled}>
      <span className="create-door-icon" aria-hidden>{icon}</span>
      <span className="create-door-title">{title}</span>
      <span className="create-door-body">{body}</span>
      {note && <span className="create-door-note">{note}</span>}
    </button>
  );
}
