import { ContextAssets } from '../AssetComposer.jsx';
// One recursive renderer for Build and Run. Containment is the graph; the DOM
// follows the YAML tree and stores no coordinates or layout sidecar.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BlockConfigurationView } from './PluginContributionView.jsx';
import { WORKFLOW_MODEL_TIERS } from '../modelTiers.js';
import { defaultModeId, workflowModes } from './workflowUx.js';
import { generatedChildren, generatedTaskWaves, workflowNodes } from './workflowTree.js';
import BuildChat from './BuildChat.jsx';
import './blockEditorStyles.css';

const TOUCH_MS = 600;
const CONTROL_KINDS = ['sequence', 'parallel', 'repeat', 'foreach', 'until', 'if'];
const MAX_VISIBLE_GENERATED_TASKS = 6;

function Icon({ name, size = 16 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    back: <path d="m14 6-6 6 6 6"/>,
    modes: <><circle cx="7" cy="8" r="2.4"/><circle cx="17" cy="16" r="2.4"/><path d="M11 8h8M5 16h8"/></>,
    grip: <><path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
    play: <path d="m8 5 11 7-11 7z"/>,
    code: <><path d="m9 7-5 5 5 5M15 7l5 5-5 5"/></>,
    blocks: <><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M14 7h3v3M10 17H7v-3"/></>,
    input: <><path d="M4 12h12M12 8l4 4-4 4"/><path d="M20 5v14"/></>,
    chat: <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>,
  };
  return <svg className="be-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name] ?? paths.blocks}
  </svg>;
}

const titleOf = (node, blocks) => node.title || blocks?.resolve?.(node.use)?.title || node.use || node.id;
const definitionOf = (node, blocks) => node?.kind === 'block' ? blocks?.resolve?.(node.use) ?? null : null;
const statusOf = (run, id) => run?.blocks?.[id]?.status ?? 'pending';

const compactNumber = value => Number.isFinite(value)
  ? new Intl.NumberFormat('en', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
  : '\u2014';

const price = value => Number.isFinite(value)
  ? `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
  : '\u2014';

function elapsedLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '\u2014';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function clockLabel(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return '\u2014';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function clockTitle(value) {
  const date = new Date(value ?? '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }) : 'Not started';
}

function BlockStatus({ status, metrics }) {
  const live = status === 'active';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const lastAt = metrics?.lastTokenAt ?? metrics?.startedAt;
  const quietMs = lastAt ? now - Date.parse(lastAt) : null;
  const showQuiet = live && metrics?.waitingForToken && Number.isFinite(quietMs) && quietMs >= 5000;
  const label = status === 'done' ? '\u2713 Done' : status === 'active' ? 'Running' : status;
  return <span className={`be-status status-${status}`}>
    {live && <span className="be-running-motion" aria-hidden="true"><i/><i/><i/></span>}
    <span>{label}</span>
    {showQuiet && <small>{metrics?.lastTokenAt ? `${elapsedLabel(quietMs)} since token` : `${elapsedLabel(quietMs)} to first token`}</small>}
  </span>;
}

function BlockMetrics({ metrics, status }) {
  const active = status === 'active';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = metrics?.startedAt && (active || metrics?.endedAt)
    ? now - Date.parse(metrics.startedAt)
    : null;
  const settledElapsed = !active && metrics?.startedAt && metrics?.endedAt
    ? Date.parse(metrics.endedAt) - Date.parse(metrics.startedAt)
    : elapsed;
  const withEstimate = (exact, estimated) => {
    if (estimated != null) return `~${compactNumber((exact ?? 0) + estimated)}`;
    return compactNumber(exact);
  };
  const input = withEstimate(metrics?.tokensIn, metrics?.estimatedTokensIn);
  const out = withEstimate(metrics?.tokensOut, metrics?.estimatedTokensOut);
  const timestamp = metrics?.startedAt ?? null;
  // A block that has not run has no facts, and a row of em dashes is not a
  // fact. Report a number only where the run actually produced one, so a
  // queued task stays a title and a status rather than five empty columns.
  const known = value => value !== '—';
  if (!timestamp && !known(input) && !known(out) && !Number.isFinite(metrics?.costUsd)) return null;
  return <div className="be-block-metrics" aria-label="Block statistics">
    {Number.isFinite(metrics?.costUsd) && <span title="Total model cost for this block"><small>Price</small><strong>{price(metrics.costUsd)}</strong></span>}
    {known(input) && <span title={metrics?.estimatedTokensIn != null ? 'Estimated effective input; provider usage replaces it when settled' : 'Provider-reported prompt and cached input tokens'}><small>Tokens in</small><strong>{input}</strong></span>}
    {known(out) && <span title={metrics?.estimatedTokensOut != null ? 'Approximate while streaming' : 'Completion tokens'}><small>Tokens out</small><strong>{out}</strong></span>}
    {known(elapsedLabel(settledElapsed)) && <span title="Elapsed block time"><small>Time</small><strong>{elapsedLabel(settledElapsed)}</strong></span>}
    {timestamp && <span title={clockTitle(timestamp)}><small>Started</small><time dateTime={timestamp}>{clockLabel(timestamp)}</time></span>}
    {metrics?.requestCount > 1 && <span title="Model requests made by this block"><small>Calls</small><strong>{metrics.requestCount}</strong></span>}
    {metrics?.toolCount > 0 && <span title="Tool calls made by this block"><small>Tools</small><strong>{metrics.toolCount}</strong></span>}
    {metrics?.cachedTokens > 0 && <span title="Cached input tokens"><small>Cached</small><strong>{compactNumber(metrics.cachedTokens)}</strong></span>}
    {metrics?.reasoningTokens > 0 && <span title="Reasoning tokens"><small>Reasoning</small><strong>{compactNumber(metrics.reasoningTokens)}</strong></span>}
  </div>;
}

function activityValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function activityClock(value) {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ActivityItem = React.memo(function ActivityItem({ item, savedExpanded, onExpanded }) {
  const live = item.status === 'running' || item.status === 'waiting';
  // The step is uncontrolled: `open` is an initial attribute captured once, so a
  // collapse the reader performs is never undone by a re-render and a step that
  // finishes does not snap shut on the result it just produced. A step that only
  // becomes live after mount is opened imperatively on that edge.
  const ref = useRef(null);
  const openedAtMount = useRef(savedExpanded ?? live).current;
  const [expanded, setExpanded] = useState(savedExpanded ?? live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current && ref.current) ref.current.open = true;
    wasLive.current = live;
  }, [live]);
  const facts = [
    item.model,
    item.maxTokens != null ? `${compactNumber(item.maxTokens)} token ceiling` : null,
    item.chars != null ? `${compactNumber(item.chars)} chars` : null,
    item.attempt != null ? `attempt ${item.attempt}${item.maxAttempts ? `/${item.maxAttempts}` : ''}` : null,
  ].filter(Boolean);
  const hasBody = item.kind === 'tool'
    || Boolean(item.content) || item.diagnostics?.length > 0 || item.transformations?.length > 0
    || (item.kind === 'chat' && item.status === 'empty');
  const body = expanded && <div className="be-activity-body">
    {item.content && <pre>{activityValue(item.content)}</pre>}
    {item.kind === 'chat' && !item.content && <p>{item.status === 'waiting'
      ? 'Waiting for visible output.'
      : `No visible response. Finish reason: ${item.finishReason ?? 'unknown'}.`}</p>}
    {item.kind === 'tool' && <>
      <label>Arguments</label><pre>{activityValue(item.args ?? {})}</pre>
      {item.status !== 'running' && <><label>{item.error ? 'Error' : 'Result'}</label><pre>{activityValue(item.error ?? item.result ?? '')}</pre></>}
    </>}
    {item.diagnostics?.length > 0 && <><label>Validation errors</label><pre>{item.diagnostics.join('\n')}</pre></>}
    {item.transformations?.length > 0 && <><label>Safe transformations</label><pre>{activityValue(item.transformations)}</pre></>}
  </div>;
  const summary = <summary>
    <span className="be-activity-type">{item.title}</span>
    {facts.length > 0 && <small>{facts.join(' · ')}</small>}
    <span className={`be-activity-state state-${item.status}`}>{item.status}</span>
    {activityClock(item.at) && <time dateTime={item.at}>{activityClock(item.at)}</time>}
  </summary>;
  return <details ref={ref} className={`be-activity-item kind-${item.kind}${hasBody ? '' : ' no-body'}`} open={openedAtMount} onToggle={event => { setExpanded(event.currentTarget.open); onExpanded?.(item.id, event.currentTarget.open); }}>
    {summary}{hasBody && body}
  </details>;
});

function BlockActivity({ items }) {
  const [open, setOpen] = useState(true);
  const [anchor, setAnchor] = useState(null);
  const [expanded, setExpanded] = useState(() => new Map());
  const saveExpanded = useCallback((id, value) => setExpanded(current => {
    if (current.get(id) === value) return current;
    return new Map(current).set(id, value);
  }), []);
  if (!items?.length) return null;
  const live = items.filter(item => item.status === 'running' || item.status === 'waiting');
  const found = anchor == null ? -1 : items.findIndex(item => item.id === anchor);
  const end = found < 0 ? items.length : found + 1;
  const start = Math.max(0, end - 60);
  const page = items.slice(start, end);
  const pageIds = new Set(page.map(item => item.id));
  const visible = [...page, ...live.filter(item => !pageIds.has(item.id))];
  const preserveSelection = event => {
    const selection = window.getSelection?.();
    if (selection?.toString() && event.currentTarget.contains(selection.anchorNode)) setAnchor(items[end - 1].id);
  };
  return <details className="be-block-activity" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>Steps</span><small>{items.length} event{items.length === 1 ? '' : 's'}{live.length ? ` · ${live.length} live` : ''}</small></summary>
    {open && <div onMouseUp={preserveSelection} onKeyUp={preserveSelection}>
      {items.length > 60 && <nav className="be-activity-pages" aria-label="Activity pages">
        <button type="button" disabled={start === 0} onClick={() => setAnchor(items[start - 1].id)}>Earlier steps</button>
        <span>{start + 1}–{end} of {items.length}</span>
        <button type="button" disabled={end === items.length} onClick={() => setAnchor(items[Math.min(items.length, end + 60) - 1].id)}>Later steps</button>
        <button type="button" disabled={anchor === null} onClick={() => setAnchor(null)}>Latest</button>
      </nav>}
      <div className="be-activity-list">{visible.map(item => <ActivityItem item={item} key={item.id} savedExpanded={expanded.get(item.id)} onExpanded={saveExpanded}/>)}</div>
    </div>}
  </details>;
}

function RecoveryFacts({ state, status = null }) {
  if (!state || (!state.attempt && !state.retryState && !state.failure && !state.lastDurableProgress && !state.blockedBy?.length)) return null;
  const durable = state.lastDurableProgress;
  // Attempts and recovery describe work in flight. On a task that has not
  // started they read as a failure that never happened, so a queued task
  // reports only what is holding it: what it waits for, or how it ended.
  const started = status !== 'pending';
  if (!started && !state.failure?.code && !state.blockedBy?.length) return null;
  return <div className="be-recovery-facts" aria-label="Task recovery state">
    {started && state.maxAttempts > 0 && <span><small>Attempt</small><strong>{state.attempt ?? 0}/{state.maxAttempts}</strong></span>}
    {started && state.retryState && <span><small>Recovery</small><strong>{String(state.retryState).replaceAll('_', ' ')}</strong></span>}
    {state.failure?.code && <span><small>Failure</small><strong>{state.failure.code}</strong></span>}
    {durable && <span title={JSON.stringify(durable)}><small>Last durable progress</small><strong>{durable.tool ?? `step ${durable.atStep ?? durable.seq ?? '?'}`}</strong></span>}
    {state.blockedBy?.length > 0 && <span><small>Blocked by</small><strong>{state.blockedBy.join(', ')}</strong></span>}
  </div>;
}

function parentSlot(root, nodeId) {
  for (const parent of workflowNodes(root, [])) {
    if (parent.kind === 'block') continue;
    const index = (parent.children ?? []).findIndex(child => child.id === nodeId);
    if (index >= 0) return { container: parent.id, index };
    if (parent.kind === 'if') {
      const other = (parent.else ?? []).findIndex(child => child.id === nodeId);
      if (other >= 0) return { container: parent.id, index: other, branch: 'else' };
    }
  }
  return null;
}

const nodeById = (root, id) => workflowNodes(root, []).find(node => node.id === id) ?? null;

function contextFor(root, id) {
  const all = workflowNodes(root, []).filter(node => node.kind === 'block');
  const index = all.findIndex(node => node.id === id);
  return {
    upstream: index > 0 ? all.slice(0, index).map(node => node.id) : [],
    downstream: index >= 0 ? all.slice(index + 1).map(node => node.id) : [],
  };
}

function uniqueId(root, seed) {
  const base = String(seed || 'block').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const ids = new Set(workflowNodes(root, []).map(node => node.id));
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function containerConfig(node) {
  if (node.kind === 'parallel') return { maxParallel: node.maxParallel };
  if (node.kind === 'repeat') return { count: node.count };
  if (node.kind === 'foreach') return { roster: node.roster, max: node.max };
  if (node.kind === 'until') return { condition: node.condition, max: node.max };
  if (node.kind === 'if') return { predicate: node.predicate };
  return {};
}

function controlLabel(node) {
  if (node.kind === 'parallel') return `Parallel${node.maxParallel ? ` · ${node.maxParallel} at once` : ''}`;
  if (node.kind === 'repeat') return `Repeat · ${node.count}×`;
  if (node.kind === 'foreach') return `For each · ${node.roster}`;
  if (node.kind === 'until') return `Until · max ${node.max}`;
  if (node.kind === 'if') return 'If';
  return 'Sequence';
}

function ContainerFields({ node, draft, update, jsonField }) {
  const number = name => <label><span>{name === 'maxParallel' ? 'Maximum parallel lanes' : name}</span>
    <input type="number" min="1" value={draft[name] ?? ''} onChange={event => update(name, { type: 'integer' }, event.target.value)} /></label>;
  if (node.kind === 'sequence') return <p className="be-empty-copy">Sequence has no runtime settings.</p>;
  if (node.kind === 'parallel') return number('maxParallel');
  if (node.kind === 'repeat') return number('count');
  if (node.kind === 'foreach') return <>{number('max')}<label><span>Roster output</span><input value={draft.roster ?? ''}
    onChange={event => update('roster', {}, event.target.value)} placeholder="plan.tasks" /></label></>;
  if (node.kind === 'until') return <>{number('max')}<label><span>Condition (JSON)</span>{jsonField('condition', {}, 5, 'Condition (JSON)')}</label></>;
  return <label><span>Predicate (JSON)</span>{jsonField('predicate', {}, 6, 'Predicate (JSON)')}</label>;
}

export function GenericConfigForm({ node, definition, commands, onError }) {
  const initial = node.kind === 'block' ? node.config ?? {} : containerConfig(node);
  const [draft, setDraft] = useState(initial);
  const [jsonDrafts, setJsonDrafts] = useState({});
  useEffect(() => { setDraft(initial); setJsonDrafts({}); }, [node.id, JSON.stringify(initial)]);
  const props = definition?.settings?.properties ?? {};
  const update = (name, field, raw) => {
    let value = raw;
    if (field.type === 'integer' || field.type === 'number') value = raw === '' ? undefined : Number(raw);
    if (field.enum && raw === '') value = undefined;
    if (field.type === 'boolean') value = Boolean(raw);
    setDraft(current => {
      const next = { ...current };
      if (value === undefined) delete next[name]; else next[name] = value;
      return next;
    });
  };
  // Keep text while it is being edited. JSON is often temporarily invalid
  // between keystrokes; validate on Save instead of erasing those keystrokes.
  const jsonField = (name, fallback, rows = 5, label = name) => <textarea rows={rows} aria-label={label}
    value={jsonDrafts[name] ?? (draft[name] === undefined ? '' : JSON.stringify(draft[name] ?? fallback, null, 2))}
    onChange={event => setJsonDrafts(current => ({ ...current, [name]: event.target.value }))} />;
  const save = async () => {
    if (!commands?.invoke) return;
    try {
      const config = { ...draft };
      for (const [name, text] of Object.entries(jsonDrafts)) {
        if (!text.trim()) { delete config[name]; continue; }
        try { config[name] = JSON.parse(text); }
        catch { throw new Error(`${name} must contain valid JSON.`); }
      }
      await commands.invoke(node.kind === 'block' ? 'stack:configure-block' : 'stack:configure-container', { nodeId: node.id, config }, 'human');
      onError('');
    } catch (error) { onError(String(error?.message ?? error)); }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || Object.keys(jsonDrafts).length > 0;
  // A field's description is the same sentence every time this panel opens, and
  // three of them stacked is a form you scroll instead of read. It rides on the
  // label as a tooltip now — still there when it is wanted, gone when it is not.
  return <div className="be-config-form">
    {node.kind === 'block' && !Object.keys(props).length && <p className="be-empty-copy">No settings.</p>}
    {Object.entries(props).filter(([name]) => !['model', 'modelTier', 'modelFallbacks'].includes(name)).map(([name, field]) => <label key={name}>
      <span title={field.description || undefined}>{field.title ?? (name === 'systemPrompt' ? 'System prompt' : name)}
        {field.description && <i className="be-field-hint" aria-hidden="true">?</i>}</span>
      {name === 'systemPrompt' && <small>{field.default
        ? (draft[name] ? 'Custom override' : 'Using built-in prompt. Edit to override it for this workflow.')
        : 'No custom guidance saved means the block uses its built-in behavior.'}</small>}
      {field.enum ? <select value={draft[name] ?? ''} onChange={event => update(name, field, event.target.value)}>
        <option value="">Default</option>{field.enum.map(option => <option key={option} value={option}>{option}</option>)}</select>
        : field.type === 'boolean' ? <input type="checkbox" checked={Boolean(draft[name] ?? field.default)} onChange={event => update(name, field, event.target.checked)} />
          : (field.type === 'array' || field.type === 'object') ? jsonField(name, field.type === 'array' ? [] : {})
          : (name === 'instructions' || field.format === 'multiline') ? <>
            <textarea rows="7" value={name === 'systemPrompt' ? draft[name] || field.default || '' : draft[name] ?? ''}
              onChange={event => update(name, field, event.target.value)} />
            {name === 'systemPrompt' && field.default && draft[name] && <button type="button"
              onClick={() => update(name, field, undefined)}>Use built-in prompt</button>}
          </>
            : <input type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} value={draft[name] ?? ''}
                min={field.minimum} max={field.maximum} onChange={event => update(name, field, event.target.value)} />}
    </label>)}
    {node.kind !== 'block' && <ContainerFields node={node} draft={draft} update={update} jsonField={jsonField} />}
    {/* Pinned, because the save button used to be below however many fields the
        block happened to declare: on a block with a prompt textarea you had to
        scroll past your own edit to commit it. */}
    <div className="be-config-actions" data-dirty={dirty || undefined}>
      <span>{dirty ? 'Unsaved' : 'Saved'}</span>
      <button type="button" className="be-primary" disabled={!commands?.invoke || !dirty} onClick={save}>Save</button>
    </div>
  </div>;
}

function ModelTierControl({ node, definition, commands, onError }) {
  const properties = definition?.settings?.properties ?? {};
  if (!properties.model && !node.config?.modelTier) return null;
  const selected = node.config?.modelTier ?? '';
  const choose = async tier => {
    const config = { ...(node.config ?? {}) };
    if (tier) config.modelTier = tier; else delete config.modelTier;
    // A tier is the route. Remove stale generated pins if this workflow was
    // copied from a resolved run before being edited.
    delete config.model;
    delete config.modelFallbacks;
    try { await commands?.invoke?.('stack:configure-block', { nodeId: node.id, config }, 'human'); }
    catch (error) { onError(String(error?.message ?? error)); }
  };
  // Four buttons and a label. The tier NAME was printed twice — once as a
  // heading and once on the button that was already lit — and each option
  // carried a sentence of advice that is the same every time you open the
  // panel. The advice is a tooltip now; the buttons say which is chosen by
  // being the one that is on.
  return <section className="be-field-group" aria-label="Model tier">
    <div className="be-field-head">
      <span>Model tier</span>
      <button type="button" className="link" disabled={!selected} onClick={() => choose(null)}
        title="Fall back to the model tier this workflow runs by default">Reset</button>
    </div>
    <div className="be-tier-options" role="group" aria-label={`${node.id} model tier`}>
      {WORKFLOW_MODEL_TIERS.map(tier => <button type="button" key={tier.id} title={tier.hint}
        className={`tier-${tier.id}${selected === tier.id ? ' active' : ''}`}
        aria-pressed={selected === tier.id} onClick={() => choose(tier.id)}>{tier.name}</button>)}
    </div>
  </section>;
}

function Inspector({ root, selected, blocks, commands, history, uiExtensions, preview = null, onError }) {
  const [tab, setTab] = useState('config');
  const node = selected ? nodeById(root, selected) : null;
  const context = node ? contextFor(root, node.id) : { upstream: [], downstream: [] };
  const records = (history ?? []).filter(row => !node || row.nodeId === node.id || row.args?.nodeId === node.id);
  const definition = definitionOf(node, blocks);
  const contributions = uiExtensions.filter(row => row?.contribution?.point === 'block-configuration'
    && node?.kind === 'block' && row.contribution.block === node.use);
  // Nothing selected is one line, not a tab strip over an empty panel: three
  // tabs that all say "select something" is three times the chrome for none of
  // the answer.
  if (!node) return <aside className="be-inspector" aria-label="Workflow inspector">
    <p className="be-empty-copy">Select a block to configure it.</p>
  </aside>;
  // The identity is ONE row. It used to be three — a kind label, a heading and
  // an id, stacked — which cost about sixty pixels above the first field the
  // person opened the panel to reach. The kind is legible from the canvas and
  // the block's `use` is a tooltip on the id.
  return <aside className="be-inspector" aria-label="Workflow inspector">
    <header className="be-inspector-head">
      <h2 title={titleOf(node, blocks)}>{titleOf(node, blocks)}</h2>
      <code title={node.kind === 'block' ? node.use ?? node.kind : node.kind}>{node.id}</code>
    </header>
    <div className="be-inspector-tabs" role="tablist">{['config', 'context', 'history'].map(name => <button type="button" role="tab"
      aria-selected={tab === name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} key={name}>{name}</button>)}</div>
    {tab === 'config' && <>
      {preview?.overrides?.[node.id] && <p className="be-mode-note">
        <strong>{preview.name}</strong> runs this with {overrideLine(preview.overrides[node.id])}. Fields below are the authored settings.
      </p>}
      <ModelTierControl node={node} definition={definition} commands={commands} onError={onError} />
      <GenericConfigForm node={node} definition={definition} commands={commands} onError={onError} />
      {contributions.map(row => <BlockConfigurationView key={`${row.pluginId}:${row.contribution.id}`} contribution={row.contribution} pluginId={row.pluginId}
        value={node.config ?? {}} onChange={config => commands?.invoke?.('stack:configure-block', { nodeId: node.id, config }, 'human')?.catch?.(error => onError(String(error)))} />)}</>}
    {/* Two headings and three sentences became three labelled rows. The panel
        is ~312px wide; "Receives context from" spent most of one. */}
    {tab === 'context' && <div className="be-context">
      <div className="be-context-row"><span title="Blocks whose output reaches this one">From</span>
        {context.upstream.length ? context.upstream.map(id => <code key={id}>{id}</code>) : <em>Input only</em>}</div>
      <div className="be-context-row"><span title="Blocks this one's output reaches">Feeds</span>
        {context.downstream.length ? context.downstream.map(id => <code key={id}>{id}</code>) : <em>Final block</em>}</div>
      {node.kind === 'block' && <div className="be-context-row"><span title="Structured outputs this block declares in YAML">Outputs</span>
        {(node.outputs ?? []).length ? node.outputs.map(output => <code key={output.name}>{output.name} · {output.type}</code>) : <em>None authored</em>}</div>}
    </div>}
    {tab === 'history' && <div className="be-history">{records.length ? records.map((row, index) => <article key={`${row.at}:${index}`}>
      <div><strong>{row.command}</strong><span>{row.caller}</span></div><time>{row.at}</time>{row.details && <small>{row.details}</small>}{row.error && <p>{row.error}</p>}</article>)
      : <p className="be-empty-copy">Nothing has edited this block yet.</p>}</div>}
  </aside>;
}

function Palette({ blocks, root, selected, commands, onError, setDragging }) {
  const [query, setQuery] = useState('');
  const search = useRef(null);
  useEffect(() => {
    const onKey = event => {
      if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) {
        event.preventDefault(); search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const rows = (blocks?.list?.() ?? []).filter(block => `${block.title} ${block.use} ${block.category}`.toLowerCase().includes(query.toLowerCase()));
  const insert = async block => {
    const from = selected ? parentSlot(root, selected) : null;
    const at = from ? { ...from, index: from.index + 1 } : { container: root.id, index: root.children.length };
    try { await commands.invoke('stack:insert-block', { block: { id: uniqueId(root, block.use.split(':').at(-1)), use: block.use, title: block.title, config: {} }, at }, 'human'); }
    catch (error) { onError(String(error?.message ?? error)); }
  };
  const wrap = async kind => {
    if (!selected) { onError('Select a block or control to wrap first.'); return; }
    const id = uniqueId(root, kind);
    const selectedNode = nodeById(root, selected);
    const ordered = workflowNodes(root, []);
    const selectedIndex = ordered.findIndex(node => node.id === selected);
    const upstreamOutput = ordered.slice(0, selectedIndex).filter(node => node.kind === 'block')
      .flatMap(node => (node.outputs ?? []).map(output => ({ node, output }))).at(-1);
    const upstreamList = ordered.slice(0, selectedIndex).filter(node => node.kind === 'block')
      .flatMap(node => (node.outputs ?? []).filter(output => output.type === 'list').map(output => ({ node, output }))).at(-1);
    const bodyOutput = selectedNode
      ? workflowNodes(selectedNode, []).filter(node => node.kind === 'block')
        .flatMap(node => (node.outputs ?? []).map(output => ({ node, output }))).at(-1)
      : null;
    let config = kind === 'repeat' ? { count: 2 } : kind === 'parallel' ? { maxParallel: 2 } : {};
    if (kind === 'foreach') {
      if (!upstreamList) { onError('For each needs an upstream block with an authored list output. Add that output in YAML first.'); return; }
      config = { roster: `${upstreamList.node.id}.${upstreamList.output.name}`, max: 8 };
    }
    if (kind === 'if') {
      if (!upstreamOutput) { onError('If needs an upstream block with an authored output. Add that output in YAML first.'); return; }
      config = { predicate: { source: `${upstreamOutput.node.id}.${upstreamOutput.output.name}`, operator: 'is not empty' } };
    }
    if (kind === 'until') {
      if (!bodyOutput) { onError('Until needs the selected body to declare an output it can check. Add that output in YAML first.'); return; }
      config = { condition: { source: `${bodyOutput.node.id}.${bodyOutput.output.name}`, operator: 'is not empty' }, max: 3 };
    }
    try { await commands.invoke('stack:wrap-block', { nodeId: selected, container: { id, kind, config } }, 'human'); }
    catch (error) { onError(String(error?.message ?? error)); }
  };
  return <aside className="be-palette" aria-label="Block palette">
    <label className="be-search"><Icon name="search"/><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search blocks"/><kbd>/</kbd></label>
    <section><h2>Blocks</h2>{rows.map(block => <button type="button" draggable key={block.use} className="be-palette-item"
      onDragStart={event => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/flyt-new-block', block.use); setDragging(`new:${block.use}`); }}
      onDragEnd={() => setDragging(null)} onClick={() => insert(block)}>
      <span className={`be-palette-glyph tone-${block.category ?? 'work'}`}><Icon name="blocks"/></span><span><strong>{block.title}</strong><small>{block.description}</small></span></button>)}</section>
    <section><h2>Controls</h2>{CONTROL_KINDS.map(kind => <button type="button" key={kind} className="be-palette-item" onClick={() => wrap(kind)}>
      <span className="be-palette-glyph tone-control"><Icon name={kind === 'parallel' ? 'blocks' : 'chevron'}/></span><span><strong>{kind === 'foreach' ? 'For each' : kind[0].toUpperCase() + kind.slice(1)}</strong><small>Wrap the selected block</small></span></button>)}</section>
  </aside>;
}

/** `effort low · model x` — a mode's change to one block, in one line. */
const overrideLine = config => Object.entries(config ?? {})
  .map(([key, value]) => `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');

/**
 * Modes, stated where they are edited.
 *
 * The rule this bar exists to make visible: a workflow is ONE graph, and its
 * modes are named settings over that graph. Low, Medium and High are not three
 * Pipelines — they are three ways to run the one below, and a mode may only
 * change the settings of blocks that already exist. Anything that needs a
 * different shape is a different workflow, which is what Duplicate is for.
 *
 * Selecting a mode PREVIEWS it: the canvas keeps showing the authored settings,
 * because those are what an edit here writes, and marks the blocks the mode
 * changes with what it changes them to.
 */
function ModesBar({ modes, previewing, onPreview, onOpenYaml, defaultId }) {
  const active = modes.find(mode => mode.id === previewing) ?? null;
  const changes = Object.entries(active?.overrides ?? {});
  return <div className="be-modes" aria-label="Modes">
    <span className="be-modes-label"><Icon name="modes" size={14} />Modes</span>
    <div className="be-mode-chips" role="group" aria-label="Preview a mode">
      <button type="button" className={previewing ? '' : 'active'} aria-pressed={!previewing}
        title="The settings every mode starts from — and the ones an edit here writes"
        onClick={() => onPreview(null)}>As authored</button>
      {modes.map(mode => <button type="button" key={mode.id}
        className={previewing === mode.id ? 'active' : ''} aria-pressed={previewing === mode.id}
        title={[mode.description, mode.id === defaultId ? 'Runs when chat picks no mode.' : ''].filter(Boolean).join(' ')}
        onClick={() => onPreview(mode.id)}>
        {mode.name}{mode.id === defaultId && <em>default</em>}
      </button>)}
    </div>
    <p className="be-modes-copy">
      {active
        ? changes.length
          ? changes.map(([blockId, config]) => `${blockId}: ${overrideLine(config)}`).join('  ·  ')
          : `${active.name} changes nothing — it runs exactly as authored.`
        : 'One graph, named settings over it. A mode may change block settings, never the steps.'}
    </p>
    {onOpenYaml && <button type="button" className="be-modes-edit" onClick={onOpenYaml}>Edit modes in YAML</button>}
  </div>;
}

const slotKey = at => `${at.container}:${at.branch ?? 'body'}:${at.index}`;

function DropZone({ at, axis = 'y', root, blocks, commands, dragging, setDragging, dropTarget, setDropTarget, onError }) {
  const key = slotKey(at);
  const drop = async event => {
    event.preventDefault(); event.stopPropagation();
    const dragged = event.dataTransfer.getData('text/flyt-node');
    const newUse = event.dataTransfer.getData('application/flyt-new-block');
    setDropTarget(null); setDragging(null);
    try {
      if (dragged) await commands.invoke('stack:move-block', { nodeId: dragged, to: at }, 'human');
      else if (newUse) {
        const definition = blocks.resolve(newUse);
        await commands.invoke('stack:insert-block', {
          block: { id: uniqueId(root, newUse.split(':').at(-1)), use: newUse, title: definition?.title, config: {} }, at,
        }, 'human');
      }
    } catch (error) { onError(String(error?.message ?? error)); }
  };
  return <div className={`be-drop-zone axis-${axis}${dropTarget === key ? ' active' : ''}`} data-drop-slot={key}
    aria-hidden={!dragging} onDragEnter={event => { event.preventDefault(); setDropTarget(key); }}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = dragging?.startsWith('new:') ? 'copy' : 'move'; setDropTarget(key); }}
    onDrop={drop}><span>Drop here</span></div>;
}

function ChildrenList({ parent, branch = null, root, blocks, commands, selected, setSelected, touched, dragging, setDragging,
  dropTarget, setDropTarget, run, preview = null, onDelete, onError }) {
  const children = branch === 'else' ? parent.else ?? [] : parent.children ?? [];
  const axis = parent.kind === 'parallel' && branch !== 'else' ? 'x' : 'y';
  return <div className={`be-children${axis === 'x' ? ' parallel' : ''}`}>
    {children.map((child, index) => <React.Fragment key={child.id}>
      {commands && <DropZone at={{ container: parent.id, index, ...(branch ? { branch } : {}) }} axis={axis} root={root} blocks={blocks}
        commands={commands} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget} setDropTarget={setDropTarget} onError={onError} />}
      <NodeView node={child} root={root} blocks={blocks} commands={commands} selected={selected} setSelected={setSelected}
        touched={touched} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget} setDropTarget={setDropTarget}
        run={run} preview={preview} onDelete={onDelete} onError={onError} />
    </React.Fragment>)}
    {commands && <DropZone at={{ container: parent.id, index: children.length, ...(branch ? { branch } : {}) }} axis={axis} root={root}
      blocks={blocks} commands={commands} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget}
      setDropTarget={setDropTarget} onError={onError} />}
  </div>;
}

/**
 * A wave summary reads worst-first: what needs attention, then what is moving,
 * then what has settled. Pending sorts last because a queue is the one thing
 * nobody has to act on.
 */
const TASK_STATUS_ORDER = ['failed', 'blocked', 'waiting', 'approval', 'input', 'active', 'done', 'pending'];
const taskStatusLabel = status => (status === 'active' ? 'running' : status);

function taskTally(run, tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const status = statusOf(run, task.id);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => TASK_STATUS_ORDER.indexOf(left) - TASK_STATUS_ORDER.indexOf(right));
}

/** The same counts twice: a dot per status for scanning, the words for reading. */
function TaskTally({ tally, className }) {
  if (!tally.length) return null;
  return <span className={className}>{tally.map(([status, count]) =>
    <span key={status} className={`be-tally-item is-${status}`}><i aria-hidden="true"/>{count} {taskStatusLabel(status)}</span>)}</span>;
}

/**
 * One layout group of dispatched work. Groups do not synchronize execution:
 * each task starts when its dependencies and an available worker slot permit.
 * Cards wrap to the available width without implying a barrier between rows.
 */
function GeneratedTaskWave({ tasks, index, root, blocks, selected, setSelected, touched, dragging, setDragging,
  dropTarget, setDropTarget, run, preview, onDelete, onError }) {
  const [expanded, setExpanded] = useState(false);
  const abbreviated = tasks.length > MAX_VISIBLE_GENERATED_TASKS;
  const visible = abbreviated ? tasks.slice(0, MAX_VISIBLE_GENERATED_TASKS - 1) : tasks;
  const hidden = abbreviated ? tasks.slice(MAX_VISIBLE_GENERATED_TASKS - 1) : [];
  const child = task => <NodeView key={task.id} node={task} root={root} blocks={blocks} commands={null}
    selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
    dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} preview={preview} onDelete={onDelete} onError={onError} />;

  return <li className="be-wave" data-wave={index + 1}>
    <header className="be-wave-head">
      <span className="be-wave-pip" aria-hidden="true">{index + 1}</span>
      <strong title="Tasks start as their dependencies finish and worker slots become available.">Group {index + 1}</strong>
      <small>{tasks.length === 1 ? '1 task' : `${tasks.length} tasks`} · starts when ready</small>
      {run && <TaskTally tally={taskTally(run, tasks)} className="be-wave-tally" />}
    </header>
    <div className="be-wave-tasks">
      {visible.map(child)}
      {abbreviated && !expanded && <button type="button" className="be-wave-more" aria-expanded={false}
        onClick={() => setExpanded(true)}>
        <strong>+{hidden.length} more</strong>
        <span>Show remaining tasks</span>
        {run && <TaskTally tally={taskTally(run, hidden)} className="be-wave-more-tally" />}
      </button>}
      {abbreviated && expanded && hidden.map(child)}
    </div>
    {abbreviated && expanded && <button type="button" className="be-wave-less" onClick={() => setExpanded(false)}>
      Show fewer</button>}
  </li>;
}

function NodeView({ node, root, blocks, commands, selected, setSelected, touched, dragging, setDragging, dropTarget, setDropTarget, run, preview = null, onDelete, onError }) {
  const editable = Boolean(commands?.invoke);
  const status = statusOf(run, node.id);
  const missing = node.kind === 'block' && !definitionOf(node, blocks);
  const definition = definitionOf(node, blocks);
  const modelBacked = Boolean(definition?.settings?.properties?.model || node.config?.modelTier);
  const blockRun = run?.blocks?.[node.id] ?? null;
  const output = blockRun?.showing ?? '';
  const metrics = blockRun?.metrics ?? null;
  const showsModel = modelBacked || Boolean(metrics?.model);
  const modelName = metrics?.model ?? node.config?.model ?? null;
  const slot = parentSlot(root, node.id);
  const move = async delta => {
    if (!slot) return;
    const to = { ...slot, index: Math.max(0, slot.index + delta + (delta > 0 ? 1 : 0)) };
    try { await commands.invoke('stack:move-block', { nodeId: node.id, to }, 'human'); }
    catch (error) { onError(String(error?.message ?? error)); }
  };
  const keyDown = event => {
    if (!editable) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDelete(node); }
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); move(1); }
  };
  const common = {
    'data-node-id': node.id, 'data-kind': node.kind, 'data-status': run ? status : undefined,
    tabIndex: 0, onFocus: () => setSelected(node.id), onClick: event => { event.stopPropagation(); setSelected(node.id); }, onKeyDown: keyDown,
    draggable: editable, onDragStart: event => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; setDragging(node.id); event.dataTransfer.setData('text/flyt-node', node.id); },
    onDragEnd: () => { setDragging(null); setDropTarget(null); },
  };
  const override = preview?.overrides?.[node.id] ?? null;
  if (node.kind === 'block') {
    const generated = generatedChildren(node);
    const card = <article {...common} className={`be-block${selected === node.id ? ' selected' : ''}${missing ? ' missing' : ''}${touched?.nodeId === node.id ? ` touched by-${touched.caller}` : ''}${dragging === node.id ? ' dragging' : ''}${override ? ' overridden' : ''}${node.generated === true ? ' generated' : ''}`}>
    {editable && <span className="be-grip"><Icon name="grip"/></span>}<span className="be-block-glyph"><Icon name="blocks"/></span>
    <span className="be-block-copy"><strong>{titleOf(node, blocks)}</strong><small>{missing ? `Missing · ${node.use}` : node.use}</small>
      {override && <span className="be-mode-override" title={`${preview.name} runs this block with ${overrideLine(override)}`}>
        {preview.name} · {overrideLine(override)}</span>}</span>
    {/* A generated task that has not been dispatched has no model to name, and
        a wave of "Model pending" badges says only that the wave has not started. */}
    {showsModel && (run
      ? (modelName || node.generated !== true) &&
        <span className="be-model-badge" title={modelName ? `Model used by this block: ${modelName}` : 'This block has not picked a model yet'}>{modelName ?? 'Model pending'}</span>
      : <span className={`be-tier-badge tier-${node.config?.modelTier ?? 'default'}`}>{node.config?.modelTier ?? 'default'}</span>)}
    {node.use === 'flyt-blocks-judgement:human-checkpoint' && <span className={`be-checkpoint-badge${node.config?.enabled === false ? ' off' : ''}`}>
      {node.config?.enabled === false ? 'checkpoint off' : 'human approval'}
    </span>}
    {run && <BlockStatus status={status} metrics={metrics} />}
    {editable && <button type="button" className="be-delete" aria-label={`Delete ${titleOf(node, blocks)}`} onClick={event => { event.stopPropagation(); onDelete(node); }}><Icon name="trash"/></button>}
    {run && <ContextAssets assets={run.contextAssets?.[node.id] ?? []} projectId={run.projectId}/>}
    {run && <BlockMetrics metrics={metrics} status={status} />}
    {run && node.generated === true && <RecoveryFacts state={blockRun} status={status} />}
    {run && <BlockActivity items={blockRun?.activity} />}
    {output && <details className="be-inline-output" open={status === 'active'}><summary>Output</summary><pre>{output}</pre></details>}
    </article>;
    if (!generated.length) return card;
    const waves = generatedTaskWaves(generated, node.config ?? {});
    const tally = taskTally(run, generated);
    const settled = tally.find(([state]) => state === 'done')?.[1] ?? 0;
    return <section className="be-dispatch" data-parent-id={node.id}>{card}
      <div className="be-dispatch-panel">
        <header className="be-dispatch-head">
          <span className="be-dispatch-label">Generated tasks</span>
          <span className="be-dispatch-meta">{generated.length === 1 ? '1 task' : `${generated.length} tasks`} · {waves.length === 1 ? '1 group' : `${waves.length} groups`} · created for this run</span>
          {run && <span className="be-dispatch-progress" title={tally.map(([state, count]) => `${count} ${taskStatusLabel(state)}`).join(' · ')}>
            <span className="be-dispatch-meter" aria-hidden="true">{tally.map(([state, count]) =>
              <i key={state} className={`is-${state}`} style={{ flexGrow: count }}/>)}</span>
            <small>{settled} of {generated.length} done</small></span>}
        </header>
        <ol className="be-waves">{waves.map((tasks, index) => <GeneratedTaskWave key={`${node.id}:wave:${index}`} tasks={tasks} index={index}
          root={root} blocks={blocks} selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
          dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} preview={preview} onDelete={onDelete} onError={onError} />)}</ol>
      </div></section>;
  }

  return <section {...common} className={`be-container kind-${node.kind}${selected === node.id ? ' selected' : ''}${touched?.nodeId === node.id ? ` touched by-${touched.caller}` : ''}`}>
    <header>{editable && <span className="be-grip"><Icon name="grip"/></span>}<strong>{controlLabel(node)}</strong><code>{node.id}</code>
      {run && <BlockStatus status={status} metrics={null} />}{editable && <button type="button" className="be-delete"
        onClick={event => { event.stopPropagation(); onDelete(node); }} aria-label={`Delete ${node.id}`}><Icon name="trash"/></button>}</header>
    <div className="be-container-well"><ChildrenList parent={node} root={root} blocks={blocks} commands={commands}
      selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
      dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} preview={preview} onDelete={onDelete} onError={onError} />
      {node.kind === 'if' && <div className="be-else"><span>Else</span><ChildrenList parent={node} branch="else" root={root} blocks={blocks}
        commands={commands} selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
        dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} preview={preview} onDelete={onDelete} onError={onError} /></div>}</div>
  </section>;
}

const SIDEBAR_LIMITS = {
  palette: { min: 184, max: 360, initial: 226 },
  inspector: { min: 260, max: 460, initial: 312 },
};

function ResizeHandle({ side, value, onChange }) {
  const limits = SIDEBAR_LIMITS[side];
  const clamp = next => Math.min(limits.max, Math.max(limits.min, next));
  const resizeFrom = (start, delta) => clamp(start + (side === 'palette' ? delta : -delta));
  const pointerDown = event => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = value;
    const move = next => onChange(resizeFrom(startWidth, next.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };
  const keyDown = event => {
    const direction = side === 'palette' ? 1 : -1;
    if (event.key === 'ArrowLeft') { event.preventDefault(); onChange(clamp(value - 12 * direction)); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onChange(clamp(value + 12 * direction)); }
    if (event.key === 'Home') { event.preventDefault(); onChange(limits.min); }
    if (event.key === 'End') { event.preventDefault(); onChange(limits.max); }
  };
  return <div className={`be-resizer side-${side}`} role="separator" aria-label={`Resize ${side === 'palette' ? 'block palette' : 'workflow inspector'}`}
    aria-orientation="vertical" aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={value} tabIndex="0"
    onPointerDown={pointerDown} onKeyDown={keyDown} onDoubleClick={() => onChange(limits.initial)}><span /></div>;
}

function YamlEditor({ source, validation, validateSource, saveSource }) {
  const [draft, setDraft] = useState(source ?? '');
  const [result, setResult] = useState(validation ?? null);
  const timer = useRef(null);
  useEffect(() => setDraft(source ?? ''), [source]);
  useEffect(() => setResult(validation ?? null), [validation]);
  const change = value => {
    setDraft(value); clearTimeout(timer.current);
    timer.current = setTimeout(() => validateSource?.(value).then(setResult).catch(error => setResult({ ok: false, errors: [{ message: String(error) }], warnings: [] })), 220);
  };
  const save = async () => { const next = await saveSource?.(draft, 'human'); setResult(next); };
  return <div className="be-yaml"><div className="be-yaml-editor"><div className="be-yaml-gutter" aria-hidden="true">{draft.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div>
    <textarea spellCheck="false" value={draft} onChange={event => change(event.target.value)} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
      if (event.key === 'Tab') { event.preventDefault(); const el = event.currentTarget; const at = el.selectionStart; change(`${draft.slice(0, at)}  ${draft.slice(el.selectionEnd)}`); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = at + 2; }); }
    }} aria-label="Workflow YAML" /></div><aside className="be-verification"><header><h2>Static verification</h2><button className="be-primary" type="button" disabled={!result?.ok} onClick={save}>Save YAML</button></header>
    {result?.stats && <dl><div><dt>Blocks</dt><dd>{result.stats.blocks}</dd></div><div><dt>Depth</dt><dd>{result.stats.depth}</dd></div><div><dt>Worst case</dt><dd>{result.stats.worstCaseExpansion}</dd></div></dl>}
    {(result?.errors ?? []).map((error, i) => <p className="be-diagnostic error" key={`e${i}`}><strong>Error{error.line ? ` · line ${error.line}` : ''}</strong>{error.message}</p>)}
    {(result?.warnings ?? []).map((warning, i) => <p className="be-diagnostic warning" key={`w${i}`}><strong>Warning{warning.line ? ` · line ${warning.line}` : ''}</strong>{warning.message}</p>)}
    {result?.ok && !(result.warnings ?? []).length && <p className="be-diagnostic ok"><strong>Ready</strong>Parse, schemas, bounds, and YAML round-trip are valid.</p>}</aside></div>;
}

export default function BlockEditor({
  stack, blocks = null, commands = null, uiExtensions = [], source = '', validation = null, history = [],
  validateSource = null, saveSource = null, mode = 'build', run = null, onRun = null, onOpenLibrary = null,
  onBack = null, projectId = null, activeModels = [],
}) {
  const [selected, setSelected] = useState(() => stack?.root?.children?.[0]?.id ?? null);
  const [touched, setTouched] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [paletteWidth, setPaletteWidth] = useState(SIDEBAR_LIMITS.palette.initial);
  const [inspectorWidth, setInspectorWidth] = useState(SIDEBAR_LIMITS.inspector.initial);
  const [view, setView] = useState('blocks');
  const [deleting, setDeleting] = useState(null);
  // Build's chat, over the canvas. Ctrl/Cmd+K because it is the one thing here
  // you reach for mid-thought, and a trip to the toolbar is enough friction to
  // make people not ask at all.
  const [asking, setAsking] = useState(false);
  // Which mode the canvas is being read AS. Null is the authored settings,
  // which is what an edit writes; a mode id overlays what that mode changes.
  const [previewing, setPreviewing] = useState(null);
  useEffect(() => commands?.subscribe?.(record => {
    if (record?.error) { setRefusal(record.error); return; }
    const nodeId = record?.result?.nodeId ?? null;
    if (nodeId) setTouched({ nodeId, caller: record.caller ?? 'human' });
  }), [commands]);
  useEffect(() => { if (!touched) return; const timer = setTimeout(() => setTouched(null), TOUCH_MS); return () => clearTimeout(timer); }, [touched]);
  useEffect(() => {
    if (mode !== 'build' || !projectId) return undefined;
    const onKey = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setAsking(open => !open); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, projectId]);
  useEffect(() => {
    if (!stack?.root) { if (selected) setSelected(null); return; }
    if (!selected || !nodeById(stack.root, selected)) setSelected(stack.root.children?.[0]?.id ?? null);
  }, [stack, selected]);
  const remove = useCallback(node => {
    if (!commands) return;
    if (node.kind !== 'block' && (node.children?.length || node.else?.length)) setDeleting(node);
    else commands.invoke('stack:remove-block', { nodeId: node.id }, 'human').catch(error => setRefusal(String(error?.message ?? error)));
  }, [commands]);
  const settleDelete = async action => {
    const node = deleting; setDeleting(null); if (!node || action === 'cancel') return;
    try { await commands.invoke(action === 'unwrap' ? 'stack:unwrap-container' : 'stack:remove-block', { nodeId: node.id }, 'human'); }
    catch (error) { setRefusal(String(error?.message ?? error)); }
  };
  if (!stack?.root) return <div className="block-editor-empty" role="status"><p className="section-label">CLEAN SLATE</p><p>No workflow yet — author canonical YAML and it will draw itself here.</p></div>;
  const editable = mode === 'build' && Boolean(commands?.invoke);
  const modes = workflowModes(stack);
  const modeDefault = defaultModeId(stack);
  const previewedMode = modes.find(row => row.id === previewing) ?? null;
  return <div className={`block-editor mode-${mode}`} data-v2 data-editable={editable || undefined}>
    {mode === 'build' && <header className="be-toolbar">
      {onBack && <button type="button" className="be-back" onClick={onBack} title="Back to every workflow in this project">
        <Icon name="back"/><span>Workflows</span></button>}
      <div><span className="section-label">Workflow</span><h1>{stack.name}</h1></div>
      <div className="be-view-switch"><button className={view === 'blocks' ? 'active' : ''} onClick={() => setView('blocks')}><Icon name="blocks"/>Build</button>
        <button className={view === 'yaml' ? 'active' : ''} onClick={() => setView('yaml')}><Icon name="code"/>YAML</button></div>
      <span className={`be-validity ${validation?.ok ? 'ok' : 'error'}`}>{validation?.ok ? `${validation.warnings?.length ?? 0} warnings` : `${validation?.errors?.length ?? 0} errors`}</span>
      {projectId && <button type="button" className="be-secondary" onClick={() => setAsking(true)}
        title="Ask about this workflow (Ctrl/Cmd+K)"><Icon name="chat"/>Ask</button>}
      {onOpenLibrary && <button type="button" className="be-secondary" onClick={onOpenLibrary}>Library</button>}
      {onRun && <button type="button" className="be-primary" disabled={!validation?.ok} onClick={onRun}><Icon name="play"/>Run</button>}</header>}
    {mode === 'build' && view === 'blocks' && modes.length > 0 && <ModesBar modes={modes} previewing={previewing}
      defaultId={modeDefault} onPreview={setPreviewing} onOpenYaml={() => setView('yaml')} />}
    {refusal && <p className="be-refusal" role="alert">{refusal}<button onClick={() => setRefusal(null)} aria-label="Dismiss">×</button></p>}
    {view === 'yaml' && mode === 'build' ? <YamlEditor source={source} validation={validation} validateSource={validateSource} saveSource={saveSource} />
      : <div className={`be-builder-grid${editable ? '' : ' no-palette'}`} style={{ '--be-palette-width': `${paletteWidth}px`, '--be-inspector-width': `${inspectorWidth}px` }}>
      {editable && <><Palette blocks={blocks} root={stack.root} selected={selected} commands={commands} onError={setRefusal} setDragging={setDragging} />
        <ResizeHandle side="palette" value={paletteWidth} onChange={setPaletteWidth} /></>}
      <main className="be-canvas" onClick={() => setSelected(null)}><div className={`be-stack${dragging ? ' is-dragging' : ''}`} role="tree" aria-label={`${stack.name} workflow`}>
        <article className="be-block be-input" tabIndex="0"><span className="be-block-glyph"><Icon name="input"/></span><span className="be-block-copy"><strong>Input</strong><small>{mode === 'run' ? 'Chat message' : 'The original chat message'}</small></span>
          {mode === 'run' && run?.input && <p className="be-input-text">{run.input}</p>}
          {mode === 'run' && <ContextAssets assets={run?.attachments} projectId={run?.projectId} label="Attached assets"/>}</article>
        <ChildrenList parent={stack.root} root={stack.root} blocks={blocks} commands={editable ? commands : null}
          selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
          dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} preview={previewedMode} onDelete={remove} onError={setRefusal} />
        {mode === 'run' && run?.summary && <article className="be-run-summary"><span className="section-label">Supervisor summary</span><p>{run.summary}</p></article>}
      </div></main>{mode === 'build' && <>{editable && <ResizeHandle side="inspector" value={inspectorWidth} onChange={setInspectorWidth} />}
        <Inspector root={stack.root} selected={selected} blocks={blocks} commands={commands} history={history}
          uiExtensions={uiExtensions} preview={previewedMode} onError={setRefusal} /></>}</div>}
    {asking && mode === 'build' && <BuildChat projectId={projectId} stack={stack}
      activeModels={activeModels} commands={commands} onClose={() => setAsking(false)} />}
    {deleting && <div className="be-modal-backdrop" role="presentation"><section className="be-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <h2 id="delete-title">Remove {controlLabel(deleting)}?</h2><p>This control contains authored blocks. Choose what happens to them.</p><div>
        <button className="be-danger" onClick={() => settleDelete('subtree')}>Delete the whole subtree</button><button className="be-secondary" onClick={() => settleDelete('unwrap')}>Keep blocks, remove control</button><button onClick={() => settleDelete('cancel')}>Cancel</button></div>
    </section></div>}
  </div>;
}
