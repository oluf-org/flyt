import React, { useEffect, useRef, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import GoalCanvas from './GoalCanvas.jsx';
import ChangeRequestDialog from './ChangeRequestDialog.jsx';
import GoalPicker from './GoalPicker.jsx';
import GoalLibrary from './GoalLibrary.jsx';
import GoalRequirements from './GoalRequirements.jsx';
import { findGoalNode } from './goalCanvasData.js';
import { GOAL_RECIPE } from './goalDefaults.js';

const SETUP = `version: 2
id: goal-setup
name: Establish baseline
blocks:
  - id: baseline
    use: flyt-blocks-core:general-analysis
    title: Record baseline and plan
    config:
      instructions: "Establish a concise baseline and approach for the Goal. Return a short setup note, at most 150 words."
`;
const defaults = { name: 'My goal', objective: '', constraints: '', criteria: [], limits: { iterations: 10, calls: 100, minutes: 30, usd: null },
  folder: '', folderMode: 'focus', createFolder: false, requiredPaths: [], tools: [], maxParallel: 1, plateau: 3, selfRedesign: false, reviewResults: false, worker: null, setup: null };
const stringify = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const localRead = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const localWrite = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Server remains authoritative. */ } };
const fieldId = address => `goal-field-${address.replaceAll('/', '-')}`;
// Block settings arrive as identifiers; a sidebar label should read like a label.
const humanize = key => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([a-z]+)/g, (whole, head, tail) => head.toLowerCase() + tail)
  .replace(/^./, character => character.toUpperCase());

function Field({ address, label, value, type = 'text', disabled, onChange, onQuote, onLock, locks = [], pending = [], warnings = [], rows = 3 }) {
  const input = useRef(null), selection = useRef(null);
  const change = pending.find(item => item.address === address), locked = locks.some(lock => address === lock || address.startsWith(`${lock}/`));
  const props = { id: fieldId(address), 'aria-describedby': warnings.length ? `${fieldId(address)}-warning` : undefined, ref: input, disabled, value: value ?? '', onChange: event => onChange(address, type === 'number' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value),
    onSelect: () => { if (input.current && typeof input.current.selectionStart === 'number') selection.current = { start: input.current.selectionStart, end: input.current.selectionEnd }; } };
  return <div className={`goal-field ${change ? 'ai-changed' : ''} ${warnings.length ? 'path-warning' : ''}`}><label htmlFor={props.id}>{label}{locked && <small>locked</small>}{change && <span className="goal-change-badge">AI {change.kind}</span>}{warnings.length > 0 && <small>Project warning</small>}</label>
    {['textarea', 'json'].includes(type) ? <textarea {...props} rows={rows}/> : <input {...props} type={type}/>}
    {warnings.length > 0 && <p id={`${props.id}-warning`} className="goal-field-warning">{warnings.map(item => item.path ? `${item.path}: ${item.message}` : item.message).join(' ')}</p>}
    {onQuote && !disabled && <div className="goal-field-actions"><button type="button" onClick={() => onQuote(address, value, selection.current)}>Ask AI to change…</button><button type="button" onClick={() => onLock(address, !locked)}>{locked ? 'Unlock' : 'Lock from AI'}</button></div>}
  </div>;
}

function ReviewDialog({ definition, requirements, goal, onClose, onApprove, busy }) {
  const ref = useRef(null), trigger = useRef(null);
  useEffect(() => { trigger.current = document.activeElement; ref.current.showModal(); return () => trigger.current?.isConnected && trigger.current.focus(); }, []);
  const action = !goal || goal.status === 'ready' ? 'start' : goal.status === 'failed' ? 'retry' : 'resume';
  return <dialog className="goal-review-dialog" ref={ref} aria-labelledby="goal-review-title" onCancel={event => { event.preventDefault(); onClose(); }}><h2 id="goal-review-title">Review and {action}</h2>
    <p className="goal-review-objective">{definition.objective}</p><dl><dt>Model</dt><dd>{definition.worker?.model || 'No model selected'}</dd><dt>Workspace</dt><dd>{definition.createFolder ? 'A new folder under ' : 'Use '}{definition.folder || 'the project folder'}</dd><dt>Budget</dt><dd>{definition.limits.iterations} iterations · {definition.limits.calls} calls · {definition.limits.minutes} min{definition.limits.usd ? ` · $${definition.limits.usd}` : ''}</dd><dt>Checks</dt><dd>{definition.criteria.length ? <ul>{definition.criteria.map((item, index) => <li key={index}>{item.value ?? stringify(item)}</li>)}</ul> : 'None'}</dd><dt>Tools</dt><dd>{definition.tools.join(', ') || 'None'}</dd><dt>Review</dt><dd>{definition.reviewResults ? 'Human, every iteration' : 'Runtime checks'}</dd></dl>
    <GoalRequirements report={requirements}/>
    {action !== 'start' && <p>Continuing this run preserves its {goal.iteration} completed iterations, {goal.calls} model calls, and recorded spend. The budget above is the total limit.</p>}
    <div className="goal-actions"><button className="goal-primary" disabled={busy} onClick={onApprove}>Approve and {action}</button><button disabled={busy} onClick={onClose}>Back to draft</button></div></dialog>;
}

export default function GoalWorkspace({ projectId, onOpenRun }) {
  const [goals, setGoals] = useState([]), [draft, setDraft] = useState(null), [models, setModels] = useState([]);
  const [savedDrafts, setSavedDrafts] = useState([]);
  const [library, setLibrary] = useState(null), [requirements, setRequirements] = useState(null);
  const [recipe, setRecipe] = useState(null), [setup, setSetup] = useState(null), [selected, setSelected] = useState(null);
  const [edits, setEdits] = useState({}), [chatOpen, setChatOpen] = useState(false), [composer, setComposer] = useState(''), [quotes, setQuotes] = useState([]);
  const [scope, setScope] = useState({ type: 'loop' }), [selectedFiles, setSelectedFiles] = useState('');
  const [authorModel, setAuthorModel] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [controlBusy, setControlBusy] = useState(null);
  const [review, setReview] = useState(false), [inspection, setInspection] = useState(null), [detail, setDetail] = useState(false), [revisionView, setRevisionView] = useState('draft');
  const [snapshot, setSnapshot] = useState(null), [mobileView, setMobileView] = useState('steps'), [feedback, setFeedback] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(280, Math.min(460, localRead('goal-sidebar-width') || 320)));
  const resizing = useRef(null);
  const sidebar = useRef(null);
  const draftRef = useRef(null), alive = useRef(true), opening = useRef(0), uiReady = useRef(false), editBase = useRef(null);
  const goal = goals.find(item => item.id === draft?.goalId), definition = draft?.definition;
  const pendingProposals = draft?.proposals.filter(item => item.status === 'pending') ?? [];
  const pending = pendingProposals.filter(item => !item.initial).flatMap(item => item.diff);
  const working = draft?.requests.some(item => item.status === 'working');
  const dirty = Object.keys(edits).length > 0;
  const invoke = (action, args = {}) => window.flyt.goal(action, { projectId, draftId: draftRef.current?.id, goalId: draftRef.current?.goalId, ...args });
  const commitDraft = value => {
    if (value.id === draftRef.current?.id && value.sequence < draftRef.current.sequence) return;
    draftRef.current = value; setDraft(value);
    setSavedDrafts(current => [...current.filter(item => item.id !== value.id), ...(!value.goalId ? [{ id: value.id, name: value.definition.name, revision: value.revision, goalId: null }] : [])]);
  };
  const refresh = async () => {
    const value = await invoke('list'); if (alive.current) setGoals(value);
    const drafts = await invoke('author-list'); if (alive.current) setSavedDrafts(drafts.filter(item => !item.goalId));
    const id = draftRef.current?.id;
    if (id) { const next = await invoke('author-read', { draftId: id }); if (alive.current && draftRef.current?.id === id) commitDraft(next); }
  };
  const checkRequirements = async (next = draftRef.current) => {
    if (!next) return null;
    const report = await invoke('requirements', { draftId: next.id });
    if (alive.current && draftRef.current?.id === next.id && draftRef.current?.revision === next.revision) setRequirements(report);
    return report;
  };
  const act = async action => {
    setError(''); setBusy(true);
    try { return await action(); } catch (caught) { if (alive.current) setError(String(caught.message ?? caught)); return null; }
    finally { if (alive.current) setBusy(false); }
  };
  // Renaming is an ordinary field edit — the same operation the name input in
  // the sidebar makes — so it goes through `author-edit` and picks up the
  // validation, the history entry and the revision bump with it. It is offered
  // only for drafts because the backend refuses `goal/` edits once an instance
  // has started, and a button that always fails is worse than no button.
  const renameDraft = (draftId, name) => act(async () => {
    const state = await invoke('author-read', { draftId });
    const next = await invoke('author-edit', {
      draftId, baseRevision: state.revision, operations: [{ op: 'replace', address: 'goal/name', value: name }]
    });
    if (draftRef.current?.id === draftId) commitDraft(next);
    await refresh();
  });
  // Deleting the draft that is currently open leaves nothing to look at, so it
  // opens a fresh one rather than rendering a workspace around a record that is
  // gone.
  const deleteDraft = draftId => act(async () => {
    await invoke('author-delete', { draftId });
    setSavedDrafts(current => current.filter(item => item.id !== draftId));
    if (draftRef.current?.id === draftId) { draftRef.current = null; setDraft(null); localWrite(`goal-active:${projectId}`, null); await open(); }
    else await refresh();
  });
  const open = async (goalId = null, restoreId = null) => {
    const generation = ++opening.current;
    return act(async () => {
      const item = goals.find(value => value.id === goalId);
      const id = restoreId || item?.contract.authoringId;
      const next = id ? await invoke('author-read', { draftId: id }) : await invoke('author-open', { goalId, definition: { ...defaults, recipe: GOAL_RECIPE } });
      if (!alive.current || generation !== opening.current) return;
      uiReady.current = false; commitDraft(next); setRequirements(null); setSelected(null); setChatOpen(false); setDetail(false); setReview(false); setInspection(null); setRevisionView('draft');
      const buffer = localRead(`goal-edits:${projectId}:${next.id}`);
      setEdits(buffer?.values ?? {}); editBase.current = buffer?.baseRevision ?? next.revision; setRevisionView(next.goalId && !Object.keys(buffer?.values ?? {}).length ? 'running' : 'draft');
      const saved = localRead(`goal-ui:${projectId}:${next.id}`) ?? next.ui;
      setComposer(saved?.composer ?? ''); setQuotes(saved?.quotes ?? []);
      setScope(saved?.scope ?? { type: saved?.quotes?.length ? 'fields' : 'loop' }); setSelectedFiles(saved?.selectedFiles ?? '');
      localWrite(`goal-active:${projectId}`, next.id); uiReady.current = true;
      return next;
    });
  };
  useEffect(() => {
    if (!window.flyt?.goal) return;
    alive.current = true;
    let polling = false;
    const poll = async () => { if (polling) return; polling = true; try { await refresh(); } catch (caught) { if (alive.current) setError(caught.message); } finally { polling = false; } };
    poll();
    window.flyt.getSettings().then(settings => { if (alive.current) setModels((settings.activeModels ?? []).filter(item => item.enabled !== false)); }).catch(caught => alive.current && setError(caught.message));
    const saved = localRead(`goal-active:${projectId}`); if (saved) open(null, saved);
    const timer = setInterval(poll, 1500);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!draft || !uiReady.current) return;
    const ui = { composer, quotes, scope, selectedFiles }; localWrite(`goal-ui:${projectId}:${draft.id}`, ui);
    const timer = setTimeout(() => { invoke('author-ui', { draftId: draft.id, ui }).catch(caught => alive.current && setError(caught.message)); }, 300);
    return () => clearTimeout(timer);
  }, [composer, quotes, scope, selectedFiles, draft?.id]);
  useEffect(() => { if (draft) localWrite(`goal-edits:${projectId}:${draft.id}`, { values: edits, baseRevision: editBase.current }); }, [edits, draft?.id]);
  useEffect(() => { if (sidebar.current) sidebar.current.scrollTop = 0; }, [draft?.id]);
  useEffect(() => {
    if (!draft) return;
    let current = true;
    const check = () => checkRequirements().catch(caught => { if (current && alive.current) setError(caught.message); });
    check();
    const timer = setInterval(check, 5000);
    return () => { current = false; clearInterval(timer); };
  }, [draft?.id, draft?.revision, goal?.workspace?.path]);
  useEffect(() => localWrite('goal-sidebar-width', sidebarWidth), [sidebarWidth]);
  useEffect(() => {
    if (!draft) return;
    let current = true;
    (async () => {
      const source = revisionView === 'running' && goal ? (await invoke('inspect', { record: `recipe-${goal.activeRevision}` })).source : draft.definition.recipe;
      const value = await invoke('draft', { source });
      const once = draft.definition.setup ? await invoke('draft', { source: draft.definition.setup }) : null;
      if (current) { setRecipe(value); setSetup(once); }
    })().catch(caught => current && setError(caught.message));
    return () => { current = false; };
  }, [draft?.id, draft?.definition.recipe, draft?.definition.setup, revisionView, goal?.activeRevision]);
  useEffect(() => {
    let current = true;
    const runId = goal?.activeChild?.runId ?? goal?.current?.runId;
    if (!runId || !window.flyt.getSnapshot) { setSnapshot(null); return; }
    window.flyt.getSnapshot(projectId, runId).then(value => { if (current) setSnapshot(value); }).catch(() => { if (current) setSnapshot(null); });
    return () => { current = false; };
  }, [goal?.activeChild?.runId, goal?.current?.runId, goal?.calls, goal?.updatedAt]);
  const update = (address, value) => setEdits(current => { if (!Object.keys(current).length) editBase.current = draftRef.current.revision; return { ...current, [address]: value }; });
  const valueFor = (address, value) => Object.hasOwn(edits, address) ? edits[address] : value;
  const flush = async () => {
    if (!dirty) return draftRef.current;
    const next = await invoke('author-edit', { baseRevision: editBase.current, operations: Object.entries(edits).map(([address, value]) => ({ op: 'replace', address, value: typeof value !== 'string' ? value : address === 'goal/requiredPaths' ? value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) : ['goal/criteria', 'goal/tests'].includes(address) ? JSON.parse(value) : value })) });
    commitDraft(next); setEdits({}); return next;
  };
  const lock = (address, locked) => act(async () => { const next = await flush(); commitDraft(await invoke('author-lock', { address, locked, baseRevision: next.revision })); });
  const quote = (address, value, range) => {
    if (dirty) { setError('Save your field edits before quoting a change. Your text is preserved.'); return; }
    const item = { address, value };
    if (typeof value === 'string' && range?.end > range?.start) item.range = { ...range, text: value.slice(range.start, range.end) };
    setQuotes(current => [...current.filter(entry => entry.address !== address), item]); setScope({ type: 'fields' }); setChatOpen(true);
  };
  const inspectTarget = address => {
    setChatOpen(false); setDetail(false); setMobileView('details');
    setSelected(address?.startsWith('goal/') ? null : address?.split('/').slice(0, 2).join('/') || null);
    setTimeout(() => { const field = document.getElementById(fieldId(address ?? '')); for (let parent = field?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; field?.focus(); }, 0);
  };
  const send = () => act(async () => {
    if (dirty) throw new Error('Save your field edits before submitting a change request');
    const choice = models.find(item => item.id === authorModel);
    await invoke('author-message', { baseRevision: draftRef.current.revision, requestId: crypto.randomUUID(), text: composer, quotes, scope,
      selectedFiles: selectedFiles.split(/\r?\n/).map(file => file.trim()).filter(Boolean), worker: { provider: choice?.source ?? 'auto', model: authorModel } });
    setComposer(''); await refresh();
  });
  const modelValue = valueFor('goal/worker', definition?.worker);
  const criteriaValue = valueFor('goal/criteria', definition?.criteria);
  const criteriaList = Array.isArray(criteriaValue) ? criteriaValue : definition?.criteria ?? [];
  const field = (address, label, value, options = {}) => <Field key={address} address={address} label={label} value={options.type === 'json' ? stringify(valueFor(address, value)) : valueFor(address, value)} onChange={update} onQuote={quote} onLock={lock} locks={draft.locks} pending={pending} warnings={[...(requirements?.paths ?? []).filter(item => item.status !== 'present'), ...(requirements?.warnings ?? [])].filter(item => item.address === address)} disabled={busy || revisionView === 'running' || (Boolean(draft.goalId) && (address.startsWith('goal/') || address.startsWith('setup/')))} {...options}/>;
  const select = address => { setSelected(address); setDetail(false); if (address) setMobileView('details'); };
  const [phase, nodeId] = selected?.split('/') ?? [];
  const selectedNode = findGoalNode((phase === 'setup' ? setup : recipe)?.stack?.root, nodeId);
  const selectedDefinition = recipe?.blocks.find(item => item.use === selectedNode?.use);
  const steps = [];
  for (const [stepPhase, tree] of [['recipe', recipe], ['setup', setup]]) {
    const visit = node => {
      if (!node) return;
      if (node !== tree.stack.root) steps.push({ address: `${stepPhase}/${node.id}`, group: stepPhase === 'setup' ? 'Setup' : 'Loop', title: node.title || node.id });
      node.children?.forEach(visit); node.else?.forEach(visit);
    };
    if (tree?.stack) visit(tree.stack.root);
  }
  const runAction = async action => {
    setControlBusy(action); setError('');
    try { await invoke('control', { action }); await refresh(); }
    catch (caught) { if (alive.current) setError(String(caught.message ?? caught)); }
    finally { if (alive.current) setControlBusy(current => current === action ? null : current); }
  };
  const reviewResult = decision => act(async () => { await invoke('review-result', { ...goal.pendingResult, decision, feedback }); setFeedback(''); await refresh(); });
  const reviewProposal = (proposalId, decision) => act(async () => { if (dirty && decision === 'accept') throw new Error('Save your direct edits first; stale proposals must be refreshed'); commitDraft(await invoke('author-review', { proposalId, decision })); });
  if (!window.flyt?.goal) return <div className="goal-page"><h1>Goals</h1><p>Open the desktop app to author and execute Goals.</p></div>;
  return <div className="goal-page"><header className="goal-header">
    <div className="goal-identity">
      <h1 className="goal-title"><GoalPicker draft={draft} goals={goals} drafts={savedDrafts} busy={busy} onOpen={(goalId, draftId) => open(goalId, draftId)} onRename={renameDraft} onDelete={deleteDraft} /></h1>
      <button className="goal-new" aria-label="New goal" title="New goal" disabled={busy} onClick={() => open()}>+</button>
      <button disabled={busy} onClick={() => act(async () => { await flush(); setLibrary(await invoke('library')); })}>Loop library</button>
      {goal ? <strong role="status" className="goal-status">{{ finishing: 'Finishing cleanup', cleanup_failed: 'Cleanup needs attention' }[goal.status] ?? goal.status.replaceAll('_', ' ')}</strong> : draft && <span className="goal-status quiet">{draft.approvedHash === draft.hash ? 'reviewed' : 'not reviewed'}</span>}
      {goal?.pendingRevision && <span className="goal-status quiet">v{goal.pendingRevision} queued</span>}
    </div>
    {draft && <div className="goal-actions">
      <div className="goal-version-group">
        <label className="goal-version">Version<select aria-label="Definition revision" value={revisionView} onChange={event => { setRevisionView(event.target.value); setDetail(false); }}><option value="draft">{draft.revision}</option>{goal && <option value="running">active recipe · {goal.activeRevision}</option>}</select></label>
        <button className="goal-save" aria-label="Save field edits" disabled={busy || !dirty} onClick={() => act(flush)}>Save{dirty && <span className="goal-count">{Object.keys(edits).length}</span>}</button>
      </div>
      <button aria-label="Chat" className={working ? 'working' : ''} disabled={busy} onClick={() => setChatOpen(true)}>Chat{pendingProposals.length > 0 && <span className="goal-count">{pendingProposals.length}</span>}</button>
      {(goal?.live || goal?.recoverable) && <button disabled={goal.controlAvailable === false || controlBusy === 'pause' || goal.status === 'pausing' || goal.status === 'stopping'} onClick={() => runAction('pause')}>{goal.status === 'pausing' ? 'Pausing…' : 'Pause'}</button>}
      {goal && (goal.live || ['ready', 'running', 'pausing', 'stopping', 'paused', 'interrupted', 'failed', 'finishing', 'cleanup_failed'].includes(goal.status)) && <button disabled={goal.controlAvailable === false || controlBusy === 'stop'} onClick={() => runAction('stop')}>{controlBusy === 'stop' ? 'Stopping…' : 'Stop'}</button>}
      {!goal?.live && <button className="goal-primary" disabled={busy || !!controlBusy || working || !!pendingProposals.length || !!goal?.pendingResult || (goal && !['ready', 'paused', 'interrupted', 'failed', 'stopped', 'cleanup_failed'].includes(goal.status) && !goal.recoverable)} onClick={() => act(async () => { const next = await flush(); await checkRequirements(next); setReview(true); })}>{goal?.status === 'cleanup_failed' ? 'Retry cleanup and resume' : goal?.status === 'failed' ? 'Review and retry' : goal && goal.status !== 'ready' ? 'Review and resume' : 'Review and start'}</button>}
    </div>}
  </header>
    {error && <p role="alert" className="goal-error">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></p>}
    {goal?.controlAvailable === false && <p className="goal-hint">This goal is owned by an older app process. Pause or stop it in that process.</p>}
    {library && <GoalLibrary items={library} busy={busy} error={error} onClose={() => setLibrary(null)} onUse={libraryId => act(async () => { const next = await invoke('reuse', { libraryId }); setLibrary(null); await open(null, next.id); await refresh(); })}/>}
    {!draft ? <div className="goal-empty"><h2>A clear objective.<br/>A repeatable process.</h2><button className="goal-primary" disabled={busy} onClick={async () => { if (await open()) setChatOpen(true); }}>Describe your loop</button></div> : <>
      <nav className="goal-mobile-tabs" aria-label="Goal panels"><button aria-pressed={mobileView === 'steps'} onClick={() => setMobileView('steps')}>Loop</button><button aria-pressed={mobileView === 'details'} onClick={() => setMobileView('details')}>Details</button></nav>
      <div className={`goal-layout mobile-${mobileView}`}><aside ref={sidebar} className="goal-sidebar" style={{ width: sidebarWidth }} aria-label={selected ? 'Step inspector' : 'Loop overview'}><div className="goal-sidebar-head">{selected ? <button className="goal-back" aria-label="Back to loop overview" onClick={() => select(null)}>← Back</button> : <h2>Overview</h2>}</div>
        {!selected ? <>
          <GoalRequirements report={requirements} onInspect={inspectTarget} busy={busy} onRefresh={() => act(() => checkRequirements())}/>
          {draft.origin && <p className="goal-hint">Reused from {draft.origin.name} · v{draft.origin.revision}. Changes and progress belong to this project.</p>}
          {field('goal/name', 'Name', definition.name)}{field('goal/objective', 'Objective', definition.objective, { type: 'textarea', rows: 4 })}
          <details open={!goal}><summary>Checks</summary>{field('goal/constraints', 'Fixed constraints', definition.constraints, { type: 'textarea' })}
            <label className="goal-field">Acceptance checks<small>Required text · one per line</small><textarea aria-label="Acceptance checks" rows={3} disabled={!!goal || busy} value={criteriaList.filter(item => item.type === 'output_contains').map(item => item.value).join('\n')} onChange={event => update('goal/criteria', [...event.target.value.split('\n').map(value => ({ type: 'output_contains', value })), ...definition.criteria.filter(item => item.type !== 'output_contains')])}/></label>
            <label className="goal-check"><input type="checkbox" disabled={!!goal || busy} checked={valueFor('goal/reviewResults', definition.reviewResults)} onChange={event => update('goal/reviewResults', event.target.checked)}/>Human review after each iteration</label></details>
          <details open={!goal}><summary>Execution</summary><label className="goal-field">Model<select id={fieldId('goal/worker')} aria-label="Goal model" disabled={!!goal || busy} value={modelValue?.model ?? ''} onChange={event => update('goal/worker', { provider: models.find(item => item.id === event.target.value)?.source ?? 'auto', model: event.target.value })}><option value="">Choose a model</option>{modelValue?.model && !models.some(item => item.id === modelValue.model) && <option value={modelValue.model}>{modelValue.model} (unavailable)</option>}{models.map(item => <option value={item.id} key={item.id}>{item.id}</option>)}</select></label>
            <p className="goal-hint">Every step uses this model.</p>{modelValue && !goal && <button disabled={busy || dirty} onClick={() => lock('goal/worker', !draft.locks.includes('goal/worker'))}>{draft.locks.includes('goal/worker') ? 'Unlock model from AI' : 'Lock model from AI'}</button>}
            {field('goal/folder', 'Workspace folder', definition.folder || '', { onQuote: undefined })}<p className="goal-hint">Leave blank to use this project. Relative folders resolve inside the project.</p>
            <label className="goal-check"><input id={fieldId('goal/createFolder')} type="checkbox" disabled={!!goal || busy} checked={Boolean(valueFor('goal/createFolder', definition.createFolder))} onChange={event => update('goal/createFolder', event.target.checked)}/>Create a new folder for each run</label>
            <p className="goal-hint">{valueFor('goal/createFolder', definition.createFolder) ? 'The new folder starts empty. Use setup to provide any required inputs.' : 'The loop works directly in the selected project folder.'}</p>
            {field('goal/requiredPaths', 'Required project paths', (definition.requiredPaths ?? []).join('\n'), { type: 'textarea', onQuote: undefined })}
            <p className="goal-hint">Files or folders the project should provide, one per line. Use relative paths such as src or docs/security.md. Missing paths produce warnings.</p>
            <label className="goal-check"><input type="checkbox" disabled={!!goal || busy} checked={Boolean(valueFor('setup', definition.setup))} onChange={event => update('setup', event.target.checked ? SETUP : null)}/>Run setup once</label></details>
          <details open={!goal}><summary>Limits</summary><div className="goal-field-row">{['iterations', 'calls', 'minutes'].map((key, index) => <label className="goal-field" key={key}>{['Iterations', 'Model calls', 'Minutes'][index]}<input type="number" min="1" disabled={!!goal || busy} value={valueFor('goal/limits', definition.limits)[key]} onChange={event => update('goal/limits', { ...valueFor('goal/limits', definition.limits), [key]: event.target.value === '' ? '' : Number(event.target.value) })}/></label>)}
            <label className="goal-field">Spend cap<input type="number" min="0.001" step="any" placeholder="$" disabled={!!goal || busy} value={valueFor('goal/limits', definition.limits).usd ?? ''} onChange={event => update('goal/limits', { ...valueFor('goal/limits', definition.limits), usd: event.target.value === '' ? null : Number(event.target.value) })}/></label>
            {field('goal/plateau', 'Stop after no gain', definition.plateau, { type: 'number', onQuote: undefined })}{field('goal/maxParallel', 'Max parallel', definition.maxParallel, { type: 'number', onQuote: undefined })}</div>
            <p className="goal-hint">The spend cap is checked between calls; unpriced usage stays unknown.</p>
            <fieldset><legend>Tools</legend>{['read_file', 'glob', 'search_files', 'create_file', 'write_file', 'edit_file', 'bash', 'run_gate'].map(tool => <label className="goal-check" key={tool}><input type="checkbox" disabled={!!goal || busy} checked={valueFor('goal/tools', definition.tools).includes(tool)} onChange={event => update('goal/tools', event.target.checked ? [...valueFor('goal/tools', definition.tools), tool] : valueFor('goal/tools', definition.tools).filter(item => item !== tool))}/>{tool}</label>)}</fieldset><label className="goal-check"><input type="checkbox" disabled={!!goal || busy} checked={valueFor('goal/selfRedesign', definition.selfRedesign)} onChange={event => update('goal/selfRedesign', event.target.checked)}/>AI may propose loop changes<small>Every change waits for your review.</small></label></details>
          {goal && <><section className="goal-progress"><h3>Progress</h3><p>{goal.reason}</p><dl><dt>Iterations</dt><dd>{goal.iteration} / {goal.contract.limits.iterations}</dd><dt>Model calls</dt><dd>{goal.calls} / {goal.contract.limits.calls}</dd><dt>Known spend</dt><dd>${goal.knownUsd.toFixed(4)}{goal.unknownCostCalls ? ` + ${goal.unknownCostCalls} unpriced` : ''}</dd><dt>Setup</dt><dd>{goal.setupDone ? 'Complete' : 'Pending'}</dd><dt>Time left</dt><dd>{Math.max(0, Math.ceil(goal.contract.limits.minutes - goal.elapsedMs / 60000))} min</dd></dl>{goal.current && <><h4>Current</h4><p>{goal.current.preview}</p></>}{goal.best && <><h4>Best · {Math.round(goal.best.score * 100)}% checks</h4><p>{goal.best.preview}</p><button onClick={() => act(async () => setInspection(await invoke('inspect', { record: goal.best.artifact })))}>View best result</button></>}</section>
            <div className="goal-actions"><button onClick={() => setInspection({ contract: goal.contract, workspace: goal.workspace, findings: goal.memory, best: goal.best })}>Inspect memory</button>{goal.activeChild && <button onClick={() => onOpenRun?.(goal.activeChild.runId)}>Open current run</button>}<button disabled={busy} onClick={() => act(async () => { const next = await invoke('clone'); await refresh(); await open(next.id); })}>New instance</button></div><details><summary>Evidence</summary>{goal.history.map(item => <p key={item.iteration}>Iteration {item.iteration} · v{item.revision} · {Math.round(item.score * 100)}% <button onClick={() => act(async () => setInspection(await invoke('inspect', { record: item.artifact })))}>Inspect</button></p>)}</details></>}
        </> : nodeId === '$verify' ? <><h3>Verify &amp; continue<span className="goal-status quiet">system</span></h3><p>Checks the result against the fixed contract, keeps the best, then repeats or exits.</p><pre>{stringify(definition.criteria)}</pre></> : selectedNode ? <>
          {field(`${phase}/${nodeId}/title`, 'Step title', selectedNode.title ?? '')}<p className="goal-meta"><span>{selectedNode.kind === 'block' ? selectedNode.use : `${selectedNode.kind} container`}</span><span>{definition.worker?.model || 'No model'}</span></p>
          {(snapshot?.meta?.nodeStatus?.[nodeId] ?? snapshot?.meta?.blockStatus?.[nodeId]) !== 'done' && goal?.activeChild && !goal.live && ['failed', 'paused', 'stopped', 'interrupted'].includes(goal.status) && (phase === 'setup' ? goal.activeChild.phase === 'setup' : goal.activeChild.phase.startsWith('iteration-')) && <button disabled={busy || !!controlBusy || dirty || !!goal.pendingRevision} onClick={() => act(async () => { await invoke('start', { retry: { runId: goal.activeChild.runId, blockId: nodeId } }); await refresh(); })}>Retry from this node</button>}
          {selectedNode.kind === 'block' ? Object.entries({ ...(selectedDefinition?.settings?.properties ?? {}), ...Object.fromEntries(Object.keys(selectedNode.config ?? {}).map(key => [key, selectedDefinition?.settings?.properties?.[key] ?? { type: 'string' }])) }).filter(([key]) => !['model', 'modelTier', 'modelFallbacks'].includes(key)).map(([key, schema]) => {
            const value = selectedNode.config?.[key]; if (['boolean', 'object', 'array'].includes(schema.type)) return null;
            return field(`${phase}/${nodeId}/config/${key}`, schema.title || humanize(key), value ?? schema.default ?? '', { type: ['integer', 'number'].includes(schema.type) ? 'number' : 'textarea', rows: key === 'instructions' || key === 'systemPrompt' ? 6 : 2, onQuote: value === undefined ? undefined : quote });
          }) : <ol className="goal-children">{[...(selectedNode.children ?? []), ...(selectedNode.else ?? [])].map(child => <li key={child.id}><button onClick={() => select(`${phase}/${child.id}`)}>{child.title || child.id} · {child.kind}</button></li>)}</ol>}
          <div className="goal-actions"><button disabled={busy || dirty || revisionView === 'running'} onClick={() => lock(`${phase}/${nodeId}`, !draft.locks.includes(`${phase}/${nodeId}`))}>{draft.locks.includes(`${phase}/${nodeId}`) ? 'Unlock step from AI' : 'Lock step from AI'}</button><button onClick={() => setDetail(!detail)}>{detail ? 'Back to loop' : 'Advanced editor'}</button></div><details><summary>Contract</summary><pre>{stringify({ inputs: selectedDefinition?.inputs, outputs: selectedDefinition?.outputs, tools: definition.tools })}</pre></details>
        </> : <p>The selected step no longer exists in this revision.</p>}
        {goal?.pendingResult && <section className="goal-pending-review"><h3>Your review</h3><p className="goal-hint">Iteration {goal.pendingResult.iteration} · v{goal.pendingResult.revision}</p><button onClick={() => act(async () => setInspection(await invoke('inspect', { record: goal.pendingResult.artifact })))}>Inspect artifact</button><label className="goal-field">Feedback<textarea value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={2000}/></label><div className="goal-actions"><button className="goal-primary" disabled={busy || goal.live} onClick={() => reviewResult('approve')}>Approve result</button><button disabled={busy || goal.live} onClick={() => reviewResult('changes')}>Request changes</button><button disabled={busy || goal.live} onClick={() => reviewResult('stop')}>Stop</button></div><p className="goal-hint">Approval cannot override a failed mandatory check.</p></section>}
        {pendingProposals.map(proposal => <section className="goal-pending-review" key={proposal.id}><h3>{proposal.initial ? 'AI draft' : 'AI changes'}<span className="goal-status quiet">needs review</span></h3><p>{proposal.rationale}</p>{proposal.diff.map(change => <details key={change.address} open={change.address.startsWith(`${selected}/`) || /^goal\/(tools|worker|folder|folderMode|createFolder|limits|maxParallel)$/.test(change.address)}><summary>{change.address.split('/').at(-1)} · {change.kind}{/^goal\/(tools|worker|folder|folderMode|createFolder|limits|maxParallel)$/.test(change.address) && <span className="goal-change-badge">Execution setting</span>}</summary><strong>Before</strong><pre>{stringify(change.before)}</pre><strong>After</strong><pre>{stringify(change.after)}</pre><button onClick={() => inspectTarget(change.address)}>Go to field</button></details>)}<div className="goal-actions"><button className="goal-primary" disabled={busy || dirty} onClick={() => reviewProposal(proposal.id, 'accept')}>Accept proposal</button><button disabled={busy} onClick={() => reviewProposal(proposal.id, 'reject')}>Reject proposal</button><button onClick={() => setChatOpen(true)}>View request</button></div></section>)}
        {!selected && <details><summary>Advanced</summary>
          {field('goal/criteria', 'All checks (JSON)', definition.criteria, { type: 'json', rows: 5, onQuote: undefined })}
          {field('goal/tests', 'Workflow tests (JSON)', definition.tests ?? [], { type: 'json', rows: 5, onQuote: undefined })}
          <p className="goal-hint">File checks use paths relative to the Goal folder. Workflow tests run separately with fixed inputs.</p>
          {!goal && <button disabled={busy} onClick={() => { update('goal/name', 'Improve a workflow'); update('goal/objective', 'Improve a workflow that answers representative tasks accurately.'); update('goal/criteria', [{ type: 'output_contains', value: 'workflow' }]); update('goal/tests', [{ input: 'What is 2 + 2?', contains: '4' }, { input: 'What is 3 + 3?', contains: '6' }]); update('recipe', GOAL_RECIPE.replace('Work toward the fixed Goal criteria.', 'Design a canonical version 2 workflow for the fixed tests. Include candidate.source as YAML with a general-analysis block. Do not configure model names. Set candidate.text to a description containing workflow.')); }}>Use workflow optimization template</button>}
        </details>}
        {goal && <button disabled={busy || working || !!pendingProposals.length} onClick={() => act(async () => { const next = await flush(); commitDraft(await invoke('author-publish', { baseRevision: next.revision })); await refresh(); })}>Publish at next boundary</button>}
        <details><summary>History</summary><p className="goal-hint">{draft.locks.length ? draft.locks.join(', ') : 'No authoring locks'}</p><button onClick={() => setInspection({ history: draft.history, proposals: draft.proposals, locks: draft.locks })}>Inspect history</button>
          {goal && Array.from({ length: goal.revisionCount }, (_, index) => index + 1).map(version => <p key={version}>Version {version} <button disabled={busy || dirty} onClick={() => act(async () => { const record = await invoke('inspect', { record: `recipe-${version}` }); commitDraft(await invoke('author-edit', { baseRevision: draft.revision, operations: [{ op: 'replace', address: 'recipe', value: record.source }] })); })}>Restore to draft</button></p>)}
        </details>
      </aside><div className="goal-resizer" role="separator" aria-label="Resize loop sidebar" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={460} aria-valuenow={sidebarWidth} tabIndex={0}
        onPointerDown={event => { resizing.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (resizing.current) setSidebarWidth(Math.max(280, Math.min(460, resizing.current.width + event.clientX - resizing.current.x))); }}
        onPointerUp={() => { resizing.current = null; }} onPointerCancel={() => { resizing.current = null; }}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); setSidebarWidth(width => event.key === 'Home' ? 320 : Math.max(280, Math.min(460, width + (event.key === 'ArrowLeft' ? -10 : 10)))); } }}/>
      <main className="goal-main">
        {detail && recipe ? <BlockEditor stack={(phase === 'setup' ? setup : recipe).stack} source={(phase === 'setup' ? setup : recipe).source} blocks={{ list: () => recipe.blocks, resolve: use => recipe.blocks.find(item => item.use === use) }} commands={revisionView === 'running' || (phase === 'setup' && goal) ? null : { invoke: async (name, args) => {
          if (dirty) throw new Error('Save sidebar field edits before structural edits');
          const value = await invoke('draft', { source: draft.definition[phase || 'recipe'], commands: [{ name, args }] });
          const next = await invoke('author-edit', { baseRevision: draft.revision, operations: [{ op: 'replace', address: phase || 'recipe', value: value.source }] }); commitDraft(next);
        } }} /> : <GoalCanvas recipe={recipe?.stack} setup={setup?.stack} goal={goal} objective={valueFor('goal/objective', definition.objective)} selected={selected} onSelect={select} pending={pending} locks={draft.locks} snapshot={revisionView === 'running' ? snapshot : null}/>}
        {inspection && <section className="goal-inspection"><header><h2>Evidence</h2><button onClick={() => setInspection(null)}>Close</button></header><pre>{stringify(inspection)}</pre></section>}
      </main></div>
      <ChangeRequestDialog open={chatOpen} onClose={() => setChatOpen(false)} composer={composer} onComposer={setComposer} quotes={quotes} onRemoveQuote={index => setQuotes(current => current.filter((_, i) => i !== index))} onInspect={inspectTarget} requests={draft.requests} proposals={draft.proposals} onSend={send} onCancel={requestId => act(async () => { await invoke('author-cancel', { requestId }); await refresh(); })} models={models} worker={authorModel} setWorker={setAuthorModel} sending={busy || working}
        scope={scope} onScope={value => { setScope(value); if (value.type !== 'fields') setQuotes([]); }} steps={steps}
        selectedFiles={selectedFiles} onSelectedFiles={setSelectedFiles}
        usage={draft.authoringCalls ? `${draft.authoringCalls} calls · $${draft.knownUsd.toFixed(4)}${draft.unknownCostCalls ? ` + ${draft.unknownCostCalls} unpriced` : ''}` : ''}/>
      {review && <ReviewDialog definition={definition} requirements={requirements} goal={goal} busy={busy} onClose={() => setReview(false)} onApprove={() => act(async () => { const next = await invoke('author-publish', { baseRevision: draft.revision }); commitDraft(next); await invoke('start', { goalId: next.goalId }); setReview(false); setRevisionView('running'); await refresh(); })}/>}
    </>}
  </div>;
}
