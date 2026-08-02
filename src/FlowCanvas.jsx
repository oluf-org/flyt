import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position,
  ReactFlowProvider, useReactFlow, applyNodeChanges, applyEdgeChanges, NodeResizer
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  TYPE_META, nodeLabel, nodeSub, nodePorts, createsNodes,
  FEEDBACK_HANDLE, isFeedbackEdge, isStructuralNode, forwardEdges
} from './flowTypes.js';
import {
  wouldCreateCycle, arrangeForCanvas, absolutePosition,
  fitOrchBox, shrinkOrchBox, ORCH_BOX_DEFAULT, ORCH_PAD
} from './flowLayout.js';
import { spawnedTasks, taskNodeStatus, nodeOutputText } from './runGraph.js';
import { formatElapsed, isTerminal } from './runProgress.js';
import { computeDisplacement, rectsOverlap } from './displace.js';
import MarkdownView from './MarkdownView.jsx';
import { statusPill } from './Inspector.jsx';
import { NodeMetricBadge } from './RunMetrics.jsx';
import FlowEdge from './FlowEdge.jsx';
import NodeMenu from './NodeMenu.jsx';
import Tip from './Tip.jsx';
import { APP_SLUG } from '../core/brand.js';

// Expanded reader cards (output-view phase 2, plan B2): a node grows into a
// readable markdown card at this default size, freely resizable down to the
// minimum via NodeResizer; the chosen size is remembered per node.
const EXPANDED_DEFAULT = { w: 560, h: 640 };
const EXPANDED_MIN = { w: 360, h: 240 };
// How long the .displacing transition class stays on a shifted node (matches
// the 240ms transform transition in styles.css, plus a settle margin).
const DISPLACE_MS = 280;

// Summary nodes (plan B4): fixed-width reader cards derived from the run's
// summaries index — never from flow.json. The width is pinned so the
// displacement math has a stable rect before React Flow measures.
const SUMMARY_WIDTH = 400;
// Placement estimate before measure (plan B4: prefer right, then below).
const SUMMARY_ESTIMATE = { w: SUMMARY_WIDTH, h: 220 };
// Node statuses that count as "the source had completed" for the D6 badge.
const TERMINAL_NODE_STATUS = new Set(['done', 'failed', 'skipped']);

// One custom edge for every canvas: weight (context bytes) + streaming signal
// dot. Registered under a named key (overriding the reserved 'default' key
// stops React Flow rendering edges); every edge we build sets type:'signal'.
const EDGE_TYPE = 'signal';
const edgeTypes = { [EDGE_TYPE]: FlowEdge };

// The run-time-spawned task column: gap from the right edge of the authored
// graph, and the vertical pitch between stacked tasks.
const SPAWN_DX = 260;
const SPAWN_DY = 88;

// Node ids for canvas-created nodes (editor drops + App's picker click-add).
let nodeSeq = 0;
export function freshNodeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${(nodeSeq++).toString(36)}`;
}

// The drag-and-drop payload the node picker puts on the dataTransfer.
export const DND_MIME = `application/x-${APP_SLUG}-node`;
export const dndOrchestrator = () => ({ kind: 'orchestrator' });
export const dndTemplate = templateId => ({ kind: 'template', templateId });
// PIVOT-PLAN §5.1: the ENGINE PRIMITIVES. A raw node of a given type, carrying
// no template at all — the thing that makes an empty library survivable. You
// can build a working flow from zero by hand, with no library and no builder,
// which is verification item 4 and the reason a broken builder is never a
// broken product.
export const dndPrimitive = type => ({ kind: 'primitive', type });

// Container node types: they hold other nodes inside a box on the canvas and
// run them in an inline sub-walk. PIVOT-PLAN §5.3's `loop` joins `orchestrator`
// here rather than getting a renderer of its own — the two differ in WHY the
// body runs, not in how a box behaves.
export const isContainer = n => n?.type === 'orchestrator' || n?.type === 'loop';

// What the palette offers when the library is empty (and always, under
// "Primitives"). These are the engine's own node types, not templates: dropping
// one gives you a node you then fill in on the inspector.
export const PRIMITIVES = [
  { type: 'aiStep', name: 'AI step', description: 'One model call. Give it a prompt and a model; upstream context is assembled for it.' },
  { type: 'agentTask', name: 'Agent task', description: 'An agent loop with tools — it can read, write and run things until the task is done.' },
  { type: 'input', name: 'User input', description: 'Where the run request enters the flow. Every flow has one.' },
  { type: 'output', name: 'Output', description: 'Where the flow\'s answer collects. Every flow has one.' }
];

// A fresh flow node from a picker spec at a canvas position: an engine
// primitive, the built-in Orchestrator structural node, or a Node Library
// template instance (overrides start empty — the node inherits the template
// until edited).
function nodeFromSpec(spec, position) {
  if (spec?.kind === 'orchestrator') {
    return {
      id: freshNodeId('orchestrator'), type: 'orchestrator', kind: 'ai',
      position, data: { title: 'Orchestrator' }
    };
  }
  if (spec?.kind === 'primitive' && TYPE_META[spec.type]) {
    return {
      id: freshNodeId(spec.type), type: spec.type, kind: TYPE_META[spec.type].kind,
      position,
      // A primitive starts unconfigured on purpose: a title you can read on the
      // canvas, and nothing else claimed on your behalf. The two exceptions are
      // the control-flow nodes, which start with a BOUND and a DEFAULT ARM —
      // PIVOT-PLAN §5.3 makes both mandatory at lint, and a node that drops onto
      // the canvas already failing lint is a worse introduction than one that
      // starts safe and asks to be edited.
      data: {
        title: TYPE_META[spec.type].label,
        ...(spec.type === 'aiStep' || spec.type === 'agentTask' ? { role: 'custom' } : {}),
        ...(spec.type === 'loop' ? { maxIterations: 3, box: ORCH_BOX_DEFAULT } : {}),
        ...(spec.type === 'branch' ? { arms: [] } : {})
      }
    };
  }
  if (spec?.kind === 'template' && typeof spec.templateId === 'string') {
    return { id: freshNodeId(spec.templateId), templateId: spec.templateId, position, overrides: {} };
  }
  return null;
}

// Derives the node graph from the run snapshot (pure function of file state).
// Layout follows the design system: vertical, top→down —
// Prompt → Planning → Routing → Execution → Verification, with per-task
// nodes in a column beside the Execution stage.
//
// Every node is the same neutral card; type is read from icon + mono label,
// state from tokens (selected / done / active / waiting / failed / pending).

const STAGE_ORDER = ['prompt', 'planning', 'awaiting_approval', 'routing', 'execution', 'verification', 'done'];

const STAGE_ICONS = { prompt: '✎', planner: '▤', router: '⇄', execution: '⚙', verifier: '⚖' };

function stageStatus(nodeStage, meta) {
  // 'done' | 'active' | 'waiting' | 'pending' | 'failed' given pipeline position
  const cur = meta.stage;
  if (cur === 'failed' || cur === 'rejected') {
    const failedAt = meta.error ? 'execution' : 'planning';
    return STAGE_ORDER.indexOf(nodeStage) < STAGE_ORDER.indexOf(failedAt) ? 'done' : 'failed';
  }
  const curIdx = STAGE_ORDER.indexOf(cur);
  const nodeIdx = STAGE_ORDER.indexOf(nodeStage);
  if (cur === 'done') return 'done';
  if (nodeIdx < curIdx) return 'done';
  if (nodeIdx === curIdx || (nodeStage === 'planning' && cur === 'awaiting_approval')) {
    return cur === 'awaiting_approval' ? 'waiting' : 'active';
  }
  return 'pending';
}

function StatusGlyph({ status }) {
  if (status === 'done') return <span className="node-status">✓</span>;
  if (status === 'active') return <span className="node-status"><span className="spinner" /></span>;
  if (status === 'waiting') return <span className="node-status">⏸</span>;
  if (status === 'failed') return <span className="node-status">✕</span>;
  // queued: the node has contributed its task and is waiting for the executor
  // to claim it. Distinct from pending (not reached yet) — it used to be
  // flattened into it, which made a node that had done its part look untouched.
  if (status === 'queued') return <Tip as="span" className="node-status" text="Queued — waiting for a worker">⋯</Tip>;
  // skipped: retired by a follow-up turn (a failed/rejected run's old path
  // that the continuation routed around) — deliberately never re-run.
  if (status === 'skipped') return <Tip as="span" className="node-status" text="Retired by a follow-up turn — not re-run">↷</Tip>;
  return <span className="node-status" />;
}

// The declared outputs of a node, made tangible: one chip per output in a
// "creates" footer, and one bottom source handle per output so the user picks
// WHICH output an edge carries. The first (primary) port is the anonymous
// default handle — edges dragged from it stay portless (legacy behavior).
function PortRow({ ports }) {
  if (!ports?.length) return null;
  return (
    <>
      <div className="node-ports">
        <span className="node-ports-label">creates</span>
        {ports.map(p => (
          <Tip key={p.id} as="span" className="node-port" text={p.description ?? p.label ?? p.id}>
            {p.label ?? p.id}
          </Tip>
        ))}
      </div>
      {ports.map((p, i) => (
        <Handle
          key={p.id}
          type="source"
          id={i === 0 ? undefined : p.id}
          position={Position.Bottom}
          className="port-handle"
          style={ports.length > 1 ? { left: `${((i + 1) / (ports.length + 1)) * 100}%` } : undefined}
        />
      ))}
    </>
  );
}

// The elapsed ticker on an active node (run canvas only — only the run graph
// stamps data.activeSince). The interval lives inside the card so the stamp
// itself never churns: memoized parents see one data change when the node
// goes active, and the second hand ticks from local state.
function ElapsedTicker({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="node-elapsed mono">{formatElapsed(Math.max(0, now - since))}</span>;
}

function NodeCard({ id, data, vertical, noTarget, noSource }) {
  const ports = noSource ? [] : (data.ports ?? []);
  return (
    <div className={`flow-node status-${data.status}` + (data.kind ? ` kind-${data.kind}` : '') + (data.selected ? ' selected' : '')}>
      {!noTarget && <Handle type="target" position={vertical ? Position.Top : Position.Left} />}
      <div className="node-main">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title-row">
            <div className="node-title">{data.label}</div>
            {data.kind && <span className={`node-kind kind-${data.kind}`}>{data.kind}</span>}
            {data.spawns && <span className="node-kind kind-spawn" title="May create other nodes at run time">＋nodes</span>}
            {data.turn != null && <span className="node-kind kind-turn" title={`Added by follow-up turn ${data.turn}`}>↩{data.turn}</span>}
            {data.activeSince != null && data.status === 'active' && <ElapsedTicker since={data.activeSince} />}
          </div>
          <div className="node-sub">
            {data.sub}
            {/* PIVOT-PLAN §6.1: cost, tokens and throughput accruing on the
                card. Numbers tick; nothing spins (D9). */}
            <NodeMetricBadge node={data.metrics} live={data.status === 'active'} />
          </div>
        </div>
        <StatusGlyph status={data.status} />
        {/* Reader affordance (output-view phase 2): run-canvas cards only —
            the editor never sets onToggleExpand, so nothing changes there. */}
        {data.onToggleExpand && data.expandable && (
          <button
            type="button"
            className="node-expand-btn nodrag"
            title="Expand to read this node's output (or double-click the card)"
            onClick={e => { e.stopPropagation(); data.onToggleExpand(id); }}
          >⤢</button>
        )}
      </div>
      <PortRow ports={ports} />
      {!noSource && ports.length === 0 && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />}
      {/* The feedback point (node rework): every AI node can send a structured
          pass/retry verdict back to the node whose output it received.
          Rendered LAST on purpose: React Flow resolves an edge with no
          sourceHandle to the first source handle in DOM order, so anything
          before the ports would steal every portless edge and draw it from
          the top. */}
      {data.feedbackPoint && (
        <Handle
          type="source"
          id={FEEDBACK_HANDLE}
          position={Position.Top}
          className="feedback-handle"
          style={{ left: '82%' }}
          title="Feedback point — drag to the upstream node this one should judge"
        />
      )}
    </div>
  );
}

// The Orchestrator container: a large box that fills with task nodes — dropped
// in by hand while authoring, or AI-created at run time. Children are separate
// React Flow nodes with parentId = this node, rendered inside; the animated
// purple gradient border marks the box while it plans and runs its children.
function OrchestratorCard({ data }) {
  const box = data.box ?? ORCH_BOX_DEFAULT;
  return (
    <div
      className={`orch-node status-${data.status}` + (data.selected ? ' selected' : '') + (data.dropTarget ? ' drop-target' : '')}
      style={{ width: box.w, height: box.h }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="orch-header">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title-row">
            <div className="node-title">{data.label}</div>
            <span className="node-kind kind-ai">ai</span>
            <span className="node-kind kind-spawn" title="Creates other nodes at run time">＋nodes</span>
            {data.childCount > 0 && (
              <span className="node-kind kind-inside" title={`${data.childCount} node(s) placed inside this box`}>
                ▣ {data.childCount}
              </span>
            )}
          </div>
          <div className="node-sub">{data.sub}</div>
        </div>
        <StatusGlyph status={data.status} />
      </div>
      {data.empty && (
        <div className="orch-hint">
          {data.emptyHint ?? (
            <>Plans autonomously at run time —<br />task nodes are created and run in here,<br />no human intervention.</>
          )}
        </div>
      )}
      {/* A large swarm collapses to a stack: the box stays compact and the
          full node list opens in a modal instead (node rework). */}
      {data.stack && (
        <button
          type="button"
          className="orch-stack"
          onClick={e => { e.stopPropagation(); data.onOpenStack?.(); }}
          title="Show every spawned node"
        >
          <span className="orch-stack-cards" aria-hidden>
            <span /><span /><span />
          </span>
          <span className="orch-stack-count">{data.stack.count} nodes</span>
          <span className="orch-stack-done mono">
            {data.stack.done}/{data.stack.count} done · click to list
          </span>
        </button>
      )}
      <div className="orch-ports">
        <PortRow ports={data.ports ?? []} />
      </div>
      {/* Last, for the same reason as NodeCard: a portless edge binds to the
          first source handle in DOM order. */}
      {data.feedbackPoint && (
        <Handle
          type="source"
          id={FEEDBACK_HANDLE}
          position={Position.Top}
          className="feedback-handle"
          style={{ left: '88%' }}
          title="Feedback point — drag to the upstream node this one should judge"
        />
      )}
    </div>
  );
}

// The expanded reader card (plan B2/D10): header with title, status pill, a
// Rendered/Raw toggle (raw = the old mono pre), Copy and a collapse button,
// over a scrolling MarkdownView body that sticks to the tail while the node
// streams (the same 24px rule NodeFocus uses). NodeResizer is mounted only
// here, so only expanded cards resize; size changes arrive as dimension
// changes on the canvas's onNodesChange and are remembered in `expanded`.
// Handles mirror the collapsed card exactly so edges don't re-anchor.
function ExpandedNodeCard({ id, data }) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const ports = data.ports ?? [];

  // Stick-to-tail: pinned to the newest text unless the user scrolls up.
  const bodyRef = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data.outputText, raw]);
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const copy = async () => {
    if (!data.outputText) return;
    try {
      await navigator.clipboard.writeText(data.outputText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the text is selectable */ }
  };

  return (
    <div className={`flow-node node-reader status-${data.status}` + (data.kind ? ` kind-${data.kind}` : '') + (data.selected ? ' selected' : '')}>
      <NodeResizer isVisible minWidth={EXPANDED_MIN.w} minHeight={EXPANDED_MIN.h} />
      <Handle type="target" position={Position.Top} />
      <div className="node-reader-head">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title">{data.label}</div>
          <div className="node-sub">{data.sub}</div>
        </div>
        {statusPill(data.status)}
        <div className="node-reader-toggle nodrag" role="group" aria-label="Output view">
          <button type="button" className={!raw ? 'active' : ''} onClick={() => setRaw(false)}>Rendered</button>
          <button type="button" className={raw ? 'active' : ''} onClick={() => setRaw(true)}>Raw</button>
        </div>
        <button type="button" className="ghost mini nodrag" onClick={copy} disabled={!data.outputText} title="Copy this node's output">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          type="button"
          className="node-expand-btn nodrag"
          title="Collapse"
          onClick={e => { e.stopPropagation(); data.onToggleExpand?.(id); }}
        >⤡</button>
      </div>
      <div className="node-reader-body nowheel nodrag nopan" ref={bodyRef} onScroll={onScroll}>
        {data.outputText
          ? raw
            ? <pre className="node-reader-raw">{data.outputText}</pre>
            : <MarkdownView text={data.outputText} streaming={data.status === 'active'} inCanvas />
          : <span className="live-idle">
              {data.status === 'active' ? 'Waiting for the first tokens…' : 'No output recorded for this node.'}
            </span>}
      </div>
      {ports.map((p, i) => (
        <Handle
          key={p.id}
          type="source"
          id={i === 0 ? undefined : p.id}
          position={Position.Bottom}
          className="port-handle"
          style={ports.length > 1 ? { left: `${((i + 1) / (ports.length + 1)) * 100}%` } : undefined}
        />
      ))}
      {ports.length === 0 && <Handle type="source" position={Position.Bottom} />}
      {data.feedbackPoint && (
        <Handle
          type="source"
          id={FEEDBACK_HANDLE}
          position={Position.Top}
          className="feedback-handle"
          style={{ left: '82%' }}
          title="Feedback point — drag to the upstream node this one should judge"
        />
      )}
    </div>
  );
}

// Snapshot pushes rebuild every node's data object; memoize on the rendered
// fields so unchanged cards skip re-rendering (positions are applied by the
// React Flow wrapper, not by NodeCard, so they don't belong in the compare).
// outputText/expanded are only attached to expanded cards, so the 250ms tick
// re-renders exactly the one streaming reader, not the whole canvas.
const cardEqual = (prev, next) =>
  ['label', 'sub', 'icon', 'kind', 'status', 'selected', 'nodeType', 'ports', 'spawns', 'box', 'empty', 'emptyHint', 'turn', 'feedbackPoint', 'stack', 'dropTarget', 'childCount', 'activeSince', 'expanded', 'outputText', 'expandable', 'hasOutput', 'metricsKey']
    .every(k => prev.data[k] === next.data[k]);

const StageNode = React.memo(props => props.data.expanded
  ? <ExpandedNodeCard {...props} />
  : <NodeCard {...props} vertical />, cardEqual);
const OrchNode = React.memo(props => <OrchestratorCard {...props} />, cardEqual);

// A summary node (plan B4): a run artifact rendered as a distinct reader card
// — accent border, ◇ icon, markdown body, mid-run badge when any source
// hadn't completed at creation (D6, persistent). Two non-artifact variants
// share the shell: the shimmer placeholder while the model writes, and the
// failure card (no-model note / error + Retry) when it couldn't.
function SummaryNode({ id, data }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!data.outputText) return;
    try {
      await navigator.clipboard.writeText(data.outputText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the text is selectable */ }
  };

  if (data.pending) {
    return (
      <div className="flow-node node-summary node-summary-pending">
        <Handle type="target" position={Position.Top} />
        <div className="node-reader-head">
          <span className="node-icon">◇</span>
          <div className="node-text">
            <div className="node-title">Summary</div>
            <div className="node-sub">summarizing {data.sourceIds?.join(', ')}…</div>
          </div>
          <span className="node-status"><span className="spinner" /></span>
        </div>
        <div className="summary-shimmer" aria-label="Summarizing…" />
      </div>
    );
  }
  if (data.failed) {
    return (
      <div className="flow-node node-summary node-summary-failed">
        <Handle type="target" position={Position.Top} />
        <div className="node-reader-head">
          <span className="node-icon">◇</span>
          <div className="node-text">
            <div className="node-title">Summary</div>
            <div className="node-sub">couldn't summarize</div>
          </div>
        </div>
        <div className="node-reader-body">
          <p className="focus-summary-note">
            {data.failed === 'no-model'
              ? 'No model configured — add a provider key in Settings to summarize outputs.'
              : data.failed}
          </p>
          <div className="focus-actions-inline">
            <button type="button" className="link nodrag" onClick={() => data.onRetry?.(id)}>Retry</button>
            <button type="button" className="link nodrag" onClick={() => data.onDiscard?.(id)}>Dismiss</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={'flow-node node-summary' + (data.selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Top} />
      <div className="node-reader-head">
        <span className="node-icon">◇</span>
        <div className="node-text">
          <div className="node-title">Summary</div>
          <div className="node-sub">{data.sub}</div>
        </div>
        <button type="button" className="ghost mini nodrag" onClick={copy} disabled={!data.outputText} title="Copy this summary">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          type="button"
          className="node-expand-btn nodrag"
          title="Delete this summary (removes the run artifact)"
          onClick={e => { e.stopPropagation(); data.onDeleteSummary?.(id); }}
        >✕</button>
      </div>
      {data.midRun && (
        <div className="summary-badge" title="At least one source was still running when this summary was made — it's a snapshot of partial output">
          ◔ summarized before completion
        </div>
      )}
      <div className="node-reader-body nowheel nodrag nopan summary-body">
        {data.outputText
          ? <MarkdownView text={data.outputText} inCanvas />
          : <span className="live-idle">The summary text is missing from the run folder.</span>}
      </div>
      <div className="summary-sources mono" title="Summarized from">
        ← {data.summary?.sources?.map(s => s.id).join(', ')}
      </div>
    </div>
  );
}

const summaryEqual = (prev, next) =>
  ['label', 'sub', 'summary', 'outputText', 'midRun', 'pending', 'failed', 'selected', 'sourceIds']
    .every(k => prev.data[k] === next.data[k]);
const SummaryNodeMemo = React.memo(SummaryNode, summaryEqual);

const nodeTypes = { stage: StageNode, task: StageNode, orchestrator: OrchNode, summary: SummaryNodeMemo };

// Editor node: same neutral card, handles depend on the node type
// (input has no target, output has no source).
const editorNodeTypes = {
  editable: React.memo(props => (
    <NodeCard
      {...props}
      vertical
      noTarget={props.data.nodeType === 'input'}
      noSource={props.data.nodeType === 'output'}
    />
  ), cardEqual),
  orchestrator: OrchNode
};

// Editable canvas over a flow DEFINITION (not run state). The raw flow object
// owned by App stays authoritative (template instances stay
// templateId+overrides on disk); `resolved` is the display copy with template
// defaults merged in — same ids/positions, richer labels.
//
// State strategy (canvas rework): local React Flow state mirrors the flow,
// because a controlled round-trip through App on every drag frame defeated
// React Flow's node-identity checks (re-measure loops, lost drag state) and
// dropped the change types the flow doesn't model (dimensions, selection).
// All change types apply locally via applyNodeChanges; only semantic changes
// (final positions, removals, adds, containment) are folded into the flow.
// Every fold marks the exact object it wrote, so the sync effect treats the
// resulting re-render as an echo instead of rebuilding mid-drag.
export function FlowEditor(props) {
  return (
    <ReactFlowProvider>
      <FlowEditorCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowEditorCanvas({ flow, resolved, selectedNode, onSelect, onChangeFlow, readOnly }) {
  const rf = useReactFlow();
  // Latest-value mirrors for callbacks that must see current props without
  // re-binding (drag handlers fire outside React's render cycle).
  const flowRef = useRef(flow);
  const resolvedRef = useRef(resolved);
  const selectedNodeRef = useRef(selectedNode);
  flowRef.current = flow;
  resolvedRef.current = resolved;
  selectedNodeRef.current = selectedNode;

  // Build React Flow nodes from a flow object. Structure (ids, parentage,
  // positions) comes from the raw flow; labels/ports prefer the resolved
  // display copy. Orchestrators order first, each followed by its children —
  // React Flow requires parents before children, and boxes belong at the
  // back so they can never cover a free node.
  const buildNodes = useCallback((f, sel, dropTargetId) => {
    const dispById = new Map((resolvedRef.current ?? f).nodes.map(n => [n.id, n]));
    const orchIds = new Set(f.nodes.filter(isContainer).map(n => n.id));
    const childCount = new Map();
    for (const n of f.nodes) {
      if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    }
    return arrangeForCanvas(f.nodes).map(raw => {
      const n = dispById.get(raw.id) ?? raw;
      const isOrch = isContainer(raw);
      const kids = childCount.get(raw.id) ?? 0;
      return {
        id: raw.id,
        type: isOrch ? 'orchestrator' : 'editable',
        position: raw.position,
        // Containment: only honored when the parent box actually exists —
        // an orphaned parentId (hand-edited YAML) degrades to top level
        // rather than vanishing. The linter flags it. Deliberately NO
        // extent:'parent' — that would clamp the child inside the box and
        // make drag-out-to-detach impossible.
        ...(raw.parentId && orchIds.has(raw.parentId)
          ? { parentId: raw.parentId }
          : {}),
        selected: raw.id === sel,
        // The pinned structural nodes cannot be deleted from the canvas.
        deletable: !readOnly && raw.type !== 'input' && raw.type !== 'output',
        data: {
          label: nodeLabel(n),
          sub: nodeSub(n),
          icon: n.data?.icon ?? TYPE_META[raw.type]?.icon ?? '▢',
          kind: n.kind,
          nodeType: raw.type,
          status: 'idle',
          ports: nodePorts(n),
          spawns: !isOrch && createsNodes(n),
          feedbackPoint: raw.type !== 'input' && raw.type !== 'output',
          ...(isOrch ? {
            empty: kids === 0,
            childCount: kids,
            box: raw.data?.box,
            dropTarget: dropTargetId === raw.id,
            emptyHint: 'Drag nodes in to run them inside this box — or let it plan for itself at run time.'
          } : {}),
          selected: raw.id === sel
        }
      };
    });
  }, [readOnly]);

  const buildEdges = useCallback(f => f.edges.map(e => ({
    ...e,
    type: EDGE_TYPE,
    ...(isFeedbackEdge(e) ? { className: 'edge-feedback' } : {})
  })), []);

  const [dropTarget, setDropTarget] = useState(null);
  const dropTargetRef = useRef(null);
  const [nodes, setNodes] = useState(() => buildNodes(flow, selectedNode, null));
  const [edges, setEdges] = useState(() => buildEdges(flow));
  // The exact flow object our own fold produced — the sync effect skips it,
  // so local drag/measure state is never rebuilt from under the gesture.
  const lastWritten = useRef(null);

  // External changes (undo/redo, YAML edits, picker click-add, inspector
  // edits) rebuild the local mirror; our own writes are already reflected in it.
  useEffect(() => {
    if (lastWritten.current === flow) return;
    setNodes(buildNodes(flow, selectedNode, dropTargetRef.current));
    setEdges(buildEdges(flow));
  }, [flow, selectedNode, buildNodes, buildEdges]);

  // The drop-target highlight maps onto orchestrator data only — a cheap
  // targeted update rather than a full rebuild on every drag frame.
  useEffect(() => {
    dropTargetRef.current = dropTarget;
    setNodes(ns => ns.map(n => n.type === 'orchestrator' && Boolean(n.data.dropTarget) !== (n.id === dropTarget)
      ? { ...n, data: { ...n.data, dropTarget: n.id === dropTarget } }
      : n));
  }, [dropTarget]);

  // Fold a mutation into the flow, keeping the local mirror for position /
  // removal changes that React Flow already applied locally.
  const writeFlow = useCallback(updater => {
    onChangeFlow(f => {
      const next = updater(f);
      if (next !== f) lastWritten.current = next;
      return next;
    });
  }, [onChangeFlow]);

  // Structural mutations (attach / detach / add) change parentage or order —
  // things the local change-application can't express. Computed from the
  // latest flow outside any updater (updaters must stay pure), then the
  // local mirror is rebuilt from the result immediately.
  const writeStructure = useCallback(buildNext => {
    const f = flowRef.current;
    const next = buildNext(f);
    if (next === f) return;
    lastWritten.current = next;
    onChangeFlow(next);
    setNodes(buildNodes(next, selectedNodeRef.current, dropTargetRef.current));
    setEdges(buildEdges(next));
  }, [onChangeFlow, buildNodes, buildEdges]);

  // Orchestrator boxes as absolute canvas rects (editor boxes are always
  // top-level — nesting is refused by the editor and flagged by the linter).
  const orchRects = useCallback(f => f.nodes
    .filter(n => n.type === 'orchestrator' && !n.parentId)
    .map(n => {
      const box = n.data?.box ?? ORCH_BOX_DEFAULT;
      return { id: n.id, x: n.position?.x ?? 0, y: n.position?.y ?? 0, w: box.w, h: box.h };
    }), []);

  const centerOf = useCallback(id => {
    const internal = rf.getInternalNode(id);
    if (!internal) return null;
    const p = internal.internals?.positionAbsolute ?? internal.position;
    const w = internal.measured?.width ?? 180;
    const h = internal.measured?.height ?? 72;
    return { x: p.x + w / 2, y: p.y + h / 2 };
  }, [rf]);

  // Which dragged nodes may change containment (structural nodes and boxes
  // themselves never can).
  const containmentCandidates = useCallback(dragged => (dragged ?? []).filter(d => {
    const raw = flowRef.current.nodes.find(n => n.id === d.id);
    return raw && raw.type !== 'input' && raw.type !== 'output' && raw.type !== 'orchestrator';
  }), []);

  const inRect = (c, r) => c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h;

  const onNodesChange = useCallback(changes => {
    if (readOnly) return;
    setNodes(ns => applyNodeChanges(changes, ns));
    const positionChanges = [];
    const removed = [];
    for (const c of changes) {
      if (c.type === 'position' && c.position) positionChanges.push(c);
      else if (c.type === 'remove') removed.push(c.id);
    }
    if (positionChanges.length) {
      writeFlow(f => ({
        ...f,
        nodes: f.nodes.map(n => {
          const c = positionChanges.find(x => x.id === n.id);
          return c ? { ...n, position: c.position } : n;
        })
      }));
    }
    if (removed.length) {
      const structural = new Set(flowRef.current.nodes.filter(isStructuralNode).map(n => n.id));
      const drop = new Set(removed.filter(id => !structural.has(id)));
      // Removing an orchestrator removes everything inside its box.
      for (const n of flowRef.current.nodes) {
        if (n.parentId && drop.has(n.parentId)) drop.add(n.id);
      }
      if (drop.size) {
        const orphanedParents = new Set(
          flowRef.current.nodes.filter(n => drop.has(n.id) && n.parentId).map(n => n.parentId));
        writeStructure(f => {
          const kept = f.nodes.filter(n => !drop.has(n.id));
          return {
            ...f,
            // Boxes that lost children shrink back around what remains.
            nodes: kept.map(n => orphanedParents.has(n.id)
              ? { ...n, data: { ...n.data, box: shrinkOrchBox(kept.filter(c => c.parentId === n.id)) } }
              : n),
            edges: f.edges.filter(e => !drop.has(e.source) && !drop.has(e.target))
          };
        });
        if (drop.has(selectedNodeRef.current)) onSelect(null);
      }
    }
  }, [readOnly, writeFlow, writeStructure, onSelect]);

  const onEdgesChange = useCallback(changes => {
    if (readOnly) return;
    setEdges(es => applyEdgeChanges(changes, es));
    const removed = new Set(changes.filter(c => c.type === 'remove').map(c => c.id));
    if (!removed.size) return;
    writeFlow(f => ({ ...f, edges: f.edges.filter(e => !removed.has(e.id)) }));
  }, [readOnly, writeFlow]);

  // sourceHandle records WHICH declared output of the source feeds the edge
  // (null = the primary output). The same node pair may be connected once per
  // output port.
  const sameEdge = (e, source, target, sourceHandle) =>
    e.source === source && e.target === target &&
    (e.sourceHandle ?? null) === (sourceHandle ?? null);

  const onConnect = useCallback(({ source, target, sourceHandle }) => {
    if (readOnly || !source || !target || source === target) return;
    const feedback = sourceHandle === FEEDBACK_HANDLE;
    writeStructure(f => {
      if (f.edges.some(e => sameEdge(e, source, target, sourceHandle))) return f;
      // Feedback edges point backwards by design — they are a reverse channel
      // outside the execution order, so the cycle guard does not apply. They
      // may only target AI nodes.
      if (feedback) {
        if (isStructuralNode(f.nodes.find(n => n.id === target))) return f;
      } else if (wouldCreateCycle(forwardEdges(f.edges), source, target)) {
        return f;
      }
      return {
        ...f,
        edges: [...f.edges, {
          id: `e-${source}-${target}` + (sourceHandle ? `-${sourceHandle}` : ''),
          source, target,
          ...(sourceHandle ? { sourceHandle } : {})
        }]
      };
    });
  }, [readOnly, writeStructure]);

  // Live drag feedback: refuse duplicate edges and anything that would close
  // a cycle (topoSort rejects cyclic flows at run time — block them here).
  // Feedback edges are exempt from the cycle rule but must target an AI node.
  const isValidConnection = useCallback(({ source, target, sourceHandle }) => {
    if (!source || !target || source === target) return false;
    const f = flowRef.current;
    if (f.edges.some(e => sameEdge(e, source, target, sourceHandle))) return false;
    if (sourceHandle === FEEDBACK_HANDLE) {
      return !isStructuralNode(f.nodes.find(n => n.id === target));
    }
    return !wouldCreateCycle(forwardEdges(f.edges), source, target);
  }, []);

  // While dragging, light up the box the node would land in.
  const onNodeDrag = useCallback((_e, _node, dragged) => {
    const cands = containmentCandidates(dragged);
    let target = null;
    if (cands.length === 1) {
      const raw = flowRef.current.nodes.find(n => n.id === cands[0].id);
      const c = centerOf(cands[0].id);
      if (c) {
        target = orchRects(flowRef.current)
          .find(r => r.id !== raw?.parentId && inRect(c, r))?.id ?? null;
      }
    }
    if (dropTargetRef.current !== target) setDropTarget(target);
  }, [containmentCandidates, centerOf, orchRects]);

  // Drag end decides containment: a node released inside a box attaches to it
  // (position becomes box-relative); a child dragged out of its box detaches
  // (position becomes absolute). Boxes refit around their children.
  const onNodeDragStop = useCallback((_e, _node, dragged) => {
    setDropTarget(null);
    if (readOnly) return;
    const cands = containmentCandidates(dragged);
    if (!cands.length) return;
    const f = flowRef.current;
    const rects = orchRects(f);
    const attached = [];  // node copies that gained a parent
    const detached = [];  // { node, from } pairs that lost one
    const nodes = f.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));

    for (const d of cands) {
      const n = byId.get(d.id);
      if (!n) continue;
      const c = centerOf(d.id);
      if (!c) continue;
      if (n.parentId) {
        const parent = byId.get(n.parentId);
        if (!parent) {
          // Orphaned child (its box was deleted): flatten to top level.
          n.position = absolutePosition(n, byId);
          delete n.parentId;
          detached.push({ node: n, from: null });
          continue;
        }
        const pAbs = absolutePosition(parent, byId);
        const pBox = parent.data?.box ?? ORCH_BOX_DEFAULT;
        const out = !inRect(c, { x: pAbs.x, y: pAbs.y, w: pBox.w, h: pBox.h });
        if (out) {
          const abs = absolutePosition(n, byId);
          const from = n.parentId;
          // Dropped over a DIFFERENT box: re-parent in the same gesture
          // rather than leaving the node floating inside it unattached.
          const target = rects.find(r => r.id !== from && inRect(c, r));
          if (target) {
            n.parentId = target.id;
            n.position = {
              x: Math.max(ORCH_PAD.x, Math.round(abs.x - target.x)),
              y: Math.max(ORCH_PAD.top, Math.round(abs.y - target.y))
            };
            detached.push({ node: n, from });
            attached.push(n);
          } else {
            n.position = abs;
            delete n.parentId;
            detached.push({ node: n, from });
          }
        }
      } else {
        const abs = absolutePosition(n, byId);
        const r = rects.find(r => r.id !== n.id && inRect(c, r));
        if (r) {
          n.parentId = r.id;
          n.position = {
            x: Math.max(ORCH_PAD.x, Math.round(abs.x - r.x)),
            y: Math.max(ORCH_PAD.top, Math.round(abs.y - r.y))
          };
          attached.push(n);
        }
      }
    }
    if (!attached.length && !detached.length) return;

    writeStructure(() => {
      let edges = f.edges;
      // A detached node loses the box's own wire to it (context edges from
      // other nodes stay).
      for (const { node, from } of detached) {
        if (from) edges = edges.filter(e => !(e.source === from && e.target === node.id));
      }
      // A fresh child with no incoming edge gets the box's wire, exactly like
      // a node the orchestrator materializes at run time — it keeps the child
      // reachable for the linter and marks ownership.
      for (const n of attached) {
        if (!edges.some(e => e.target === n.id)) {
          edges = [...edges, { id: `e-${n.parentId}-${n.id}`, source: n.parentId, target: n.id }];
        }
      }
      const refit = new Set([...attached.map(n => n.parentId), ...detached.map(d => d.from).filter(Boolean)]);
      const sized = nodes.map(n => refit.has(n.id)
        ? { ...n, data: { ...n.data, box: fitOrchBox(nodes.filter(c => c.parentId === n.id), n.data?.box) } }
        : n);
      const shrunk = sized.map(n => detached.some(d => d.from === n.id)
        ? { ...n, data: { ...n.data, box: shrinkOrchBox(sized.filter(c => c.parentId === n.id)) } }
        : n);
      return { ...f, nodes: arrangeForCanvas(shrunk), edges };
    });
  }, [readOnly, containmentCandidates, centerOf, orchRects, writeStructure]);

  // --- Node picker drag-and-drop: a spec on the dataTransfer becomes a node
  // where it lands — inside a box when dropped onto one.
  const onDragOver = useCallback(e => {
    if (readOnly || !e.dataTransfer.types.includes(DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [readOnly]);

  const onDrop = useCallback(e => {
    if (readOnly) return;
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    e.preventDefault();
    let spec;
    try { spec = JSON.parse(raw); } catch { return; }
    const point = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // The card centers on the cursor, snapped to the background grid.
    const position = {
      x: Math.round((point.x - 115) / 20) * 20,
      y: Math.round((point.y - 36) / 20) * 20
    };
    const node = nodeFromSpec(spec, position);
    if (!node) return;
    writeStructure(f => {
      const rects = orchRects(f);
      const r = spec.kind === 'orchestrator' ? null : rects.find(r => inRect(point, r));
      if (r) {
        node.parentId = r.id;
        node.position = {
          x: Math.max(ORCH_PAD.x, position.x - r.x),
          y: Math.max(ORCH_PAD.top, position.y - r.y)
        };
      }
      let nodes = [...f.nodes, node];
      let edges = f.edges;
      if (node.parentId) {
        if (!edges.some(e => e.target === node.id)) {
          edges = [...edges, { id: `e-${node.parentId}-${node.id}`, source: node.parentId, target: node.id }];
        }
        nodes = nodes.map(n => n.id === node.parentId
          ? { ...n, data: { ...n.data, box: fitOrchBox(nodes.filter(c => c.parentId === n.id), n.data?.box) } }
          : n);
      }
      return { ...f, nodes: arrangeForCanvas(nodes), edges };
    });
    onSelect(node.id);
  }, [readOnly, rf, orchRects, writeStructure, onSelect]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={editorNodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodeClick={(_e, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onDragOver={onDragOver}
      onDrop={onDrop}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      snapToGrid
      snapGrid={[20, 20]}
      connectionRadius={32}
      minZoom={0.2}
      maxZoom={1.75}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1.1} />
      <Controls showInteractive={false} />
      <MiniMap className="flow-minimap" pannable zoomable position="bottom-right" />
    </ReactFlow>
  );
}

// The run canvas (D4): a read-only, live view of the run's graph. It wraps
// its own ReactFlowProvider (the editor has one too, FlowEditor above) so the
// follow camera can drive the viewport through useReactFlow.
export default function FlowCanvas(props) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({ snapshot, selectedNode, onSelect, live = false, paused = false, follow = true, onFollowChange, onInvestigate, control, focusOpen = false }) {
  const rf = useReactFlow();
  // Which orchestrator's collapsed swarm list is open (null = none).
  const [stackOpenFor, setStackOpenFor] = useState(null);
  // Right-click menu: { kind:'node', id, x, y } | { kind:'pane', x, y } | null.
  const [menu, setMenu] = useState(null);
  // The done bloom: { x, y } in canvas pixels, {} for "canvas center", null off.
  const [bloom, setBloom] = useState(null);
  // nodeId -> the instant the run first showed it active (drives the card
  // ticker). Stamping here, not in the cards, keeps "first seen" honest across
  // the memoized re-render path.
  const activeSince = useRef(new Map());
  const prevStage = useRef(snapshot?.meta?.stage);
  const prevActive = useRef(new Set());

  const { nodes: baseNodes, edges: baseEdges } = useMemo(() => {
    const g = buildGraph(snapshot, selectedNode, setStackOpenFor);
    // Stamp first-seen-active onto the node's data (run canvas only — the
    // editor never sets it, which is exactly what gates the ticker off there).
    const now = Date.now();
    for (const n of g.nodes) {
      if (n.data.status === 'active') {
        if (!activeSince.current.has(n.id)) activeSince.current.set(n.id, now);
        n.data.activeSince = activeSince.current.get(n.id);
      } else {
        activeSince.current.delete(n.id);
      }
    }
    return g;
  }, [snapshot, selectedNode]);
  const { nodes: litNodes, edges, dimming, onNodeMouseEnter, onNodeMouseLeave } =
    useLineageFocus(baseNodes, baseEdges);
  const stack = stackOpenFor
    ? baseNodes.find(n => n.id === stackOpenFor)?.data?.stack ?? null
    : null;

  // --- Canvas reader (output-view phase 2, plan B2/B3/D4/D9) ---
  // Per-run, in-memory-only UI state: which nodes are expanded (with their
  // remembered sizes), local position overrides (displacement + user drags —
  // never written back to run files), and the displacement restore records.
  // Everything resets on a run switch; the canvas itself remounts per tab.
  const [expanded, setExpanded] = useState({});          // nodeId -> {w, h}
  const [posOverrides, setPosOverrides] = useState({});  // nodeId -> {x, y}
  const [displacing, setDisplacing] = useState(() => new Set()); // animated movers
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const userMoved = useRef(new Set());           // manually dragged — restore loses to these
  const displacedBy = useRef(new Map());         // expandedId -> [{id, from}]
  const rememberedSizes = useRef({});            // nodeId -> {w, h}; survives collapse
  const displaceTimer = useRef(null);
  const autoExpanded = useRef(false);            // D9 fires once per run
  const userClosedOut = useRef(new Set());       // a collapsed Output stays collapsed
  const baseNodesRef = useRef(baseNodes);
  baseNodesRef.current = baseNodes;

  const runId = snapshot?.meta?.runId;
  const prevReaderRun = useRef(runId);
  useEffect(() => {
    if (prevReaderRun.current === runId) return;
    prevReaderRun.current = runId;
    setExpanded({});
    setPosOverrides({});
    setDisplacing(new Set());
    userMoved.current = new Set();
    displacedBy.current = new Map();
    rememberedSizes.current = {};
    autoExpanded.current = false;
    userClosedOut.current = new Set();
    selectionRef.current = new Set();
    placedSummaries.current = new Set();
    setPendingSummaries([]);
    setFailedSummaries([]);
  }, [runId]);

  // Top-level absolute rect for a node, preferring the remembered expanded
  // size over the measured collapsed card (React Flow measures lazily).
  const rectOf = useCallback(id => {
    const internal = rf.getInternalNode(id);
    if (!internal || internal.parentId) return null; // orch children stay out of displacement
    const p = internal.internals?.positionAbsolute ?? internal.position;
    const ex = expandedRef.current[id];
    return {
      id, x: p.x, y: p.y,
      w: ex?.w ?? internal.measured?.width ?? 232,
      h: ex?.h ?? internal.measured?.height ?? 76
    };
  }, [rf]);

  // Shift nodes to their displaced/restored positions and animate them there
  // via the .displacing transform transition (cleared after it settles).
  const applyMoves = useCallback(moves => {
    if (!moves.length) return;
    setPosOverrides(prev => {
      const next = { ...prev };
      for (const m of moves) next[m.id] = { x: m.to.x, y: m.to.y };
      return next;
    });
    setDisplacing(new Set(moves.map(m => m.id)));
    clearTimeout(displaceTimer.current);
    displaceTimer.current = setTimeout(() => setDisplacing(new Set()), DISPLACE_MS);
  }, []);

  const expandNode = useCallback(id => {
    if (expandedRef.current[id]) return;
    const size = rememberedSizes.current[id] ?? EXPANDED_DEFAULT;
    // D4 local displacement: the expanded bbox pushes overlapping top-level
    // neighbors aside (cascading); every mover's origin is recorded so the
    // collapse can restore exactly.
    const target = rectOf(id);
    if (target) {
      const others = baseNodesRef.current
        .filter(n => n.id !== id && !n.parentId)
        .map(n => rectOf(n.id))
        .filter(Boolean);
      const moves = computeDisplacement(others, { ...target, w: size.w, h: size.h });
      displacedBy.current.set(id, moves.map(m => ({ id: m.id, from: m.from })));
      applyMoves(moves);
    }
    setExpanded(prev => ({ ...prev, [id]: size }));
  }, [rectOf, applyMoves]);

  const collapseNode = useCallback(id => {
    userClosedOut.current.add(id);
    setExpanded(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // Restore recorded positions exactly — except nodes the user dragged
    // meanwhile; their manual placement wins (plan D4).
    const recs = displacedBy.current.get(id) ?? [];
    displacedBy.current.delete(id);
    applyMoves(recs
      .filter(r => !userMoved.current.has(r.id))
      .map(r => ({ id: r.id, to: r.from })));
  }, [applyMoves]);

  const toggleExpand = useCallback(id => {
    if (expandedRef.current[id]) collapseNode(id);
    else expandNode(id);
  }, [expandNode, collapseNode]);

  // --- Summary nodes (plan B4/D5–D8) ---
  // Local-only companion state for the artifact-backed summaries the snapshot
  // carries: the shimmer placeholder while the model writes, the retryable
  // failure card when it couldn't, which summaries have been auto-placed, and
  // the canvas multi-selection (for "Summarize N nodes").
  const [pendingSummaries, setPendingSummaries] = useState([]); // [{ tempId, sourceIds }]
  const [failedSummaries, setFailedSummaries] = useState([]);   // [{ tempId, sourceIds, error }]
  const pendingSeq = useRef(0);
  const placedSummaries = useRef(new Set());
  const selectionRef = useRef(new Set());
  const [, bumpSelection] = useState(0);

  // Where a new summary card goes (B4): beside the source(s) — prefer right
  // of the rightmost source at the sources' centroid height, then below; when
  // both spots are taken, displace the neighbors with the D4 routine.
  const placementFor = useCallback(sourceIds => {
    const rects = baseNodesRef.current
      .filter(n => !n.parentId)
      .map(n => rectOf(n.id))
      .filter(Boolean);
    const srcs = sourceIds.map(id => rects.find(r => r.id === id)).filter(Boolean);
    const cx = srcs.length ? srcs.reduce((a, r) => a + r.x + r.w / 2, 0) / srcs.length : 0;
    const cy = srcs.length ? srcs.reduce((a, r) => a + r.y + r.h / 2, 0) / srcs.length : 0;
    const rightEdge = Math.max(0, ...srcs.map(r => r.x + r.w));
    const bottomEdge = Math.max(0, ...srcs.map(r => r.y + r.h));
    const candidates = [
      { x: rightEdge + 24, y: Math.round(cy - SUMMARY_ESTIMATE.h / 2) }, // prefer right
      { x: Math.round(cx - SUMMARY_ESTIMATE.w / 2), y: bottomEdge + 24 } // then below
    ];
    for (const c of candidates) {
      if (!rects.some(r => rectsOverlap(r, { ...c, ...SUMMARY_ESTIMATE }))) return c;
    }
    const pos = candidates[1];
    applyMoves(computeDisplacement(rects, { ...pos, ...SUMMARY_ESTIMATE }));
    return pos;
  }, [rectOf, applyMoves]);

  // Fire a summarize: shimmer placeholder at its spot immediately, then the
  // engine call — success swaps the placeholder for the artifact card (via
  // the snapshot push), failure becomes the retryable error card.
  const summarize = useCallback(async (sourceIds, position = null, reuseId = null) => {
    const ids = [...new Set((sourceIds ?? []).filter(Boolean))];
    if (!ids.length || !control?.summarize) return;
    const tempId = reuseId ?? `sum-pending-${Date.now().toString(36)}${(pendingSeq.current++).toString(36)}`;
    const pos = position ?? placementFor(ids);
    setPosOverrides(prev => ({ ...prev, [tempId]: pos }));
    setPendingSummaries(prev => [...prev, { tempId, sourceIds: ids }]);
    const res = await control.summarize(ids, pos);
    setPendingSummaries(prev => prev.filter(p => p.tempId !== tempId));
    if (res?.ok) {
      // Hand the placeholder's spot to the real card (the engine saved it
      // into the index, but be idempotent).
      setPosOverrides(prev => {
        const next = { ...prev };
        if (res.summary?.id) next[res.summary.id] = pos;
        delete next[tempId];
        return next;
      });
    } else {
      // Keep the override: the failure card stays where the shimmer was.
      setFailedSummaries(prev => [...prev, { tempId, sourceIds: ids, error: res?.error ?? 'Summarize failed.' }]);
    }
  }, [control, placementFor]);

  const retrySummary = useCallback(tempId => {
    setFailedSummaries(prev => {
      const f = prev.find(x => x.tempId === tempId);
      if (f) summarize(f.sourceIds, posOverrides[tempId], tempId);
      return prev.filter(x => x.tempId !== tempId);
    });
  }, [summarize, posOverrides]);

  const discardSummary = useCallback(tempId => {
    setFailedSummaries(prev => prev.filter(x => x.tempId !== tempId));
    setPosOverrides(prev => { const next = { ...prev }; delete next[tempId]; return next; });
  }, []);

  const deleteSummary = useCallback(id => { control?.deleteSummary?.(id); }, [control]);

  // Summaries that arrive without a saved position (created before positions
  // existed, or by another surface) get placed once, then the spot is saved
  // back into the index so it survives reload.
  const summaries = snapshot?.summaries ?? [];
  useEffect(() => {
    for (const s of summaries) {
      if (s.position || placedSummaries.current.has(s.id)) continue;
      placedSummaries.current.add(s.id);
      if (posOverrides[s.id]) continue; // our own placeholder handoff placed it
      const pos = placementFor((s.sources ?? []).map(x => x.id));
      setPosOverrides(prev => ({ ...prev, [s.id]: pos }));
      control?.moveSummary?.(s.id, pos);
    }
  }, [summaries, posOverrides, placementFor, control]);

  // D9: the Output node(s) auto-expand when the run reaches a terminal stage;
  // everything else mounts collapsed.
  const stage = snapshot?.meta?.stage;
  useEffect(() => {
    if (autoExpanded.current || !isTerminal(stage)) return;
    autoExpanded.current = true;
    for (const n of snapshot?.flow?.nodes ?? []) {
      if (n.type === 'output' && !userClosedOut.current.has(n.id)) expandNode(n.id);
    }
  }, [stage, snapshot?.flow, expandNode]);

  // Drags and NodeResizer resizes land here. Both are folded into the local
  // override maps — run files stay untouched. A finished drag marks the node
  // user-moved so a later collapse won't restore over it; a finished drag on
  // a summary card also persists its position into the summaries index (B4).
  const onNodesChange = useCallback(changes => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        setPosOverrides(prev => ({ ...prev, [c.id]: { x: c.position.x, y: c.position.y } }));
        if (c.dragging === false) {
          userMoved.current.add(c.id);
          if (c.id.startsWith('sum-') && !c.id.startsWith('sum-pending-')) {
            control?.moveSummary?.(c.id, c.position);
          }
        }
      } else if (c.type === 'dimensions' && c.dimensions && c.setAttributes && expandedRef.current[c.id]) {
        rememberedSizes.current[c.id] = { w: c.dimensions.width, h: c.dimensions.height };
        setExpanded(prev => prev[c.id]
          ? { ...prev, [c.id]: rememberedSizes.current[c.id] }
          : prev);
      } else if (c.type === 'select') {
        // Multi-selection for "Summarize N nodes" (D8). We never write
        // `selected` back onto nodes — the single-select ring stays App's —
        // this is just the menu's source list.
        if (c.selected) selectionRef.current.add(c.id);
        else selectionRef.current.delete(c.id);
        bumpSelection(v => v + 1);
      }
    }
  }, [control]);

  // The rendered node list: lineage-lit base + reader overlay (positions,
  // expansion, affordance callbacks). Output text is resolved ONLY for
  // expanded nodes — the memoized cards otherwise see no per-tick churn.
  // Summary placeholders (shimmer / failure) are local-only and appended here.
  const nodes = useMemo(() => {
    const view = litNodes.map(n => {
      const ex = expanded[n.id];
      const o = posOverrides[n.id];
      const expandable = n.type !== 'orchestrator' && n.type !== 'summary' && !n.parentId;
      if (!ex && !o && !displacing.has(n.id) && !expandable && n.type !== 'summary') return n;
      let cls = n.className ?? '';
      if (displacing.has(n.id)) cls += ' displacing';
      if (ex) cls += ' node-expanded';
      return {
        ...n,
        ...(o ? { position: o } : {}),
        ...(cls ? { className: cls.trim() } : {}),
        ...(ex ? { style: { ...n.style, width: ex.w, height: ex.h } } : {}),
        data: {
          ...n.data,
          expandable,
          onToggleExpand: toggleExpand,
          ...(n.type === 'summary' ? { onDeleteSummary: deleteSummary } : {}),
          ...(ex ? { expanded: true, outputText: nodeOutputText(snapshot, n.id) } : {})
        }
      };
    });
    for (const p of pendingSummaries) {
      view.push({
        id: p.tempId, type: 'summary',
        position: posOverrides[p.tempId] ?? { x: 0, y: 0 },
        style: { width: SUMMARY_WIDTH },
        data: { pending: true, sourceIds: p.sourceIds, ports: [] }
      });
    }
    for (const f of failedSummaries) {
      view.push({
        id: f.tempId, type: 'summary',
        position: posOverrides[f.tempId] ?? { x: 0, y: 0 },
        style: { width: SUMMARY_WIDTH },
        data: {
          failed: f.error, sourceIds: f.sourceIds, ports: [],
          onRetry: retrySummary, onDiscard: discardSummary
        }
      });
    }
    return view;
  }, [litNodes, expanded, posOverrides, displacing, toggleExpand, snapshot,
    pendingSummaries, failedSummaries, deleteSummary, retrySummary, discardSummary]);

  // Double-click does what the ⤢ button does (expand only — collapse is the
  // ⤡ button, so double-clicking text inside a reader never collapses it).
  const onNodeDoubleClick = useCallback((_e, node) => {
    if (node.type === 'orchestrator' || node.type === 'summary' || node.parentId) return;
    if (!expandedRef.current[node.id]) expandNode(node.id);
  }, [expandNode]);

  // Keyboard polish (output-view phase 4): Enter expands the selected node,
  // Esc collapses it. Focus discipline: never while typing in a field, while
  // a canvas menu/modal is open, or while NodeFocus owns Esc (it closes on
  // the same keypress and the two would race).
  useEffect(() => {
    const onKey = e => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const t = e.target;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (menu || stackOpenFor || focusOpen) return;
      const node = selectedNode ? baseNodesRef.current.find(n => n.id === selectedNode) : null;
      if (!node || node.type === 'orchestrator' || node.type === 'summary' || node.parentId) return;
      if (e.key === 'Enter' && !expandedRef.current[node.id]) { e.preventDefault(); expandNode(node.id); }
      else if (e.key === 'Escape' && expandedRef.current[node.id]) collapseNode(node.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNode, menu, stackOpenFor, focusOpen, expandNode, collapseNode]);

  // --- Follow execution: the chat-scrolls-to-the-nodes camera. ---
  const nodeStatus = snapshot?.meta?.nodeStatus;

  // Center on a set of node ids: one node glides to middle; a parallel wave
  // frames the union of its cards at a readable zoom.
  const centerOn = useCallback(ids => {
    const rects = ids.map(id => {
      const internal = rf.getInternalNode(id);
      if (!internal) return null;
      const p = internal.internals?.positionAbsolute ?? internal.position;
      return {
        x: p.x, y: p.y,
        w: internal.measured?.width ?? 180,
        h: internal.measured?.height ?? 72
      };
    }).filter(Boolean);
    if (!rects.length) return;
    if (rects.length === 1) {
      const r = rects[0];
      rf.setCenter(r.x + r.w / 2, r.y + r.h / 2, { duration: 600, zoom: rf.getZoom() });
      return;
    }
    const x0 = Math.min(...rects.map(r => r.x));
    const y0 = Math.min(...rects.map(r => r.y));
    rf.fitBounds(
      { x: x0, y: y0,
        width: Math.max(...rects.map(r => r.x + r.w)) - x0,
        height: Math.max(...rects.map(r => r.y + r.h)) - y0 },
      { duration: 600, padding: 0.4, maxZoom: 1 }
    );
  }, [rf]);

  // Glide only to NEWLY active nodes (diffed against the previous push) —
  // re-centering on every snapshot would drag the canvas back under the user.
  // The diff resets on run switches: ids repeat across runs, and opening a
  // live run should frame whatever is working right now.
  const prevFollowRun = useRef(snapshot?.meta?.runId);
  useEffect(() => {
    if (prevFollowRun.current !== snapshot?.meta?.runId) {
      prevFollowRun.current = snapshot?.meta?.runId;
      prevActive.current = new Set();
    }
    const active = new Set(
      Object.entries(nodeStatus ?? {}).filter(([, s]) => s === 'active').map(([id]) => id)
    );
    const fresh = [...active].filter(id => !prevActive.current.has(id));
    prevActive.current = active;
    if (follow && live && fresh.length) centerOn(fresh);
  }, [nodeStatus, snapshot?.meta?.runId, follow, live, centerOn]);

  // Don't fight the user: a manual pan/zoom yields the camera until the chip
  // re-arms follow. Programmatic moves (setCenter/fitBounds/fitView) pass a
  // null event, so only real gestures turn follow off.
  const onMoveStart = useCallback(event => {
    if (event && follow) onFollowChange?.(false);
  }, [follow, onFollowChange]);

  const reFollow = useCallback(() => {
    onFollowChange?.(true);
    centerOn(Object.entries(nodeStatus ?? {}).filter(([, s]) => s === 'active').map(([id]) => id));
  }, [onFollowChange, centerOn, nodeStatus]);

  // --- Done bloom: one soft pulse when the walk completes, then it's gone.
  // Under reduced motion nothing renders at all (a JS gate, not just CSS).
  const prevRunId = useRef(snapshot?.meta?.runId);
  useEffect(() => {
    const stage = snapshot?.meta?.stage;
    const runId = snapshot?.meta?.runId;
    const prev = prevStage.current;
    prevStage.current = stage;
    // A run switch can carry the stage from live to done — that's navigation,
    // not completion. Only a transition within the SAME run blooms.
    const sameRun = prevRunId.current === runId;
    prevRunId.current = runId;
    if (!sameRun || stage !== 'done' || prev === 'done' || prev == null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const out = (snapshot?.flow?.nodes ?? []).find(n => n.type === 'output');
    const internal = out && rf.getInternalNode(out.id);
    if (!internal) { setBloom({}); return; } // no output node: pulse from center
    const p = internal.internals?.positionAbsolute ?? internal.position;
    const pt = rf.flowToScreenPosition({
      x: p.x + (internal.measured?.width ?? 180) / 2,
      y: p.y + (internal.measured?.height ?? 72) / 2
    });
    setBloom({ x: pt.x, y: pt.y });
  }, [snapshot?.meta?.stage, snapshot?.meta?.runId, snapshot?.flow, rf]);

  // --- Context menus: run controls a right-click away, on node and canvas. ---
  const onNodeContextMenu = useCallback((e, node) => {
    e.preventDefault();
    setMenu({ kind: 'node', id: node.id, x: e.clientX, y: e.clientY });
  }, []);
  const onPaneContextMenu = useCallback(e => {
    e.preventDefault();
    const pt = 'clientX' in (e ?? {}) ? e : (e?.nativeEvent ?? {});
    setMenu({ kind: 'pane', x: pt.clientX ?? 0, y: pt.clientY ?? 0 });
  }, []);

  const menuNode = menu?.kind === 'node'
    ? baseNodes.find(n => n.id === menu.id) ?? null
    : null;

  // The sources a "Summarize" menu click would act on (D8): the right-clicked
  // node's whole multi-selection when it's part of one, else the node alone —
  // filtered to nodes that actually have output. Summary nodes are excluded
  // (no summarize-on-summary).
  const summarizeIds = menu?.kind === 'node'
    ? (selectionRef.current.has(menu.id) ? [...selectionRef.current] : [menu.id])
      .filter(id => baseNodes.some(n => n.id === id && n.type !== 'summary' && n.data?.hasOutput))
    : [];

  return (
    <div className={'run-canvas' + (live ? ' canvas-live' : '')}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        className={dimming ? 'dimming' : undefined}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeClick={(_e, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onMoveStart={onMoveStart}
        onNodesChange={onNodesChange}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={1.75}
      >
        <Background gap={20} size={1.1} />
        <Controls showInteractive={false} />
        <MiniMap className="flow-minimap" pannable zoomable position="bottom-right" />
      </ReactFlow>
      {live && <div className="canvas-vignette" aria-hidden="true" />}
      {!follow && live && (
        <button type="button" className="follow-chip" onClick={reFollow}>
          ▶ Follow execution
        </button>
      )}
      {bloom && (
        <div
          className="canvas-bloom"
          style={bloom.x != null ? { '--bloom-x': `${bloom.x}px`, '--bloom-y': `${bloom.y}px` } : undefined}
          onAnimationEnd={() => setBloom(null)}
        />
      )}
      {menu && (
        <NodeMenu
          menu={menu}
          node={menuNode}
          flowBacked={Boolean(snapshot?.flow)}
          live={live}
          paused={paused}
          follow={follow}
          summarizeCount={summarizeIds.length}
          onSummarize={() => summarize(summarizeIds)}
          onDeleteSummary={() => deleteSummary(menu.id)}
          onClose={() => setMenu(null)}
          onInvestigate={() => onInvestigate?.(menu.id)}
          onRestart={guidance => control?.restart?.(menu.id, guidance)}
          onBranch={() => control?.branch?.(menu.id)}
          onPause={() => control?.pause?.()}
          onResume={() => control?.resume?.()}
          onStop={() => control?.stop?.()}
          onToggleFollow={() => onFollowChange?.(!follow)}
        />
      )}
      {stack && (
        <div className="orch-modal-backdrop" onClick={() => setStackOpenFor(null)}>
          <div className="orch-modal" role="dialog" aria-label="Spawned nodes" onClick={e => e.stopPropagation()}>
            <div className="orch-modal-head">
              <span className="section-label">Spawned nodes</span>
              <span className="mono">{stack.done}/{stack.count} done</span>
              <button className="link" onClick={() => setStackOpenFor(null)} aria-label="Close">✕</button>
            </div>
            <div className="orch-modal-list">
              {stack.items.map(it => (
                <button
                  key={it.id}
                  type="button"
                  className={'orch-modal-item' + (selectedNode === it.id ? ' active' : '')}
                  onClick={() => { onSelect(it.id); setStackOpenFor(null); }}
                >
                  <span className={`orch-modal-status status-${it.status}`} aria-hidden />
                  <span className="orch-modal-title">{it.title}</span>
                  <span className="mono orch-modal-id">{it.id}</span>
                  <span className="orch-modal-state">{it.status}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Focus dimming with lineage (flare 5): hovering a node lifts its full upstream
// chain and recedes everything else. CSS can't walk a graph, so JS computes the
// lit set (the hovered node + all ancestors via an upward walk) and tags nodes/
// edges `lit` or `dim`; the CSS only fades. The hover is delayed ~150ms so a
// mouse sweeping across the canvas doesn't strobe the whole graph.
function useLineageFocus(baseNodes, baseEdges) {
  // Upward adjacency (target -> [sources]); rebuilt only when the edges change.
  const parents = useMemo(() => {
    const m = new Map();
    for (const e of baseEdges) {
      if (!m.has(e.target)) m.set(e.target, []);
      m.get(e.target).push(e.source);
    }
    return m;
  }, [baseEdges]);

  const [lit, setLit] = useState(null); // Set<id> in focus, or null = no focus
  const timer = useRef(null);

  const onNodeMouseLeave = useCallback(() => {
    clearTimeout(timer.current);
    setLit(null);
  }, []);

  const onNodeMouseEnter = useCallback((_e, node) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const set = new Set([node.id]);
      const stack = [node.id];
      while (stack.length) {
        for (const p of (parents.get(stack.pop()) ?? [])) {
          if (!set.has(p)) { set.add(p); stack.push(p); }
        }
      }
      setLit(set);
    }, 150);
  }, [parents]);

  const withClass = (obj, cls) => ({
    ...obj, className: obj.className ? `${obj.className} ${cls}` : cls
  });
  const nodes = useMemo(() => !lit ? baseNodes
    : baseNodes.map(n => withClass(n, lit.has(n.id) ? 'lit' : 'dim')), [baseNodes, lit]);
  const edges = useMemo(() => !lit ? baseEdges
    // an edge is part of the lineage only when BOTH ends are lit
    : baseEdges.map(e => withClass(e, lit.has(e.source) && lit.has(e.target) ? 'lit' : 'dim')),
    [baseEdges, lit]);

  return { nodes, edges, dimming: !!lit, onNodeMouseEnter, onNodeMouseLeave };
}

function buildGraph(snapshot, selectedNode, onOpenStack) {
  // Flow runs carry their definition in the run dir; render that graph with
  // live per-node statuses instead of the classic linear stages.
  if (snapshot.flow) return buildFlowRunGraph(snapshot, selectedNode, onOpenStack);
  const { meta, tasks, retrospectives } = snapshot;
  const STEP_Y = 104;

  const stageDefs = [
    { id: 'prompt', label: 'Prompt', stage: 'prompt', sub: 'brief · user request' },
    { id: 'planner', label: 'Planning', stage: 'planning', sub: workerSub('llm', retrospectives?.planner) },
    { id: 'router', label: 'Routing', stage: 'routing', sub: workerSub('logic', retrospectives?.router) },
    { id: 'execution', label: 'Execution', stage: 'execution', sub: tasks ? `tool · ${tasks.tasks.filter(t => t.status === 'done').length}/${tasks.tasks.length} tasks` : 'tool · splits into tasks' },
    { id: 'verifier', label: 'Verification', stage: 'verification', sub: workerSub('eval', retrospectives?.verifier) }
  ];

  const nodes = stageDefs.map((def, i) => ({
    id: def.id,
    type: 'stage',
    position: { x: 0, y: i * STEP_Y },
    data: {
      label: def.label,
      sub: def.sub,
      icon: STAGE_ICONS[def.id],
      status: def.id === 'prompt' ? 'done' : stageStatus(def.stage, meta),
      hasOutput: Boolean(nodeOutputText(snapshot, def.id)),
      selected: selectedNode === def.id
    }
  }));

  const edges = stageDefs.slice(1).map((def, i) => ({
    id: `e-${stageDefs[i].id}-${def.id}`,
    source: stageDefs[i].id,
    target: def.id,
    type: EDGE_TYPE,
    animated: nodes[i + 1].data.status === 'active',
    data: { sourceStatus: nodes[i].data.status }
  }));

  // Task nodes: a column beside the Execution stage.
  if (tasks?.tasks?.length) {
    const execY = 3 * STEP_Y;
    const startY = execY - ((tasks.tasks.length - 1) * STEP_Y) / 2;
    tasks.tasks.forEach((t, i) => {
      // 'running' is persisted per task when the scheduler claims it, so any
      // number of tasks can show active at once (V1 task 6). currentTaskId is
      // the legacy single-task signal, kept for runs recorded before that.
      const running = t.status === 'running'
        || (meta.currentTaskId === t.id && meta.stage === 'execution');
      nodes.push({
        id: t.id,
        type: 'task',
        position: { x: 300, y: startY + i * STEP_Y },
        data: {
          label: t.title.length > 26 ? t.title.slice(0, 26) + '…' : t.title,
          sub: `tool · ${t.worker.provider}/${t.worker.model}`,
          icon: '⚙',
          status: running ? 'active' : t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'pending',
          hasOutput: Boolean(snapshot.taskOutputs?.[t.id]),
          selected: selectedNode === t.id
        }
      });
      const srcId = i === 0 ? 'execution' : tasks.tasks[i - 1].id;
      edges.push({
        id: `e-exec-${t.id}`,
        source: srcId,
        target: t.id,
        type: EDGE_TYPE,
        animated: running,
        data: { sourceStatus: nodes.find(n => n.id === srcId)?.data.status }
      });
    });
  }

  return { nodes, edges };
}

function workerSub(kind, retro) {
  return retro?.model ? `${kind} · ${retro.model.provider}/${retro.model.model}` : `${kind} · idle`;
}

// A swarm larger than this collapses into a stack on the orchestrator box —
// the full list opens in a modal instead of drawing dozens of cards.
const MAX_VISIBLE_CHILDREN = 8;

// The metrics slice for one card, plus a scalar identity for the memo compare.
//
// The card data object is rebuilt on every snapshot push, so an object compared
// by reference would re-render every card on every tick. `metricsKey` is the
// only thing cardEqual looks at: it changes exactly when a displayed number
// does. A node's calls may be filed under its own id (aiStep) or under the task
// it spawned (agentTask) — both are checked, and the two are summed for a node
// that did both.
function nodeMetricsData(snapshot, nodeId, taskId = null) {
  const m = snapshot.metrics;
  if (!m) return {};
  const own = m.nodes?.[nodeId] ?? null;
  const task = taskId ? (m.tasks?.[taskId] ?? null) : null;
  const metrics = own ?? task;
  if (!metrics) return {};
  return {
    metrics,
    metricsKey: [
      metrics.calls, metrics.retries,
      metrics.cost?.total ?? 'x', metrics.cost?.estimated ? 'e' : '',
      metrics.usage?.totalTokens ?? 0, metrics.throughput?.p50 ?? ''
    ].join('|')
  };
}

function buildFlowRunGraph(snapshot, selectedNode, onOpenStack) {
  const { flow, meta } = snapshot;
  const statusOf = id => meta.nodeStatus?.[id] ?? 'pending';
  const childrenOf = id => flow.nodes.filter(n => n.parentId === id);
  // Orchestrators whose swarm is too large to draw: their children are hidden
  // and the box shows a stack + count (modal lists them).
  const collapsed = new Set(flow.nodes
    .filter(n => isContainer(n) && childrenOf(n.id).length > MAX_VISIBLE_CHILDREN)
    .map(n => n.id));
  const hidden = new Set(flow.nodes
    .filter(n => n.parentId && collapsed.has(n.parentId))
    .map(n => n.id));
  const stackFor = id => {
    const kids = childrenOf(id);
    return {
      count: kids.length,
      done: kids.filter(k => statusOf(k.id) === 'done').length,
      items: kids.map(k => ({ id: k.id, title: nodeLabel(k), status: statusOf(k.id) }))
    };
  };
  const nodes = arrangeForCanvas(flow.nodes.filter(n => !hidden.has(n.id))).map(n => ({
    id: n.id,
    // PIVOT-PLAN §5.3: a loop is a container like an orchestrator — same box
    // card, same containment rules — so it shares the renderer.
    type: isContainer(n) ? 'orchestrator' : 'stage',
    position: n.position,
    // Orchestrator children live inside their container's box. arrangeForCanvas
    // guarantees parents precede children (React Flow drops the child
    // otherwise); a child whose box is missing or collapsed degrades to top
    // level instead of vanishing.
    ...(n.parentId && !hidden.has(n.parentId) && flow.nodes.some(p => p.id === n.parentId && isContainer(p))
      ? { parentId: n.parentId, extent: 'parent', draggable: false }
      : {}),
    data: {
      label: nodeLabel(n),
      sub: nodeSub(n),
      icon: n.data?.icon ?? TYPE_META[n.type]?.icon ?? '▢',
      kind: n.kind,
      status: statusOf(n.id),
      // Follow-up provenance (FU5): badge the node with its turn number.
      ...(n.data?.origin === 'followup' ? { turn: n.data.turn } : {}),
      ports: nodePorts(n),
      spawns: n.type !== 'orchestrator' && createsNodes(n),
      feedbackPoint: n.type !== 'input' && n.type !== 'output',
      ...(isContainer(n)
        ? collapsed.has(n.id)
          // Collapsed: a compact box regardless of the swarm's laid-out size.
          ? { empty: false, box: { w: 380, h: 230 }, stack: stackFor(n.id), onOpenStack: () => onOpenStack?.(n.id) }
          : { empty: childrenOf(n.id).length === 0, box: n.data?.box }
        : {}),
      // Feeds the NodeMenu's Summarize item (D8: offered on any node WITH output).
      hasOutput: Boolean(nodeOutputText(snapshot, n.id)),
      selected: selectedNode === n.id,
      // PIVOT-PLAN §6.1: what this node has cost and produced, accruing live.
      ...nodeMetricsData(snapshot, n.id, n.data?.taskId)
    }
  }));
  const parentOf = new Map(flow.nodes.map(n => [n.id, n.parentId ?? null]));
  const edges = flow.edges
    // Hide the container's attach edges (orchestrator -> its own children);
    // the box already communicates ownership. Edges touching a hidden child
    // (collapsed swarm) go with their nodes.
    .filter(e => parentOf.get(e.target) !== e.source)
    .filter(e => !hidden.has(e.source) && !hidden.has(e.target))
    .map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: EDGE_TYPE,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      ...(isFeedbackEdge(e) ? { className: 'edge-feedback' } : {}),
      animated: statusOf(e.target) === 'active',
      // FlowEdge: line weight from context that flowed here, streaming dot while
      // the source produces. edgeContext is written by the runner as it assembles
      // each node's context; absent (older runs / authoring) => the 2px default.
      data: { contextBytes: meta.edgeContext?.[e.id], sourceStatus: statusOf(e.source) }
    }));

  // Tasks an agent spawned at run time (V1 task 9). They have no node in the
  // definition — they didn't exist when the flow was authored — so they are
  // derived here. Without this an agent delegating its work showed nothing.
  //
  // They get their OWN column clear of the authored graph rather than an offset
  // from the node that caused them: the flow's own layout already owns that
  // space, and hanging them off their owner dropped them on top of whatever sat
  // to its right. The dashed edge carries the ownership; position doesn't have
  // to. Everything is measured from top-level nodes only — an orchestrator
  // child's position is relative to its parent box, not the canvas.
  const spawned = spawnedTasks(snapshot);
  if (spawned.length) {
    const byId = new Map(flow.nodes.map(n => [n.id, n]));
    const top = flow.nodes.filter(n => !n.parentId);
    const colX = Math.max(0, ...top.map(n => (n.position?.x ?? 0) + (n.data?.box?.w ?? 0))) + SPAWN_DX;
    const colY = Math.min(0, ...top.map(n => n.position?.y ?? 0));
    spawned.forEach(({ task, ownerNodeId }, i) => {
      const status = taskNodeStatus(task.status);
      nodes.push({
        id: task.id,
        type: 'task',
        position: { x: colX, y: colY + i * SPAWN_DY },
        draggable: false,
        data: {
          label: task.title || task.id,
          sub: `spawned task · ${task.worker?.provider}/${task.worker?.model}`,
          icon: TYPE_META.agentTask.icon,
          kind: 'ai',
          status,
          ports: [],
          hasOutput: Boolean(snapshot.taskOutputs?.[task.id]),
          selected: selectedNode === task.id,
          ...nodeMetricsData(snapshot, task.id, task.id)
        }
      });
      // An untraceable task is still shown, just without a line home.
      if (ownerNodeId && byId.has(ownerNodeId)) {
        edges.push({
          id: `e-spawn-${ownerNodeId}-${task.id}`,
          source: ownerNodeId,
          target: task.id,
          type: EDGE_TYPE,
          className: 'edge-spawned', // dashed: created at run time, not authored
          animated: status === 'active',
          data: { sourceStatus: statusOf(ownerNodeId) }
        });
      }
    });
  }

  // Summary nodes (plan B4/D5): derived from the run's summaries index — a run
  // artifact, never part of flow.json. Each gets a dashed edge from every
  // source it read (ghost sources — deleted nodes, legacy ids — just don't
  // draw one). The card itself is rendered by SummaryNode; position comes
  // from the index (saved on drag) or the canvas's placement pass.
  for (const s of snapshot.summaries ?? []) {
    nodes.push({
      id: s.id,
      type: 'summary',
      position: s.position ?? { x: 0, y: 0 },
      style: { width: SUMMARY_WIDTH },
      data: {
        label: 'Summary',
        sub: s.model ? `◇ ${s.model.provider}/${s.model.model}` : '◇ summary',
        icon: '◇',
        kind: 'ai',
        status: 'done',
        summary: s,
        outputText: s.text ?? '',
        midRun: (s.sources ?? []).some(src => !TERMINAL_NODE_STATUS.has(src.statusAtCreation)),
        ports: [],
        selected: selectedNode === s.id
      }
    });
    for (const src of s.sources ?? []) {
      if (!nodes.some(n => n.id === src.id)) continue;
      edges.push({
        id: `e-sum-${src.id}__${s.id}`,
        source: src.id,
        target: s.id,
        type: EDGE_TYPE,
        className: 'edge-spawned', // dashed: derived at view time, not authored
        data: { sourceStatus: statusOf(src.id) ?? 'done' }
      });
    }
  }
  return { nodes, edges };
}
