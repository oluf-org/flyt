import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import FlowCanvas, { FlowEditor, freshNodeId } from './FlowCanvas.jsx';
import Inspector, { FlowInspector } from './Inspector.jsx';
import Settings from './Settings.jsx';
import NodesPage from './NodesPage.jsx';
import NodePicker from './NodePicker.jsx';
import FlowYamlEditor from './FlowYamlEditor.jsx';
import LiveStream from './LiveStream.jsx';
import RunBar from './RunBar.jsx';
import RunResult from './RunResult.jsx';
import RunsList from './RunsList.jsx';
import NodeFocus from './NodeFocus.jsx';
import { isTerminal } from './runProgress.js';
import { resolveFlow, namedFlow, UNTITLED_FLOW, isStructuralNode } from './flowTypes.js';
import { comparePair } from './compareRun.js';
import { layoutPositions, shrinkOrchBox } from './flowLayout.js';
import { mergeSnapshot } from '../core/snapshotDiff.js';
import { runDocument } from './runDocument.js';
import { foldReplay, replaySnapshot } from './runReplay.js';
import ReplayStrip from './ReplayStrip.jsx';
import TabStrip, { NewTabPage } from './TabStrip.jsx';
import TabDeck from './TabDeck.jsx';
import Lander from './Lander.jsx';
import ChatRun from './ChatRun.jsx';
import CompareRun from './CompareRun.jsx';
import ApprovalModePicker from './ApprovalModePicker.jsx';
import LaunchInputs from './LaunchInputs.jsx';
import ConfigsPanel, { slugConfigId } from './ConfigsPanel.jsx';
import RematchPicker from './RematchPicker.jsx';
import Logo from './Logo.jsx';
import { LEGACY_STORAGE_PREFIX } from '../core/brand.js';

const THEME_KEY = 'flyt-theme';

function setTheme(mode) { // 'light' | 'dark'
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem(THEME_KEY, mode); } catch {}
  // Keep the native window controls in step with the custom title bar.
  window.flyt?.setTitleBarTheme?.(mode);
}

// D29 storage-key migration. Only the theme is worth carrying over: index.html
// reads it before first paint, so losing it means a visible light/dark flash on
// the first launch after updating. Column widths and the node-menu tip are
// deliberately NOT migrated — the cost of resetting them is one drag and one
// tooltip, which is cheaper than three more migration paths to maintain.
// Runs once on mount; the old key is removed so this is genuinely one-shot.
function migrateThemeKey() {
  try {
    if (localStorage.getItem(THEME_KEY)) return;
    const legacy = localStorage.getItem(`${LEGACY_STORAGE_PREFIX}-theme`);
    if (!legacy) return;
    localStorage.setItem(THEME_KEY, legacy);
    localStorage.removeItem(`${LEGACY_STORAGE_PREFIX}-theme`);
  } catch { /* storage blocked: the bootstrap default is fine */ }
}
// Module scope, not an effect: index.html has already applied the theme from
// whichever key it found, so this only needs to settle the storage before the
// first toggle writes to it.
migrateThemeKey();

// The engine puts the whole reason in an IPC rejection's message; the wrapper
// around it ("Error invoking remote method …") is noise. The older call sites
// inline this same strip; new run-control paths share it.
const ipcMessage = err => String(err?.message ?? err)
  .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

// Crossfade a whole-tree swap (theme flip, section change) via the View
// Transitions API instead of transitioning every element's colours on every
// mutation. flushSync forces the React re-render to land inside the transition
// so the API captures the correct "after" frame. Falls back to an instant swap
// where the API is missing or motion is reduced.
function withViewTransition(update) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !document.startViewTransition) { update(); return; }
  document.startViewTransition(() => flushSync(update));
}

// Column widths (left explorer / right run panel) are user-resizable and
// remembered. Drag the edge handle; double-click snaps back to the default.
function useResizableColumn(storageKey, initial, { min, max }, dir) {
  const clamp = w => Math.min(max, Math.max(min, Math.round(w)));
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return Number.isFinite(v) && v > 0 ? clamp(v) : initial;
    } catch { return initial; }
  });
  const start = useCallback(e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    document.body.classList.add('col-resizing');
    const onMove = ev => setWidth(clamp(startW + (ev.clientX - startX) * dir));
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('col-resizing');
      setWidth(w => {
        try { localStorage.setItem(storageKey, String(w)); } catch {}
        return w;
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [width, storageKey, dir]);
  return [width, start, useCallback(() => {
    setWidth(initial);
    try { localStorage.removeItem(storageKey); } catch {}
  }, [initial, storageKey])];
}

// The drag handle between two columns. `dir` is +1 when dragging right grows
// the column (left sidebar) and -1 when dragging left grows it (right panel).
function ColumnResizer({ onStart, onReset, label }) {
  return (
    <div
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={onStart}
      onDoubleClick={onReset}
    />
  );
}

// --- Activity rail: refined line icons in the app's geometric language.
// Stroke-based, currentColor, so they tint to --accent when active and inherit
// the theme everywhere else. No emoji — they'd break the Slate & Sage feel. ---
const RailIcon = {
  // Home — the lander. A single node radiating three short rays: the sigil
  // burst distilled to a rail glyph, in the same 1.6-stroke geometry.
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 5.4V8M12 16v2.6M5.4 12H8M16 12h2.6M7.6 7.6 9.4 9.4M14.6 14.6l1.8 1.8M16.4 7.6 14.6 9.4M9.4 14.6l-1.8 1.8" />
    </svg>
  ),
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
  { key: 'home', label: 'Home', hint: 'Home  (Ctrl+1)' },
  { key: 'flows', label: 'Flows', hint: 'Flows  (Ctrl+2)' },
  { key: 'library', label: 'Library', hint: 'Node Library  (Ctrl+3)' },
  { key: 'runs', label: 'Runs', hint: 'Runs  (Ctrl+4)' }
];

// The run's plaintext mirror (flare 7): the same run as a typeset dossier you
// can copy straight into an issue or PR. A pure projection of the snapshot —
// runDocument does the typesetting; this just frames it and offers Copy.
function RunMirror({ snapshot }) {
  const doc = useMemo(() => runDocument(snapshot), [snapshot]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(doc);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the <pre> is still selectable */ }
  };
  return (
    <div className="mirror-wrap">
      <div className="mirror-toolbar">
        <span className="section-label">Document</span>
        <span className="mirror-hint">A pasteable dossier of this run — copy it into an issue or PR.</span>
        <button className="ghost mini" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <pre className="mirror">{doc}</pre>
    </div>
  );
}

// One mental model (GOALS.md): a Node Library of reusable AI templates, and
// workflows composed from them on the canvas. Renderer is a pure view over
// file state pushed from the main process: run snapshots (read-only), flow
// definitions (editable, autosaved), node templates (edited on the Nodes
// page). One engine, one run entry: the run panel on the right.
export default function App() {
  const [runs, setRuns] = useState([]); // summaries (id, name, createdAt, stage…), newest first
  const [activeRunId, setActiveRunId] = useState(null);
  // CHAT-RUN: the run attached to the home chat surface. When set and the
  // section is 'home', home renders the chat thread + unfolding flow instead
  // of the lander. chatSeed holds the submitted prompt for the instant before
  // the first snapshot lands.
  const [chatRunId, setChatRunId] = useState(null);
  const [chatSeed, setChatSeed] = useState('');
  // COMPARE (MODES-COMPARE T11/T12): a compare launch fires two ordinary runs
  // from one prompt. `compareRunIds` = [a, b] takes over the home surface (the
  // split-view CompareRun) when set; `compareOn` is the composer's A/B toggle
  // and `compareB` slot B's flow+mode selection — both persisted per tab.
  const [compareOn, setCompareOn] = useState(false);
  const [compareB, setCompareB] = useState(null); // { flowId, modeId } | null
  const [compareRunIds, setCompareRunIds] = useState(null); // [runIdA, runIdB] | null
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
  const [saveState, setSaveState] = useState('saved'); // 'saved' | 'saving' | 'failed'
  const [flowLint, setFlowLint] = useState(null); // { ok, errors, warnings } for the open flow
  const [models, setModels] = useState([]);
  const [flowViewMode, setFlowViewMode] = useState('canvas'); // 'canvas' | 'yaml'
  const [pickerOpen, setPickerOpen] = useState(false); // the add-node panel over the canvas
  // CONFIGS-COMPARE P1: the Configs panel (anchored at the modes chip) and the
  // Inspector's config edit target (null = editing the Flow, today's behavior).
  const [configsOpen, setConfigsOpen] = useState(false);
  const [configEditId, setConfigEditId] = useState(null);
  // Per-flow config summaries with diff badges (flow:listConfigs), for the
  // composer/compare pickers and the run panel's mode dropdown.
  const [configsByFlow, setConfigsByFlow] = useState({});
  // CONFIGS-COMPARE P2: this project's comparison records (newest first — the
  // Runs list ⚖ badge and the reopen path read them) and the pending rematch
  // (a finished run about to be re-fired against a picked config).
  const [comparisons, setComparisons] = useState([]);
  const [rematch, setRematch] = useState(null);
  // P3: a judge call is in flight for the open comparison.
  const [judging, setJudging] = useState(false);
  const [runView2, setRunView2] = useState('canvas'); // run view: 'canvas' | 'document'
  // Resizable outer columns (explorer left, run panel right).
  const [leftColW, startLeftResize, resetLeftCol] = useResizableColumn('flyt.col.left', 288, { min: 208, max: 520 }, 1);
  const [rightColW, startRightResize, resetRightCol] = useResizableColumn('flyt.col.right', 372, { min: 300, max: 640 }, -1);
  // Replay scrubber (finished runs): folded frames + where the scrubber sits
  // (null = live/final), and whether it's playing.
  const [replayFrames, setReplayFrames] = useState(null);
  const [replayIndex, setReplayIndex] = useState(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const flowRef = useRef(null);
  const saveTimer = useRef(null);
  const landerInputRef = useRef(null); // lander composer, for Ctrl+1 focus

  // Unified run entry (the run panel): workflow dropdown + user input.
  const [runFlowId, setRunFlowId] = useState('');
  // MODES-COMPARE T4: the picked mode of the selected flow (null = default).
  // Persisted per tab beside runFlowId; layered as a launch override at start.
  const [runModeId, setRunModeId] = useState(null);
  // MODES-COMPARE T10: exposed run-input values, per flow: { flowId: { nodeId:
  // { field: value } } }. The current flow's bucket IS the override map sent at
  // start; last-used values persist per flow per tab.
  const [runInputs, setRunInputs] = useState({});
  // The exposed-input spec of the selected flow (fetched, not persisted).
  const [launchInputSpec, setLaunchInputSpec] = useState([]);
  const [runInput, setRunInput] = useState('');
  const [workspaceDir, setWorkspaceDir] = useState(''); // bound target project folder (optional)
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false); // continuing an interrupted run
  // Explicitly reopened the run form while watching a live run (see `watching`).
  const [newRunOpen, setNewRunOpen] = useState(false);
  // --- Run mode (RUN-CONTROL) ---
  // Follow-execution camera (default ON per session; the canvas remounts on
  // tab switch, so it lives here), the Node Focus panel's target, a transient
  // toast for run-action rejections, and the one-time newcomer tip.
  const [followRun, setFollowRun] = useState(true);
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [runToast, setRunToast] = useState(null);
  const [coachTip, setCoachTip] = useState(false);

  // Primary navigation. The active section drives which explorer list shows and
  // which document the main area renders; each section keeps its own selection
  // (activeFlowId / activeRunId / selectedTemplateId) so switching sections and
  // coming back is lossless.
  const [activeActivity, setActiveActivity] = useState('home'); // 'home' | 'flows' | 'library' | 'runs'
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);

  // Undo/redo over flow edits. Bursts of changes (a node drag emits one per
  // frame) coalesce into a single history entry via the time gate.
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const lastHistoryPush = useRef(0);
  const [historySize, setHistorySize] = useState({ undo: 0, redo: 0 });

  // --- Project tabs (D22): one tab per open project; single renderer (T6).
  // A tab switch swaps the per-tab state bundle (T8) — everything above that
  // belongs to ONE project's view. Theme, Settings, models, templates and the
  // flows list stay global (T2).
  const [tabs, setTabs] = useState([]); // [{ id, folder, name, live, state }]
  const [activeTab, setActiveTab] = useState(null); // project id ('default' = scratch)
  // Ref mirror for handlers that must know the current tab without re-binding
  // (push filtering, the Ctrl+Tab stream).
  const activeTabRef = useRef(null);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const [tabLive, setTabLive] = useState({}); // id -> count of live runs (strip dots)
  const [newTabOpen, setNewTabOpen] = useState(false); // the ＋ page (T15)
  const [recents, setRecents] = useState([]);
  const [tabNotice, setTabNotice] = useState(null); // restore-time dropped-folder notice (T17)
  const bundles = useRef(new Map()); // id -> captured bundle for tabs left this session
  const mruRef = useRef([]); // tab ids, most recently used first (deck order)
  const [deck, setDeck] = useState(null); // { order: [id…], index } while Ctrl+Tab is held
  const deckRef = useRef(null);
  useEffect(() => { deckRef.current = deck; }, [deck]);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    withViewTransition(() => { setTheme(next); setThemeState(next); });
  };

  // Sync the native title-bar overlay to the boot theme once on mount.
  useEffect(() => { window.flyt?.setTitleBarTheme?.(theme); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a different run always lands on the canvas, not the last run's doc,
  // and clears any replay state from the previous run. Bundle restores are the
  // exception: a tab comes back exactly as it was left (T8), so the flag set by
  // applyBundle skips this reset once.
  useEffect(() => {
    if (restoringRef.current) { restoringRef.current = false; return; }
    setRunView2('canvas');
    setReplayFrames(null); setReplayIndex(null); setReplayPlaying(false);
  }, [activeRunId]);

  // For a FINISHED flow run, fetch its log once and fold it into replay frames.
  // Live runs get null (the scrubber is meaningless while it's still moving).
  useEffect(() => {
    const stage = snapshot?.meta?.stage;
    const flow = snapshot?.flow;
    if (activeActivity === 'runs' && activeRunId && flow && isTerminal(stage) && window.flyt?.readRunLog) {
      let cancelled = false;
      window.flyt.readRunLog(activeTabRef.current, activeRunId)
        .then(log => { if (!cancelled) setReplayFrames(foldReplay(log, flow)); })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    setReplayFrames(null);
  }, [activeActivity, activeRunId, snapshot?.meta?.stage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback advances one frame at a time in event order; stops at the end.
  useEffect(() => {
    if (!replayPlaying || !replayFrames?.length) return;
    const id = setInterval(() => {
      setReplayIndex(i => {
        const next = (i == null ? 0 : i) + 1;
        if (next > replayFrames.length - 1) { setReplayPlaying(false); return replayFrames.length - 1; }
        return next;
      });
    }, 380);
    return () => clearInterval(id);
  }, [replayPlaying, replayFrames]);

  const toggleReplayPlay = () => {
    if (replayPlaying) { setReplayPlaying(false); return; }
    setReplayIndex(i => (i == null || i >= (replayFrames?.length ?? 1) - 1) ? 0 : i);
    setReplayPlaying(true);
  };

  const refreshRuns = useCallback(async () => {
    // Runs are per-project (T2): list the active tab's, and drop the result if
    // the user switched tabs while the read was in flight. Projectless (L6):
    // no tab, no runs — never call the run store with a null project id.
    const pid = activeTabRef.current;
    if (pid == null) { setRuns([]); setComparisons([]); return; }
    const list = await window.flyt.listRuns(pid);
    if (activeTabRef.current === pid) setRuns(list);
    // Comparison records (P2) ride the same refresh — they change only when a
    // comparison is created or a run is deleted, both of which refresh runs.
    window.flyt.listComparisons?.(pid)
      .then(recs => { if (activeTabRef.current === pid) setComparisons(recs ?? []); })
      .catch(() => {});
  }, []);
  // Listing runs re-reads every run's meta + prompt from disk, and run updates
  // arrive as often as the token stream flushes (250ms) — that would re-read the
  // whole runs/ directory several times a second while a run is live. The list
  // only shows stage-level facts, so coalesce the storm into one trailing read.
  const runsRefreshTimer = useRef(null);
  const refreshRunsSoon = useCallback(() => {
    if (runsRefreshTimer.current) return;
    runsRefreshTimer.current = setTimeout(() => {
      runsRefreshTimer.current = null;
      refreshRuns();
    }, 400);
  }, [refreshRuns]);
  useEffect(() => () => clearTimeout(runsRefreshTimer.current), []);
  const refreshFlows = useCallback(async () => {
    const list = await window.flyt.listFlows();
    setFlowsList(list);
    // Keep the run panel pointed at a real workflow (default pipeline first).
    setRunFlowId(prev => list.some(f => f.id === prev) ? prev : (list[0]?.id ?? ''));
    // Config badges for the pickers (P1) ride the same refresh — a flow save
    // is the only thing that changes them, and every save re-runs this.
    window.flyt.listConfigs?.().then(setConfigsByFlow).catch(() => {});
    return list;
  }, []);
  const refreshTemplates = useCallback(async () => {
    setTemplates(await window.flyt.listNodeTemplates());
  }, []);

  // Global catalogs (flows, templates) load once; per-project data (runs, the
  // restored selection) loads in the project boot effect further down, after
  // the tab machinery is defined.
  useEffect(() => { refreshFlows(); refreshTemplates(); },
    [refreshFlows, refreshTemplates]);

  // Worker defaults + model options for the node editor's worker pickers, plus
  // whether a key exists (drives the lander's no-key hint). Re-read when Settings
  // closes so adding a key clears the hint without a restart.
  const [hasKey, setHasKey] = useState(false);
  // Claude-subscription usage notice (SUBSCRIPTION-AUTH-GUIDE): when runs can
  // draw on the user's Claude plan, the lander says so next to the composer.
  const [claudeSubActive, setClaudeSubActive] = useState(false);
  const [activeModels, setActiveModels] = useState([]);
  // Tool-call approval (APPROVAL-MODES §3). The saved default seeds the chip;
  // changing it in the chatbox saves it back, so the picker beside Run and the
  // Settings control are two views of one value — with the per-run capture
  // happening main-side at start, from whatever the chip shows at that moment.
  const [approvalMode, setApprovalMode] = useState('ask');
  const [safetyModel, setSafetyModel] = useState(null);
  const refreshSettings = useCallback(() => {
    window.flyt.getSettings().then(s => {
      setHasKey(Boolean(s.hasKey));
      setClaudeSubActive(Boolean(s.claudeSubscriptionActive));
      setActiveModels(s.activeModels ?? []);
      setApprovalMode(s.approvalMode ?? 'ask');
      setSafetyModel(s.resolvedSafetyModel ?? null);
      // The openrouter live catalog only feeds the legacy free-text fallback
      // in worker pickers; the curated active-models list is the primary offer.
      if (s.providers?.openrouter?.hasKey) window.flyt.listModels('openrouter').then(setModels).catch(() => setModels([]));
    });
  }, []);
  useEffect(() => { refreshSettings(); }, [refreshSettings]);

  // Keep snapRef in step with the rendered snapshot so the update handler reads
  // a fresh baseline (pushes are ≥80ms apart, so this is settled between them).
  useEffect(() => { snapRef.current = snapshot; }, [snapshot]);

  // Incremental run updates (V1 task 5): the main process pushes either a full
  // snapshot (rev/base) or a patch (only the changed slice) with the rev it
  // targets and the base rev it was diffed against. We apply patches on top of
  // the currently-viewed run's snapshot; a base that doesn't line up means we
  // missed one (e.g. a push during a run switch), so we resync from files.
  useEffect(() => {
    return window.flyt.onRunUpdate(payload => {
      const { runId } = payload;
      // Scoped pushes (T7): a background project's run must never patch the
      // foreground tab's snapshot. Same guard shape as the rev matching below.
      if (payload.projectId && payload.projectId !== activeTabRef.current) return;
      refreshRunsSoon();
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
        window.flyt.getSnapshot(activeTabRef.current, runId).then(s => {
          // Ignore a resync that lost a race: another fetch (or the patch
          // stream) may have already carried this run past the rev we asked
          // for, and applying it would rewind the view.
          const now = snapRef.current;
          if (now?.meta?.runId === runId && (now.rev ?? 0) <= s.rev) setSnapshot(s);
        });
        return;
      }
      setSnapshot({ ...mergeSnapshot(cur, payload.patch), rev: payload.rev });
    });
  }, [refreshRunsSoon]);

  useEffect(() => {
    if (!activeRunId) { setSnapshot(null); return; }
    // Switching runs faster than a fetch resolves must not land the old run's
    // snapshot on the new view. activeTab is a dependency on purpose: a tab
    // switch resyncs the (background-stale) snapshot from files even when the
    // restored bundle carried one (T9: background projects don't stream).
    let cancelled = false;
    window.flyt.getSnapshot(activeTab, activeRunId).then(s => { if (!cancelled) setSnapshot(s); });
    return () => { cancelled = true; };
  }, [activeRunId, activeTab]);

  // --- Flow persistence: debounced autosave, flushed on view switches ---
  // Every save re-lints the stored flow (schema + semantic rules over the
  // *.flow.yaml source of truth) to drive the validity badge in the toolbar.
  const refreshLint = useCallback(async id => {
    if (!id) { setFlowLint(null); return; }
    try { setFlowLint(await window.flyt.lintFlow(id)); }
    catch { setFlowLint(null); }
  }, []);

  // The one write path. Every navigation awaits flushSave, so a rejection here
  // would wedge the app rather than just this document: keep failures inside,
  // and say so in the badge instead of claiming a save that never landed.
  const persist = useCallback(async flow => {
    try {
      await window.flyt.saveFlow(namedFlow(flow));
      setSaveState('saved');
      refreshFlows(); // name may have changed
      refreshLint(flow.id);
    } catch (e) {
      console.error('Saving the flow failed:', e);
      setSaveState('failed');
    }
  }, [refreshFlows, refreshLint]);

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (flowRef.current) await persist(flowRef.current);
    }
  }, [persist]);

  const schedulePersist = useCallback(next => {
    flowRef.current = next;
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      persist(flowRef.current);
    }, 500);
  }, [persist]);

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
    const f = await window.flyt.loadFlow(activeFlowId);
    flowRef.current = f;
    setFlow(f);
    setSaveState('saved');
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
    const f = await window.flyt.loadFlow(id);
    flowRef.current = f;
    setFlow(f);
    setSaveState('saved');
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
    // The unfold (§5): crossfade the lander/section into the live run in one
    // whole-tree view transition (reduced-motion → instant, handled by the
    // helper). Same helper section changes already use, so opening a run from
    // the lander and from the Runs list read consistently.
    withViewTransition(() => {
      restoringRef.current = false; // a user-driven open always resets the run view
      setActiveRunId(id);
      setSelectedNode(null);
      setActiveActivity('runs');
      setNewRunOpen(false); // a fresh run is for watching, not for starting another
    });
  }, [flushSave]);

  const renameRun = useCallback(async (id, name) => {
    await window.flyt.renameRun(activeTabRef.current, id, name);
    await refreshRuns();
  }, [refreshRuns]);

  const deleteRun = useCallback(async id => {
    try {
      await window.flyt.deleteRun(activeTabRef.current, id);
    } catch (err) {
      // The main process refuses while the run is still executing; that reason
      // is the whole message, so show it rather than the IPC wrapper around it.
      window.alert(String(err?.message ?? err)
        .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
      return;
    }
    // The run being watched can be the one deleted: drop the view with it.
    setActiveRunId(prev => (prev === id ? null : prev));
    setChatRunId(prev => (prev === id ? null : prev));
    setSnapshot(prev => (prev?.meta?.runId === id ? null : prev));
    await refreshRuns();
  }, [refreshRuns]);

  // Switch section via the rail / shortcuts. Selections persist per section;
  // we only drop the canvas node selection, which is section-specific.
  const goActivity = useCallback(async key => {
    await flushSave();
    withViewTransition(() => { setSelectedNode(null); setActiveActivity(key); });
  }, [flushSave]);

  const openTemplate = useCallback(async id => {
    await flushSave();
    withViewTransition(() => {
      setSelectedTemplateId(id);
      setSelectedNode(null);
      setActiveActivity('library');
    });
  }, [flushSave]);

  const newTemplate = useCallback(async () => {
    const tpl = await window.flyt.newNodeTemplate();
    await refreshTemplates();
    withViewTransition(() => { setSelectedTemplateId(tpl.id); setActiveActivity('library'); });
  }, [refreshTemplates]);

  // ===================== Project tabs (D22) =====================
  // The per-tab bundle (T8): everything one project's view holds. Captured on
  // leave, applied on return; a slim projection (ids + view modes, no
  // snapshots/undo) goes to the main process so restore survives restarts
  // (T17). These are plain functions, not useCallbacks — they run on tab
  // events, not hot paths, and must always see current state.
  const restoringRef = useRef(false); // lets the run-open reset effect skip bundle restores

  const captureBundle = () => ({
    activeActivity, activeFlowId, flow: flowRef.current, flowLint,
    activeRunId, snapshot, selectedNode, chatRunId,
    compareOn, compareB, compareRunIds,
    undo: [...undoStack.current], redo: [...redoStack.current],
    runFlowId, runModeId, runInputs, runInput, workspaceDir, newRunOpen,
    flowViewMode, runView2, runs
  });

  const slimOf = b => ({
    activeActivity: b.activeActivity,
    activeFlowId: b.activeFlowId,
    activeRunId: b.activeRunId,
    chatRunId: b.chatRunId,
    compareOn: b.compareOn,
    compareB: b.compareB,
    compareRunIds: b.compareRunIds,
    runFlowId: b.runFlowId,
    runModeId: b.runModeId,
    runInputs: b.runInputs,
    runInput: b.runInput,
    workspaceDir: b.workspaceDir,
    flowViewMode: b.flowViewMode,
    runView2: b.runView2
  });

  const applyBundle = b => {
    restoringRef.current = true;
    setActiveActivity(b.activeActivity ?? 'home');
    setActiveFlowId(b.activeFlowId ?? null);
    flowRef.current = b.flow ?? null;
    setFlow(b.flow ?? null);
    setSaveState('saved'); // leave always flushes, so the incoming tab is saved by construction
    setFlowLint(b.flowLint ?? null);
    setActiveRunId(b.activeRunId ?? null);
    setChatRunId(b.chatRunId ?? null);
    setCompareOn(b.compareOn ?? false);
    setCompareB(b.compareB ?? null);
    setCompareRunIds(comparePair(b.compareRunIds));
    setChatSeed('');
    setSnapshot(b.snapshot ?? null);
    setSelectedNode(b.selectedNode ?? null);
    undoStack.current = b.undo ?? [];
    redoStack.current = b.redo ?? [];
    lastHistoryPush.current = 0;
    setHistorySize({ undo: undoStack.current.length, redo: redoStack.current.length });
    setRunFlowId(prev => b.runFlowId || prev); // fresh tabs keep the catalog default
    setRunModeId(b.runModeId ?? null);
    setRunInputs(b.runInputs ?? {});
    setRunInput(b.runInput ?? '');
    setWorkspaceDir(b.workspaceDir ?? '');
    setNewRunOpen(b.newRunOpen ?? false);
    setFlowViewMode(b.flowViewMode ?? 'canvas');
    setRunView2(b.runView2 ?? 'canvas');
    setReplayFrames(null); setReplayIndex(null); setReplayPlaying(false);
    setRuns(b.runs ?? []);
    setBusy(false); setResuming(false);
  };

  // First visit to a tab this session: rebuild the bundle from the slim state
  // the main process kept for it (T17 restore depth, best-effort).
  const restoreSlim = async (slim = {}) => {
    const b = {
      activeActivity: slim.activeActivity, activeRunId: slim.activeRunId ?? null,
      chatRunId: slim.chatRunId ?? null,
      compareOn: slim.compareOn ?? false,
      compareB: slim.compareB ?? null,
      compareRunIds: slim.compareRunIds ?? null,
      runFlowId: slim.runFlowId, runModeId: slim.runModeId ?? null,
      runInputs: slim.runInputs ?? {}, runInput: slim.runInput,
      workspaceDir: slim.workspaceDir,
      flowViewMode: slim.flowViewMode, runView2: slim.runView2,
      runs: []
    };
    if (slim.activeFlowId) {
      try {
        b.flow = await window.flyt.loadFlow(slim.activeFlowId);
        b.activeFlowId = slim.activeFlowId;
      } catch { /* flow deleted since — open the section empty */ }
    }
    applyBundle(b);
    refreshRuns();
    if (b.activeFlowId) refreshLint(b.activeFlowId);
  };

  // Leaving a tab: flush the debounced autosave (exactly as section switches
  // do), then capture. The slim copy goes to settings.json via the registry.
  const leaveCurrentTab = async () => {
    const cur = activeTabRef.current;
    if (cur == null) return;
    await flushSave();
    const bundle = captureBundle();
    bundles.current.set(cur, bundle);
    window.flyt.saveProjectState?.(cur, slimOf(bundle));
  };

  const enterTab = async (id, savedState) => {
    activeTabRef.current = id;
    // Projectless (L6): no tab to enter — reset to a clean home so the lander
    // takes over with no stale run/flow from the tab we just left.
    if (id == null) {
      withViewTransition(() => { setActiveTab(null); applyBundle({}); });
      window.flyt.projectRecents?.().then(r => setRecents(r ?? []));
      return;
    }
    mruRef.current = [id, ...mruRef.current.filter(x => x !== id)];
    const target = bundles.current.get(id);
    withViewTransition(() => {
      setActiveTab(id);
      if (target) applyBundle(target);
    });
    if (target) refreshRuns(); // resync what background execution changed (T9)
    else await restoreSlim(savedState ?? {});
  };

  const switchTab = async id => {
    if (!id || id === activeTabRef.current || !tabs.some(t => t.id === id)) return;
    await leaveCurrentTab();
    await enterTab(id, tabs.find(t => t.id === id)?.state);
    const payload = await window.flyt.activateProject?.(id);
    if (payload) setTabs(payload.tabs);
  };

  // Open a folder as a tab (null = the scratch tab). Same folder twice focuses
  // the existing tab (T5) — the main process decides, we follow.
  const openProjectTab = async folder => {
    await leaveCurrentTab();
    let payload;
    try {
      payload = await window.flyt.openProject(folder);
    } catch (err) {
      window.alert(String(err?.message ?? err)
        .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
      return;
    }
    setTabs(payload.tabs);
    setNewTabOpen(false);
    if (payload.opened !== activeTabRef.current) {
      await enterTab(payload.opened, payload.tabs.find(t => t.id === payload.opened)?.state);
    }
  };

  // Closing a tab keeps its runs executing (T13) — main owns the engine; we
  // just drop the view. No confirm: nothing is lost.
  const closeTab = async id => {
    if (id === activeTabRef.current) await leaveCurrentTab();
    const payload = await window.flyt.closeProject(id);
    bundles.current.delete(id);
    mruRef.current = mruRef.current.filter(x => x !== id);
    setTabs(payload.tabs);
    setTabLive(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (payload.active !== activeTabRef.current) {
      await enterTab(payload.active, payload.tabs.find(t => t.id === payload.active)?.state);
    }
  };

  const reorderTabs = async ids => {
    setTabs(prev => [...prev].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)));
    const payload = await window.flyt.reorderProjects?.(ids);
    if (payload) setTabs(payload.tabs);
  };

  // Rename a project from the tab strip (LANDER-PLAN §6). Display-name only —
  // the appdata directory keeps its creation slug, so run paths and the tab id
  // never churn. Main persists the override so it survives restarts (T17).
  const renameTab = async (id, name) => {
    const payload = await window.flyt.renameProject?.(id, name);
    if (payload) setTabs(payload.tabs);
  };

  // "Move to folder…" (Phase 6): adopt an appdata project into a real repo. Main
  // migrates the files and swaps the tab in place; here we re-key the per-tab
  // bundle + MRU from the old id to the new one, and resync if it was active.
  const adoptTab = async id => {
    const dir = await window.flyt.pickProjectFolder?.();
    if (!dir) return;
    let payload;
    try {
      payload = await window.flyt.adoptProject?.(id, dir);
    } catch (err) {
      window.alert(String(err?.message ?? err)
        .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
      return;
    }
    if (!payload) return;
    const { oldId, opened } = payload;
    if (bundles.current.has(oldId)) {
      bundles.current.set(opened, bundles.current.get(oldId));
      bundles.current.delete(oldId);
    }
    mruRef.current = mruRef.current.map(x => (x === oldId ? opened : x));
    setTabs(payload.tabs);
    if (activeTabRef.current === oldId) {
      activeTabRef.current = opened;
      setActiveTab(opened);
      refreshRuns(); // runs moved with the same ids — re-read from the new store
    }
  };

  const revealTab = id => { window.flyt.revealProject?.(id); };

  const openNewTabPage = async () => {
    setRecents(await window.flyt.projectRecents?.() ?? []);
    setNewTabOpen(true);
  };

  // Boot: adopt the restored session (T17) and enter the active tab.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      const p = await window.flyt.listProjects?.();
      if (!p) { // bridge without projects (stale mock): single scratch tab
        activeTabRef.current = 'default';
        setTabs([{ id: 'default', folder: null, name: 'Scratch', live: 0, state: {} }]);
        setActiveTab('default');
        mruRef.current = ['default'];
        refreshRuns();
        return;
      }
      setTabs(p.tabs);
      setTabLive(Object.fromEntries(p.tabs.map(t => [t.id, t.live])));
      if (p.dropped?.length) {
        setTabNotice(`Couldn't reopen ${p.dropped.length === 1 ? 'a tab' : `${p.dropped.length} tabs`} — folder missing: ${p.dropped.join(', ')}. Recents still lists ${p.dropped.length === 1 ? 'it' : 'them'}.`);
      }
      activeTabRef.current = p.active;
      setActiveTab(p.active);
      // Projectless first launch (L5/L6): no active tab. The initial state is
      // already a clean home, so the lander shows; just load recents for its
      // recent-projects strip.
      if (p.active == null) {
        mruRef.current = p.tabs.map(t => t.id);
        setRecents(await window.flyt.projectRecents?.() ?? []);
        return;
      }
      mruRef.current = [p.active, ...p.tabs.map(t => t.id).filter(x => x !== p.active)];
      await restoreSlim(p.tabs.find(t => t.id === p.active)?.state ?? {});
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live-run indicators for every tab, active or not (T9's featherweight push).
  useEffect(() => window.flyt.onProjectActivity?.(({ projectId, live }) => {
    setTabLive(prev => ({ ...prev, [projectId]: live.length }));
  }), []);

  // --- Ctrl+Tab (T14 + 4.2): quick tap = instant MRU flip; holding ≥150ms
  // deals the deck; further presses advance; releasing Ctrl commits; Esc
  // cancels. Events arrive from the main process (before-input-event), so a
  // focused canvas or text field can never eat them. Refs, not state, so the
  // one subscription sees current values.
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const switchTabRef = useRef(switchTab);
  switchTabRef.current = switchTab;
  const holdTimer = useRef(null);
  const pendingSteps = useRef(0);

  useEffect(() => {
    const openDeck = steps => {
      const openIds = tabsRef.current.map(t => t.id);
      const order = [
        ...mruRef.current.filter(id => openIds.includes(id)),
        ...openIds.filter(id => !mruRef.current.includes(id))
      ];
      if (order.length < 2) return;
      const index = ((steps % order.length) + order.length) % order.length;
      setDeck({ order, index });
    };
    const handle = ({ kind, shift }) => {
      if (tabsRef.current.length < 2) return;
      if (kind === 'cycle') {
        const d = deckRef.current;
        if (d) {
          const len = d.order.length;
          setDeck({ ...d, index: (d.index + (shift ? -1 : 1) + len) % len });
        } else if (holdTimer.current) {
          // A second press while the hold timer runs: the user is cycling, not
          // tapping — deal the deck now, advanced by the accumulated steps.
          clearTimeout(holdTimer.current);
          holdTimer.current = null;
          pendingSteps.current += shift ? -1 : 1;
          openDeck(pendingSteps.current);
        } else {
          pendingSteps.current = shift ? -1 : 1;
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null;
            openDeck(pendingSteps.current);
          }, 150);
        }
      } else if (kind === 'release') {
        if (holdTimer.current) {
          // Quick tap: flip to the most recently used other tab.
          clearTimeout(holdTimer.current);
          holdTimer.current = null;
          const openIds = tabsRef.current.map(t => t.id);
          const mru = mruRef.current.filter(id => openIds.includes(id));
          if (mru[1]) switchTabRef.current(mru[1]);
        } else if (deckRef.current) {
          const d = deckRef.current;
          setDeck(null);
          switchTabRef.current(d.order[d.index]);
        }
      }
    };
    // Two sources, one state machine. The main process intercepts Ctrl+Tab in
    // before-input-event (T14) and preventDefaults it, so when that path fires
    // the DOM never sees the key; the window capture listeners are the
    // fallback for input that bypasses the native pipeline (and make the
    // feature testable). A duplicated 'release' is a no-op by construction.
    const unsub = window.flyt.onTabsKey?.(handle);
    const onKeyDown = e => {
      if (e.key === 'Tab' && e.ctrlKey) {
        e.preventDefault();
        handle({ kind: 'cycle', shift: e.shiftKey });
      }
    };
    const onKeyUp = e => {
      if (e.key === 'Control') handle({ kind: 'release' });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      unsub?.();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  // Section shortcuts: Ctrl/Cmd + 1/2/3 jump between Flows / Library / Runs.
  useEffect(() => {
    const onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const idx = { '1': 0, '2': 1, '3': 2, '4': 3 }[e.key];
      if (idx === undefined) return;
      e.preventDefault();
      // Ctrl+1 goes Home; when already Home, it focuses the composer instead —
      // the fast path back to typing. (A fresh switch autofocuses on mount.)
      if (NAV[idx].key === 'home' && activeActivity === 'home') {
        landerInputRef.current?.focus();
        return;
      }
      goActivity(NAV[idx].key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goActivity, activeActivity]);

  const newFlow = async () => {
    const f = await window.flyt.newFlow();
    await refreshFlows();
    await openFlow(f.id);
  };

  const duplicateFlow = async () => {
    if (!flow) return;
    await flushSave();
    const fresh = await window.flyt.newFlow();
    const copy = { ...structuredClone(flow), id: fresh.id, name: `${flow.name} (copy)` };
    await window.flyt.saveFlow(copy);
    await refreshFlows();
    await openFlow(fresh.id);
  };

  const deleteFlow = async () => {
    if (!flow) return;
    if (!window.confirm(`Delete flow "${flow.name}"?`)) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await window.flyt.deleteFlow(flow.id);
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

  // The node picker's click-to-add (drag-to-canvas drops are handled by the
  // editor itself). The panel stays open so several nodes can be added in a row.
  const addFromPicker = spec => {
    if (spec?.kind === 'orchestrator') addStructuralNode('orchestrator');
    else if (spec?.kind === 'template') addTemplateNode(spec.templateId);
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
    changeFlow(f => {
      // The pinned structural nodes (input/output) never leave the canvas.
      if (isStructuralNode(f.nodes.find(n => n.id === nodeId))) return f;
      // Deleting an orchestrator deletes the nodes inside its box too.
      const drop = new Set([nodeId]);
      for (const n of f.nodes) if (n.parentId && drop.has(n.parentId)) drop.add(n.id);
      return {
        ...f,
        nodes: f.nodes.filter(n => !drop.has(n.id)),
        edges: f.edges.filter(e => !drop.has(e.source) && !drop.has(e.target))
      };
    });
    setSelectedNode(null);
  };

  // Take a node out of its orchestrator box (inspector "Remove from box"):
  // the position becomes absolute, the box's ownership wire goes with it,
  // and the box shrinks back around whatever remains inside.
  const detachNode = nodeId => {
    changeFlow(f => {
      const node = f.nodes.find(n => n.id === nodeId);
      if (!node?.parentId) return f;
      const parent = f.nodes.find(n => n.id === node.parentId);
      if (!parent) return f;
      const abs = {
        x: (parent.position?.x ?? 0) + (node.position?.x ?? 0),
        y: (parent.position?.y ?? 0) + (node.position?.y ?? 0)
      };
      const nodes = f.nodes.map(n => n.id === nodeId
        ? (() => { const { parentId, ...rest } = n; return { ...rest, position: abs }; })()
        : n);
      return {
        ...f,
        nodes: nodes.map(n => n.id === parent.id
          ? { ...n, data: { ...n.data, box: shrinkOrchBox(nodes.filter(c => c.parentId === n.id)) } }
          : n),
        edges: f.edges.filter(e => !(e.source === parent.id && e.target === nodeId))
      };
    });
  };

  // --- Configs (CONFIGS-COMPARE P1) ------------------------------------------
  // A config IS a mode in the open flow's modes: block. Panel edits ride the
  // same changeFlow path as canvas edits — undoable, debounce-autosaved,
  // re-linted — so the Configs panel and the YAML editor stay two views of the
  // one source of truth.

  // Inspector config editing: patch one node's entry in a config's override
  // map; undefined values remove the field, an emptied node entry drops out.
  const changeConfigOverrides = useCallback((modeId, nodeId, patch) => {
    changeFlow(f => {
      const mode = f.modes?.[modeId];
      if (!mode) return f;
      const entry = { ...(mode.overrides?.[nodeId] ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete entry[k];
        else entry[k] = v;
      }
      const overrides = { ...(mode.overrides ?? {}) };
      if (Object.keys(entry).length) overrides[nodeId] = entry;
      else delete overrides[nodeId];
      return { ...f, modes: { ...f.modes, [modeId]: { ...mode, overrides } } };
    });
  }, [changeFlow]);

  // ＋ New config: an empty bundle (same as Default until edited), named by
  // prompt, opened in the Inspector straight away.
  const newConfig = useCallback(() => {
    const f = flowRef.current;
    if (!f) return;
    const name = window.prompt('Name the new config:', 'New config');
    if (name == null) return;
    const base = slugConfigId(name) ?? 'config';
    let id = base;
    for (let n = 2; f.modes?.[id]; n++) id = `${base}-${n}`;
    changeFlow(prev => ({ ...prev, modes: { ...(prev.modes ?? {}), [id]: { name: name.trim() || id, overrides: {} } } }));
    setConfigEditId(id);
    setConfigsOpen(false);
  }, [changeFlow]);

  // Duplicate: copy the full override map under a new id, derivedFrom = the
  // source (lineage metadata only — mirrors flowstore.duplicateConfig).
  const duplicateConfig = useCallback(sourceId => {
    const f = flowRef.current;
    const src = f?.modes?.[sourceId];
    if (!f || !src) return;
    const name = window.prompt('Duplicate config as:', `${src.name ?? sourceId} (copy)`);
    if (name == null) return;
    const base = slugConfigId(name) ?? `${sourceId}-copy`;
    let id = base;
    for (let n = 2; f.modes?.[id]; n++) id = `${base}-${n}`;
    changeFlow(prev => ({
      ...prev,
      modes: {
        ...(prev.modes ?? {}),
        [id]: {
          name: name.trim() || id,
          ...(src.description ? { description: src.description } : {}),
          derivedFrom: sourceId,
          overrides: structuredClone(src.overrides ?? {})
        }
      }
    }));
  }, [changeFlow]);

  // Delete: confirmed while the config is the tab's selected launch target
  // (the selection clears with it); also released as the Inspector's target.
  const deleteConfig = useCallback(modeId => {
    const f = flowRef.current;
    const mode = f?.modes?.[modeId];
    if (!f || !mode) return;
    const isLaunchTarget = runFlowId === f.id && runModeId === modeId;
    if (!window.confirm(
      `Delete config "${mode.name || modeId}"?` +
      (isLaunchTarget ? '\n\nIt is the run panel\'s selected launch target — that selection will be cleared.' : '')
    )) return;
    changeFlow(prev => {
      const modes = { ...(prev.modes ?? {}) };
      delete modes[modeId];
      return { ...prev, modes };
    });
    if (isLaunchTarget) setRunModeId(null);
    setConfigEditId(cur => (cur === modeId ? null : cur));
  }, [changeFlow, runFlowId, runModeId]);

  // Run a config: point the run panel at flow+mode and open the form.
  const runConfig = useCallback(modeId => {
    if (!flowRef.current) return;
    setRunFlowId(flowRef.current.id);
    setRunModeId(modeId);
    setNewRunOpen(true);
    setConfigsOpen(false);
  }, []);

  // Edit a config: make it the Inspector's edit target.
  const editConfig = useCallback(modeId => {
    setConfigEditId(modeId);
    setConfigsOpen(false);
  }, []);

  // The Inspector's edit target must always name a config that still exists.
  useEffect(() => {
    if (configEditId && !flow?.modes?.[configEditId]) setConfigEditId(null);
  }, [flow, configEditId]);

  // "Save as config" on a finished run (P1): the run's launchOverrides become
  // a new config on its flow, derivedFrom the run's mode if it had one.
  const saveRunAsConfig = useCallback(async runId => {
    const name = window.prompt('Save this run\'s launch configuration as a config:', 'Saved config');
    if (name == null) return;
    try {
      const res = await window.flyt.promoteRunConfig(activeTabRef.current, runId, name);
      await refreshFlows();
      // If the promoted flow is open in the editor, reload it so the new
      // config shows in the panel/pickers (the debounced saver is idle: the
      // user was watching a run, not editing).
      if (flowRef.current?.id === res.flowId) await reloadCurrentFlow();
      window.alert(`Saved config "${res.mode?.name ?? res.modeId}" on flow "${res.flowId}".`);
    } catch (err) {
      window.alert(ipcMessage(err));
    }
  }, [refreshFlows, reloadCurrentFlow]);

  // Picking a mode in the chatbox both governs the next run and becomes the new
  // saved default — the alternative (a per-run choice that forgets itself) means
  // a user who wants unattended runs re-arms the dangerous mode every time,
  // which is exactly the habit that stops people reading the warning.
  const changeApprovalMode = useCallback(mode => {
    setApprovalMode(mode);
    window.flyt.setSettings({ approvalMode: mode })
      .then(s => setSafetyModel(s.resolvedSafetyModel ?? null))
      .catch(() => {});
  }, []);

  // Pick a workflow (and optionally one of its modes) for the next run. A flow
  // change clears any stale mode, so the mode always belongs to the flow shown.
  const selectRunFlow = useCallback((flowId, modeId = null) => {
    setRunFlowId(flowId);
    setRunModeId(modeId ?? null);
  }, []);

  // Fetch the selected flow's exposed run inputs (T10). Refetched on flow change;
  // the values themselves live in runInputs, keyed per flow so they persist.
  useEffect(() => {
    let live = true;
    if (!runFlowId) { setLaunchInputSpec([]); return; }
    window.flyt.flowLaunchInputs?.(runFlowId)
      .then(spec => { if (live) setLaunchInputSpec(spec ?? []); })
      .catch(() => { if (live) setLaunchInputSpec([]); });
    return () => { live = false; };
  }, [runFlowId]);

  // Set one exposed run-input value into the current flow's bucket. A null value
  // clears the override (back to the mode/node default).
  const setRunInputValue = useCallback((nodeId, field, value) => {
    setRunInputs(prev => {
      const flowBucket = { ...(prev[runFlowId] ?? {}) };
      const nodeBucket = { ...(flowBucket[nodeId] ?? {}) };
      if (value == null || value === '') delete nodeBucket[field];
      else nodeBucket[field] = value;
      if (Object.keys(nodeBucket).length) flowBucket[nodeId] = nodeBucket;
      else delete flowBucket[nodeId];
      return { ...prev, [runFlowId]: flowBucket };
    });
  }, [runFlowId]);

  // The launch payload (MODES-COMPARE): a picked mode + exposed run-input
  // overrides. Null when neither is set — an ordinary default run. Shared by the
  // single-run path and each compare slot.
  const launchForSelection = (modeId, overrides = null) => {
    const hasOverrides = overrides && Object.values(overrides).some(f => f && Object.keys(f).length);
    if (!modeId && !hasOverrides) return null;
    return {
      ...(modeId ? { modeId } : {}),
      ...(hasOverrides ? { overrides } : {})
    };
  };
  const launchFor = () => launchForSelection(runModeId, runInputs[runFlowId] ?? {});

  // Toggle the composer's Compare mode. Turning it on seeds slot B with a
  // distinct config — a different mode of the same flow if one exists, else the
  // same flow (repointed by the user) — so the two slots aren't identical.
  const toggleCompare = useCallback(() => {
    setCompareOn(on => {
      const next = !on;
      if (next) {
        setCompareB(prev => {
          if (prev) return prev;
          const f = flowsList.find(x => x.id === runFlowId);
          const altMode = f?.modes?.find(m => m.id !== runModeId)?.id ?? null;
          return { flowId: runFlowId, modeId: altMode };
        });
      }
      return next;
    });
  }, [flowsList, runFlowId, runModeId]);

  // The one run entry: selected workflow + user input -> User Input node.
  const startRun = async () => {
    if (!runFlowId || busy) return;
    setBusy(true);
    try {
      await flushSave();
      const runId = await window.flyt.runFlow(activeTabRef.current, runFlowId, runInput.trim(), workspaceDir || null, approvalMode, launchFor());
      setRunInput('');
      await openRun(runId);
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  // The lander's front door (LANDER-PLAN.md §5): the composer text becomes the
  // run's User Input on the currently-selected workflow. CHAT-RUN: the view no
  // longer hands off to the Runs section — home becomes the chat surface and
  // the flow unfolds below the message. activeRunId still points at the run so
  // the snapshot stream follows it; opening the run full-screen is one click
  // away in the Runs list.
  const runFromLander = async text => {
    if (!runFlowId || busy || !text.trim()) return;
    setBusy(true);
    try {
      let pid = activeTabRef.current;
      // Projectless (L5): the first prompt auto-creates a project — no folder
      // picker. The slug is derived main-side, atomic with the mkdir; we open
      // the returned tab, then run in it exactly as a bound tab would.
      if (pid == null) {
        const payload = await window.flyt.createProject(text.trim());
        setTabs(payload.tabs);
        pid = payload.opened;
        await enterTab(pid, payload.tabs.find(t => t.id === pid)?.state);
      }
      await flushSave();
      const runId = await window.flyt.runFlow(pid, runFlowId, text.trim(), workspaceDir || null, approvalMode, launchFor());
      setRunInput('');
      withViewTransition(() => {
        setChatSeed(text.trim());
        setChatRunId(runId);
        setActiveRunId(runId);
        setSelectedNode(null);
      });
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  // Compare launch (T11/T12): one prompt fires two ordinary runs — slot A is the
  // composer's flow+mode, slot B the compare picker's — and the home surface
  // switches to the split-view. Same auto-create-project path as runFromLander.
  const runCompareFromLander = async text => {
    if (!runFlowId || busy || !text.trim()) return;
    const slotA = { flowId: runFlowId, modeId: runModeId };
    const slotB = compareB ?? { flowId: runFlowId, modeId: null };
    setBusy(true);
    try {
      let pid = activeTabRef.current;
      if (pid == null) {
        const payload = await window.flyt.createProject(text.trim());
        setTabs(payload.tabs);
        pid = payload.opened;
        await enterTab(pid, payload.tabs.find(t => t.id === pid)?.state);
      }
      await flushSave();
      const prompt = text.trim();
      // Slot inputs aren't exposed in compare mode (the modes carry the config),
      // so each slot's launch is just its mode.
      // P2: mint the comparison id BEFORE the runs start so both run metas
      // carry the group from creation; the record is written once both run
      // ids exist (original = A, compare slot = B).
      const cmp = await window.flyt.beginCompare(pid);
      const launchA = { ...(launchForSelection(slotA.modeId) ?? {}), compareGroup: { id: cmp.id, label: 'A' } };
      const launchB = { ...(launchForSelection(slotB.modeId) ?? {}), compareGroup: { id: cmp.id, label: 'B' } };
      const runIdA = await window.flyt.runFlow(pid, slotA.flowId, prompt, workspaceDir || null, approvalMode, launchA);
      const runIdB = await window.flyt.runFlow(pid, slotB.flowId, prompt, workspaceDir || null, approvalMode, launchB);
      await window.flyt.saveCompare(pid, { id: cmp.id, runIds: [runIdA, runIdB], origin: 'launch' });
      setRunInput('');
      withViewTransition(() => {
        setChatSeed(prompt);
        setCompareRunIds([runIdA, runIdB]);
        setChatRunId(null);
        setActiveRunId(runIdA);
        setSelectedNode(null);
      });
      await refreshRuns();
    } finally {
      setBusy(false);
    }
  };

  // P2: every compare origin (launch / rematch / manual / reopen) lands on the
  // same home-surface switch — the split view replaces the chat, exactly like
  // a launch-compare does.
  const openCompare = async ids => {
    withViewTransition(() => {
      setChatRunId(null);
      setChatSeed('');
      setCompareRunIds(ids);
      setActiveRunId(ids[0]);
      setSelectedNode(null);
      setActiveActivity('home');
    });
    await refreshRuns();
  };

  // Rematch (P2): a finished run's "Compare against…" button. Snapshot the
  // run's launch facts (prompt, workspace, flow, config) and open the picker;
  // the actual re-fire happens in confirmRematch so no run is started before
  // the user has picked a configuration.
  const startRematch = async runId => {
    const pid = activeTabRef.current;
    const s = await window.flyt.getSnapshot(pid, runId).catch(() => null);
    const meta = s?.meta;
    if (!meta?.flowId) return;
    setRematch({
      runId,
      flowId: meta.flowId,
      modeId: meta.modeId ?? null,
      flowName: meta.flowName ?? meta.flowId,
      prompt: s.prompt ?? '',
      workspace: meta.workspace ?? null,
    });
  };

  const confirmRematch = async modeId => {
    const r = rematch;
    setRematch(null);
    if (!r) return;
    const pid = activeTabRef.current;
    try {
      await flushSave();
      // Same shape as a launch-compare: id first, then the run, then the
      // record — original stays pane A, the fresh rematch is pane B.
      const cmp = await window.flyt.beginCompare(pid);
      const runIdB = await window.flyt.runFlow(
        pid, r.flowId, r.prompt, r.workspace || workspaceDir || null, approvalMode,
        { ...(modeId ? { modeId } : {}), compareGroup: { id: cmp.id, label: 'B' } });
      await window.flyt.saveCompare(pid, { id: cmp.id, runIds: [r.runId, runIdB], origin: 'rematch' });
      await openCompare([r.runId, runIdB]);
    } catch (err) {
      window.alert(ipcMessage(err));
    }
  };

  // Manual select-compare (P2): any two existing runs. Their metas get the
  // group stamped retroactively main-side (first stamp wins), so a run can
  // sit in several comparisons without losing its first pairing.
  const compareExistingRuns = async ids => {
    const pid = activeTabRef.current;
    if (pid == null || !Array.isArray(ids) || ids.length !== 2) return;
    try {
      const cmp = await window.flyt.beginCompare(pid);
      await window.flyt.saveCompare(pid, { id: cmp.id, runIds: ids, origin: 'manual' });
      await openCompare(ids);
    } catch (err) {
      window.alert(ipcMessage(err));
    }
  };

  // The Runs list ⚖ badge: reopen a recorded pairing.
  const openComparison = rec => {
    if (Array.isArray(rec?.runIds) && rec.runIds.length === 2) openCompare(rec.runIds);
  };

  // P3: the record for the currently open pair (newest match), and the Judge
  // action itself. Judging refreshes the records so the verdict panel updates
  // in place; an unrecorded pair gets a record main-side (run:judge creates
  // one), which is why the record lookup tolerates null here.
  const activeComparison = compareRunIds
    ? comparisons.find(c => c.runIds?.[0] === compareRunIds[0] && c.runIds?.[1] === compareRunIds[1]) ?? null
    : null;
  const judgeComparison = async () => {
    const ids = compareRunIds;
    const pid = activeTabRef.current;
    if (!ids || pid == null || judging) return;
    setJudging(true);
    try {
      await window.flyt.judgeRuns(pid, ids[0], ids[1], activeComparison?.id ?? null);
      await refreshRuns();
    } catch (err) {
      window.alert(ipcMessage(err));
    } finally {
      setJudging(false);
    }
  };

  // New chat: the conversation surface resets to the lander. The run(s) are
  // untouched — they keep going (or stay finished) in the Runs section.
  const startNewChat = useCallback(() => {
    withViewTransition(() => {
      setChatRunId(null);
      setChatSeed('');
      setCompareRunIds(null);
      setActiveRunId(null);
      setSnapshot(null);
      setSelectedNode(null);
      setFocusNodeId(null);
    });
  }, []);

  // The chat composer speaks follow-up: the engine triages the reply and grows
  // the flow in place (terminal runs only — the composer disables otherwise).
  // Rejections read as a toast over the chat, never an alert.
  const chatFollowUp = useCallback(async text => {
    try {
      await window.flyt.followUpRun(activeTabRef.current, chatRunId, text);
    } catch (err) {
      setRunToast(ipcMessage(err));
    }
  }, [chatRunId]);

  // Answer a run parked at the refiner's awaiting_input gate (MODES-COMPARE T6):
  // a distinct IPC from follow-up — it closes the in-flight question and re-runs
  // the refine node, rather than opening a new turn.
  const chatAnswerInput = useCallback(async text => {
    try {
      await window.flyt.answerInput(activeTabRef.current, chatRunId, text);
    } catch (err) {
      setRunToast(ipcMessage(err));
    }
  }, [chatRunId]);

  // Continue a run the app died in the middle of. The main process keeps the
  // completed nodes and picks the walk up from there (V1 task 7).
  const resumeRun = async () => {
    if (!activeRunId || resuming) return;
    setResuming(true);
    try { await window.flyt.resumeRun(activeTabRef.current, activeRunId); }
    finally { setResuming(false); }
  };

  // --- Run control (RUN-CONTROL): the canvas menu, RunBar and Node Focus all
  // call through here. Rejections surface as a transient toast over the canvas,
  // never an alert; { ok:false, error:'not-live' } resolves read the same way.
  const showRunToast = useCallback(err => setRunToast(ipcMessage(err)), []);
  // The run-control set bound to a given run. The single-run views use the
  // active run's; a compare pane binds its own so the two panes drive
  // independently (RUN-CONTROL + T12).
  const makeRunControl = useCallback(runId => {
    // fn() is invoked inside the try: a missing bridge method throws
    // synchronously, and that deserves the same toast as a rejection.
    const guard = fn => {
      let p;
      try { p = fn(); } catch (e) { showRunToast(e); return Promise.resolve(); }
      return p
        .then(res => {
          if (res && res.ok === false) {
            setRunToast(res.error === 'not-live' ? 'That run is no longer live.' : (res.error ?? 'Run action failed.'));
          }
          return res;
        })
        .catch(e => showRunToast(e));
    };
    return {
      pause: () => guard(() => window.flyt.pauseRun(activeTabRef.current, runId)),
      resume: () => guard(() => window.flyt.resumeRun(activeTabRef.current, runId)),
      stop: () => guard(() => window.flyt.stopRun(activeTabRef.current, runId)),
      restart: (nodeId, guidance) =>
        guard(() => window.flyt.restartNode(activeTabRef.current, runId, nodeId, guidance)),
      // A successful branch launches the fork — switch the view to the new run.
      branch: nodeId =>
        guard(() => window.flyt.branchRun(activeTabRef.current, runId, nodeId))
          .then(async res => {
            if (res?.runId) { await openRun(res.runId); refreshRunsSoon(); }
          }),
      // Summary nodes (B4): summarize resolves { ok, summary } / { ok:false,
      // error } — NOT toasted, the canvas shows a retryable failure card
      // instead. delete/move are fire-and-forget (the snapshot push confirms).
      summarize: async (sourceIds, position = null) => {
        try {
          return await window.flyt.summarizeRun(activeTabRef.current, runId, sourceIds, position);
        } catch (e) {
          return { ok: false, error: ipcMessage(e) };
        }
      },
      deleteSummary: summaryId => guard(() => window.flyt.deleteSummary(activeTabRef.current, runId, summaryId)),
      moveSummary: (summaryId, position) =>
        window.flyt.moveSummary?.(activeTabRef.current, runId, summaryId, position)?.catch(() => {})
    };
  }, [openRun, refreshRunsSoon, showRunToast]);
  const runControl = useMemo(() => makeRunControl(activeRunId), [makeRunControl, activeRunId]);

  // Compare-pane callbacks (T12): follow-up / answer / approve / reject routed
  // to a specific pane's run, not the active one. Rejections read as a toast.
  const compareFollowUp = useCallback(async (runId, text) => {
    try { await window.flyt.followUpRun(activeTabRef.current, runId, text); }
    catch (err) { setRunToast(ipcMessage(err)); }
  }, []);
  const compareAnswerInput = useCallback(async (runId, text) => {
    try { await window.flyt.answerInput(activeTabRef.current, runId, text); }
    catch (err) { setRunToast(ipcMessage(err)); }
  }, []);
  const exitCompare = useCallback(() => {
    withViewTransition(() => {
      setCompareRunIds(null);
      setChatSeed('');
      setActiveRunId(null);
      setSnapshot(null);
      setSelectedNode(null);
      setFocusNodeId(null);
    });
  }, []);

  // The toast dismisses itself; a new one re-arms the clock.
  useEffect(() => {
    if (!runToast) return;
    const id = setTimeout(() => setRunToast(null), 4000);
    return () => clearTimeout(id);
  }, [runToast]);

  // The picker belongs to one flow's canvas — navigation and view switches close it.
  useEffect(() => { setPickerOpen(false); }, [activeFlowId, flowViewMode, activeActivity]);

  const stage = snapshot?.meta?.stage;
  // A bound tab IS the workspace (T19): its runs always target the tab's
  // folder, so the per-run picker only survives in the unbound scratch tab.
  const activeTabInfo = tabs.find(t => t.id === activeTab) ?? null;
  const boundFolder = activeTabInfo?.folder ?? null;
  const flowView = activeActivity === 'flows' && Boolean(activeFlowId && flow);
  const runView = activeActivity === 'runs' && Boolean(activeRunId);
  // Watching a run in flight is a different job from starting one. While the
  // run is live the "Run a workflow" form collapses to a button so the column
  // belongs to live output; it comes back on its own once the run settles.
  const watching = runView && Boolean(snapshot) && !isTerminal(stage);
  // The chat surface streams the same run without leaving home — live-ness for
  // the one-time context-menu tip has to count both surfaces.
  const chatLive = Boolean(
    chatRunId && activeActivity === 'home' &&
    snapshot?.meta?.runId === chatRunId && !isTerminal(stage)
  );
  const showRunForm = !watching || newRunOpen;

  // Node Focus belongs to one run's view: switching runs or leaving the run
  // view closes it rather than leaving it pointing at another run's node.
  useEffect(() => { setFocusNodeId(null); }, [activeRunId]);
  useEffect(() => { if (!runView) setFocusNodeId(null); }, [runView]);

  // One-time newcomer tip: the first live run introduces the node context
  // menu, then localStorage remembers forever — once ever, never naggy.
  useEffect(() => {
    if ((!watching && !chatLive) || coachTip) return;
    let seen = '1';
    try { seen = localStorage.getItem('flyt.tip.nodeMenu'); } catch { /* storage blocked: don't nag */ }
    if (!seen) setCoachTip(true);
  }, [watching, chatLive, coachTip]);
  const dismissCoachTip = () => {
    setCoachTip(false);
    try { localStorage.setItem('flyt.tip.nodeMenu', '1'); } catch {}
  };
  const homeView = activeActivity === 'home';
  // Projectless (L6): no tab open — the lander shows its no-project variant.
  const projectless = activeTab == null;
  // The greeting names the project for a real tab (bound folder or appdata),
  // and stays generic when projectless.
  const landerProjectName = projectless || !activeTabInfo || activeTabInfo.kind === 'default'
    ? null : activeTabInfo.name;
  const libraryView = activeActivity === 'library';
  const selectedTemplate = templates.find(t => t.id === selectedTemplateId) ?? null;

  // Display copy of the edited flow with template defaults merged in.
  const resolvedFlow = useMemo(
    () => flow ? resolveFlow(flow, templates) : null,
    [flow, templates]
  );

  const activeIndex = NAV.findIndex(n => n.key === activeActivity);
  // A run is identified by its name everywhere it's named; the id stays the
  // fallback for a run the list hasn't loaded yet.
  const activeRunName = runs.find(r => r.id === activeRunId)?.name ?? activeRunId;
  const crumb =
    homeView ? ['Home'] :
    libraryView ? ['Library', selectedTemplate?.name].filter(Boolean) :
    activeActivity === 'runs' ? (activeRunId ? ['Runs', activeRunName] : ['Runs']) :
    flowView ? ['Flows', flow.name] : ['Flows'];

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <Logo markSize={17} />
        </div>
        <TabStrip
          tabs={tabs}
          activeId={activeTab}
          live={tabLive}
          saveState={saveState}
          onSelect={switchTab}
          onClose={closeTab}
          onReorder={reorderTabs}
          onNewTab={openNewTabPage}
          onRename={renameTab}
          onAdopt={adoptTab}
          onReveal={revealTab}
        />
        {flowView
          ? <span className="titlebar-doc mono">{flow.name}</span>
          : libraryView
            ? <span className="titlebar-doc mono">{selectedTemplate?.name ?? 'Node Library'}</span>
            : runView && <span className="titlebar-doc mono" title={activeRunId}>{activeRunName}</span>}
      </div>
      {tabNotice && (
        <div className="tab-notice" role="status">
          <span>{tabNotice}</span>
          <button className="link" onClick={() => setTabNotice(null)} aria-label="Dismiss notice">✕</button>
        </div>
      )}

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

        {homeView ? (
          compareRunIds ? (
            <CompareRun
              runIds={compareRunIds}
              projectId={activeTab}
              seed={chatSeed}
              onExit={exitCompare}
              runControlFor={makeRunControl}
              onFollowUp={compareFollowUp}
              onAnswerInput={compareAnswerInput}
              onApprove={runId => window.flyt.approvePlan(activeTab, runId)}
              onReject={runId => window.flyt.rejectPlan(activeTab, runId, 'Rejected by user')}
              onOpenRun={openRun}
              onOpenFolder={runId => window.flyt.openRunFolder(activeTab, runId)}
              onSaveConfig={saveRunAsConfig}
              onRematch={startRematch}
              comparison={activeComparison}
              onJudge={judgeComparison}
              judging={judging}
            />
          ) : chatRunId ? (
            <ChatRun
              snapshot={snapshot?.meta?.runId === chatRunId ? snapshot : null}
              runId={chatRunId}
              projectId={activeTab}
              seed={chatSeed}
              followRun={followRun}
              onFollowChange={setFollowRun}
              runControl={runControl}
              onFollowUp={chatFollowUp}
              onAnswerInput={chatAnswerInput}
              onNewChat={startNewChat}
              onOpenFolder={() => window.flyt.openRunFolder(activeTab, chatRunId)}
              onOpenWorkspace={() => window.flyt.openWorkspace(activeTab, chatRunId)}
              onResume={resumeRun}
              resuming={resuming}
              onApprove={() => window.flyt.approvePlan(activeTab, chatRunId)}
              onReject={() => window.flyt.rejectPlan(activeTab, chatRunId, 'Rejected by user')}
              runToast={runToast}
              coachTip={coachTip}
              onDismissCoachTip={dismissCoachTip}
            />
          ) : (
          <Lander
            projectName={landerProjectName}
            projectless={projectless}
            recents={recents}
            seed={projectless ? null : activeTab}
            runs={runs}
            onOpenRun={openRun}
            flows={flowsList}
            configs={configsByFlow}
            flowId={runFlowId}
            modeId={runModeId}
            onSelect={selectRunFlow}
            compareOn={compareOn}
            onToggleCompare={toggleCompare}
            slotB={compareB}
            onSelectB={(flowId, modeId = null) => setCompareB({ flowId, modeId })}
            launchInputs={launchInputSpec}
            launchValues={runInputs[runFlowId]}
            onLaunchInput={setRunInputValue}
            models={models}
            activeModels={activeModels}
            hasKey={hasKey}
            claudeSubActive={claudeSubActive}
            onOpenSettings={() => setShowSettings(true)}
            inputRef={landerInputRef}
            busy={busy}
            onSubmit={text => (compareOn ? runCompareFromLander(text) : runFromLander(text))}
            onOpenProject={openProjectTab}
            onOpenFolder={async () => {
              const dir = await window.flyt.pickProjectFolder?.();
              if (dir) openProjectTab(dir);
            }}
          />
          )
        ) : (
        <>
        <aside className="sidebar" style={{ width: leftColW }}>
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
              <div className="sidebar-section runs-header" style={{ paddingBottom: 8 }}>
                <span className="section-label">Runs</span>
                {runs.length > 0 && <span className="run-count mono">{runs.length}</span>}
              </div>
              <RunsList
                runs={runs}
                activeRunId={runView ? activeRunId : null}
                onOpen={openRun}
                onRename={renameRun}
                onDelete={deleteRun}
                comparisons={comparisons}
                onCompareRuns={compareExistingRuns}
                onOpenComparison={openComparison}
              />
            </>
          )}
        </aside>

        <ColumnResizer onStart={startLeftResize} onReset={resetLeftCol} label="Resize explorer" />

        <main className="canvas-area">
          {flowView && (
            <div className="editor-bar">
              <input
                className="flow-name mono"
                value={flow.name}
                onChange={e => changeFlow(f => ({ ...f, name: e.target.value }))}
                onBlur={() => changeFlow(f => (f.name.trim() ? f : { ...f, name: UNTITLED_FLOW }))}
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
                <button
                  type="button"
                  className={'add-node-btn' + (pickerOpen ? ' active' : '')}
                  onClick={() => setPickerOpen(o => !o)}
                  title="Add a node — search the library, click to add, or drag onto the canvas"
                >
                  <span aria-hidden>＋</span> Add node
                </button>
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
              {/* Configs (CONFIGS-COMPARE P1): the modes chip toggles the
                  Configs panel — one card per config with its diff-against-
                  Default badges. YAML editing stays fully supported (the
                  panel and the YAML are two views of the same modes: block). */}
              {flow?.modes && Object.keys(flow.modes).length > 0 && (
                <button
                  type="button"
                  className={'modes-chip' + (configsOpen ? ' active' : '')}
                  onClick={() => setConfigsOpen(o => !o)}
                  title={'Configs (click to open the panel):\n' + Object.entries(flow.modes).map(([id, m]) => `• ${m.name || id}`).join('\n')}
                >
                  ◑ {Object.keys(flow.modes).length} config{Object.keys(flow.modes).length === 1 ? '' : 's'}
                </button>
              )}
              {(!flow?.modes || Object.keys(flow.modes).length === 0) && flow && (
                <button
                  type="button"
                  className={'modes-chip empty' + (configsOpen ? ' active' : '')}
                  onClick={() => setConfigsOpen(o => !o)}
                  title="No configs yet — click to create one"
                >
                  ◑ configs
                </button>
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
              <span className={'save-dot ' + saveState}>
                {saveState === 'saved' ? 'Saved' : saveState === 'failed' ? 'Save failed' : 'Saving…'}
              </span>
              <button className="reject" onClick={deleteFlow}>Delete flow</button>
            </div>
          )}
          {runView && snapshot && (
            <RunBar
              snapshot={snapshot}
              onOpenFolder={() => window.flyt.openRunFolder(activeTab, activeRunId)}
              onOpenWorkspace={() => window.flyt.openWorkspace(activeTab, activeRunId)}
              docView={runView2}
              onDocView={v => withViewTransition(() => setRunView2(v))}
              onPause={runControl.pause}
              onResume={runControl.resume}
              onStop={runControl.stop}
              onSaveConfig={saveRunAsConfig}
              onRematch={startRematch}
            />
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
            <div className={'approval-bar' + (snapshot?.meta?.pendingToolCall?.risk === 'danger' ? ' danger' : '')}>
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
                    {/* Smart mode only stops for a reason, so say what it was —
                        a pause with no explanation trains people to click
                        Approve without reading, which defeats the gate. */}
                    {snapshot.meta.pendingToolCall.reason && (
                      <span className={'risk-note risk-' + (snapshot.meta.pendingToolCall.risk ?? 'caution')}>
                        <span className="risk-pill">
                          {snapshot.meta.pendingToolCall.risk === 'danger' ? '⚠ danger' : '◈ caution'}
                        </span>
                        {snapshot.meta.pendingToolCall.reason}
                      </span>
                    )}
                  </span>
                )
                : <span>Review the work so far, then approve to continue or reject to stop.</span>}
              <button className="primary" onClick={() => window.flyt.approvePlan(activeTab, activeRunId)}>Approve</button>
              <button className="reject" onClick={() => window.flyt.rejectPlan(activeTab, activeRunId, 'Rejected by user')}>Reject</button>
            </div>
          )}
          {libraryView
            ? <NodesPage
                templates={templates}
                selectedId={selectedTemplateId}
                models={models}
                activeModels={activeModels}
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
                            key={activeTab}
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
                        key={activeTab}
                        flow={flow}
                        resolved={resolvedFlow}
                        selectedNode={selectedNode}
                        onSelect={setSelectedNode}
                        onChangeFlow={changeFlow}
                      />)
              : runView && snapshot
                ? (runView2 === 'document'
                    ? <RunMirror snapshot={snapshot} />
                    : <>
                        <FlowCanvas
                          key={activeTab}
                          snapshot={replayIndex != null && replayFrames
                            ? replaySnapshot(snapshot, replayFrames[replayIndex])
                            : snapshot}
                          selectedNode={selectedNode}
                          onSelect={setSelectedNode}
                          live={watching}
                          paused={Boolean(snapshot.meta?.paused)}
                          follow={followRun}
                          onFollowChange={setFollowRun}
                          onInvestigate={setFocusNodeId}
                          focusOpen={Boolean(focusNodeId)}
                          control={runControl}
                        />
                        <ReplayStrip
                          frames={replayFrames}
                          index={replayIndex}
                          playing={replayPlaying}
                          onScrub={i => { setReplayPlaying(false); setReplayIndex(i); }}
                          onPlayToggle={toggleReplayPlay}
                        />
                      </>)
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
          {flowView && flowViewMode !== 'yaml' && pickerOpen && (
            <>
              <div className="picker-backdrop" onClick={() => setPickerOpen(false)} />
              <NodePicker templates={templates} onAdd={addFromPicker} onClose={() => setPickerOpen(false)} />
            </>
          )}

          {/* The Configs panel (P1), anchored at the modes chip above. */}
          {flowView && configsOpen && flow && (
            <>
              <div className="picker-backdrop" onClick={() => setConfigsOpen(false)} />
              <ConfigsPanel
                flow={flow}
                resolved={resolvedFlow}
                launchTargetId={runFlowId === flow.id ? runModeId : null}
                editModeId={configEditId}
                onRun={runConfig}
                onDuplicate={duplicateConfig}
                onEdit={editConfig}
                onDelete={deleteConfig}
                onNew={newConfig}
                onClose={() => setConfigsOpen(false)}
              />
            </>
          )}

          {/* Run-mode overlays: action rejections (transient) and the one-time
              context-menu tip. Both live over the canvas, clear of the panels. */}
          {runToast && <div className="run-toast" role="status">{runToast}</div>}
          {coachTip && (
            <div className="coach-tip" role="note">
              <span className="section-label">Tip</span>
              <span className="coach-tip-text">
                Right-click any node for run actions — investigate, restart, branch, pause, stop.
              </span>
              <button className="link" onClick={dismissCoachTip} aria-label="Dismiss tip">✕</button>
            </div>
          )}
        </main>

        <ColumnResizer onStart={startRightResize} onReset={resetRightCol} label="Resize run panel" />

        <div className="right-col" style={{ width: rightColW }}>
          {!showRunForm && (
            <button className="new-run-btn" onClick={() => setNewRunOpen(true)}>
              <span aria-hidden>＋</span> New run
            </button>
          )}
          {/* Conditionally rendered, not [hidden]: .run-panel sets display:flex,
              which beats the UA stylesheet's [hidden] { display: none }. Every
              field's state lives in App, so unmounting loses nothing. */}
          {showRunForm && <div className="run-panel">
            <span className="section-label">Run a workflow</span>
            <select
              value={runFlowId}
              onChange={e => selectRunFlow(e.target.value)}
              aria-label="Workflow to run"
            >
              {flowsList.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {/* Mode picker (MODES-COMPARE T4): only when the selected flow ships
                modes. "Default" runs the flow's stored configuration. P1: each
                option carries its diff-against-Default badges as a tooltip. */}
            {(flowsList.find(f => f.id === runFlowId)?.modes?.length > 0) && (
              <select
                value={runModeId ?? ''}
                onChange={e => setRunModeId(e.target.value || null)}
                aria-label="Mode"
              >
                <option value="">Default</option>
                {flowsList.find(f => f.id === runFlowId).modes.map(m => {
                  const cfg = configsByFlow[runFlowId]?.find(c => c.id === m.id);
                  const summary = [
                    cfg?.description,
                    ...(cfg?.badges ?? [])
                  ].filter(Boolean).join('\n');
                  return (
                    <option key={m.id} value={m.id} title={summary || undefined}>
                      {m.name}{cfg?.badges?.length ? ` (${cfg.badges.length} change${cfg.badges.length === 1 ? '' : 's'})` : ''}
                    </option>
                  );
                })}
              </select>
            )}
            {/* Exposed run inputs (MODES-COMPARE T10). */}
            <LaunchInputs
              inputs={launchInputSpec}
              values={runInputs[runFlowId]}
              onChange={setRunInputValue}
              models={models}
              activeModels={activeModels}
            />
            <textarea
              placeholder="Type what you want done — this becomes the User Input node…"
              value={runInput}
              onChange={e => setRunInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startRun(); }}
            />
            {(boundFolder || activeTabInfo?.kind === 'appdata') ? (
              // A bound folder or an appdata project (L5) both have a fixed
              // workspace — runs always target it, so no per-run picker.
              <div className="workspace-row">
                <span className="workspace-path bound" title={boundFolder ?? activeTabInfo?.name}>
                  Runs in <span className="mono">{activeTabInfo?.name}</span>
                </span>
              </div>
            ) : (
              <div className="workspace-row">
                <button
                  className="ghost"
                  onClick={async () => {
                    const dir = await window.flyt.pickWorkspace();
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
            )}
            {/* Sits directly above Run, because it is a property OF the run you
                are about to start — not a project setting that happens to live
                nearby. */}
            <ApprovalModePicker
              mode={approvalMode}
              onChange={changeApprovalMode}
              safetyModel={safetyModel}
            />
            <button className="primary" onClick={startRun} disabled={busy || !runFlowId}>
              {busy ? 'Starting…' : 'Run'}<kbd className="shortcut">⌘↵</kbd>
            </button>
          </div>}

          {/* One slot, two states: live token output while nodes are producing
              (self-hiding when none are), and the run's outcome once it settles.
              Both render only in the run view. */}
          {runView && snapshot && <LiveStream snapshot={snapshot} />}
          {runView && snapshot && (
            <RunResult
              snapshot={snapshot}
              onFollowUp={text => window.flyt.followUpRun(activeTab, activeRunId, text)}
              onSummarize={runControl?.summarize}
            />
          )}

          {flowView
            ? <FlowInspector
                flow={flow}
                selectedNode={selectedNode}
                models={models}
                activeModels={activeModels}
                templates={templates}
                onChangeData={changeNodeData}
                onChangeOverrides={changeNodeOverrides}
                onDeleteNode={deleteNode}
                onDetachNode={detachNode}
                editModeId={configEditId}
                onEditMode={setConfigEditId}
                onChangeConfigOverrides={changeConfigOverrides}
              />
            : snapshot && runView
              ? <>
                  {focusNodeId && (
                    <NodeFocus
                      snapshot={snapshot}
                      nodeId={focusNodeId}
                      projectId={activeTab}
                      runId={activeRunId}
                      live={watching}
                      onClose={() => setFocusNodeId(null)}
                      onRestart={runControl.restart}
                      onBranch={runControl.branch}
                      onOpenFolder={() => window.flyt.openRunFolder(activeTab, activeRunId)}
                    />
                  )}
                  <Inspector snapshot={snapshot} selectedNode={selectedNode} />
                </>
              : (
                <aside className="inspector">
                  <div className="inspector-body">
                    <section className="about-panel">
                      <Logo stacked markSize={40} />
                      <pre>{'Pick a workflow, type your request, run it.\n\nWorkflows are built from Node Library templates on the canvas; every run is a folder of plain files you can open.'}</pre>
                    </section>
                  </div>
                </aside>
              )}
        </div>
        </>
        )}
      </div>

      {showSettings && <Settings onClose={() => { setShowSettings(false); refreshSettings(); }} />}
      {rematch && (
        <RematchPicker
          run={rematch}
          configs={configsByFlow[rematch.flowId] ?? []}
          onPick={confirmRematch}
          onCancel={() => setRematch(null)}
        />
      )}
      {newTabOpen && (
        <NewTabPage
          recents={recents}
          onOpenFolder={async () => {
            const dir = await window.flyt.pickProjectFolder?.();
            if (dir) openProjectTab(dir);
          }}
          onOpenRecent={openProjectTab}
          onRemoveRecent={async folder => {
            setRecents(await window.flyt.removeProjectRecent?.(folder) ?? []);
          }}
          onClose={() => setNewTabOpen(false)}
        />
      )}
      {deck && (
        <TabDeck
          order={deck.order}
          index={deck.index}
          tabs={tabs}
          onPick={id => { setDeck(null); switchTab(id); }}
          onCancel={() => setDeck(null)}
          onNav={d => setDeck(prev => prev && ({
            ...prev, index: (prev.index + d + prev.order.length) % prev.order.length
          }))}
        />
      )}
    </div>
  );
}
