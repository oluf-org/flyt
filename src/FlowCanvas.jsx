import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  TYPE_META, nodeLabel, nodeSub, nodePorts, createsNodes,
  FEEDBACK_HANDLE, isFeedbackEdge, isStructuralNode, forwardEdges
} from './flowTypes.js';
import { wouldCreateCycle } from './flowLayout.js';
import { spawnedTasks, taskNodeStatus } from './runGraph.js';
import FlowEdge from './FlowEdge.jsx';
import Tip from './Tip.jsx';

// One custom edge for every canvas: weight (context bytes) + streaming signal
// dot. Registered under a named key (overriding the reserved 'default' key
// stops React Flow rendering edges); every edge we build sets type:'signal'.
const EDGE_TYPE = 'signal';
const edgeTypes = { [EDGE_TYPE]: FlowEdge };

// The run-time-spawned task column: gap from the right edge of the authored
// graph, and the vertical pitch between stacked tasks.
const SPAWN_DX = 260;
const SPAWN_DY = 88;

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

function NodeCard({ data, vertical, noTarget, noSource }) {
  const ports = noSource ? [] : (data.ports ?? []);
  return (
    <div className={`flow-node status-${data.status}` + (data.kind ? ` kind-${data.kind}` : '') + (data.selected ? ' selected' : '')}>
      {!noTarget && <Handle type="target" position={vertical ? Position.Top : Position.Left} />}
      {/* The feedback point (node rework): every AI node can send a structured
          pass/retry verdict back to the node whose output it received. */}
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
      <div className="node-main">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title-row">
            <div className="node-title">{data.label}</div>
            {data.kind && <span className={`node-kind kind-${data.kind}`}>{data.kind}</span>}
            {data.spawns && <span className="node-kind kind-spawn" title="May create other nodes at run time">＋nodes</span>}
            {data.turn != null && <span className="node-kind kind-turn" title={`Added by follow-up turn ${data.turn}`}>↩{data.turn}</span>}
          </div>
          <div className="node-sub">{data.sub}</div>
        </div>
        <StatusGlyph status={data.status} />
      </div>
      <PortRow ports={ports} />
      {!noSource && ports.length === 0 && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />}
    </div>
  );
}

// The Orchestrator container: a large box that fills with AI-created task
// nodes at run time. Children are separate React Flow nodes with
// parentId = this node, rendered inside; the animated purple gradient border
// marks the box while it plans and runs its children.
function OrchestratorCard({ data }) {
  const box = data.box ?? { w: 360, h: 200 };
  return (
    <div
      className={`orch-node status-${data.status}` + (data.selected ? ' selected' : '')}
      style={{ width: box.w, height: box.h }}
    >
      <Handle type="target" position={Position.Top} />
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
      <div className="orch-header">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title-row">
            <div className="node-title">{data.label}</div>
            <span className="node-kind kind-ai">ai</span>
            <span className="node-kind kind-spawn" title="Creates other nodes at run time">＋nodes</span>
          </div>
          <div className="node-sub">{data.sub}</div>
        </div>
        <StatusGlyph status={data.status} />
      </div>
      {data.empty && (
        <div className="orch-hint">
          Plans autonomously at run time —<br />task nodes are created and run in here,<br />no human intervention.
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
    </div>
  );
}

// Snapshot pushes rebuild every node's data object; memoize on the rendered
// fields so unchanged cards skip re-rendering (positions are applied by the
// React Flow wrapper, not by NodeCard, so they don't belong in the compare).
const cardEqual = (prev, next) =>
  ['label', 'sub', 'icon', 'kind', 'status', 'selected', 'nodeType', 'ports', 'spawns', 'box', 'empty', 'turn', 'feedbackPoint', 'stack']
    .every(k => prev.data[k] === next.data[k]);

const StageNode = React.memo(props => <NodeCard {...props} vertical />, cardEqual);
const OrchNode = React.memo(props => <OrchestratorCard {...props} />, cardEqual);

const nodeTypes = { stage: StageNode, task: StageNode, orchestrator: OrchNode };

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

// Editable canvas over a flow DEFINITION (not run state). Authoritative state
// is the RAW flow object owned by App (template instances stay
// templateId+overrides on disk); `resolved` is the display copy with template
// defaults merged in — same ids/positions, richer labels. React Flow changes
// are folded back into the raw flow and persisted upstream (debounced save).
export function FlowEditor({ flow, resolved, selectedNode, onSelect, onChangeFlow, readOnly }) {
  const displayNodes = (resolved ?? flow).nodes;
  const nodes = useMemo(() => displayNodes.map(n => ({
    id: n.id,
    type: n.type === 'orchestrator' ? 'orchestrator' : 'editable',
    position: n.position,
    selected: n.id === selectedNode,
    // The pinned structural nodes cannot be deleted from the canvas.
    deletable: !readOnly && n.type !== 'input' && n.type !== 'output',
    data: {
      label: nodeLabel(n),
      sub: nodeSub(n),
      icon: n.data?.icon ?? TYPE_META[n.type]?.icon ?? '▢',
      kind: n.kind,
      nodeType: n.type,
      status: 'idle',
      ports: nodePorts(n),
      spawns: n.type !== 'orchestrator' && createsNodes(n),
      feedbackPoint: n.type !== 'input' && n.type !== 'output',
      ...(n.type === 'orchestrator' ? { empty: true, box: n.data?.box } : {}),
      selected: n.id === selectedNode
    }
  })), [displayNodes, selectedNode, readOnly]);

  const edges = useMemo(() => flow.edges.map(e => ({
    ...e,
    type: EDGE_TYPE,
    ...(isFeedbackEdge(e) ? { className: 'edge-feedback' } : {})
  })), [flow.edges]);

  const onNodesChange = useCallback(changes => {
    if (readOnly) return;
    onChangeFlow(f => {
      let ns = f.nodes, es = f.edges, deselect = false;
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          ns = ns.map(n => n.id === c.id ? { ...n, position: c.position } : n);
        } else if (c.type === 'remove') {
          // Structural nodes are pinned: input/output never leave the canvas.
          if (isStructuralNode(f.nodes.find(n => n.id === c.id))) continue;
          ns = ns.filter(n => n.id !== c.id);
          es = es.filter(e => e.source !== c.id && e.target !== c.id);
          deselect = true;
        }
      }
      if (deselect) onSelect(null);
      return ns === f.nodes && es === f.edges ? f : { ...f, nodes: ns, edges: es };
    });
  }, [onChangeFlow, onSelect, readOnly]);

  const onEdgesChange = useCallback(changes => {
    if (readOnly) return;
    const removed = new Set(changes.filter(c => c.type === 'remove').map(c => c.id));
    if (!removed.size) return;
    onChangeFlow(f => ({ ...f, edges: f.edges.filter(e => !removed.has(e.id)) }));
  }, [onChangeFlow, readOnly]);

  // sourceHandle records WHICH declared output of the source feeds the edge
  // (null = the primary output). The same node pair may be connected once per
  // output port.
  const sameEdge = (e, source, target, sourceHandle) =>
    e.source === source && e.target === target &&
    (e.sourceHandle ?? null) === (sourceHandle ?? null);

  const onConnect = useCallback(({ source, target, sourceHandle }) => {
    if (readOnly || !source || !target || source === target) return;
    const feedback = sourceHandle === FEEDBACK_HANDLE;
    onChangeFlow(f => {
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
  }, [onChangeFlow, readOnly]);

  // Live drag feedback: refuse duplicate edges and anything that would close
  // a cycle (topoSort rejects cyclic flows at run time — block them here).
  // Feedback edges are exempt from the cycle rule but must target an AI node.
  const isValidConnection = useCallback(({ source, target, sourceHandle }) => {
    if (!source || !target || source === target) return false;
    if (flow.edges.some(e => sameEdge(e, source, target, sourceHandle))) return false;
    if (sourceHandle === FEEDBACK_HANDLE) {
      return !isStructuralNode(flow.nodes.find(n => n.id === target));
    }
    return !wouldCreateCycle(forwardEdges(flow.edges), source, target);
  }, [flow.edges, flow.nodes]);

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
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1.1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export default function FlowCanvas({ snapshot, selectedNode, onSelect }) {
  // Which orchestrator's collapsed swarm list is open (null = none).
  const [stackOpenFor, setStackOpenFor] = useState(null);
  const { nodes: baseNodes, edges: baseEdges } = useMemo(
    () => buildGraph(snapshot, selectedNode, setStackOpenFor), [snapshot, selectedNode]);
  const { nodes, edges, dimming, onNodeMouseEnter, onNodeMouseLeave } =
    useLineageFocus(baseNodes, baseEdges);
  const stack = stackOpenFor
    ? baseNodes.find(n => n.id === stackOpenFor)?.data?.stack ?? null
    : null;
  return (
    <>
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
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={20} size={1.1} />
        <Controls showInteractive={false} />
      </ReactFlow>
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
    </>
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

function buildFlowRunGraph(snapshot, selectedNode, onOpenStack) {
  const { flow, meta } = snapshot;
  const statusOf = id => meta.nodeStatus?.[id] ?? 'pending';
  const childrenOf = id => flow.nodes.filter(n => n.parentId === id);
  // Orchestrators whose swarm is too large to draw: their children are hidden
  // and the box shows a stack + count (modal lists them).
  const collapsed = new Set(flow.nodes
    .filter(n => n.type === 'orchestrator' && childrenOf(n.id).length > MAX_VISIBLE_CHILDREN)
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
  const nodes = flow.nodes.filter(n => !hidden.has(n.id)).map(n => ({
    id: n.id,
    type: n.type === 'orchestrator' ? 'orchestrator' : 'stage',
    position: n.position,
    // Orchestrator children live inside their container's box.
    ...(n.parentId ? { parentId: n.parentId, extent: 'parent', draggable: false } : {}),
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
      ...(n.type === 'orchestrator'
        ? collapsed.has(n.id)
          // Collapsed: a compact box regardless of the swarm's laid-out size.
          ? { empty: false, box: { w: 380, h: 230 }, stack: stackFor(n.id), onOpenStack: () => onOpenStack?.(n.id) }
          : { empty: childrenOf(n.id).length === 0, box: n.data?.box }
        : {}),
      selected: selectedNode === n.id
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
          selected: selectedNode === task.id
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
  return { nodes, edges };
}
