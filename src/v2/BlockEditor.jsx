// One recursive renderer for Build and Run. Containment is the graph; the DOM
// follows the YAML tree and stores no coordinates or layout sidecar.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BlockConfigurationView } from './PluginContributionView.jsx';
import './blockEditorStyles.css';

const TOUCH_MS = 600;
const CONTROL_KINDS = ['sequence', 'parallel', 'repeat', 'foreach', 'until', 'if'];

function Icon({ name, size = 16 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    grip: <><path d="M8 7h.01M8 12h.01M8 17h.01M16 7h.01M16 12h.01M16 17h.01"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
    play: <path d="m8 5 11 7-11 7z"/>,
    code: <><path d="m9 7-5 5 5 5M15 7l5 5-5 5"/></>,
    blocks: <><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M14 7h3v3M10 17H7v-3"/></>,
    input: <><path d="M4 12h12M12 8l4 4-4 4"/><path d="M20 5v14"/></>,
  };
  return <svg className="be-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name] ?? paths.blocks}
  </svg>;
}

const titleOf = (node, blocks) => node.title || blocks?.resolve?.(node.use)?.title || node.use || node.id;
const definitionOf = (node, blocks) => node?.kind === 'block' ? blocks?.resolve?.(node.use) ?? null : null;
const statusOf = (run, id) => run?.blocks?.[id]?.status ?? 'pending';

function walkNode(node, out = []) {
  out.push(node);
  if (node?.kind !== 'block') {
    for (const child of node.children ?? []) walkNode(child, out);
    if (node.kind === 'if') for (const child of node.else ?? []) walkNode(child, out);
  }
  return out;
}

function parentSlot(root, nodeId) {
  for (const parent of walkNode(root, [])) {
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

const nodeById = (root, id) => walkNode(root, []).find(node => node.id === id) ?? null;

function contextFor(root, id) {
  const all = walkNode(root, []).filter(node => node.kind === 'block');
  const index = all.findIndex(node => node.id === id);
  return {
    upstream: index > 0 ? all.slice(0, index).map(node => node.id) : [],
    downstream: index >= 0 ? all.slice(index + 1).map(node => node.id) : [],
  };
}

function uniqueId(root, seed) {
  const base = String(seed || 'block').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
  const ids = new Set(walkNode(root, []).map(node => node.id));
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

function ContainerFields({ node, draft, update }) {
  const number = name => <label><span>{name === 'maxParallel' ? 'Maximum parallel lanes' : name}</span>
    <input type="number" min="1" value={draft[name] ?? ''} onChange={event => update(name, { type: 'integer' }, event.target.value)} /></label>;
  if (node.kind === 'sequence') return <p className="be-empty-copy">Sequence has no runtime settings.</p>;
  if (node.kind === 'parallel') return number('maxParallel');
  if (node.kind === 'repeat') return number('count');
  if (node.kind === 'foreach') return <>{number('max')}<label><span>Roster output</span><input value={draft.roster ?? ''}
    onChange={event => update('roster', {}, event.target.value)} placeholder="plan.tasks" /></label></>;
  if (node.kind === 'until') return <>{number('max')}<label><span>Condition (JSON)</span><textarea rows="5"
    value={JSON.stringify(draft.condition ?? {}, null, 2)} onChange={event => {
      try { update('condition', {}, JSON.parse(event.target.value)); } catch { /* retain last valid value */ }
    }} /></label></>;
  return <label><span>Predicate (JSON)</span><textarea rows="6" value={JSON.stringify(draft.predicate ?? {}, null, 2)}
    onChange={event => { try { update('predicate', {}, JSON.parse(event.target.value)); } catch { /* retain last valid value */ } }} /></label>;
}

function GenericConfigForm({ node, definition, commands, onError }) {
  const initial = node.kind === 'block' ? node.config ?? {} : containerConfig(node);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [node.id, JSON.stringify(initial)]);
  const props = definition?.settings?.properties ?? {};
  const update = (name, field, raw) => {
    let value = raw;
    if (field.type === 'integer' || field.type === 'number') value = raw === '' ? null : Number(raw);
    if (field.type === 'boolean') value = Boolean(raw);
    setDraft(current => ({ ...current, [name]: value }));
  };
  const save = async () => {
    if (!commands?.invoke) return;
    try {
      await commands.invoke(node.kind === 'block' ? 'stack:configure-block' : 'stack:configure-container', { nodeId: node.id, config: draft }, 'human');
    } catch (error) { onError(String(error?.message ?? error)); }
  };
  return <div className="be-config-form">
    {node.kind === 'block' && !Object.keys(props).length && <p className="be-empty-copy">This block has no settings.</p>}
    {Object.entries(props).map(([name, field]) => <label key={name}>
      <span>{field.title ?? name}</span>{field.description && <small>{field.description}</small>}
      {field.enum ? <select value={draft[name] ?? ''} onChange={event => update(name, field, event.target.value)}>
        <option value="">Default</option>{field.enum.map(option => <option key={option} value={option}>{option}</option>)}</select>
        : field.type === 'boolean' ? <input type="checkbox" checked={Boolean(draft[name])} onChange={event => update(name, field, event.target.checked)} />
          : (name === 'instructions' || field.format === 'multiline') ? <textarea rows="7" value={draft[name] ?? ''} onChange={event => update(name, field, event.target.value)} />
            : <input type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} value={draft[name] ?? ''}
                min={field.minimum} max={field.maximum} onChange={event => update(name, field, event.target.value)} />}
    </label>)}
    {node.kind !== 'block' && <ContainerFields node={node} draft={draft} update={update} />}
    <button type="button" className="be-primary" disabled={!commands?.invoke} onClick={save}>Save configuration</button>
  </div>;
}

function Inspector({ root, selected, blocks, commands, history, uiExtensions, onError }) {
  const [tab, setTab] = useState('config');
  const node = selected ? nodeById(root, selected) : null;
  const context = node ? contextFor(root, node.id) : { upstream: [], downstream: [] };
  const records = (history ?? []).filter(row => !node || row.nodeId === node.id || row.args?.nodeId === node.id);
  const definition = definitionOf(node, blocks);
  const contributions = uiExtensions.filter(row => row?.contribution?.point === 'block-configuration'
    && node?.kind === 'block' && row.contribution.block === node.use);
  return <aside className="be-inspector" aria-label="Workflow inspector">
    <div className="be-inspector-tabs" role="tablist">{['config', 'context', 'history'].map(name => <button type="button" role="tab"
      aria-selected={tab === name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} key={name}>{name}</button>)}</div>
    {!node ? <p className="be-empty-copy">Select a block or control to inspect it.</p> : <>
      <header className="be-inspector-head"><span className="section-label">{node.kind}</span><h2>{titleOf(node, blocks)}</h2><code>{node.id}</code></header>
      {tab === 'config' && <><GenericConfigForm node={node} definition={definition} commands={commands} onError={onError} />
        {contributions.map(row => <BlockConfigurationView key={`${row.pluginId}:${row.contribution.id}`} contribution={row.contribution} pluginId={row.pluginId}
          value={node.config ?? {}} onChange={config => commands?.invoke?.('stack:configure-block', { nodeId: node.id, config }, 'human')?.catch?.(error => onError(String(error)))} />)}</>}
      {tab === 'context' && <div className="be-context"><h3>Receives context from</h3>{context.upstream.length
        ? context.upstream.map(id => <code key={id}>{id}</code>) : <p>Input only</p>}<h3>Feeds</h3>{context.downstream.length
          ? context.downstream.map(id => <code key={id}>{id}</code>) : <p>Final block</p>}{node.kind === 'block' && <><h3>Declared outputs</h3>
          {(node.outputs ?? []).length ? node.outputs.map(output => <code key={output.name}>{node.id}.{output.name} · {output.type}</code>) : <p>No structured outputs authored.</p>}</>}</div>}
      {tab === 'history' && <div className="be-history">{records.length ? records.map((row, index) => <article key={`${row.at}:${index}`}>
        <div><strong>{row.command}</strong><span>{row.caller}</span></div><time>{row.at}</time>{row.details && <small>{row.details}</small>}{row.error && <p>{row.error}</p>}</article>)
        : <p className="be-empty-copy">No authoring or prior-run history for this block yet.</p>}</div>}
    </>}
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
    const ordered = walkNode(root, []);
    const selectedIndex = ordered.findIndex(node => node.id === selected);
    const upstreamOutput = ordered.slice(0, selectedIndex).filter(node => node.kind === 'block')
      .flatMap(node => (node.outputs ?? []).map(output => ({ node, output }))).at(-1);
    const upstreamList = ordered.slice(0, selectedIndex).filter(node => node.kind === 'block')
      .flatMap(node => (node.outputs ?? []).filter(output => output.type === 'list').map(output => ({ node, output }))).at(-1);
    const bodyOutput = selectedNode
      ? walkNode(selectedNode, []).filter(node => node.kind === 'block')
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
  dropTarget, setDropTarget, run, onDelete, onError }) {
  const children = branch === 'else' ? parent.else ?? [] : parent.children ?? [];
  const axis = parent.kind === 'parallel' && branch !== 'else' ? 'x' : 'y';
  return <div className={`be-children${axis === 'x' ? ' parallel' : ''}`}>
    {children.map((child, index) => <React.Fragment key={child.id}>
      {commands && <DropZone at={{ container: parent.id, index, ...(branch ? { branch } : {}) }} axis={axis} root={root} blocks={blocks}
        commands={commands} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget} setDropTarget={setDropTarget} onError={onError} />}
      <NodeView node={child} root={root} blocks={blocks} commands={commands} selected={selected} setSelected={setSelected}
        touched={touched} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget} setDropTarget={setDropTarget}
        run={run} onDelete={onDelete} onError={onError} />
    </React.Fragment>)}
    {commands && <DropZone at={{ container: parent.id, index: children.length, ...(branch ? { branch } : {}) }} axis={axis} root={root}
      blocks={blocks} commands={commands} dragging={dragging} setDragging={setDragging} dropTarget={dropTarget}
      setDropTarget={setDropTarget} onError={onError} />}
  </div>;
}

function NodeView({ node, root, blocks, commands, selected, setSelected, touched, dragging, setDragging, dropTarget, setDropTarget, run, onDelete, onError }) {
  const editable = Boolean(commands?.invoke);
  const status = statusOf(run, node.id);
  const missing = node.kind === 'block' && !definitionOf(node, blocks);
  const output = run?.blocks?.[node.id]?.showing ?? '';
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
  if (node.kind === 'block') return <article {...common} className={`be-block${selected === node.id ? ' selected' : ''}${missing ? ' missing' : ''}${touched?.nodeId === node.id ? ` touched by-${touched.caller}` : ''}${dragging === node.id ? ' dragging' : ''}`}>
    <span className="be-grip"><Icon name="grip"/></span><span className="be-block-glyph"><Icon name="blocks"/></span>
    <span className="be-block-copy"><strong>{titleOf(node, blocks)}</strong><small>{missing ? `Missing · ${node.use}` : node.use}</small></span>
    {run && <span className={`be-status status-${status}`}>{status === 'active' ? 'running' : status}</span>}
    {editable && <button type="button" className="be-delete" aria-label={`Delete ${titleOf(node, blocks)}`} onClick={event => { event.stopPropagation(); onDelete(node); }}><Icon name="trash"/></button>}
    {output && <details className="be-inline-output" open={status === 'active'}><summary>Output</summary><pre>{output}</pre></details>}
  </article>;

  return <section {...common} className={`be-container kind-${node.kind}${selected === node.id ? ' selected' : ''}${touched?.nodeId === node.id ? ` touched by-${touched.caller}` : ''}`}>
    <header><span className="be-grip"><Icon name="grip"/></span><strong>{controlLabel(node)}</strong><code>{node.id}</code>
      {run && <span className={`be-status status-${status}`}>{status}</span>}{editable && <button type="button" className="be-delete"
        onClick={event => { event.stopPropagation(); onDelete(node); }} aria-label={`Delete ${node.id}`}><Icon name="trash"/></button>}</header>
    <div className="be-container-well"><ChildrenList parent={node} root={root} blocks={blocks} commands={commands}
      selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
      dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} onDelete={onDelete} onError={onError} />
      {node.kind === 'if' && <div className="be-else"><span>Else</span><ChildrenList parent={node} branch="else" root={root} blocks={blocks}
        commands={commands} selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
        dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} onDelete={onDelete} onError={onError} /></div>}</div>
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
  useEffect(() => commands?.subscribe?.(record => {
    if (record?.error) { setRefusal(record.error); return; }
    const nodeId = record?.result?.nodeId ?? null;
    if (nodeId) setTouched({ nodeId, caller: record.caller ?? 'human' });
  }), [commands]);
  useEffect(() => { if (!touched) return; const timer = setTimeout(() => setTouched(null), TOUCH_MS); return () => clearTimeout(timer); }, [touched]);
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
  return <div className={`block-editor mode-${mode}`} data-v2 data-editable={editable || undefined}>
    {mode === 'build' && <header className="be-toolbar"><div><span className="section-label">Workflow</span><h1>{stack.name}</h1></div>
      <div className="be-view-switch"><button className={view === 'blocks' ? 'active' : ''} onClick={() => setView('blocks')}><Icon name="blocks"/>Build</button>
        <button className={view === 'yaml' ? 'active' : ''} onClick={() => setView('yaml')}><Icon name="code"/>YAML</button></div>
      <span className={`be-validity ${validation?.ok ? 'ok' : 'error'}`}>{validation?.ok ? `${validation.warnings?.length ?? 0} warnings` : `${validation?.errors?.length ?? 0} errors`}</span>
      {onOpenLibrary && <button type="button" className="be-secondary" onClick={onOpenLibrary}>Library</button>}
      {onRun && <button type="button" className="be-primary" disabled={!validation?.ok} onClick={onRun}><Icon name="play"/>Run</button>}</header>}
    {refusal && <p className="be-refusal" role="alert">{refusal}<button onClick={() => setRefusal(null)} aria-label="Dismiss">×</button></p>}
    {view === 'yaml' && mode === 'build' ? <YamlEditor source={source} validation={validation} validateSource={validateSource} saveSource={saveSource} />
      : <div className={`be-builder-grid${editable ? '' : ' no-palette'}`} style={{ '--be-palette-width': `${paletteWidth}px`, '--be-inspector-width': `${inspectorWidth}px` }}>
      {editable && <><Palette blocks={blocks} root={stack.root} selected={selected} commands={commands} onError={setRefusal} setDragging={setDragging} />
        <ResizeHandle side="palette" value={paletteWidth} onChange={setPaletteWidth} /></>}
      <main className="be-canvas" onClick={() => setSelected(null)}><div className={`be-stack${dragging ? ' is-dragging' : ''}`} role="tree" aria-label={`${stack.name} workflow`}>
        <article className="be-block be-input" tabIndex="0"><span className="be-block-glyph"><Icon name="input"/></span><span className="be-block-copy"><strong>Input</strong><small>{mode === 'run' ? 'Chat message' : 'The original chat message'}</small></span>
          {mode === 'run' && run?.input && <p className="be-input-text">{run.input}</p>}</article>
        <ChildrenList parent={stack.root} root={stack.root} blocks={blocks} commands={editable ? commands : null}
          selected={selected} setSelected={setSelected} touched={touched} dragging={dragging} setDragging={setDragging}
          dropTarget={dropTarget} setDropTarget={setDropTarget} run={run} onDelete={remove} onError={setRefusal} />
        {mode === 'run' && run?.summary && <article className="be-run-summary"><span className="section-label">Supervisor summary</span><p>{run.summary}</p></article>}
      </div></main>{mode === 'build' && <>{editable && <ResizeHandle side="inspector" value={inspectorWidth} onChange={setInspectorWidth} />}
        <Inspector root={stack.root} selected={selected} blocks={blocks} commands={commands} history={history}
          uiExtensions={uiExtensions} onError={setRefusal} /></>}</div>}
    {deleting && <div className="be-modal-backdrop" role="presentation"><section className="be-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <h2 id="delete-title">Remove {controlLabel(deleting)}?</h2><p>This control contains authored blocks. Choose what happens to them.</p><div>
        <button className="be-danger" onClick={() => settleDelete('subtree')}>Delete the whole subtree</button><button className="be-secondary" onClick={() => settleDelete('unwrap')}>Keep blocks, remove control</button><button onClick={() => settleDelete('cancel')}>Cancel</button></div>
    </section></div>}
  </div>;
}
