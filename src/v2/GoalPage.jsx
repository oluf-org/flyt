import React, { useEffect, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import './goalStyles.css';

export const GOAL_RECIPE = `version: 2
id: goal-recipe
name: Improve a candidate
blocks:
  - id: improve
    use: flyt-blocks-core:general-analysis
    title: Build / improve candidate
    config:
      systemPrompt: "You build the next candidate for a persistent Goal. Follow its fixed contract and CURRENT iteration number. Return exactly ONE JSON object with candidate.text and optional findings/proposal for this iteration only. Never emit multiple objects or simulate future iterations. Execute the requested task; do not summarize the Goal packet or continue the preceding prose."
      instructions: "Work toward the fixed Goal criteria. Read the Goal memory and improve the best candidate. Return the JSON output contract from the Goal context, with candidate.text containing the complete result."
`;
const SETUP = `version: 2
id: goal-setup
name: Establish baseline
blocks:
  - id: baseline
    use: flyt-blocks-core:general-analysis
    title: Record baseline and plan
    config:
      systemPrompt: "Establish a concise baseline and approach for the Goal. Return a short setup note, at most 150 words."
      instructions: "Record a concise baseline, fixed requirements and approach for this Goal."
`;
const OPTIMIZE = GOAL_RECIPE.replace('Work toward the fixed Goal criteria.', 'Design a canonical version 2 workflow for the fixed representative tests. Include candidate.source as YAML with a general-analysis block. Do not configure model names. Set candidate.text to a short description containing workflow.');

function RecipeEditor({ source, onChange, label }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    window.flyt.goal('draft', { source }).then(value => { if (alive) { setDraft(value); setError(''); } }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [source]);
  return <section className="goal-recipe" aria-label={label}>
    <h2>{label}</h2>
    {error && <p role="alert">{error}</p>}
    {draft && <BlockEditor stack={draft.stack} source={source}
      blocks={{ list: () => draft.blocks, resolve: use => draft.blocks.find(block => block.use === use) }}
      commands={{ invoke: async (name, args) => {
        const result = await window.flyt.goal('draft', { source, commands: [{ name, args }] });
        setDraft(result); onChange(result.source);
      } }}
      validateSource={async value => { await window.flyt.goal('draft', { source: value }); return { valid: true, errors: [] }; }}
      saveSource={async value => { await window.flyt.goal('draft', { source: value }); onChange(value); }} />}
  </section>;
}

export default function GoalPage({ projectId, onOpenRun }) {
  const [goals, setGoals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('My goal');
  const [objective, setObjective] = useState('');
  const [constraints, setConstraints] = useState('');
  const [expected, setExpected] = useState('');
  const [folder, setFolder] = useState('');
  const [folderMode, setFolderMode] = useState('focus');
  const [iterations, setIterations] = useState(10);
  const [minutes, setMinutes] = useState(30);
  const [calls, setCalls] = useState(100);
  const [usd, setUsd] = useState('');
  const [allowedTools, setAllowedTools] = useState([]);
  const [fileChecks, setFileChecks] = useState('[]');
  const [plateau, setPlateau] = useState(3);
  const [parallel, setParallel] = useState(1);
  const [redesign, setRedesign] = useState(true);
  const [setup, setSetup] = useState(false);
  const [setupSource, setSetupSource] = useState(SETUP);
  const [recipe, setRecipe] = useState(GOAL_RECIPE);
  const [tests, setTests] = useState('[]');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [revision, setRevision] = useState(null);
  const [editingRecipe, setEditingRecipe] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const goal = goals.find(item => item.id === selected);
  const invoke = (action, args = {}) => window.flyt.goal(action, { projectId, goalId: selected, ...args });
  const refresh = async () => setGoals(await invoke('list'));
  useEffect(() => {
    if (typeof window.flyt?.goal !== 'function') return undefined;
    let alive = true;
    const load = () => window.flyt.goal('list', { projectId }).then(value => { if (alive) setGoals(value); }).catch(error => { if (alive) setError(error.message); });
    load(); const timer = setInterval(load, 1500);
    window.flyt.getSettings().then(settings => { if (alive) setModels((settings.activeModels ?? []).filter(item => item.enabled !== false)); });
    return () => { alive = false; clearInterval(timer); };
  }, [projectId]);
  const act = async action => {
    setError(''); setBusy(true);
    try { await action(); await refresh(); } catch (error) { setError(String(error.message ?? error)); } finally { setBusy(false); }
  };
  const inspect = record => act(async () => setInspection(await invoke('inspect', { record })));
  if (typeof window.flyt?.goal !== 'function') return <div className="goal-page"><h1>Goals</h1><p>Open the desktop app to create and execute Goals. The browser preview has no connected Goal runtime.</p></div>;
  return <div className="goal-page">
    <header className="goal-header"><div><h1>Goals</h1><p>A persistent objective. Setup once, improve each iteration, keep the best verified result.</p></div>
      <button onClick={() => { setCreating(true); setInspection(null); }}>New goal</button></header>
    {error && <p className="goal-error" role="alert">{error}</p>}
    <div className="goal-layout"><aside aria-label="Saved goals">
      {goals.length === 0 && <p>No goals yet.</p>}
      {goals.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setCreating(false); setInspection(null); setEditingRecipe(null); }}>
        <strong>{item.name}</strong><span>{item.status.replaceAll('_', ' ')} · {item.iteration} iterations</span></button>)}
    </aside><main>
      {creating ? <><form id="goal-create-form" onSubmit={event => { event.preventDefault(); act(async () => {
        const choice = models.find(item => item.id === model);
        const result = await invoke('create', { definition: {
          name, objective, constraints, folder: folder || undefined, folderMode, createFolder: true,
          criteria: [...expected.split('\n').filter(Boolean).map(value => ({ type: 'output_contains', value })), ...JSON.parse(fileChecks)],
          limits: { iterations: Number(iterations), calls: Number(calls), minutes: Number(minutes), usd: usd === '' ? null : Number(usd) },
          selfRedesign: redesign, setup: setup ? setupSource : null, recipe, tests: JSON.parse(tests), tools: allowedTools,
          plateau: Number(plateau), maxParallel: Number(parallel),
          ...(model ? { worker: { provider: choice?.source ?? 'auto', model } } : {}),
        } }); setSelected(result.id); setCreating(false);
      }); }}>
        <div className="goal-fields">
          <label>Name<input value={name} onChange={e => setName(e.target.value)} required /></label>
          <label>Objective<textarea value={objective} onChange={e => setObjective(e.target.value)} required rows={3} /></label>
          <label>Fixed constraints<textarea value={constraints} onChange={e => setConstraints(e.target.value)} rows={2} /></label>
          <label>Acceptance checks — required text, one per line<textarea value={expected} onChange={e => setExpected(e.target.value)} rows={2} /></label>
          <p>These exact text checks are enforced by the runtime. Choose evidence that represents your actual objective.</p>
          <label>Model<select aria-label="Goal model" value={model} onChange={e => setModel(e.target.value)}><option value="">Configured default</option>{models.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
          <label>Parent folder<input value={folder} onChange={e => setFolder(e.target.value)} placeholder="Current project folder" /></label>
          <label>Folder policy<select value={folderMode} onChange={e => setFolderMode(e.target.value)}><option value="focus">Folder focus</option><option value="strict">Strict isolation — unavailable on this provider</option></select></label>
          <p>A dedicated goal folder is created once. Folder focus sets the working directory; broader access follows the selected tools. File and shell tools are off by default.</p>
          <div className="goal-limits">{[['Iterations', iterations, setIterations], ['Model calls', calls, setCalls], ['Minutes', minutes, setMinutes]].map(([label, value, set]) => <label key={label}>{label}<input type="number" min="1" value={value} onChange={e => set(e.target.value)} /></label>)}</div>
          <label className="goal-check"><input type="checkbox" checked={redesign} onChange={e => setRedesign(e.target.checked)} />Allow validated recipe redesign between iterations</label>
          <label className="goal-check"><input type="checkbox" checked={setup} onChange={e => setSetup(e.target.checked)} />Run setup once</label>
          <details><summary>Tools, artifact checks and additional limits</summary>
            <p>File checks read paths relative to the goal folder and preserve the verified content with each result. Shell access follows the machine’s execution policy.</p>
            <label>Artifact checks (JSON)<textarea rows={3} value={fileChecks} onChange={e => setFileChecks(e.target.value)} placeholder={'[{"type":"file_contains","path":"result.txt","value":"expected content"}]'} /></label>
            <fieldset><legend>Allowed tools</legend>{['read_file', 'glob', 'search_files', 'create_file', 'write_file', 'edit_file', 'bash', 'run_gate'].map(tool => <label className="goal-check" key={tool}><input type="checkbox" checked={allowedTools.includes(tool)} onChange={e => setAllowedTools(current => e.target.checked ? [...current, tool] : current.filter(item => item !== tool))} />{tool}</label>)}</fieldset>
            <label>Dollar stop threshold<input type="number" min="0.001" step="any" value={usd} onChange={e => setUsd(e.target.value)} placeholder="Optional" /></label>
            <p>Checked between model calls. An active call can cross this threshold. Unpriced calls remain unknown; the call and time limits always apply.</p>
            <label>Stop after this many iterations without improvement<input type="number" min="1" max="1000" value={plateau} onChange={e => setPlateau(e.target.value)} /></label>
            <label>Maximum parallel blocks<input type="number" min="1" max="4" value={parallel} onChange={e => setParallel(e.target.value)} /></label>
          </details>
          <details><summary>Workflow optimization template and fixed tests</summary><p>Candidate workflows run in separate test folders. Each test checks its result for fixed expected text.</p>
            <button type="button" onClick={() => { setName('Improve a workflow'); setRecipe(OPTIMIZE); setExpected('workflow'); setObjective('Improve a workflow that answers representative tasks accurately.'); setTests('[{"input":"What is 2 + 2?","contains":"4"},{"input":"What is 3 + 3?","contains":"6"}]'); }}>Use workflow optimization template</button>
            <label>Fixed tests (JSON)<textarea value={tests} onChange={e => setTests(e.target.value)} rows={4} /></label></details>
        </div></form>
        {setup && <RecipeEditor source={setupSource} onChange={setSetupSource} label="Setup once" />}
        <RecipeEditor source={recipe} onChange={setRecipe} label="Each iteration" />
        <button type="submit" form="goal-create-form" disabled={busy}>Save goal</button>
      </> : goal ? <>
        <div className="goal-header"><div><h2>{goal.name}</h2><p>{goal.contract.objective}</p></div><strong role="status">{goal.status.replaceAll('_', ' ')}</strong></div>
        <p>{goal.reason}</p>
        <div className="goal-actions">
          {['ready', 'paused'].includes(goal.status) || goal.recoverable || (goal.status === 'failed' && goal.pendingRevision) ? <button disabled={busy} onClick={() => act(() => invoke('start'))}>{goal.status === 'ready' ? 'Start goal' : 'Resume goal'}</button> : null}
          {goal.live && <button disabled={busy} onClick={() => act(() => invoke('control', { action: 'pause' }))}>Pause</button>}
          {['running', 'paused', 'ready'].includes(goal.status) && <button disabled={busy} onClick={() => act(() => invoke('control', { action: 'stop' }))}>Stop</button>}
          <button disabled={busy} onClick={() => act(async () => { const next = await invoke('clone'); setSelected(next.id); })}>New instance</button>
          <button onClick={() => setInspection({ contract: goal.contract, workspace: goal.workspace, findings: goal.memory, best: goal.best })}>Inspect memory</button>
          <button onClick={() => act(async () => { const version = goal.pendingRevision ?? goal.activeRevision; const value = await invoke('inspect', { record: `recipe-${version}` }); setRevision(version); setEditingRecipe(value.source); })}>Edit recipe</button>
        </div>
        <dl className="goal-stats"><div><dt>Iteration</dt><dd>{goal.iteration} / {goal.contract.limits.iterations}</dd></div><div><dt>Recipe</dt><dd>v{goal.activeRevision}{goal.pendingRevision ? ` · v${goal.pendingRevision} pending` : ''}</dd></div><div><dt>Model calls</dt><dd>{goal.calls} / {goal.contract.limits.calls}</dd></div><div><dt>Known spend</dt><dd>${goal.knownUsd.toFixed(4)}{goal.unknownCostCalls > 0 ? ` + ${goal.unknownCostCalls} unpriced calls` : ''}</dd></div></dl>
        <p>Folder focus: {goal.workspace?.path ?? goal.contract.folder} · Setup {goal.setupDone ? 'complete' : 'pending'} · {Math.max(0, Math.ceil(goal.contract.limits.minutes - goal.elapsedMs / 60000))} minutes remaining</p>
        {goal.activeChild && <p>Current run: <button onClick={() => onOpenRun?.(goal.activeChild.runId)}>{goal.activeChild.phase}</button></p>}
        {goal.lastRevisionError && <p role="alert">Recipe proposal rejected: {goal.lastRevisionError}</p>}
        {goal.best && <section className="goal-best"><h3>Best result · {Math.round(goal.best.score * 100)}% checks passed</h3><p>{goal.best.preview}</p><button onClick={() => inspect(goal.best.artifact)}>View best artifact and evidence</button></section>}
        <h3>Compare iterations</h3><table><thead><tr><th>Iteration</th><th>Recipe</th><th>Checks passed</th><th>Evidence</th></tr></thead><tbody>{goal.history.map(item => <tr key={item.iteration}><td>{item.iteration}</td><td>v{item.revision}</td><td>{Math.round(item.score * 100)}%</td><td><button onClick={() => inspect(item.artifact)}>Inspect result</button></td></tr>)}</tbody></table>
        <details><summary>Recipe versions and restore</summary>{Array.from({ length: goal.revisionCount }, (_, i) => i + 1).map(version => <p key={version}>Version {version} <button onClick={() => inspect(`recipe-${version}`)}>View changes</button> <button disabled={busy} onClick={() => act(() => invoke('restore', { revision: version, baseRevision: goal.pendingRevision ?? goal.activeRevision }))}>Restore at next boundary</button></p>)}</details>
        {editingRecipe !== null && <><RecipeEditor source={editingRecipe} onChange={setEditingRecipe} label={`Draft from recipe v${revision}`} /><button disabled={busy} onClick={() => act(async () => { await invoke('revise', { source: editingRecipe, baseRevision: revision, rationale: 'Edited in Goal authoring' }); setEditingRecipe(null); })}>Save pending revision</button></>}
      </> : <p>Create a goal or select a saved instance to inspect its progress.</p>}
      {inspection && <section className="goal-inspection"><button onClick={() => setInspection(null)}>Close inspection</button><pre>{JSON.stringify(inspection, null, 2)}</pre></section>}
    </main></div>
  </div>;
}
