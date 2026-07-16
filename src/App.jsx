import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FlowCanvas, { FlowEditor } from './FlowCanvas.jsx';
import Inspector, { FlowInspector } from './Inspector.jsx';
import Settings from './Settings.jsx';
import NodesPage from './NodesPage.jsx';
import FlowYamlEditor from './FlowYamlEditor.jsx';
import { resolveFlow } from './flowTypes.js';
import { layoutPositions } from './flowLayout.js';
import { mergeSnapshot } from '../core/snapshotDiff.js';

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

// --- Activity rail: refined line icons in the app's geometric language.
// Stroke-based, currentColor, so they tint to --accent when active and inherit
// the theme everywhere else. No emoji — they'd break the Slate & Sage feel. ---
const RailIcon = {
  // Flows — a small workflow graph (one node branching to two)
  flows: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.3" /><circle cx="6" cy="18.5" r="2.3" /><circle cx="18" cy="18.5" r="2.3" />
      <path d="M12 7.3v3.2M12 10.5 6.9 16.4M12 10.5l5.1 5.9" />
    </svg>
  ),
  // Library — a grid of template tiles
  library: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.6" /><rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" /><rect x="13" y="13" width="7" height="7" rx="1.6" />
    </svg>
  ),
  // Runs — run history (clock with a back-arrow)
  runs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.3A9 9 0 1 1 3 12" /><path d="M3.2 4v4.3h4.3" /><path d="M12 7.6V12l3 1.8" />
    </svg>
  ),
  // Settings — a gear (utility, foot of the rail)
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
};

// The three primary sections, in rail order. Each is a self-contained mode
// with its own explorer list + remembered selection (Ctrl+1/2/3).
const NAV = [
  { key: 'flows', label: 'Flows', hint: 'Flows  (Ctrl+1)' },
  { key: 'library', label: 'Library', hint: 'Node Library  (Ctrl+2)' },
  { key: 'runs', label: 'Runs', hint: 'Runs  (Ctrl+3)' }
];

// One mental model (GOALS.md): a Node Library of reusable AI templates, and
// workflows composed from them on the canvas. Renderer is a pure view over
// file state pushed from the main process: run snapshots (read-only), flow
// definitions (editable, autosaved), node templates (edited on the Nodes
// page). One engine, one run entry: the run panel on the right.
export default function App() {
  const [runIds, setRunIds] = useState([]);
  const [activeRunId, setActiveRunId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  // Mirror of `snapshot` for the incremental-update handler to read without a
  // stale closure: it needs the currently-viewed run + rev to decide whether an
  // incoming patch applies and lines up (see onRunUpdate below).
  const snapRef = useRef(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
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
  const [flowViewMode, setFlowViewMode] = useState('canvas'); // 'canvas' | 'yaml'
  const flowRef = useRef(null);
  const saveTimer = useRef(null);

  // Unified run entry (the run panel): workflow dropdown + user input.
  const [runFlowId, setRunFlowId] = useState('');
  const [runInput, setRunInput] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState(''); // bound target project folder (optional)
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false); // continuing an interrupted run

  // Primary navigation. The active section drives which explorer list shows and
  // which document the main area renders; each section keeps its own selection
  // (activeFlowId / activeRunId / selectedTemplateId) so switching sections and
  // coming back is lossless.
  const [activeActivity, setActiveActivity] = useState('flows'); // 'flows' | 'library' | 'runs'
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);

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

  // Keep snapRef in step with the rendered snapshot so the update handler reads
  // a fresh baseline (pushes are ≥80ms apart, so this is settled between them).
  useEffect(() => { snapRef.current = snapshot; }, [snapshot]);

  // Incremental run updates (V1 task 5): the main process pushes either a full
  // snapshot (rev/base) or a patch (only the changed slice) with the rev it
  // targets and the base rev it was diffed against. We apply patches on top of
  // the currently-viewed run's snapshot; a base that doesn't line up means we
  // missed one (e.g. a push during a run switch), so we resync from files.
  useEffect(() => {
    return window.llmflow.onRunUpdate(payload => {
      const { runId } = payload;
      refreshRuns();
      setActiveRunId(prev => prev ?? runId);
      const cur = snapRef.current;
      // Only mirror the run being viewed (or the very first one to appear).
      if (cur?.meta?.runId && cur.meta.runId !== runId) return;
      if (payload.full) {
        setSnapshot({ ...payload.full, rev: payload.rev });
        return;
      }
      // A patch with no baseline for this run yet: the activeRunId effect will
      // fetch the full snapshot.
      if (!cur || cur.meta?.runId !== runId) return;
      if (payload.base !== cur.rev) {
        window.llmflow.getSnapshot(runId).then(s => {
          if (snapRef.current?.meta?.runId === runId) setSnapshot(s);
        });
        return;
      }
      setSnapshot({ ...mergeSnapshot(cur, payload.patch), rev: payload.rev });
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

  // Used by the YAML editor after a manual save-from-yaml succeeds.
  const reloadCurrentFlow = useCallback(async () => {
    if (!activeFlowId) return;
    const f = await window.llmflow.loadFlow(activeFlowId);
    flowRef.current = f;
    setFlow(f);
    setFlowSaved(true);
    refreshLint(activeFlowId);
    // keep selected if the node still exists
    setSelectedNode(sel => sel && f.nodes.some(n => n.id === sel) ? sel : null);
  }, [activeFlowId, refreshLint]);

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
    setSelectedNode(null);
    setRunFlowId(id); // browsing a flow points the run panel at it
    setFlowViewMode('canvas');
    setActiveActivity('flows');
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

  // Keep the Library selection pointed at a real template: default to the first
  // one, and recover if the selected template is deleted elsewhere.
  useEffect(() => {
    if (selectedTemplateId && templates.some(t => t.id === selectedTemplateId)) return;
    setSelectedTemplateId(templates[0]?.id ?? null);
  }, [templates, selectedTemplateId]);

  const openRun = useCallback(async id => {
    await flushSave();
    setActiveRunId(id);
    setSelectedNode(null);
    setActiveActivity('runs');
  }, [flushSave]);

  // Switch section via the rail / shortcuts. Selections persist per section;
  // we only drop the canvas node selection, which is section-specific.
  const goActivity = useCallback(async key => {
    await flushSave();
    setSelectedNode(null);
    setActiveActivity(key);
  }, [flushSave]);

  const openTemplate = useCallback(async id => {
    await flushSave();
    setSelectedTemplateId(id);
    setSelectedNode(null);
    setActiveActivity('library');
  }, [flushSave]);

  const newTemplate = useCallback(async () => {
    const tpl = await window.llmflow.newNodeTemplate();
    await refreshTemplates();
    setSelectedTemplateId(tpl.id);
    setActiveActivity('library');
  }, [refreshTemplates]);

  // Section shortcuts: Ctrl/Cmd + 1/2/3 jump between Flows / Library / Runs.
  useEffect(() => {
    const onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const idx = { '1': 0, '2': 1, '3': 2 }[e.key];
      if (idx === undefined) return;
      e.preventDefault();
      goActivity(NAV[idx].key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goActivity]);

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
      const runId = await window.llmflow.runFlow(runFlowId, runInput.trim(), workspaceDir || null);
      setRunInput('');
      await openRun(runId);
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  // Continue a run the app died in the middle of. The main process keeps the
  // completed nodes and picks the walk up from there (V1 task 7).
  const resumeRun = async () => {
    if (!activeRunId || resuming) return;
    setResuming(true);
    try { await window.llmflow.resumeRun(activeRunId); }
    finally { setResuming(false); }
  };

  const stage = snapshot?.meta?.stage;
  const flowView = activeActivity === 'flows' && Boolean(activeFlowId && flow);
  const runView = activeActivity === 'runs' && Boolean(activeRunId);
  const libraryView = activeActivity === 'library';
  const selectedTemplate = templates.find(t => t.id === selectedTemplateId) ?? null;

  // Display copy of the edited flow with template defaults merged in.
  const resolvedFlow = useMemo(
    () => flow ? resolveFlow(flow, templates) : null,
    [flow, templates]
  );

  const activeIndex = NAV.findIndex(n => n.key === activeActivity);
  const crumb =
    libraryView ? ['Library', selectedTemplate?.name].filter(Boolean) :
    activeActivity === 'runs' ? (activeRunId ? ['Runs', activeRunId] : ['Runs']) :
    flowView ? ['Flows', flow.name] : ['Flows'];

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <div className="brand-mark">◆</div>
          <span className="brand-name">LLM Flow</span>
        </div>
        {flowView
          ? <span className="titlebar-doc mono">{flow.name}</span>
          : libraryView
            ? <span className="titlebar-doc mono">{selectedTemplate?.name ?? 'Node Library'}</span>
            : runView && <span className="titlebar-doc mono">{activeRunId}</span>}
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
        <button type="button" className="theme-toggle" onClick={toggleTheme} title="Toggle appearance">
          <span>{theme === 'light' ? '☾' : '☀'}</span>
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
      </header>

      <div className="app-body">
        {/* Primary navigation rail — the one persistent way between sections */}
        <nav className="activity-bar" aria-label="Primary">
          <div className="activity-group">
            <div
              className="activity-indicator"
              data-hidden={activeIndex < 0 ? 'true' : 'false'}
              style={{ '--active-index': Math.max(activeIndex, 0) }}
              aria-hidden="true"
            />
            {NAV.map(item => (
              <button
                key={item.key}
                type="button"
                className={'activity-btn' + (activeActivity === item.key ? ' active' : '')}
                aria-current={activeActivity === item.key ? 'page' : undefined}
                onClick={() => goActivity(item.key)}
                title={item.hint}
              >
                {RailIcon[item.key]}
                <span className="activity-label">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="activity-spacer" />
          <button
            type="button"
            className="activity-btn utility"
            onClick={() => setShowSettings(true)}
            title="Settings — providers & models"
          >
            {RailIcon.settings}
            <span className="activity-label">Settings</span>
          </button>
        </nav>

        <aside className="sidebar">
          {activeActivity === 'flows' && (
            <>
              <div className="sidebar-section">
                <div className="section-row">
                  <span className="section-label">Flows</span>
                  <button className="ghost mini" onClick={newFlow}>＋ New</button>
                </div>
              </div>
              <div className="explorer-list">
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
            </>
          )}

          {activeActivity === 'library' && (
            <>
              <div className="sidebar-section">
                <div className="section-row">
                  <span className="section-label">Node Library</span>
                  <button className="ghost mini" onClick={newTemplate}>＋ New</button>
                </div>
              </div>
              <div className="explorer-list">
                {templates.map(t => (
                  <div
                    key={t.id}
                    className={'run-item flow-item' + (t.id === selectedTemplateId ? ' active' : '')}
                    onClick={() => openTemplate(t.id)}
                  >
                    <span className="palette-icon">{t.icon || '✦'}</span>
                    <span className="flow-item-name">{t.name}</span>
                    {t.category && <span className="node-kind kind-ai">{t.category}</span>}
                  </div>
                ))}
                {templates.length === 0 && <div className="muted">No node templates yet.</div>}
              </div>
            </>
          )}

          {activeActivity === 'runs' && (
            <>
              <div className="sidebar-section" style={{ paddingBottom: 8 }}>
                <span className="section-label">Runs</span>
              </div>
              <div className="explorer-list">
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
                  {snapshot?.meta?.workspace && (
                    <div className="workspace-binding" title={snapshot.meta.workspace}>
                      <span className="section-label">Workspace</span>
                      <span className="mono workspace-path">{snapshot.meta.workspace}</span>
                    </div>
                  )}
                  <button className="ghost" onClick={() => window.llmflow.openRunFolder(activeRunId)}>
                    Open run folder
                  </button>
                  {snapshot?.meta?.workspace && (
                    <button className="ghost" onClick={() => window.llmflow.openWorkspace(activeRunId)}>
                      Open workspace
                    </button>
                  )}
                </div>
              )}
            </>
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
              <div className="view-switch" role="tablist" aria-label="Editor view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={flowViewMode === 'canvas'}
                  className={'view-btn' + (flowViewMode === 'canvas' ? ' active' : '')}
                  onClick={() => setFlowViewMode('canvas')}
                  title="Visual flow editor"
                >
                  <span className="view-btn-glyph" aria-hidden>▦</span>Canvas
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={flowViewMode === 'split'}
                  className={'view-btn' + (flowViewMode === 'split' ? ' active' : '')}
                  onClick={() => setFlowViewMode('split')}
                  title="Canvas and YAML side by side"
                >
                  <span className="view-btn-glyph" aria-hidden>◫</span>Split
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={flowViewMode === 'yaml'}
                  className={'view-btn' + (flowViewMode === 'yaml' ? ' active' : '')}
                  onClick={() => setFlowViewMode('yaml')}
                  title="View and edit the raw .flow.yaml definition"
                >
                  <span className="view-btn-glyph" aria-hidden>{'{ }'}</span>YAML
                </button>
              </div>
              {flowViewMode !== 'yaml' && (
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
              )}
              <div className="toolbar-spacer" />
              {flowViewMode !== 'yaml' && (
                <>
                  <button className="ghost mini" onClick={undo} disabled={historySize.undo === 0} title="Undo (Ctrl+Z)">↩ Undo</button>
                  <button className="ghost mini" onClick={redo} disabled={historySize.redo === 0} title="Redo (Ctrl+Y)">↪ Redo</button>
                  <button className="ghost mini" onClick={autoLayout} title="Arrange nodes into dependency layers">Auto-layout</button>
                  <button className="ghost mini" onClick={duplicateFlow} title="Duplicate this workflow">Duplicate</button>
                </>
              )}
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
          {runView && snapshot?.meta?.interrupted && (
            <div className="approval-bar">
              <span className="section-label">Interrupted</span>
              <span>
                The app closed while this run was working. Its finished steps are kept —
                resuming continues from where it stopped.
              </span>
              <button className="primary" onClick={resumeRun} disabled={resuming}>
                {resuming ? 'Resuming…' : 'Resume'}
              </button>
            </div>
          )}
          {runView && stage === 'awaiting_approval' && (
            <div className="approval-bar">
              <span className="section-label">
                {snapshot?.meta?.pendingGateKind === 'tool' ? 'Tool approval' : 'Approval gate'}
              </span>
              {snapshot?.meta?.pendingGateKind === 'tool' && snapshot?.meta?.pendingToolCall
                ? (
                  <span>
                    This node wants to run <span className="mono">{snapshot.meta.pendingToolCall.tool}</span>
                    {snapshot.meta.pendingToolCall.summary
                      ? <> on <span className="mono">{snapshot.meta.pendingToolCall.summary}</span></>
                      : null}. Approve to run it, or reject to abort the task.
                  </span>
                )
                : <span>Review the work so far, then approve to continue or reject to stop.</span>}
              <button className="primary" onClick={() => window.llmflow.approvePlan(activeRunId)}>Approve</button>
              <button className="reject" onClick={() => window.llmflow.rejectPlan(activeRunId, 'Rejected by user')}>Reject</button>
            </div>
          )}
          {libraryView
            ? <NodesPage
                templates={templates}
                selectedId={selectedTemplateId}
                models={models}
                onChanged={refreshTemplates}
                onSelect={setSelectedTemplateId}
              />
            : flowView
              ? (flowViewMode === 'yaml'
                  ? <FlowYamlEditor
                      flow={flow}
                      onApplied={reloadCurrentFlow}
                    />
                  : flowViewMode === 'split'
                    ? <div className="split-view">
                        <div className="split-pane split-canvas">
                          <FlowEditor
                            flow={flow}
                            resolved={resolvedFlow}
                            selectedNode={selectedNode}
                            onSelect={setSelectedNode}
                            onChangeFlow={changeFlow}
                          />
                        </div>
                        <div className="split-gutter" aria-hidden />
                        <div className="split-pane split-yaml">
                          <FlowYamlEditor
                            flow={flow}
                            onApplied={reloadCurrentFlow}
                            embedded
                          />
                        </div>
                      </div>
                    : <FlowEditor
                        flow={flow}
                        resolved={resolvedFlow}
                        selectedNode={selectedNode}
                        onSelect={setSelectedNode}
                        onChangeFlow={changeFlow}
                      />)
              : runView && snapshot
                ? <FlowCanvas snapshot={snapshot} selectedNode={selectedNode} onSelect={setSelectedNode} />
                : activeActivity === 'runs'
                  ? (
                    <div className="empty-state">
                      <span className="section-label">Runs</span>
                      {activeRunId
                        ? <>Loading run <span className="mono">{activeRunId}</span>…</>
                        : <>Select a run to inspect its graph —<br />or start one from the panel on the right.</>}
                    </div>
                  )
                  : (
                    <div className="empty-state">
                      <span className="section-label">Flows</span>
                      Select a flow to edit its graph —<br />or press ＋ New to start one.
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
            <div className="workspace-row">
              <button
                className="ghost"
                onClick={async () => {
                  const dir = await window.llmflow.pickWorkspace();
                  if (dir) setWorkspaceDir(dir);
                }}
                title="Bind this run to a real project folder"
              >
                {workspaceDir ? 'Change workspace…' : 'Choose workspace…'}
              </button>
              {workspaceDir
                ? (
                  <span className="workspace-path" title={workspaceDir}>
                    <span className="mono">{workspaceDir.split(/[\\/]/).pop()}</span>
                    <button className="link" onClick={() => setWorkspaceDir('')} title="Clear workspace">✕</button>
                  </span>
                )
                : <span className="muted">No workspace (files stay in the run folder)</span>}
            </div>
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
