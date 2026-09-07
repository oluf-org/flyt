import React, { useEffect, useRef, useState } from 'react';

export default function GoalLibrary({ items, busy, error, onClose, onUse }) {
  const dialog = useRef(null), trigger = useRef(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    trigger.current = document.activeElement; dialog.current.showModal();
    return () => { if (trigger.current?.isConnected) trigger.current.focus(); };
  }, []);
  const filtered = items.filter(item => `${item.name} ${item.objective} ${item.projectName}`.toLowerCase().includes(query.toLowerCase()));
  return <dialog ref={dialog} className="goal-library-dialog" aria-labelledby="goal-library-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="goal-library-title">Loop library</h2><button onClick={onClose}>Close</button></header>
    <p>Saved goals and loops from every project. Reuse one as a fresh draft in this project, with its own runs and progress.</p>
    {error && <p role="alert" className="goal-error">{error}</p>}
    <input autoFocus type="search" aria-label="Search loops" placeholder="Search by name, objective or project" value={query} onChange={event => setQuery(event.target.value)}/>
    <ul>{filtered.map(item => <li key={item.id}><div><h3>{item.name || 'Untitled loop'}</h3><small>From {item.projectName} · v{item.revision}</small><p>{item.objective}</p></div><button className="goal-primary" disabled={busy} onClick={() => onUse(item.id)} aria-label={`Use ${item.name} in this project`}>Use in this project</button></li>)}</ul>
    {!filtered.length && <p>{items.length ? 'No loops match your search.' : 'Save a goal with an objective to make it available in every project.'}</p>}
  </dialog>;
}
