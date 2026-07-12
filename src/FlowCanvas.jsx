import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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

function NodeCard({ data, vertical }) {
  return (
    <div className={`flow-node status-${data.status}` + (data.selected ? ' selected' : '')}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} />
      <span className="node-icon">{data.icon}</span>
      <div className="node-text">
        <div className="node-title">{data.label}</div>
        <div className="node-sub">{data.sub}</div>
      </div>
      <StatusGlyph status={data.status} />
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} />
    </div>
  );
}

const nodeTypes = {
  stage: props => <NodeCard {...props} vertical />,
  task: props => <NodeCard {...props} vertical />
};

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
      const running = meta.currentTaskId === t.id && meta.stage === 'execution';
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
