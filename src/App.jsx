import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FlowCanvas, { FlowEditor } from './FlowCanvas.jsx';
import Inspector, { FlowInspector } from './Inspector.jsx';
import Settings from './Settings.jsx';
import NodesPage from './NodesPage.jsx';
import { resolveFlow } from './flowTypes.js';
import { layoutPositions } from './flowLayout.js';

function setTheme(mode) { // 'light' | 'dark'
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('llmflow-theme', mode); } catch {}
  // Keep the native window controls in step with the custom title bar.
  window.llmflow?.setTitleBarTheme?.(mode);
}

let nodeSeq = 0;
function freshNodeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${(nodeSeq++).toString(36)}`;
}

// One mental model (GOALS.md): a Node Library of reusable AI templates, and
// workflows composed from them on the canvas. Renderer is a pure view over
// file state pushed from the main process: run snapshots (read-only), flow
// definitions (editable, autosaved), node templates (edited on the Nodes
// page). One engine, one run entry: the run panel on the right.
export default function App() {
  const [runIds, setRunIds] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNodesPage, setShowNodesPage] = useState(false);
  const [theme, setThemeState] = useState(
    () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  );

  // Node Library (templates) — full definitions for resolution + palette.
  const [templates, setTemplates] = useState([]);

  // Flow-builder state.
  const [flowsList, setFlowsList] = useState([]);
  const [activeFlowId, setActiveFlowId] = useState(null);
  const [flow, setFlow] = useState(null);
  const [flowSaved, setFlowSaved] = useState(true);
  const [flowLint, setFlowLint] = useState(null); // { ok, errors, warnings } for the open flow
  const [models, setModels] = useState([]);
  const flowRef = useRef(null);
  const saveTimer = useRef(null);

  // Unified run entry (the run panel): workflow dropdown + user input.
  const [runFlowId, setRunFlowId] = useState('');
  const [runInput, setRunInput] = useState('');
  const [busy, setBusy] = useState(false);

  // Undo/redo over flow edits. Bursts of changes (a node drag emits one per
  // frame) coalesce into a single history entry via the time gate.
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const lastHistoryPush = useRef(0);
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });

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
    const list = await window.llmflow.listFlows();
    setFlowsList(list);
    // Keep the run panel pointed at a real workflow (default pipeline first).
    setRunFlowId(prev => list.some(f => f.id === prev) ? prev : (list[0]?.id ?? ''));
    return list;
  }, []);
  const refreshTemplates = useCallback(async () => {
    setTemplates(await window.llmflow.listNodeTemplates());
  }, []);

  useEffect(() => { refreshRuns(); refreshFlows(); refreshTemplates(); },
    [refreshRuns, refreshFlows, refreshTemplates]);

  // Worker defaults + model options for the node editor's worker pickers.
  useEffect(() => {
    window.llmflow.getSettings().then(s => {
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
  // Every save re-lints the stored flow (schema + semantic rules over the
  // *.flow.yaml source of truth) to drive the validity badge in the toolbar.
  const refreshLint = useCallback(async id => {
    if (!id) { setFlowLint(null); return; }
    try { setFlowLint(await window.llmflow.lintFlow(id)); }
    catch { setFlowLint(null); }
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (flowRef.current) {
        await window.llmflow.saveFlow(flowRef.current);
        setFlowSaved(true);
        refreshFlows();
        refreshLint(flowRef.current.id);
      }
    }
  }, [refreshFlows, refreshLint]);

  const schedulePersist = useCallback(next => {
    flowRef.current = next;
    setFlowSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;
      await window.llmflow.saveFlow(flowRef.current);
      setFlowSaved(true);
      refreshFlows(); // name may have changed
      refreshLint(flowRef.current?.id);
    }, 500);
  }, [refreshFlows, refreshLint]);

  const changeFlow = useCallback(updater => {
    setFlow(prev => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (next === prev) return next;
      const now = Date.now();
      if (now - lastHistoryPush.current > 400) {
        undoStack.current.push(prev);
        if (undoStack.current.length > 100) undoStack.current.shift();
      }
      lastHistoryPush.current = now;
      redoStack.current = [];
      setHistorySize({ undo: undoStack.current.length, redo: 0 });
      schedulePersist(next);
      return next;
    });
  }, [schedulePersist]);

  const resetHistory = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    lastHistoryPush.current = 0;
    setHistorySize({ undo: 0, redo: 0 });
  }, []);

  const undo = useCallback(() => {
    const cur = flowRef.current;
    if (!cur || !undoStack.current.length) return;
    const target = undoStack.current.pop();
    redoStack.current.push(cur);
    lastHistoryPush.current = 0; // next edit starts a fresh history entry
    setHistorySize({ undo: undoStack.current.length, redo: redoStack.current.length });
    schedulePersist(target);
    setFlow(target);
    setSelectedNode(sel => sel && target.nodes.some(n => n.id === sel) ? sel : null);
  }, [schedulePersist]);

  const redo = useCallback(() => {
    const cur = flowRef.current;
    if (!cur || !redoStack.current.length) return;
    const target = redoStack.current.pop();
    undoStack.current.push(cur);
    lastHistoryPush.current = 0;
    setHistorySize({ undo: undoStack.current.length, redo: redoStack.current.length });
    schedulePersist(target);
    setFlow(target);
    setSelectedNode(sel => sel && target.nodes.some(n => n.id === sel) ? sel : null);
  }, [schedulePersist]);

  const openFlow = useCallback(async id => {
    await flushSave();
    const f = await window.llmflow.loadFlow(id);
    flowRef.current = f;
    setFlow(f);
    setFlowSaved(true);
    setActiveFlowId(id);
    setActiveRunId(null);
    setShowNodesPage(false);
    setSelectedNode(null);
    setRunFlowId(id); // browsing a flow points the run panel at it
    resetHistory();
    refreshLint(id);
  }, [flushSave, resetHistory, refreshLint]);

  // Undo/redo shortcuts while editing a flow (skip when typing in a field so
  // native text undo keeps working).
  useEffect(() => {
    const onKey = e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const openRun = useCallback(async id => {
    await flushSave();
    setActiveFlowId(null);
    setFlow(null);
    setShowNodesPage(false);
    setActiveRunId(id);
    setSelectedNode(null);
  }, [flushSave]);

  const openNodesPage = useCallback(async () => {
    await flushSave();
    setActiveFlowId(null);
    setFlow(null);
    setActiveRunId(null);
    setSelectedNode(null);
    setShowNodesPage(true);
  }, [flushSave]);

  const newFlow = async () => {
    const f = await window.llmflow.newFlow();
    await refreshFlows();
    await openFlow(f.id);
  };

  const duplicateFlow = async () => {
    if (!flow) return;
    await flushSave();
    const fresh = await window.llmflow.newFlow();
    const copy = { ...structuredClone(flow), id: fresh.id, name: `${flow.name} (copy)` };
    await window.llmflow.saveFlow(copy);
    await refreshFlows();
    await openFlow(fresh.id);
  };

  const deleteFlow = async () => {
    if (!flow) return;
    if (!window.confirm(`Delete flow "${flow.name}"?`)) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await window.llmflow.deleteFlow(flow.id);
    flowRef.current = null;
    setFlow(null);
    setActiveFlowId(null);
    setSelectedNode(null);
    resetHistory();
    refreshFlows();
  };

  const autoLayout = () => changeFlow(f => {
    const pos = layoutPositions(f);
    return { ...f, nodes: f.nodes.map(n => ({ ...n, position: pos.get(n.id) ?? n.position })) };
  });

  // Structural nodes: every runnable workflow starts from a User Input node
  // and ends in an Output node. The Orchestrator is the third built-in — an
  // AI container that creates and runs its own task nodes at run time.
  const addStructuralNode = type => {
    changeFlow(f => {
      const n = f.nodes.length;
      const id = freshNodeId(type);
      setSelectedNode(id);
      return {
        ...f,
        nodes: [...f.nodes, {
          id, type,
          kind: type === 'orchestrator' ? 'ai' : 'user',
          position: { x: 280, y: 40 + (n % 6) * 90 },
          data: type === 'orchestrator' ? { title: 'Orchestrator' } : {}
        }]
      };
    });
  };

  // Drop a Node Library template onto the canvas as a fresh instance.
  // Overrides start empty: the node inherits the template until edited.
  const addTemplateNode = templateId => {
    changeFlow(f => {
      const n = f.nodes.length;
      const id = freshNodeId(templateId);
      setSelectedNode(id);
      return {
        ...f,
        nodes: [...f.nodes, {
          id, templateId,
          position: { x: 280, y: 40 + (n % 6) * 90 },
          overrides: {}
        }]
      };
    });
  };

  // Legacy raw nodes (aiStep/agentTask) still edit through data.
  const changeNodeData = (nodeId, patch) => {
    changeFlow(f => ({
      ...f,
      nodes: f.nodes.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)
    }));
  };

  // Template instances edit through overrides; undefined values remove the
  // override (revert to the template default). Saved in this workflow only.
  const changeNodeOverrides = (nodeId, patch) => {
    changeFlow(f => ({
      ...f,
      nodes: f.nodes.map(n => {
        if (n.id !== nodeId) return n;
        const overrides = { ...n.overrides };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete overrides[k];
          else overrides[k] = v;
        }
        return { ...n, overrides };
      })
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

  // The one run entry: selected workflow + user input -> User Input node.
  const startRun = async () => {
    if (!runFlowId || busy) return;
    setBusy(true);
    try {
      await flushSave();
      const runId = await window.llmflow.runFlow(runFlowId, runInput.trim());
      setRunInput('');
      await openRun(runId);
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  const stage = snapshot?.meta?.stage;
  const flowView = Boolean(activeFlowId && flow && !showNodesPage);
  const runView = Boolean(activeRunId && !flowView && !showNodesPage);

  // Display copy of the edited flow with template defaults merged in.
  const resolvedFlow = useMemo(
    () => flow ? resolveFlow(flow, templates) : null,
    [flow, templates]
  );

  const crumb = showNodesPage ? ['Nodes'] :
    flowView ? ['Flows', flow.name] :
    activeRunId ? ['Runs', activeRunId] : ['Flows'];

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">◆</div>
          <span className="brand-name">LLM Flow</span>
        </div>
        {flowView
          ? <span className="titlebar-doc mono">{flow.name}</span>
          : showNodesPage
            ? <span className="titlebar-doc mono">Node Library</span>
            : activeRunId && <span className="titlebar-doc mono">{activeRunId}</span>}
      </div>

      <header className="toolbar">
        <nav className="breadcrumb">
          <span className="crumb-dim">{crumb[0]}</span>
          {crumb[1] && <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{crumb[1]}</span>
          </>}
        </nav>
        {runView && stage && <span className="stage-chip">{stage.replace(/_/g, ' ')}</span>}
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
                {f.id === 'default-pipeline' && <span className="node-kind kind-user">default</span>}
              </div>
            ))}
            {flowsList.length === 0 && <div className="muted">No flows yet.</div>}
          </div>

          <div className="sidebar-section">
            <div className="section-row">
              <span className="section-label">Node Library</span>
              <button
                className={'ghost mini' + (showNodesPage ? ' active' : '')}
                onClick={openNodesPage}
              >
                {templates.length} templates →
              </button>
            </div>
          </div>

          <div className="sidebar-section" style={{ paddingBottom: 8 }}>
            <span className="section-label">Runs</span>
          </div>
          <div className="run-list">
            {[...runIds].reverse().map(id => (
              <div
                key={id}
                className={'run-item' + (id === activeRunId && runView ? ' active' : '')}
                onClick={() => openRun(id)}
              >
                {id}
              </div>
            ))}
            {runIds.length === 0 && <div className="muted">No runs yet.</div>}
          </div>
          {runView && (
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
              <input
                className="flow-name mono"
                value={flow.name}
                onChange={e => changeFlow(f => ({ ...f, name: e.target.value }))}
                aria-label="Flow name"
              />
              <div className="palette">
                <button className="palette-btn" onClick={() => addStructuralNode('input')} title="Add a User Input node — the run panel input lands here">
                  <span className="palette-icon">✎</span>User Input
                </button>
                <button className="palette-btn" onClick={() => addStructuralNode('output')} title="Add an Output node — collects upstream results">
                  <span className="palette-icon">◎</span>Output
                </button>
                <button className="palette-btn" onClick={() => addStructuralNode('orchestrator')} title="Add an Orchestrator — plans autonomously and creates & runs task nodes inside its box, no human intervention">
                  <span className="palette-icon">▦</span>Orchestrator
                </button>
                {templates.map(t => (
                  <button
                    key={t.id}
                    className="palette-btn"
                    onClick={() => addTemplateNode(t.id)}
                    title={`${t.name}: ${t.description || 'Node Library template'}`}
                  >
                    <span className="palette-icon">{t.icon || '✦'}</span>{t.name}
                  </button>
                ))}
              </div>
              <div className="toolbar-spacer" />
              <button className="ghost mini" onClick={undo} disabled={historySize.undo === 0} title="Undo (Ctrl+Z)">↩ Undo</button>
              <button className="ghost mini" onClick={redo} disabled={historySize.redo === 0} title="Redo (Ctrl+Y)">↪ Redo</button>
              <button className="ghost mini" onClick={autoLayout} title="Arrange nodes into dependency layers">Auto-layout</button>
              <button className="ghost mini" onClick={duplicateFlow} title="Duplicate this workflow">Duplicate</button>
              {flowLint && (flowLint.errors.length + flowLint.warnings.length > 0 ? (
                <span
                  className={'lint-badge' + (flowLint.ok ? ' warn' : ' error')}
                  title={[...flowLint.errors, ...flowLint.warnings].map(f => `[${f.rule}] ${f.message}`).join('\n')}
                >
                  {flowLint.ok
                    ? `⚠ ${flowLint.warnings.length} warning${flowLint.warnings.length === 1 ? '' : 's'}`
                    : `✕ ${flowLint.errors.length} error${flowLint.errors.length === 1 ? '' : 's'}`}
                </span>
              ) : (
                <span className="lint-badge ok" title="Flow passes all lint rules">✓ Valid</span>
              ))}
              <span className={'save-dot' + (flowSaved ? ' saved' : '')}>{flowSaved ? 'Saved' : 'Saving…'}</span>
              <button className="reject" onClick={deleteFlow}>Delete flow</button>
            </div>
          )}
          {runView && stage === 'awaiting_approval' && (
            <div className="approval-bar">
              <span className="section-label">Approval gate</span>
              <span>Review the work so far, then approve to continue or reject to stop.</span>
              <button className="primary" onClick={() => window.llmflow.approvePlan(activeRunId)}>Approve</button>
              <button className="reject" onClick={() => window.llmflow.rejectPlan(activeRunId, 'Rejected by user')}>Reject</button>
            </div>
          )}
          {showNodesPage
            ? <NodesPage templates={templates} models={models} onChanged={refreshTemplates} />
            : flowView
              ? <FlowEditor
                  flow={flow}
                  resolved={resolvedFlow}
                  selectedNode={selectedNode}
                  onSelect={setSelectedNode}
                  onChangeFlow={changeFlow}
                />
              : snapshot
                ? <FlowCanvas snapshot={snapshot} selectedNode={selectedNode} onSelect={setSelectedNode} />
                : (
                  <div className="empty-state">
                    <span className="section-label">Nothing selected</span>
                    Pick a workflow, type your request, run it —<br />or select a flow to edit its graph.
                  </div>
                )}
        </main>

        <div className="right-col">
          <div className="run-panel">
            <span className="section-label">Run a workflow</span>
            <select
              value={runFlowId}
              onChange={e => setRunFlowId(e.target.value)}
              aria-label="Workflow to run"
            >
              {flowsList.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <textarea
              placeholder="Type what you want done — this becomes the User Input node…"
              value={runInput}
              onChange={e => setRunInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startRun(); }}
            />
            <button className="primary" onClick={startRun} disabled={busy || !runFlowId}>
              {busy ? 'Starting…' : 'Run'}<kbd className="shortcut">⌘↵</kbd>
            </button>
          </div>

          {flowView
            ? <FlowInspector
                flow={flow}
                selectedNode={selectedNode}
                models={models}
                templates={templates}
                onChangeData={changeNodeData}
                onChangeOverrides={changeNodeOverrides}
                onDeleteNode={deleteNode}
              />
            : snapshot && runView
              ? <Inspector snapshot={snapshot} selectedNode={selectedNode} />
              : (
                <aside className="inspector">
                  <div className="inspector-body">
                    <section>
                      <h3>LLM Flow</h3>
                      <pre>{'Pick a workflow, type your request, run it.\n\nWorkflows are built from Node Library templates on the canvas; every run is a folder of plain files you can open.'}</pre>
                    </section>
                  </div>
                </aside>
              )}
        </div>
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
