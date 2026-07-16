import React, { useCallback, useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TYPE_META, nodeLabel, nodeSub, nodePorts, createsNodes } from './flowTypes.js';
import { wouldCreateCycle } from './flowLayout.js';

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
          <span key={p.id} className="node-port" title={p.description ?? p.label ?? p.id}>
            {p.label ?? p.id}
          </span>
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
      <div className="node-main">
        <span className="node-icon">{data.icon}</span>
        <div className="node-text">
          <div className="node-title-row">
            <div className="node-title">{data.label}</div>
            {data.kind && <span className={`node-kind kind-${data.kind}`}>{data.kind}</span>}
            {data.spawns && <span className="node-kind kind-spawn" title="May create other nodes at run time">＋nodes</span>}
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
  ['label', 'sub', 'icon', 'kind', 'status', 'selected', 'nodeType', 'ports', 'spawns', 'box', 'empty']
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
    data: {
      label: nodeLabel(n),
      sub: nodeSub(n),
      icon: n.data?.icon ?? TYPE_META[n.type]?.icon ?? '▢',
      kind: n.kind,
      nodeType: n.type,
      status: 'idle',
      ports: nodePorts(n),
      spawns: n.type !== 'orchestrator' && createsNodes(n),
      ...(n.type === 'orchestrator' ? { empty: true, box: n.data?.box } : {}),
      selected: n.id === selectedNode
    }
  })), [displayNodes, selectedNode]);

  const edges = useMemo(() => flow.edges.map(e => ({ ...e })), [flow.edges]);

  const onNodesChange = useCallback(changes => {
    if (readOnly) return;
    onChangeFlow(f => {
      let ns = f.nodes, es = f.edges, deselect = false;
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          ns = ns.map(n => n.id === c.id ? { ...n, position: c.position } : n);
        } else if (c.type === 'remove') {
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
    onChangeFlow(f => {
      if (f.edges.some(e => sameEdge(e, source, target, sourceHandle))) return f;
      if (wouldCreateCycle(f.edges, source, target)) return f;
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
  const isValidConnection = useCallback(({ source, target, sourceHandle }) =>
    Boolean(source && target) && source !== target &&
    !flow.edges.some(e => sameEdge(e, source, target, sourceHandle)) &&
    !wouldCreateCycle(flow.edges, source, target),
  [flow.edges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={editorNodeTypes}
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
  const { nodes, edges } = useMemo(() => buildGraph(snapshot, selectedNode), [snapshot, selectedNode]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
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
  );
}

function buildGraph(snapshot, selectedNode) {
  // Flow runs carry their definition in the run dir; render that graph with
  // live per-node statuses instead of the classic linear stages.
  if (snapshot.flow) return buildFlowRunGraph(snapshot, selectedNode);
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
    animated: nodes[i + 1].data.status === 'active'
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
      edges.push({
        id: `e-exec-${t.id}`,
        source: i === 0 ? 'execution' : tasks.tasks[i - 1].id,
        target: t.id,
        animated: running
      });
    });
  }

  return { nodes, edges };
}

function workerSub(kind, retro) {
  return retro?.model ? `${kind} · ${retro.model.provider}/${retro.model.model}` : `${kind} · idle`;
}

function buildFlowRunGraph(snapshot, selectedNode) {
  const { flow, meta } = snapshot;
  const statusOf = id => {
    const s = meta.nodeStatus?.[id] ?? 'pending';
    return s === 'queued' ? 'pending' : s;
  };
  const childrenOf = id => flow.nodes.some(n => n.parentId === id);
  const nodes = flow.nodes.map(n => ({
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
      ports: nodePorts(n),
      spawns: n.type !== 'orchestrator' && createsNodes(n),
      ...(n.type === 'orchestrator' ? { empty: !childrenOf(n.id), box: n.data?.box } : {}),
      selected: selectedNode === n.id
    }
  }));
  const parentOf = new Map(flow.nodes.map(n => [n.id, n.parentId ?? null]));
  const edges = flow.edges
    // Hide the container's attach edges (orchestrator -> its own children);
    // the box already communicates ownership.
    .filter(e => parentOf.get(e.target) !== e.source)
    .map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      animated: statusOf(e.target) === 'active'
    }));
  return { nodes, edges };
}
