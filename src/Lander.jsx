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
import ActivityIcon from './ActivityIcon.jsx';
import { loopLabel } from './activityFormat.js';
import './v2/chatHistoryStyles.css';
import { runStatus, runTimeLabel } from './runList.js';
import LaunchInputs from './LaunchInputs.jsx';
import { ModelBadge, ModelPicker, workerLabel } from './ModelPicker.jsx';
import {
  effortCopy, selectedWorkflowPreset, workflowOutcome, workflowSteps,
} from './v2/workflowUx.js';
import { WORKFLOW_MODEL_TIERS, workerForTier, workersForTier } from './modelTiers.js';
import { defaultModeId } from './workflowModes.js';

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
  // A workflow with modes always runs in one of them, so the chip names the
  // one a run would use — the chosen mode, or the default. Naming only the
  // workflow would leave the effort dial unreadable from the composer.
  const runningMode = flowsOnly ? null : (modeId ?? defaultModeId(selectedFlow));
  const selectedMode = selectedFlow?.modes?.find(m => m.id === runningMode) ?? null;
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
            // A flow with modes expands to a flat list: the workflow, then each
            // of its modes. The workflow row is not a fourth choice — it picks
            // the default mode, which is what a run names when nobody chose.
            const modes = flowsOnly ? [] : (f.modes ?? []);
            const fallbackMode = defaultModeId(f);
            // With modes, the workflow row is a shortcut to the default one:
            // picking "no mode" would be picking a fourth way to run it that
            // the runner does not have.
            const flowSelected = f.id === flowId
              && (modes.length ? (modeId ?? fallbackMode) === fallbackMode : !modeId);
            return (
              <Fragment key={f.id}>
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={flowSelected}
                  className={'lander-picker-item' + (flowSelected ? ' selected' : '')}
                  onClick={() => pick(f.id, modes.length ? fallbackMode : null)}
                >
                  <span className="lander-picker-check" aria-hidden>{flowSelected ? '✓' : ''}</span>
                  <span className="lander-picker-name">{f.name}</span>
                  {modes.length > 0 && <span className="lander-picker-badge">{modes.length} modes</span>}
                </button>
                {!flowsOnly && (f.modes ?? []).map(m => {
                  const modeSelected = f.id === flowId && (modeId ?? fallbackMode) === m.id;
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
                        {m.id === fallbackMode && <span className="lander-picker-default">default</span>}
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
  runs = [], onOpenRun, onOpenHistory = null,
  flows = [], flowId, modeId = null, onSelect, configs = {},
  canonicalWorkflows = false,
  compareOn = false, onToggleCompare, slotB = null, onSelectB,
  launchInputs = [], launchValues, onLaunchInput,
  declaredInputs = [], declaredValues, onDeclaredInput,
  models = [], activeModels = [],
  hasKey = true, claudeSubActive = false, onOpenSettings,
  busy, ready = true, inputRef, onSubmit, onOpenProject, onOpenFolder,
  submitKind = 'run', onSubmitKind = null,
  queueLevel = 'low', onQueueLevel = null,
  fallbackWorker = null, modelTiers = {}, defaultTier = 'standard', blockTiers = {}, authoredBlockTiers = {}, modelOverrides = {},
  onDefaultTier = null, onStepTier = null, onModelTier = null,
  onStepWorker = null, onResetStepWorker = null,
  queueReceipt = null,
  returnRun = null, onReturnRun = null,
}) {
  const [text, setText] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const localRef = useRef(null);
  const taRef = inputRef ?? localRef;
  const canRun = text.trim().length > 0 && !busy && ready;
  const selectedFlow = flows.find(f => f.id === flowId) ?? null;
  const selectedPreset = selectedWorkflowPreset(selectedFlow, modeId);
  const selectedSteps = workflowSteps(selectedFlow, modeId);
  const modelSteps = selectedSteps.filter(step => step.modelBacked !== false);
  const queued = submitKind === 'loop';
  const customModelCount = new Set([
    ...Object.keys(blockTiers ?? {}), ...Object.keys(modelOverrides ?? {}),
  ]).size;
  const defaultWorker = workerForTier(modelTiers, defaultTier, fallbackWorker) ?? fallbackWorker;

  useEffect(() => setModelsOpen(false), [flowId]);

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
      {!canonicalWorkflows && !compareOn && configOpen && selectedFlow && (
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
            {!queued && compareOn ? (
              <div className="lander-compare-slots">
                <span className="compare-slot-label" aria-hidden>A</span>
                <WorkflowPicker flows={flows} flowId={flowId} modeId={modeId} onPick={onSelect} ariaLabel="Workflow A" composerRef={taRef} configs={configs} />
                <span className="compare-vs" aria-hidden>vs</span>
                <span className="compare-slot-label" aria-hidden>B</span>
                <WorkflowPicker flows={flows} flowId={bFlowId} modeId={bModeId} onPick={onSelectB} ariaLabel="Workflow B" composerRef={taRef} configs={configs} />
              </div>
            ) : !queued ? (
              <div className="lander-workflow-group">
                <WorkflowPicker flows={flows} flowId={flowId} modeId={modeId} onPick={onSelect} ariaLabel="Workflow" composerRef={taRef} configs={configs} flowsOnly={!canonicalWorkflows} />
                {/* The cog is the "later stage" of choosing: which config of the
                    picked workflow to run, and its per-node settings. Disabled
                    until a workflow is chosen — there's nothing to configure. */}
                {!canonicalWorkflows && <button
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
                </button>}
              </div>
            ) : (
              <div className="lander-queue-level" role="group" aria-label="Starting effort">
                <span>Starting effort</span>
                {['low', 'medium', 'high'].map(level => (
                  <button key={level} type="button" className={queueLevel === level ? 'active' : ''}
                    aria-pressed={queueLevel === level} onClick={() => onQueueLevel?.(level)}>{level}</button>
                ))}
              </div>
            )}

            {/* Compare toggle (T11): splits the chip into A/B slots and fires two
                runs from one prompt. Off by default — the common path is one run. */}
            {!queued && onToggleCompare && (
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
            )}

            <div className="lander-submit-kind" role="group" aria-label="What should happen">
              <button type="button" className={!queued ? 'active' : ''} aria-pressed={!queued}
                onClick={() => onSubmitKind?.('run')} title="Run the selected workflow now and show its result here">Run now</button>
              <button type="button" className={queued ? 'active' : ''} aria-pressed={queued}
                onClick={() => onSubmitKind?.('loop')} title="Add this request to the Loop queue without running a workflow now">Add to Loop</button>
            </div>

            <button
              type="button"
              className="lander-run primary"
              onClick={submit}
              disabled={!canRun}
            >
              {!ready ? 'Loading…' : busy ? (queued ? 'Adding…' : 'Starting…') : queued ? 'Add task' : compareOn ? 'Compare' : 'Run'}<kbd className="shortcut">↵</kbd>
            </button>
          </div>
        </div>

        {queued ? (
          <section className="lander-run-preview queue" aria-label="Loop task summary">
            <div className="lander-preview-head">
              <div><span className="section-label">ADD TO LOOP</span><strong>Queue for unattended work</strong></div>
              <span className="lander-preview-model">{queueLevel} effort</span>
            </div>
            <p>This creates one backlog task. It does not run the selected workflow or start the Loop.</p>
            <div className="lander-preview-result"><span aria-hidden>→</span> The Loop claims it later, in an isolated worktree, and can escalate its effort if it fails.</div>
          </section>
        ) : selectedFlow ? (
          <section className="lander-run-preview" aria-label="Selected workflow summary">
            <div className="lander-preview-head">
              <div>
                <span className="section-label">RUN NOW</span>
                <strong>{selectedFlow.name}{selectedPreset ? ` · ${selectedPreset.name}` : ''}</strong>
              </div>
              <span className="lander-preview-kind">Workflow</span>
            </div>
            <p>{selectedPreset?.description || selectedFlow.description}</p>
            {selectedPreset?.id && effortCopy[selectedPreset.id] && <p className="lander-preview-effort">{effortCopy[selectedPreset.id]}</p>}
            {selectedSteps.length > 0 && <div className="lander-preview-steps" aria-label="Workflow steps">
              {selectedSteps.map((step, index) => <Fragment key={step.id}>
                {index > 0 && <span className="lander-preview-arrow" aria-hidden>→</span>}
                <span className={'lander-preview-step' + (step.checkpoint ? ' checkpoint' : '')}><strong>{step.title}</strong>
                  {step.checkpoint
                    ? <small>human approval</small>
                    : <small>{WORKFLOW_MODEL_TIERS.find(tier => tier.id === step.modelTier)?.name ?? step.modelTier ?? step.effort ?? 'Workflow default'}</small>}
                </span>
              </Fragment>)}
            </div>}
            <div className="lander-model-bar">
              <span className="lander-model-label">Model profile</span>
              <select className="lander-tier-select" value={defaultTier} onChange={event => onDefaultTier?.(event.target.value)}
                aria-label="Default workflow model profile">
                {WORKFLOW_MODEL_TIERS.map(tier => {
                  const worker = workerForTier(modelTiers, tier.id, fallbackWorker);
                  const fallbacks = tier.id === 'free'
                    ? Math.max(0, workersForTier(modelTiers, tier.id).length - 1)
                    : 0;
                  return <option key={tier.id} value={tier.id} disabled={!worker?.model}>
                    {tier.name}{worker?.model
                      ? tier.id === 'free' && fallbacks
                        ? ` · ${workerLabel(worker)} + ${fallbacks} fallback${fallbacks === 1 ? '' : 's'}`
                        : ` · ${workerLabel(worker)}`
                      : ' · not configured'}
                  </option>;
                })}
              </select>
              <button type="button" className={'lander-model-tune' + (modelsOpen ? ' active' : '')}
                onClick={() => setModelsOpen(open => !open)} aria-expanded={modelsOpen}>
                Configure{customModelCount ? ` · ${customModelCount} assigned` : ''} <span aria-hidden>{modelsOpen ? '▴' : '▾'}</span>
              </button>
            </div>
            {modelsOpen && <div className="lander-model-config">
              <div className="lander-tier-head">
                <div><strong>Model profiles</strong><small>Change a model once; every block using that profile follows. Profiles may share a model.</small></div>
              </div>
              <div className="lander-tier-grid" aria-label="Workflow model profiles">
                {WORKFLOW_MODEL_TIERS.map(tier => {
                  const freeCandidates = tier.id === 'free' ? workersForTier(modelTiers, 'free') : [];
                  return <div className={'lander-tier-row' + (tier.id === 'free' ? ' free-chain' : '')} key={tier.id}>
                    <span><strong>{tier.name}</strong><small>{tier.hint}</small></span>
                    {tier.id === 'free' ? <div className="lander-free-chain">
                      {freeCandidates.map((worker, index) => <div className="lander-free-candidate" key={`${worker.provider}/${worker.model}/${index}`}>
                        <small>{index === 0 ? 'Primary' : `Fallback ${index}`}</small>
                        <ModelPicker worker={worker} activeModels={activeModels}
                          onChange={next => onModelTier?.('free', next, index)} idPrefix={`landing-tier-free-${index}`} />
                        {index > 0 && <button type="button" className="link lander-free-remove"
                          onClick={() => onModelTier?.('free', null, index)} aria-label={`Remove free fallback ${index}`}>Remove</button>}
                      </div>)}
                      {freeCandidates.length < 4 && <div className="lander-free-candidate add">
                        <small>{freeCandidates.length ? `Fallback ${freeCandidates.length}` : 'Primary'}</small>
                        <ModelPicker worker={null} activeModels={activeModels}
                          onChange={next => onModelTier?.('free', next, freeCandidates.length)}
                          idPrefix={`landing-tier-free-${freeCandidates.length}`}
                          placeholder={freeCandidates.length ? 'Add free fallback' : 'Choose free model'} />
                      </div>}
                      <p>Tries these in order. It never falls through to a paid profile.</p>
                    </div> : <ModelPicker worker={modelTiers?.[tier.id] ?? null} activeModels={activeModels}
                      onChange={worker => onModelTier?.(tier.id, worker)} idPrefix={`landing-tier-${tier.id}`}
                      placeholder={`Uses default · ${workerLabel(fallbackWorker)}`} />}
                  </div>;
                })}
              </div>
              {modelSteps.length > 0 && <>
                <div className="lander-tier-head blocks"><div><strong>Blocks</strong><small>Pick a profile, or click the model badge for a one-off model.</small></div></div>
                <div className="lander-step-models" aria-label="Models by workflow step">
                  {modelSteps.map(step => {
                    const custom = modelOverrides?.[step.id] ?? null;
                    const assignedTier = blockTiers?.[step.id] ?? null;
                    const authoredTier = authoredBlockTiers?.[step.id] ?? null;
                    const tierId = assignedTier ?? authoredTier;
                    const effective = custom
                      ?? workerForTier(modelTiers, tierId ?? defaultTier, fallbackWorker)
                      ?? defaultWorker;
                    return <div className="lander-step-model" key={step.id}>
                      <span className="lander-step-model-copy"><strong>{step.title}</strong><small>{step.effort ? `${step.effort} reasoning` : 'workflow step'}</small></span>
                      <select value={custom ? 'custom' : (tierId ?? 'default')}
                        onChange={event => event.target.value !== 'custom' && onStepTier?.(step.id, event.target.value === 'default' ? null : event.target.value)}
                        aria-label={`${step.title} model profile`}>
                        <option value="default">Workflow default</option>
                        {WORKFLOW_MODEL_TIERS.map(tier => {
                          const worker = workerForTier(modelTiers, tier.id, fallbackWorker);
                          return <option key={tier.id} value={tier.id} disabled={!worker?.model}>{tier.name}</option>;
                        })}
                        {custom && <option value="custom">Specific model</option>}
                      </select>
                      <ModelBadge worker={effective} activeModels={activeModels}
                        onChange={worker => onStepWorker?.(step.id, worker)}
                        title={`${step.title}: ${custom ? 'specific model' : tierId ? `${tierId} profile` : 'workflow default'} — click for a one-off model`} />
                      {(custom || assignedTier) && <button type="button" className="link lander-model-reset" onClick={() => onResetStepWorker?.(step.id)}>Reset</button>}
                    </div>;
                  })}
                </div>
              </>}
            </div>}
            <div className="lander-preview-result"><span aria-hidden>→</span> {workflowOutcome(selectedFlow)}. {(selectedFlow?.steps ?? []).some(step => step.use === 'flyt-blocks-loop:loop-handoff') ? 'The handoff queues tasks without starting the Loop.' : 'Only an explicit Backlog handoff block can queue tasks during a workflow.'}</div>
          </section>
        ) : null}

        {queueReceipt && (
          <div className="lander-queue-receipt" role="status">
            <span aria-hidden>✓</span><span><strong>{queueReceipt.title}</strong> added to Loop as <code>{queueReceipt.id}</code>. It has not started yet.</span>
          </div>
        )}

        {returnRun && (
          <button type="button" className="lander-return-run" onClick={onReturnRun}>
            <span aria-hidden>↩</span><span><small>RETURN TO RUN</small><strong>{returnRun.name}</strong></span>
            <span className="lander-return-stage">{returnRun.stage}</span>
          </button>
        )}

        {/* First-ever-launch (no key): a single quiet line under the composer,
            not a wall (§3). The run path still works for no-file flows, so
            this informs rather than blocks. */}
        {!queued && !hasKey && (
          <div className="lander-hint">
            Add an OpenRouter key in{' '}
            <button type="button" className="link" onClick={onOpenSettings}>Models</button>
            {' '}to run.
          </div>
        )}

        {/* Claude-subscription notice (DESIGN-SPEC.md §6): the user
            opted in, but each run should still say where its usage lands. */}
        {!queued && claudeSubActive && (
          <div className="lander-hint lander-hint-warn">
            <span aria-hidden>⚠</span> Runs may use your Claude subscription (via Claude Code) — plan limits apply.{' '}
            <button type="button" className="link" onClick={onOpenSettings}>Manage in Models</button>
          </div>
        )}

        {/* Recent runs (§3) — up to five for this project, each a sigil + name +
            time + status, opening the run on click. Replaces empty-page syndrome
            for returning users and quietly advertises the sigil identity. */}
        {!projectless && (
          <div className="lander-recent-runs">
            <div className="lander-recents-head"><span className="section-label">Recent</span>{onOpenHistory && <button onClick={onOpenHistory}>Chat history ↗</button>}</div>
            {runs.length === 0 ? (
              <div className="muted lander-recents-empty">Runs will appear here.</div>
            ) : (
              <div className="lander-runs-list">
                {runs.slice(0, 5).map(run => {
                  const status = run.kind === 'loop' ? { ...runStatus(run), label: loopLabel(run.status) } : runStatus(run);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className="lander-run-row"
                      onClick={() => onOpenRun?.(run.id)}
                      title={`${run.name} · ${status.label}`}
                    >
                      <span className={'run-sigil ' + status.kind}><ActivityIcon kind={run.kind} id={run.id} size={20}/></span>
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
