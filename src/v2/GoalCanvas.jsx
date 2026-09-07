import React, { useId, useState } from 'react';
import { loopNodes, circlePositions, goalNodeStatus } from './goalCanvasData.js';

// Long runtime phrases are for the record, not for a card. The card shows the
// shortest word that still distinguishes the state.
const STATE_LABEL = { 'Not run in this view': 'Idle', 'Not run': null, 'Pending setup': 'Pending' };
const TONE = { Running: 'live', Done: 'done', 'Setup complete': 'done' };

const LockIcon = () => <svg className="goal-lock" viewBox="0 0 12 12" aria-label="Locked from AI" role="img">
  <rect x="2.6" y="5.3" width="6.8" height="5" rx="1.3"/><path d="M4.3 5.3V4a1.7 1.7 0 0 1 3.4 0v1.3"/></svg>;

export default function GoalCanvas({ recipe, setup, goal, objective, selected, onSelect, pending = [], locks = [], snapshot }) {
  const [view, setView] = useState('steps');
  const marker = useId().replaceAll(':', '');
  const nodes = loopNodes(recipe?.root), positions = circlePositions(nodes.length);
  const loop = view === 'loop' && nodes.length <= 9;
  const setupNodes = setup?.root?.children ?? [];

  const nodeButton = (node, phase = 'recipe') => {
    const address = `${phase}/${node.id}`;
    const count = pending.filter(change => change.address.startsWith(`${address}/`)).length;
    const locked = locks.some(lock => lock === address || lock.startsWith(`${address}/`));
    const system = node.kind === 'system';
    const raw = system
      ? (goal?.pendingResult ? 'Needs review' : goal?.current ? `${Math.round(goal.current.score * 100)}% checks` : null)
      : (goal ? goalNodeStatus(snapshot, goal, phase, node.id) : null);
    const state = raw && (Object.hasOwn(STATE_LABEL, raw) ? STATE_LABEL[raw] : raw);
    const shape = system ? 'Repeat or exit' : node.kind === 'block' ? null : `${node.childCount ?? node.children?.length ?? 0} branches`;
    return <button type="button" className={`goal-node${system ? ' system' : ''}`} aria-pressed={selected === address}
      onClick={event => { event.stopPropagation(); onSelect(address); }}>
      <strong>{node.title || node.id}</strong>
      {shape && <small>{shape}</small>}
      {(state || locked || count > 0) && <span className="goal-node-meta">
        {state && <span className={`goal-node-state ${TONE[state] ?? ''}`}>{state}</span>}
        {locked && <LockIcon/>}
        {count > 0 && <span className="goal-change-badge" title={`${count} AI change${count > 1 ? 's' : ''}`}>{count}</span>}
      </span>}
    </button>;
  };

  // Setup runs once, so it sits above the repeating part rather than inside it.
  const setupStrip = setupNodes.length > 0 && <div className={`goal-setup-strip${loop ? ' centered' : ''}`}>
    <span className="goal-eyebrow">Setup · once</span>
    <div className="goal-setup-cards">{setupNodes.map(node => <React.Fragment key={node.id}>{nodeButton(node, 'setup')}</React.Fragment>)}</div>
  </div>;

  return <section className="goal-canvas" aria-label="Loop canvas"
    onClick={event => { if (!event.target.closest('button,select,summary')) onSelect(null); }}>
    <div className="goal-canvas-toolbar">
      <div className="goal-segmented" role="group" aria-label="Loop view">
        <button type="button" aria-pressed={!loop} onClick={() => setView('steps')}>Steps</button>
        <button type="button" aria-pressed={loop} disabled={nodes.length > 9} onClick={() => setView('loop')}>Loop</button>
      </div>
    </div>

    {loop ? <div className="goal-loop">{setupStrip}
      <div className="goal-circle" style={{ '--goal-nodes': nodes.length }}>
        <svg viewBox="0 0 1000 1000" aria-hidden="true" focusable="false">
          <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="var(--accent)"/></marker></defs>
          <circle cx="500" cy="500" r="350"/>
          {nodes.map((node, index) => {
            const angle = -Math.PI / 2 + (index + 0.5) * Math.PI * 2 / nodes.length;
            const x = 500 + 350 * Math.cos(angle), y = 500 + 350 * Math.sin(angle);
            return <path key={node.id} d={`M ${x + 9 * Math.sin(angle)} ${y - 9 * Math.cos(angle)} L ${x - 9 * Math.sin(angle)} ${y + 9 * Math.cos(angle)}`} markerEnd={`url(#${marker})`}/>;
          })}
        </svg>
        <div className="goal-circle-center">
          <h2 className={objective ? '' : 'placeholder'}>{objective || 'What should this loop achieve?'}</h2>
          {goal && <p>Iteration {goal.iteration} / {goal.contract.limits.iterations}</p>}
        </div>
        {nodes.map((node, index) => <div className="goal-node-position" key={node.id} style={{ left: `${positions[index].x}%`, top: `${positions[index].y}%` }}>
          <span className="goal-step-mark" aria-hidden="true">{node.kind === 'system' ? '↻' : String(node.ordinal).padStart(2, '0')}</span>
          {nodeButton(node)}
        </div>)}
      </div>
    </div> : <div className="goal-flow">{setupStrip}
      <div className="goal-steps-wrap">
        <span className="goal-steps-return" aria-hidden="true"><i>↻</i></span>
        <ol className="goal-steps">{nodes.map(node => <li key={node.id}>
          <span className="goal-step-mark" aria-hidden="true">{node.kind === 'system' ? '↻' : String(node.ordinal).padStart(2, '0')}</span>
          {nodeButton(node)}
        </li>)}</ol>
      </div>
    </div>}
  </section>;
}
