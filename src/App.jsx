import React, { useCallback, useEffect, useState } from 'react';
import FlowCanvas from './FlowCanvas.jsx';
import Inspector from './Inspector.jsx';
import Settings from './Settings.jsx';

function setTheme(mode) { // 'light' | 'dark'
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('llmflow-theme', mode); } catch {}
  // Keep the native window controls in step with the custom title bar.
  window.llmflow?.setTitleBarTheme?.(mode);
}

// Renderer is a pure view over the file-based run state pushed from the main
// process. It holds no authoritative state of its own.
export default function App() {
  const [runIds, setRunIds] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null); // 'prompt' | 'planner' | 'router' | 'task-N' | 'verifier'
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setThemeState] = useState(
    () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  );

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  // Sync the native title-bar overlay to the boot theme once on mount.
  useEffect(() => { window.llmflow?.setTitleBarTheme?.(theme); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshRuns = useCallback(async () => {
    setRunIds(await window.llmflow.listRuns());
  }, []);

  useEffect(() => { refreshRuns(); }, [refreshRuns]);

  useEffect(() => {
    return window.llmflow.onRunUpdate(({ runId, snapshot }) => {
      refreshRuns();
      setActiveRunId(prev => prev ?? runId);
      // Only mirror updates for the run being viewed.
      setSnapshot(prev => (runId === (prevActive(prev) ?? runId)) ? snapshot : prev);
      function prevActive(s) { return s?.meta?.runId; }
    });
  }, [refreshRuns]);

  useEffect(() => {
    if (!activeRunId) { setSnapshot(null); return; }
    window.llmflow.getSnapshot(activeRunId).then(setSnapshot);
  }, [activeRunId]);

  const startRun = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const runId = await window.llmflow.startRun(prompt.trim());
      setActiveRunId(runId);
      setSelectedNode(null);
      setPrompt('');
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  const stage = snapshot?.meta?.stage;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">◆</div>
          <span className="brand-name">LLM Flow</span>
        </div>
        {activeRunId && <span className="titlebar-doc mono">{activeRunId}</span>}
      </div>

      <header className="toolbar">
        <nav className="breadcrumb">
          <span className="crumb-dim">Runs</span>
          {activeRunId && <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{activeRunId}</span>
          </>}
        </nav>
        {stage && <span className="stage-chip">{stage.replace(/_/g, ' ')}</span>}
        <div className="toolbar-spacer" />
        <button type="button" className="theme-toggle" onClick={() => setShowSettings(true)} title="Providers & models">
          <span>⚙</span>
          Settings
        </button>
        <button type="button" className="theme-toggle" onClick={toggleTheme} title="Toggle appearance">
          <span>{theme === 'light' ? '☾' : '☀'}</span>
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-section">
            <span className="section-label">New run</span>
            <textarea
              placeholder="Describe what you want done…"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startRun(); }}
            />
            <button className="primary" onClick={startRun} disabled={busy || !prompt.trim()}>
              {busy ? 'Starting…' : 'Run pipeline'}<kbd className="shortcut">⌘↵</kbd>
            </button>
          </div>
          <div className="sidebar-section" style={{ paddingBottom: 8 }}>
            <span className="section-label">Runs</span>
          </div>
          <div className="run-list">
            {[...runIds].reverse().map(id => (
              <div
                key={id}
                className={'run-item' + (id === activeRunId ? ' active' : '')}
                onClick={() => { setActiveRunId(id); setSelectedNode(null); }}
              >
                {id}
              </div>
            ))}
            {runIds.length === 0 && <div className="muted">No runs yet.</div>}
          </div>
          {activeRunId && (
            <div className="sidebar-footer">
              <button className="ghost" onClick={() => window.llmflow.openRunFolder(activeRunId)}>
                Open run folder
              </button>
            </div>
          )}
        </aside>

        <main className="canvas-area">
          {stage === 'awaiting_approval' && (
            <div className="approval-bar">
              <span className="section-label">Plan ready</span>
              <span>Review the plan, then approve to continue or reject to stop.</span>
              <button className="primary" onClick={() => window.llmflow.approvePlan(activeRunId)}>Approve plan</button>
              <button className="reject" onClick={() => window.llmflow.rejectPlan(activeRunId, 'Rejected by user')}>Reject</button>
            </div>
          )}
          {snapshot
            ? <FlowCanvas snapshot={snapshot} selectedNode={selectedNode} onSelect={setSelectedNode} />
            : (
              <div className="empty-state">
                <span className="section-label">No run selected</span>
                Enter a prompt and run the pipeline.<br />Each stage becomes a live node on this canvas.
              </div>
            )}
        </main>

        {snapshot && <Inspector snapshot={snapshot} selectedNode={selectedNode} />}
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
