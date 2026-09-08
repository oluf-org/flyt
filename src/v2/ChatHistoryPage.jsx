import React, { useEffect, useMemo, useState } from 'react';
import { groupRuns, runStatus, runTimeLabel, runTimeTitle } from '../runList.js';
import { loopLabel, count, elapsed } from '../activityFormat.js';
import ActivityIcon from '../ActivityIcon.jsx';
import './chatHistoryStyles.css';

export default function ChatHistoryPage({ projectId, onOpen, onNewChat }) {
  const [rows, setRows] = useState([]), [query, setQuery] = useState(''), [kind, setKind] = useState('all');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(60);
  useEffect(() => { setLimit(60); }, [kind, query]);
  useEffect(() => {
    let live = true, loading = false;
    setRows([]); setBusy(true); setError('');
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try { const next = projectId ? await window.flyt.chatHistory(projectId) : []; if (live) { setRows(next); setError(''); } }
      catch (caught) { if (live) setError(String(caught.message ?? caught)); }
      finally { loading = false; if (live) setBusy(false); }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [projectId, revision]);
  const filtered = useMemo(() => rows.filter(row => (kind === 'all' || row.kind === kind)
    && `${row.name} ${row.model ?? ''} ${row.flowName ?? ''} ${row.status ?? row.stage}`.toLowerCase().includes(query.trim().toLowerCase())), [rows, kind, query]);
  const groups = groupRuns(filtered.slice(0, limit));
  return <div className="chats-page">
    <header className="chats-head"><div><h1>Chat history</h1><span>{count(rows.length)} conversations</span></div>
      <button className="chats-new" onClick={onNewChat}>＋ New chat</button></header>
    <div className="chats-toolbar"><input type="search" aria-label="Search chat history" placeholder="Search history…" value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="chats-tabs" role="group" aria-label="Conversation type">{[['all', 'All'], ['loop', 'Loops'], ['workflow', 'Workflows']].map(([value, label]) => <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div></div>
    {error && <p role="alert" className="chats-error">{error} <button onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {busy ? <p role="status" className="chats-empty">Loading history…</p> : !groups.length ? <div className="chats-empty"><ActivityIcon kind={kind === 'loop' ? 'loop' : 'workflow'} id="empty-history" size={36}/><p>{query || kind !== 'all' ? 'No matches' : 'No conversations yet'}</p>{(query || kind !== 'all') && <button onClick={() => { setQuery(''); setKind('all'); }}>Clear filters</button>}</div> : groups.map(group => <section className="chats-group" key={group.key} aria-label={group.label}>
      <h2>{group.label}</h2><div className="chats-list">{group.runs.map(row => {
        const status = row.kind === 'loop' ? { label: loopLabel(row.status), kind: row.status === 'achieved' ? 'done' : row.settled ? 'settled' : row.status } : runStatus(row);
        return <button className="chats-row" key={`${row.kind}:${row.id}`} onClick={() => onOpen(row)} title={runTimeTitle(row)}>
          <ActivityIcon kind={row.kind} id={row.id} size={28}/>
          <span className="chats-title"><strong>{row.name || 'Untitled'}</strong><small>{row.kind === 'loop' ? `${count(row.iterations)} iterations · ${elapsed(row.elapsedMs)}` : row.flowName ?? row.stackId ?? 'Workflow'}{row.conversationRuns > 1 ? ` · ${row.conversationRuns} turns` : ''}</small></span>
          {row.kind === 'loop' && row.score != null && <span className="chats-score" title="Best checks passed"><span style={{ width: `${row.score * 100}%` }}/><small>{Math.round(row.score * 100)}%</small></span>}
          <span className={`chats-status ${status.kind}`}><i/>{status.label}</span><time>{runTimeLabel(row)}</time><span aria-hidden="true" className="chats-arrow">↗</span>
        </button>;
      })}</div></section>)}
    {filtered.length > limit && <button className="chats-more" onClick={() => setLimit(value => value + 60)}>Show more · {filtered.length - limit}</button>}
  </div>;
}
