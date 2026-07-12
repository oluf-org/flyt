import React from 'react';

// Right-hand panel: shows the artifacts and retrospective for whichever node
// is selected on the canvas. Everything shown here is read straight from the
// run's files — this is the "auditable state" made visible.

const NODE_META = {
  prompt: { icon: '✎', typeLabel: 'brief · entry prompt' },
  planner: { icon: '▤', typeLabel: 'llm step · planner' },
  router: { icon: '⇄', typeLabel: 'logic step · router' },
  execution: { icon: '⚙', typeLabel: 'tool · task fan-out' },
  verifier: { icon: '⚖', typeLabel: 'eval · quality gate' }
};

function statusPill(status) {
  if (!status) return null;
  const label = status.replace(/_/g, ' ');
  const cls =
    status === 'done' || status === 'passed' || status === 'ok' ? '' :
    status === 'failed' || status === 'rejected' || status === 'fail' ? ' pill-err' :
    status === 'awaiting_approval' || status === 'running' ? ' pill-accent' :
    ' pill-neutral';
  return <span className={'status-pill' + cls}>{label}</span>;
}

export default function Inspector({ snapshot, selectedNode }) {
  const { meta, prompt, plan, tasks, retrospectives, taskOutputs } = snapshot;

  let title = 'Run overview';
  let icon = '◆';
  let typeLabel = `run · ${meta.runId}`;
  let status = meta.stage;
  let sections = [];

  if (!selectedNode) {
    sections = [
      ['Stage', meta.stage + (meta.error ? ` — ${meta.error}` : '')],
      ['Run ID', meta.runId],
      ['Prompt', prompt]
    ];
  } else if (selectedNode === 'prompt') {
    title = 'Prompt';
    ({ icon, typeLabel } = NODE_META.prompt);
    status = null;
    sections = [['prompt.md', prompt]];
  } else if (selectedNode === 'planner') {
    title = 'Planning';
    ({ icon, typeLabel } = NODE_META.planner);
    status = retrospectives?.planner?.status;
    sections = [['plan.md', plan ?? '(not yet produced)'], retroSection(retrospectives?.planner)];
  } else if (selectedNode === 'router') {
    title = 'Routing';
    ({ icon, typeLabel } = NODE_META.router);
    status = retrospectives?.router?.status;
    sections = [['tasks.json', tasks ? JSON.stringify(tasks, null, 2) : '(not yet produced)'], retroSection(retrospectives?.router)];
  } else if (selectedNode === 'execution') {
    title = 'Execution';
    ({ icon, typeLabel } = NODE_META.execution);
    status = null;
    sections = [['Tasks', tasks ? tasks.tasks.map(t => `${t.id} [${t.status}] — ${t.title}`).join('\n') : '(no tasks yet)']];
  } else if (selectedNode === 'verifier') {
    title = 'Verification';
    ({ icon, typeLabel } = NODE_META.verifier);
    const v = retrospectives?.verifier;
    status = v?.verification?.verdict;
    sections = [
      ['Verdict', v?.verification ? `${v.verification.verdict.toUpperCase()} — ${v.verification.summary}` : '(not yet run)'],
      v?.verification?.checks?.length ? ['Checks', v.verification.checks.map(c => `[${c.result}] ${c.name}`).join('\n')] : null,
      retroSection(v)
    ];
  } else if (selectedNode.startsWith('task-')) {
    const task = tasks?.tasks.find(t => t.id === selectedNode);
    title = task ? task.title : selectedNode;
    icon = '⚙';
    typeLabel = task ? `tool · ${task.worker.provider}/${task.worker.model}` : 'tool';
    status = task?.status;
    sections = task ? [
      ['Goal', task.goal],
      task.constraints.length ? ['Constraints', task.constraints.join('\n')] : null,
      task.dependsOn.length ? ['Depends on', task.dependsOn.join(', ')] : null,
      ['Output', taskOutputs?.[task.id] ?? '(not yet produced)'],
      retroSection(retrospectives?.[`executor-${task.id}`])
    ] : [];
  }

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="node-icon">{icon}</span>
        <div className="inspector-title">
          <h2>{title}</h2>
          <div className="node-sub">{typeLabel}</div>
        </div>
        {statusPill(status)}
      </div>
      <div className="inspector-body">
        {sections.filter(Boolean).map(([label, body]) => (
          <section key={label}>
            <h3>{label}</h3>
            <pre>{body}</pre>
          </section>
        ))}
      </div>
    </aside>
  );
}

function retroSection(retro) {
  if (!retro) return ['Retrospective', '(none yet)'];
  const lines = [
    `status: ${retro.status}   confidence: ${retro.confidence}`,
    retro.model ? `model: ${retro.model.provider}/${retro.model.model}` : null,
    retro.durationMs != null ? `duration: ${retro.durationMs} ms` : null,
    retro.problems?.length ? `problems:\n  - ${retro.problems.join('\n  - ')}` : 'problems: none',
    retro.resolution ? `resolution: ${retro.resolution}` : null,
    retro.recommendation ? `recommendation: ${retro.recommendation}` : null
  ].filter(Boolean);
  return ['Retrospective', lines.join('\n')];
}
