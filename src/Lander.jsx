// The lander — the chat-first home of every project tab (DECISIONS.md D25).
// A chat window you already know how to use: a greeting, an autofocused
// composer, Enter to run. The differentiators (workflows, the canvas, the
// unfold) are revealed by later phases, never front-loaded here.
//
// Phase 2b completes the composer: the workflow chip opens a real picker (L3),
// the selection persists per tab (App's run-flow state, carried in the tab
// bundle), and a first-launch line points to Settings when no key is configured.
//
// Phase 5 resolved the open questions (DECISIONS.md D25):
//   Q-L1 — the rail stays visible on the lander (hiding chrome on the home page
//          would make the other sections feel like a different app).
//   Q-L2 — a purpose-built picker (there was no existing dropdown component).
//   Q-L3 — the composer stays silent about auto-creating a project; only the
//          empty projectless recents state hints it, so returning users (who
//          already know the model) aren't nagged.
// The picker is a keyboard-navigable listbox (arrow keys, Home/End, Esc back to
// the chip); the constellation is aria-hidden; focus order is composer → chip →
// run → recents.
//
// DECISIONS.md D27 adds the Compare toggle: the workflow chip splits into two
// slots (A / B), each an independent flow+mode selection, and one prompt fires
// two runs shown side by side. The picker is extracted to WorkflowPicker so a
// slot and the single-run chip share exactly one keyboard-correct listbox.
import { Fragment, useEffect, useRef, useState } from 'react';
import Constellation from './Constellation.jsx';
import Logo from './Logo.jsx';
import ConfigModal from './ConfigModal.jsx';
import { sigil } from './sigil.js';
import { runStatus, runTimeLabel } from './runList.js';
import LaunchInputs from './LaunchInputs.jsx';

// One workflow chip + its listbox popover. Owns only its open/close and roving
// focus; the selection and the pick handler come from the parent, so a slot and
// the single-run chip are the same control with different wiring.
// `configs` (DECISIONS.md D27) is flow:listConfigs output keyed by flow id —
// each config's diff-against-Default badges render under its name, so
// "Low · Fable vs Low · GPT-5" is scannable instead of a flat list of names.
function WorkflowPicker({ flows, flowId, modeId, onPick, ariaLabel, composerRef, configs = {}, flowsOnly = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const chipRef = useRef(null);
  const listRef = useRef(null);

  const selectedFlow = flows.find(f => f.id === flowId) ?? null;
  const selectedMode = selectedFlow?.modes?.find(m => m.id === modeId) ?? null;
  const chipLabel = selectedFlow
    ? (selectedMode ? `${selectedFlow.name} · ${selectedMode.name}` : selectedFlow.name)
    : (flows.length ? 'Select workflow' : 'No workflows');

  // Dismissal: Esc closes (and returns focus to the chip), a click or focus
  // move outside closes too.
  useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); chipRef.current?.focus(); }
    };
    const outside = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('focusin', outside);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('focusin', outside);
    };
  }, [open]);

  // On open, focus the selected option (or the first) so it is arrow-navigable.
  useEffect(() => {
    if (!open) return;
    const items = listRef.current?.querySelectorAll('.lander-picker-item');
    if (!items?.length) return;
    ([...items].find(el => el.getAttribute('aria-selected') === 'true') ?? items[0]).focus();
  }, [open]);

  const onListKeyDown = e => {
    const items = [...(listRef.current?.querySelectorAll('.lander-picker-item') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1 + items.length) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  };

  const pick = (id, mode = null) => {
    onPick(id, mode);
    setOpen(false);
    composerRef?.current?.focus(); // straight back to typing after choosing
  };

  return (
    <div className="lander-chip-wrap" ref={wrapRef}>
      <button
        ref={chipRef}
        type="button"
        className={'lander-chip' + (open ? ' open' : '')}
        onClick={() => setOpen(o => !o)}
        disabled={!flows.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${chipLabel}`}
        title="Choose the workflow to run"
      >
        <span className="lander-chip-glyph" aria-hidden>◇</span>
        <span className="lander-chip-name">{chipLabel}</span>
        <span className="lander-chip-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="lander-picker" role="listbox" aria-label={ariaLabel} ref={listRef} onKeyDown={onListKeyDown}>
          {flows.map(f => {
            // A flow with modes expands to a flat list: the flow itself (its
            // stored default) followed by each named mode (T4).
            const flowSelected = f.id === flowId && !modeId;
            return (
              <Fragment key={f.id}>
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={flowSelected}
                  className={'lander-picker-item' + (flowSelected ? ' selected' : '')}
                  onClick={() => pick(f.id, null)}
                >
                  <span className="lander-picker-check" aria-hidden>{flowSelected ? '✓' : ''}</span>
                  <span className="lander-picker-name">{f.name}</span>
                  {f.modes?.length > 0 && <span className="lander-picker-badge">{f.modes.length} modes</span>}
                </button>
                {!flowsOnly && (f.modes ?? []).map(m => {
                  const modeSelected = f.id === flowId && modeId === m.id;
                  const cfg = configs[f.id]?.find(c => c.id === m.id) ?? null;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={modeSelected}
                      className={'lander-picker-item lander-picker-mode' + (modeSelected ? ' selected' : '')}
                      onClick={() => pick(f.id, m.id)}
                      title={cfg?.description ?? undefined}
                    >
                      <span className="lander-picker-check" aria-hidden>{modeSelected ? '✓' : ''}</span>
                      <span className="lander-picker-name">
                        {m.name}
                        {cfg?.badges?.length > 0 && (
                          <span className="lander-picker-badges">
                            {cfg.badges.slice(0, 3).map((b, i) => <span key={i} className="lander-picker-diff">{b}</span>)}
                            {cfg.badges.length > 3 && <span className="lander-picker-diff">+{cfg.badges.length - 3} more</span>}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Lander({
  projectName, projectless, recents = [], seed,
  runs = [], onOpenRun,
  flows = [], flowId, modeId = null, onSelect, configs = {},
  compareOn = false, onToggleCompare, slotB = null, onSelectB,
  launchInputs = [], launchValues, onLaunchInput,
  declaredInputs = [], declaredValues, onDeclaredInput,
  models = [], activeModels = [],
  hasKey = true, claudeSubActive = false, onOpenSettings,
  busy, inputRef, onSubmit, onOpenProject, onOpenFolder
}) {
  const [text, setText] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const localRef = useRef(null);
  const taRef = inputRef ?? localRef;
  const canRun = text.trim().length > 0 && !busy;
  const selectedFlow = flows.find(f => f.id === flowId) ?? null;

  // Slot B falls back to slot A's flow (default mode) until the user repoints it.
  const bFlowId = slotB?.flowId ?? flowId;
  const bModeId = slotB?.modeId ?? null;

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

  return (
    <main className="lander">
      <Constellation seed={seed} />
      {/* The config modal (the cog's "later stage"): pick a config of the chosen
          workflow and tune its per-node settings. Rendered at the lander root so
          its backdrop covers the whole home area. */}
      {!compareOn && configOpen && selectedFlow && (
        <ConfigModal
          flow={selectedFlow}
          configs={configs[flowId] ?? []}
          modeId={modeId}
          onSelect={(fid, mid) => onSelect(fid, mid)}
          launchInputs={launchInputs}
          launchValues={launchValues}
          onLaunchInput={onLaunchInput}
          models={models}
          activeModels={activeModels}
          onClose={() => { setConfigOpen(false); taRef.current?.focus(); }}
        />
      )}
      <div className="lander-stage">
        <div className="lander-greeting">
          <Logo className="lander-lockup" markSize={15} />
          <h1 className="lander-title">
            {projectName
              ? <>What should we build in <span className="mono">{projectName}</span>?</>
              : 'What should we build?'}
          </h1>
        </div>

        {/* What this flow DECLARED it needs (D36 P1.3) sits ON the composer, not
            behind the config modal: a run that cannot start without a
            repository URL must not hide the field that supplies it. */}
        {declaredInputs.length > 0 && (
          <LaunchInputs
            inputs={[]}
            declared={declaredInputs}
            inputValues={declaredValues}
            onInputChange={onDeclaredInput}
            models={models}
            activeModels={activeModels}
          />
        )}

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
            {/* Workflow choice (L3 / T11). One chip normally; two slots (A vs B)
                when Compare is on — each an independent flow+mode selection. */}
            {compareOn ? (
              <div className="lander-compare-slots">
                <span className="compare-slot-label" aria-hidden>A</span>
                <WorkflowPicker flows={flows} flowId={flowId} modeId={modeId} onPick={onSelect} ariaLabel="Workflow A" composerRef={taRef} configs={configs} />
                <span className="compare-vs" aria-hidden>vs</span>
                <span className="compare-slot-label" aria-hidden>B</span>
                <WorkflowPicker flows={flows} flowId={bFlowId} modeId={bModeId} onPick={onSelectB} ariaLabel="Workflow B" composerRef={taRef} configs={configs} />
              </div>
            ) : (
              <div className="lander-workflow-group">
                <WorkflowPicker flows={flows} flowId={flowId} modeId={modeId} onPick={onSelect} ariaLabel="Workflow" composerRef={taRef} configs={configs} flowsOnly />
                {/* The cog is the "later stage" of choosing: which config of the
                    picked workflow to run, and its per-node settings. Disabled
                    until a workflow is chosen — there's nothing to configure. */}
                <button
                  type="button"
                  className={'lander-config-cog' + (configOpen ? ' open' : '')}
                  onClick={() => setConfigOpen(true)}
                  disabled={!flowId}
                  aria-haspopup="dialog"
                  aria-expanded={configOpen}
                  title="Configure this workflow — pick a config and tune per-node settings"
                  aria-label="Configure workflow"
                >
                  <span aria-hidden>⚙</span>
                </button>
              </div>
            )}

            {/* Compare toggle (T11): splits the chip into A/B slots and fires two
                runs from one prompt. Off by default — the common path is one run. */}
            <button
              type="button"
              className={'lander-compare-toggle' + (compareOn ? ' active' : '')}
              onClick={onToggleCompare}
              disabled={!flows.length}
              aria-pressed={compareOn}
              title="Compare two workflows or modes side by side on one prompt"
            >
              <span aria-hidden>⚖</span> Compare
            </button>

            <button
              type="button"
              className="lander-run primary"
              onClick={submit}
              disabled={!canRun}
            >
              {busy ? 'Starting…' : compareOn ? 'Compare' : 'Run'}<kbd className="shortcut">↵</kbd>
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

        {/* Claude-subscription notice (DESIGN-SPEC.md §6): the user
            opted in, but each run should still say where its usage lands. */}
        {claudeSubActive && (
          <div className="lander-hint lander-hint-warn">
            <span aria-hidden>⚠</span> Runs may use your Claude subscription (via Claude Code) — plan limits apply.{' '}
            <button type="button" className="link" onClick={onOpenSettings}>Manage</button>
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
