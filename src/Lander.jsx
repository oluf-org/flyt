// The lander — the chat-first home of every project tab (LANDER-PLAN.md).
// A chat window you already know how to use: a greeting, an autofocused
// composer, Enter to run. The differentiators (workflows, the canvas, the
// unfold) are revealed by later phases, never front-loaded here.
//
// Phase 2b completes the composer: the workflow chip opens a real picker (L3),
// the selection persists per tab (App's run-flow state, carried in the tab
// bundle), and a first-launch line points to Settings when no key is configured.
//
// Phase 5 resolved the open questions (LANDER-PLAN §6):
//   Q-L1 — the rail stays visible on the lander (hiding chrome on the home page
//          would make the other sections feel like a different app).
//   Q-L2 — a purpose-built picker (there was no existing dropdown component).
//   Q-L3 — the composer stays silent about auto-creating a project; only the
//          empty projectless recents state hints it, so returning users (who
//          already know the model) aren't nagged.
// The picker is a keyboard-navigable listbox (arrow keys, Home/End, Esc back to
// the chip); the constellation is aria-hidden; focus order is composer → chip →
// run → recents.
import { useEffect, useRef, useState } from 'react';
import Constellation from './Constellation.jsx';
import { sigil } from './sigil.js';
import { runStatus, runTimeLabel } from './runList.js';

export default function Lander({
  projectName, projectless, recents = [], seed,
  runs = [], onOpenRun,
  flows = [], flowId, onSelectFlow,
  hasKey = true, onOpenSettings,
  busy, inputRef, onSubmit, onOpenProject, onOpenFolder
}) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const localRef = useRef(null);
  const taRef = inputRef ?? localRef;
  const chipWrapRef = useRef(null);
  const chipRef = useRef(null);
  const pickerRef = useRef(null);
  const canRun = text.trim().length > 0 && !busy;

  const selectedFlow = flows.find(f => f.id === flowId) ?? null;
  const chipLabel = selectedFlow?.name ?? (flows.length ? 'Select workflow' : 'No workflows');

  const submit = () => {
    if (!canRun) return;
    onSubmit(text.trim());
    setText('');
  };

  // Enter runs, Shift+Enter inserts a newline — the composer convention every
  // chat app has trained users on.
  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Picker dismissal: Esc closes it (and only it — the lander stays put) and
  // returns focus to the chip (the ARIA-correct trigger); a click or a focus
  // move outside closes it too.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); setPickerOpen(false); chipRef.current?.focus(); }
    };
    const onPointer = e => {
      if (chipWrapRef.current && !chipWrapRef.current.contains(e.target)) setPickerOpen(false);
    };
    const onFocusIn = e => {
      if (chipWrapRef.current && !chipWrapRef.current.contains(e.target)) setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [pickerOpen]);

  // On open, move focus to the selected option (or the first) so the listbox is
  // immediately arrow-navigable for keyboard users.
  useEffect(() => {
    if (!pickerOpen) return;
    const items = pickerRef.current?.querySelectorAll('.lander-picker-item');
    if (!items?.length) return;
    ([...items].find(el => el.getAttribute('aria-selected') === 'true') ?? items[0]).focus();
  }, [pickerOpen]);

  // Roving focus within the listbox: arrows wrap, Home/End jump to the ends.
  const onPickerKeyDown = e => {
    const items = [...(pickerRef.current?.querySelectorAll('.lander-picker-item') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1 + items.length) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  };

  const pickFlow = id => {
    onSelectFlow?.(id);
    setPickerOpen(false);
    taRef.current?.focus(); // straight back to typing after choosing
  };

  return (
    <main className="lander">
      <Constellation seed={seed} />
      <div className="lander-stage">
        <div className="lander-greeting">
          <span className="section-label">LLM Flow</span>
          <h1 className="lander-title">
            {projectName
              ? <>What should we build in <span className="mono">{projectName}</span>?</>
              : 'What should we build?'}
          </h1>
        </div>

        <div className="lander-composer">
          <textarea
            ref={taRef}
            className="lander-input"
            placeholder="Describe what you want…"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Describe what you want"
            autoFocus
            rows={3}
          />
          <div className="lander-composer-footer">
            {/* Workflow chip (L3): the only place workflow choice appears on the
                lander. Opens a compact picker of the real flow list; the choice
                persists per tab via App's run-flow state. */}
            <div className="lander-chip-wrap" ref={chipWrapRef}>
              <button
                ref={chipRef}
                type="button"
                className={'lander-chip' + (pickerOpen ? ' open' : '')}
                onClick={() => setPickerOpen(o => !o)}
                disabled={!flows.length}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label={`Workflow: ${chipLabel}`}
                title="Choose the workflow to run"
              >
                <span className="lander-chip-glyph" aria-hidden>◇</span>
                <span className="lander-chip-name">{chipLabel}</span>
                <span className="lander-chip-caret" aria-hidden>▾</span>
              </button>
              {pickerOpen && (
                <div
                  className="lander-picker"
                  role="listbox"
                  aria-label="Workflow"
                  ref={pickerRef}
                  onKeyDown={onPickerKeyDown}
                >
                  {flows.map(f => (
                    <button
                      key={f.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={f.id === flowId}
                      className={'lander-picker-item' + (f.id === flowId ? ' selected' : '')}
                      onClick={() => pickFlow(f.id)}
                    >
                      <span className="lander-picker-check" aria-hidden>{f.id === flowId ? '✓' : ''}</span>
                      <span className="lander-picker-name">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="lander-run primary"
              onClick={submit}
              disabled={!canRun}
            >
              {busy ? 'Starting…' : 'Run'}<kbd className="shortcut">↵</kbd>
            </button>
          </div>
        </div>

        {/* First-ever-launch (no key): a single quiet line under the composer,
            not a wall (§3). The run path still works for mock/no-file flows, so
            this informs rather than blocks. */}
        {!hasKey && (
          <div className="lander-hint">
            Add an OpenRouter key in{' '}
            <button type="button" className="link" onClick={onOpenSettings}>Settings</button>
            {' '}to run.
          </div>
        )}

        {/* Recent runs (§3) — up to five for this project, each a sigil + name +
            time + status, opening the run on click. Replaces empty-page syndrome
            for returning users and quietly advertises the sigil identity. */}
        {!projectless && (
          <div className="lander-recent-runs">
            <span className="section-label">Recent</span>
            {runs.length === 0 ? (
              <div className="muted lander-recents-empty">Runs will appear here.</div>
            ) : (
              <div className="lander-runs-list">
                {runs.slice(0, 5).map(run => {
                  const status = runStatus(run);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className="lander-run-row"
                      onClick={() => onOpenRun?.(run.id)}
                      title={`${run.name} · ${status.label}`}
                    >
                      <span
                        className={'run-sigil ' + status.kind}
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: sigil(run.id, 20) }}
                      />
                      <span className="lander-run-name">{run.name}</span>
                      <span className="lander-run-meta mono">
                        <span className="lander-run-time">{runTimeLabel(run)}</span>
                        <span className="run-sep">·</span>
                        <span className={'run-status ' + status.kind}>{status.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Projectless (L5): no recent-runs strip (there is no project). Instead
            a compact recent-projects list plus a quiet folder link, for users
            who'd rather bind an existing repo up front. Running from the
            composer above auto-creates a project — no picker required. */}
        {projectless && (
          <div className="lander-recents">
            <div className="lander-recents-head">
              <span className="section-label">Recent projects</span>
              <button type="button" className="link" onClick={onOpenFolder}>Open folder…</button>
            </div>
            {recents.length === 0 ? (
              <div className="muted lander-recents-empty">Type above to start — we'll create a project for you.</div>
            ) : (
              <div className="lander-recents-list">
                {recents.map(r => (
                  <button
                    key={r.folder}
                    type="button"
                    className={'lander-recent' + (r.exists ? '' : ' missing')}
                    disabled={!r.exists}
                    title={r.exists ? r.folder : `${r.folder} — folder not found`}
                    onClick={() => r.exists && onOpenProject?.(r.folder)}
                  >
                    <span className="lander-recent-name">{r.name}</span>
                    <span className="lander-recent-path mono">{r.folder}</span>
                    {!r.exists && <span className="lander-recent-missing">missing</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
