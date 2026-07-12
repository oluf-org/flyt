import React, { useCallback, useEffect, useRef, useState } from 'react';
import FlowCanvas, { FlowEditor } from './FlowCanvas.jsx';
import Inspector, { FlowInspector } from './Inspector.jsx';
import Settings from './Settings.jsx';
import { TYPE_META } from './flowTypes.js';

function setTheme(mode) { // 'light' | 'dark'
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('llmflow-theme', mode); } catch {}
  // Keep the native window controls in step with the custom title bar.
  window.llmflow?.setTitleBarTheme?.(mode);
}

let nodeSeq = 0;
function freshNodeId(type) {
  return `${type}-${Date.now().toString(36)}${(nodeSeq++).toString(36)}`;
}

// Renderer is a pure view over file state pushed from the main process:
// run snapshots (read-only) and flow definitions (editable, autosaved).
export default function App() {
  const [runIds, setRunIds] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [theme, setThemeState] = useState(
    () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  );

  // Flow-builder state.
  const [flowsList, setFlowsList] = useState([]);
  const [activeFlowId, setActiveFlowId] = useState(null);
  const [flow, setFlow] = useState(null);
  const [flowSaved, setFlowSaved] = useState(true);
  const [models, setModels] = useState([]);
  const [defaultWorker, setDefaultWorker] = useState({ provider: 'mock', model: 'mock-large' });
  const flowRef = useRef(null);
  const saveTimer = useRef(null);

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
  const refreshFlows = useCallback(async () => {
    setFlowsList(await window.llmflow.listFlows());
  }, []);

  useEffect(() => { refreshRuns(); refreshFlows(); }, [refreshRuns, refreshFlows]);

  // Worker defaults + model options for the node editor's worker pickers.
  useEffect(() => {
    window.llmflow.getSettings().then(s => {
      setDefaultWorker(s.workers.executor);
      if (s.hasKey) window.llmflow.listModels().then(setModels).catch(() => setModels([]));
    });
  }, []);

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

  // --- Flow persistence: debounced autosave, flushed on view switches ---
  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (flowRef.current && !flowRef.current.builtin) {
        await window.llmflow.saveFlow(flowRef.current);
        setFlowSaved(true);
        refreshFlows();
      }
    }
  }, [refreshFlows]);

  const changeFlow = useCallback(updater => {
    setFlow(prev => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next === prev || next.builtin) return next;
      flowRef.current = next;
      setFlowSaved(false);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        saveTimer.current = null;
        await window.llmflow.saveFlow(flowRef.current);
        setFlowSaved(true);
        refreshFlows(); // name may have changed
      }, 500);
      return next;
    });
  }, [refreshFlows]);

  const openFlow = useCallback(async id => {
    await flushSave();
    const f = await window.llmflow.loadFlow(id);
    flowRef.current = f;
    setFlow(f);
    setFlowSaved(true);
    setActiveFlowId(id);
    setActiveRunId(null);
    setSelectedNode(null);
  }, [flushSave]);

  const openRun = useCallback(async id => {
    await flushSave();
    setActiveFlowId(null);
    setFlow(null);
    setActiveRunId(id);
    setSelectedNode(null);
  }, [flushSave]);

  const newFlow = async () => {
    const f = await window.llmflow.newFlow();
    await refreshFlows();
    await openFlow(f.id);
  };

  const deleteFlow = async () => {
    if (!flow || flow.builtin) return;
    if (!window.confirm(`Delete flow "${flow.name}"?`)) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await window.llmflow.deleteFlow(flow.id);
    flowRef.current = null;
    setFlow(null);
    setActiveFlowId(null);
    setSelectedNode(null);
    refreshFlows();
  };

  const addNode = type => {
    const meta = TYPE_META[type];
    const data =
      type === 'input' ? { text: '' } :
      type === 'agentTask' ? { title: 'New task', goal: '', constraints: [], worker: { ...defaultWorker } } :
      type === 'aiStep' ? { title: '', role: 'custom', system: '', worker: { ...defaultWorker } } :
      {};
    changeFlow(f => {
      const n = f.nodes.length;
      const id = freshNodeId(type);
      setSelectedNode(id);
      return {
        ...f,
        nodes: [...f.nodes, {
          id, type, kind: meta.kind,
          position: { x: 280, y: 40 + (n % 6) * 90 },
          data
        }]
      };
    });
  };

  const changeNodeData = (nodeId, patch) => {
    changeFlow(f => ({
      ...f,
      nodes: f.nodes.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)
    }));
  };

  const deleteNode = nodeId => {
    changeFlow(f => ({
      ...f,
      nodes: f.nodes.filter(n => n.id !== nodeId),
      edges: f.edges.filter(e => e.source !== nodeId && e.target !== nodeId)
    }));
    setSelectedNode(null);
  };

  const startRun = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      const runId = await window.llmflow.startRun(prompt.trim());
      await openRun(runId);
      setPrompt('');
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  const stage = snapshot?.meta?.stage;
  const flowView = Boolean(activeFlowId && flow);

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">◆</div>
          <span className="brand-name">LLM Flow</span>
        </div>
        {flowView
          ? <span className="titlebar-doc mono">{flow.name}</span>
          : activeRunId && <span className="titlebar-doc mono">{activeRunId}</span>}
      </div>

      <header className="toolbar">
        <nav className="breadcrumb">
          <span className="crumb-dim">{flowView ? 'Flows' : 'Runs'}</span>
          {(flowView || activeRunId) && <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{flowView ? flow.name : activeRunId}</span>
          </>}
        </nav>
        {!flowView && stage && <span className="stage-chip">{stage.replace(/_/g, ' ')}</span>}
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
            <div className="section-row">
              <span className="section-label">Flows</span>
              <button className="ghost mini" onClick={newFlow}>＋ New flow</button>
            </div>
          </div>
          <div className="flow-list">
            {flowsList.map(f => (
              <div
                key={f.id}
                className={'run-item flow-item' + (f.id === activeFlowId ? ' active' : '')}
                onClick={() => openFlow(f.id)}
              >
                <span className="flow-item-name">{f.name}</span>
                {f.builtin && <span className="node-kind kind-user">built-in</span>}
              </div>
            ))}
          </div>

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
                className={'run-item' + (id === activeRunId && !flowView ? ' active' : '')}
                onClick={() => openRun(id)}
              >
                {id}
              </div>
            ))}
            {runIds.length === 0 && <div className="muted">No runs yet.</div>}
          </div>
          {activeRunId && !flowView && (
            <div className="sidebar-footer">
              <button className="ghost" onClick={() => window.llmflow.openRunFolder(activeRunId)}>
                Open run folder
              </button>
            </div>
          )}
        </aside>

        <main className="canvas-area">
          {flowView && (
            <div className="editor-bar">
              {flow.builtin ? <>
                <span className="section-label">Built-in flow</span>
                <span className="editor-hint">Read-only — the classic pipeline. Run it from the New run box.</span>
              </> : <>
                <input
                  className="flow-name mono"
                  value={flow.name}
                  onChange={e => changeFlow(f => ({ ...f, name: e.target.value }))}
                  aria-label="Flow name"
                />
                <div className="palette">
                  {Object.entries(TYPE_META).map(([type, m]) => (
                    <button key={type} className="palette-btn" onClick={() => addNode(type)} title={`Add ${m.label}`}>
                      <span className="palette-icon">{m.icon}</span>{m.label}
                    </button>
                  ))}
                </div>
                <div className="toolbar-spacer" />
                <span className={'save-dot' + (flowSaved ? ' saved' : '')}>{flowSaved ? 'Saved' : 'Saving…'}</span>
                <button className="reject" onClick={deleteFlow}>Delete flow</button>
              </>}
            </div>
          )}
          {!flowView && stage === 'awaiting_approval' && (
            <div className="approval-bar">
              <span className="section-label">Approval gate</span>
              <span>Review the work so far, then approve to continue or reject to stop.</span>
              <button className="primary" onClick={() => window.llmflow.approvePlan(activeRunId)}>Approve</button>
              <button className="reject" onClick={() => window.llmflow.rejectPlan(activeRunId, 'Rejected by user')}>Reject</button>
            </div>
          )}
          {flowView
            ? <FlowEditor
                flow={flow}
                selectedNode={selectedNode}
                onSelect={setSelectedNode}
                onChangeFlow={changeFlow}
                readOnly={Boolean(flow.builtin)}
              />
            : snapshot
              ? <FlowCanvas snapshot={snapshot} selectedNode={selectedNode} onSelect={setSelectedNode} />
              : (
                <div className="empty-state">
                  <span className="section-label">Nothing selected</span>
                  Enter a prompt and run the pipeline,<br />or pick a flow to edit its graph.
                </div>
              )}
        </main>

        {flowView
          ? <FlowInspector
              flow={flow}
              selectedNode={selectedNode}
              models={models}
              onChangeData={changeNodeData}
              onDeleteNode={deleteNode}
              readOnly={Boolean(flow.builtin)}
            />
          : snapshot && <Inspector snapshot={snapshot} selectedNode={selectedNode} />}
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
