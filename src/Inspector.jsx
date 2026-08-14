import React from 'react';
import { ModelPicker } from './ModelPicker.jsx';
import {
  // grantableTools(type) reads the live tool library (tools/<id>.json) snapshot
  // App installs at boot, before any inspector panel renders, and returns what
  // THIS node type may hold; it falls back to the shipped built-ins when there
  // is no library to read.
  TYPE_META, AI_ROLES, NODE_CATEGORIES, NODE_TEMPLATES, grantableTools,
  EFFORT_LEVELS, DEFAULT_EFFORT, EVAL_TYPES, WORK_CATEGORIES,
  nodeLabel, isInstance, resolveInstance, nodePorts, isStructuralNode,
  overridableFields, resolveFlow, diffOverrides
} from './flowTypes.js';

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

export function statusPill(status) {
  if (!status) return null;
  const label = status.replace(/_/g, ' ');
  const cls =
    status === 'done' || status === 'passed' || status === 'ok' ? '' :
    status === 'failed' || status === 'rejected' || status === 'fail' ? ' pill-err' :
    status === 'awaiting_approval' || status === 'running' ? ' pill-accent' :
    ' pill-neutral';
  return <span className={'status-pill' + cls}>{label}</span>;
}

export default function Inspector({ snapshot, selectedNode, onOpenArtifact = null }) {
  const { meta, prompt, tasks, retrospectives, flow } = snapshot;

  let title = 'Run overview';
  let icon = '◆';
  let typeLabel = `run · ${meta.runId}`;
  let status = meta.stage;
  let sections = [];

  const flowNode = flow?.nodes?.find(n => n.id === selectedNode);

  if (!selectedNode) {
    sections = [
      ['Stage', meta.stage + (meta.error ? ` — ${meta.error}` : '')],
      ['Run ID', meta.runId],
      flow ? ['Flow', `${flow.name} · ${flow.nodes.length} nodes`] : null,
      ['Prompt', prompt]
    ];
  } else if (flowNode) {
    // Flow-run node: config + facts, straight from the run's files.
    // D11 (output-view phase 4): OUTPUT sections (nodes/<id>.md, task outputs,
    // result.md, orchestration plan/aggregate) no longer render here — the
    // canvas is the reader (expand the node card; NodeFocus keeps its own
    // output view). What stays: goal/constraints, tool calls, retrospective.
    title = nodeLabel(flowNode);
    icon = TYPE_META[flowNode.type]?.icon ?? '▢';
    typeLabel = `${TYPE_META[flowNode.type]?.label.toLowerCase() ?? flowNode.type} · ${flowNode.kind}`;
    status = meta.nodeStatus?.[selectedNode];
    // Points at the reading surface wherever an output section was removed.
    const outputHint = ['Output', 'Expand the node card on the canvas to read this node\'s output (or right-click → Investigate node).'];
    if (flowNode.type === 'input') {
      sections = [['prompt.md', prompt]];
    } else if (flowNode.type === 'agentTask') {
      const task = tasks?.tasks.find(t => t.id === flowNode.data?.taskId);
      sections = [
        ['Goal', flowNode.data?.goal || '(none)'],
        flowNode.data?.constraints?.length ? ['Constraints', flowNode.data.constraints.join('\n')] : null,
        outputHint,
        task ? toolCallsSection(retrospectives?.[`executor-${task.id}`]) : null,
        task ? retroSection(retrospectives?.[`executor-${task.id}`]) : null
      ];
    } else if (flowNode.type === 'aiStep') {
      sections = [
        outputHint,
        retroSection(retrospectives?.[flowNode.id])
      ];
    } else if (flowNode.type === 'orchestrator') {
      const children = flow.nodes.filter(n => n.data?.managedBy === flowNode.id);
      sections = [
        children.length
          ? ['Created nodes', children.map(n => `${n.id} [${meta.nodeStatus?.[n.id] ?? 'pending'}] — ${n.data?.title ?? n.id}`).join('\n')]
          : ['Created nodes', '(none yet — nodes appear inside the box once planning completes)'],
        outputHint,
        retroSection(retrospectives?.[flowNode.id])
      ];
    } else {
      sections = [outputHint];
    }
  } else if (selectedNode === 'prompt') {
    title = 'Prompt';
    ({ icon, typeLabel } = NODE_META.prompt);
    status = null;
    sections = [['prompt.md', prompt]];
  } else if (selectedNode === 'planner') {
    title = 'Planning';
    ({ icon, typeLabel } = NODE_META.planner);
    status = retrospectives?.planner?.status;
    // D11: plan.md moved to the canvas reader; the retrospective stays.
    sections = [
      ['Output', 'Expand the node card on the canvas to read the plan.'],
      retroSection(retrospectives?.planner)
    ];
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
      // D11: the task's output moved to the canvas reader; facts stay.
      ['Output', 'Expand the task card on the canvas to read this task\'s output.'],
      toolCallsSection(retrospectives?.[`executor-${task.id}`]),
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
        {sections.filter(Boolean).map(([label, body, artifacts]) => (
          <section key={label}>
            <h3>{label}</h3>
            <pre>{body}</pre>
            {/* Result artifacts (TOOLS-PLAN §13): the preview above is bounded,
                the file holds everything. Opening it is the point. */}
            {onOpenArtifact && artifacts?.length ? (
              <div className="artifact-links">
                {artifacts.map(rel => (
                  <button key={rel} className="link-button mono" onClick={() => onOpenArtifact(rel)}>{rel}</button>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    </aside>
  );
}

// --- Flow-definition editing (flow builder view) ---
// Same aside, but the sections are editable fields writing through to the
// flow definition via onChangeData. Worker pickers mirror the Settings page.

// The worker field, everywhere it appears. Since D36 P0.4 this is one popover
// picker (search, catalog facts, model sets, free-text id, unrouted warning)
// rather than a bare <select> here and a second implementation on the node
// card. The signature is unchanged so every existing call site still works;
// `models` (the fetched openrouter catalog) now reaches the menu through
// ModelMetaProvider, which is why it is no longer read here.
export function WorkerPicker({ worker, models, activeModels, onChange, idPrefix }) {
  const w = worker?.provider ? worker : { provider: 'mock', model: 'mock-large' };
  return <ModelPicker worker={w} activeModels={activeModels} onChange={onChange} idPrefix={idPrefix} />;
}

// Edit-target toggle (CONFIGS-COMPARE P1): at the top of the Inspector, switch
// between Flow (stored node overrides — today's behavior) and Config: <name>
// (that config's override map). Same fields, same override tags, same
// overridableFields validation — only the write target changes.
function EditTargetBar({ modes, editModeId, onEditMode }) {
  const ids = Object.keys(modes ?? {});
  if (!ids.length || !onEditMode) return null;
  return (
    <div className="edit-target">
      <button
        type="button"
        className={'edit-target-btn' + (!editModeId ? ' active' : '')}
        onClick={() => onEditMode(null)}
        title="Edit the flow itself — stored node overrides"
      >Flow</button>
      <select
        className={'edit-target-select' + (editModeId ? ' active' : '')}
        value={editModeId ?? ''}
        onChange={e => onEditMode(e.target.value || null)}
        aria-label="Edit a config's override map instead"
        title="Edit a config — changes land in that config's override map, not the flow"
      >
        <option value="">Config…</option>
        {ids.map(id => <option key={id} value={id}>◑ {modes[id].name || id}</option>)}
      </select>
    </div>
  );
}

export function FlowInspector({ flow, selectedNode, models, activeModels, templates, onChangeData, onChangeOverrides, onDeleteNode, onDetachNode, editModeId = null, onEditMode, onChangeConfigOverrides }) {
  const node = flow.nodes.find(n => n.id === selectedNode);
  const modes = flow.modes ?? {};
  const editMode = editModeId && modes[editModeId] ? { id: editModeId, ...modes[editModeId] } : null;
  const targetBar = <EditTargetBar modes={modes} editModeId={editMode?.id ?? null} onEditMode={onEditMode} />;

  // Config edit target, no node selected: the config's summary (description,
  // lineage, diff-against-Default badges) and the invitation to pick a node.
  if (editMode && !node) {
    const resolved = resolveFlow(flow, templates ?? []);
    const badges = diffOverrides(resolved, editMode.overrides);
    return (
      <aside className="inspector">
        {targetBar}
        <div className="inspector-header">
          <span className="node-icon">◑</span>
          <div className="inspector-title">
            <h2>{editMode.name || editMode.id}</h2>
            <div className="node-sub">config · {flow.name}</div>
          </div>
        </div>
        <div className="inspector-body">
          {editMode.description && (
            <section>
              <h3>Description</h3>
              <pre>{editMode.description}</pre>
            </section>
          )}
          {editMode.derivedFrom && (
            <section>
              <h3>Lineage</h3>
              <pre>{`Derived from "${editMode.derivedFrom}" (metadata only — the full override map is stored on this config; nothing is merged at run time).`}</pre>
            </section>
          )}
          <section>
            <h3>What it changes vs Default</h3>
            <div className="config-badges">
              {badges.length
                ? badges.map((b, i) => <span key={i} className={'config-badge' + (b.kind === 'change' ? '' : ' warn')} title={b.text}>{b.text}</span>)
                : <span className="config-badge neutral">same as Default</span>}
            </div>
          </section>
          <section>
            <h3>Editing</h3>
            <pre>Select a node on the canvas to view and edit this config&rsquo;s overrides for that node. Clearing a field removes it from the config (back to the flow default).</pre>
          </section>
        </div>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="inspector">
        {targetBar}
        <div className="inspector-header">
          <span className="node-icon">✏</span>
          <div className="inspector-title">
            <h2>{flow.name}</h2>
            <div className="node-sub">flow · {flow.nodes.length} nodes · {flow.edges.length} edges</div>
          </div>
        </div>
        <div className="inspector-body">
          <section>
            <h3>Flow</h3>
            <pre>Select a node to edit it, drag between handles to connect, or press ＋ Add node to search the library — drag nodes straight onto the canvas, and onto a box to fill it.</pre>
          </section>
        </div>
      </aside>
    );
  }

  // Config edit target + a node: edit that config's overrides FOR THIS NODE.
  // Same fields and override tags as the flow editor, gated by the same
  // overridableFields whitelist the runner enforces at launch.
  if (editMode) {
    return (
      <ConfigNodeEditor
        node={node}
        mode={editMode}
        template={node.templateId ? templates?.find(t => t.id === node.templateId) ?? null : null}
        models={models}
        activeModels={activeModels}
        onChangeConfigOverrides={onChangeConfigOverrides}
        banner={targetBar}
      />
    );
  }

  // Template instances get the override editor: template defaults come from
  // the Node Library; every change here is saved in this workflow only.
  if (isInstance(node)) {
    return (
      <InstanceInspector
        node={node}
        parent={node.parentId ? flow.nodes.find(n => n.id === node.parentId) : null}
        template={templates?.find(t => t.id === node.templateId) ?? null}
        models={models}
        activeModels={activeModels}
        onChangeOverrides={onChangeOverrides}
        onDeleteNode={onDeleteNode}
        onDetachNode={onDetachNode}
        banner={targetBar}
      />
    );
  }

  const meta = TYPE_META[node.type] ?? { icon: '▢', label: node.type };
  const set = patch => onChangeData(node.id, patch);
  const d = node.data ?? {};
  const readOnly = false;

  return (
    <aside className="inspector">
      {targetBar}
      <div className="inspector-header">
        <span className="node-icon">{meta.icon}</span>
        <div className="inspector-title">
          <h2>{nodeLabel(node)}</h2>
          <div className="node-sub">{meta.label.toLowerCase()} · {node.kind}</div>
        </div>
        <span className={'status-pill ' + (node.kind === 'ai' ? 'pill-accent' : 'pill-neutral')}>{node.kind}</span>
      </div>
      <div className="inspector-body node-editor">
        {readOnly && (
          <section><h3>Read-only</h3><pre>Built-in flow nodes cannot be edited.</pre></section>
        )}

        {node.type === 'input' && (
          <>
            <section>
              <h3>User Input</h3>
              <pre>What you type in the run panel becomes this node&rsquo;s content for that run.</pre>
            </section>
            <section>
              <h3>Fallback text — used when the run panel input is empty</h3>
              <textarea
                rows={5}
                placeholder="(optional)"
                value={d.text ?? ''}
                onChange={e => set({ text: e.target.value })}
              />
            </section>
          </>
        )}

        {node.type === 'agentTask' && <>
          <section>
            <h3>Title</h3>
            <input value={d.title ?? ''} disabled={readOnly} onChange={e => set({ title: e.target.value })} />
          </section>
          <section>
            <h3>Goal</h3>
            <textarea rows={4} placeholder="What must this task produce?" value={d.goal ?? ''} disabled={readOnly}
              onChange={e => set({ goal: e.target.value })} />
          </section>
          <section>
            <h3>Constraints — one per line</h3>
            <textarea rows={3} value={(d.constraints ?? []).join('\n')} disabled={readOnly}
              onChange={e => set({ constraints: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })} />
          </section>
          <section>
            <h3>Worker</h3>
            <WorkerPicker worker={d.worker} models={models} activeModels={activeModels} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
          </section>

          {/* Advanced example node fields (category, template, contextSpec) — see FLOW_NODES.md */}
          {(node.type === 'agentTask' || node.type === 'aiStep') && (
            <>
              <section>
                <h3>Category (for model selection)</h3>
                <select
                  value={d.category ?? ''}
                  disabled={readOnly}
                  onChange={e => set({ category: e.target.value || undefined })}
                >
                  <option value="">(none)</option>
                  {NODE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </section>
              <section>
                <h3>Template (from catalog — see FLOW_NODES.md)</h3>
                <select
                  value={d.template ?? ''}
                  disabled={readOnly}
                  onChange={e => {
                    const t = e.target.value;
                    const patch = { template: t || undefined };
                    if (t && NODE_TEMPLATES[t]?.category) patch.category = NODE_TEMPLATES[t].category;
                    set(patch);
                  }}
                >
                  <option value="">(custom / none)</option>
                  {Object.keys(NODE_TEMPLATES).map(k => (
                    <option key={k} value={k}>{k} — {NODE_TEMPLATES[k].label}</option>
                  ))}
                </select>
                {d.template && NODE_TEMPLATES[d.template] && (
                  <div className="node-sub" style={{ marginTop: 4 }}>{NODE_TEMPLATES[d.template].description}</div>
                )}
              </section>
              <section>
                <h3>Context spec — explicit minimal files + descriptions (recommended for plan-start / generated nodes)</h3>
                <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: 4 }}>
                  Only these files (with the given descriptions) will be given to the node. See FLOW_NODES.md.
                </div>
                {(d.contextSpec?.files ?? []).map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input
                      style={{ flex: '1 1 40%' }}
                      placeholder="path/to/file.ts"
                      value={f.path || ''}
                      disabled={readOnly}
                      onChange={e => {
                        const files = [...(d.contextSpec?.files || [])];
                        files[i] = { ...files[i], path: e.target.value };
                        set({ contextSpec: { files } });
                      }}
                    />
                    <input
                      style={{ flex: '1 1 60%' }}
                      placeholder="Description / reason for including (keeps context small)"
                      value={f.description || ''}
                      disabled={readOnly}
                      onChange={e => {
                        const files = [...(d.contextSpec?.files || [])];
                        files[i] = { ...files[i], description: e.target.value };
                        set({ contextSpec: { files } });
                      }}
                    />
                    {!readOnly && (
                      <button type="button" onClick={() => {
                        const files = (d.contextSpec?.files || []).filter((_, idx) => idx !== i);
                        set({ contextSpec: files.length ? { files } : undefined });
                      }}>✕</button>
                    )}
                  </div>
                ))}
                {!readOnly && (
                  <button type="button" className="ghost mini" onClick={() => {
                    const files = [...(d.contextSpec?.files || []), { path: '', description: '' }];
                    set({ contextSpec: { files } });
                  }}>+ Add file</button>
                )}
              </section>
              {d.generatedBy && (
                <section>
                  <h3>Provenance</h3>
                  <pre>Generated by: {d.generatedBy}{d.template ? ` (template: ${d.template})` : ''}</pre>
                </section>
              )}
            </>
          )}
        </>}

        {node.type === 'aiStep' && <>
          <section>
            <h3>Title</h3>
            <input value={d.title ?? ''} placeholder="AI step" disabled={readOnly} onChange={e => set({ title: e.target.value })} />
          </section>
          <section>
            <h3>Role</h3>
            <select value={d.role ?? 'custom'} disabled={readOnly} onChange={e => set({ role: e.target.value })}>
              {AI_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </section>
          {d.role === 'evaluation' && (
            <section>
              <h3>Evaluation type</h3>
              <select value={d.evalType ?? 'step'} disabled={readOnly} onChange={e => set({ evalType: e.target.value })}>
                {Object.keys(EVAL_TYPES).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </section>
          )}
          {d.role === 'translate' && (
            <section>
              <h3>Target language</h3>
              <input value={d.language ?? ''} placeholder="English" disabled={readOnly}
                onChange={e => set({ language: e.target.value || undefined })} />
            </section>
          )}
          <section>
            <h3>Effort level</h3>
            <select value={d.effort ?? DEFAULT_EFFORT} disabled={readOnly} onChange={e => set({ effort: e.target.value })}>
              {EFFORT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </section>
          <section>
            <h3>System prompt — blank uses the role default</h3>
            <textarea rows={5} value={d.system ?? ''} disabled={readOnly} onChange={e => set({ system: e.target.value })} />
          </section>
          <section>
            <h3>Worker</h3>
            <WorkerPicker worker={d.worker} models={models} activeModels={activeModels} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
          </section>
        </>}

        {node.type === 'orchestrator' && <>
          <section>
            <h3>Orchestrator</h3>
            <pre>{'Plans autonomously at run time: one AI call decides the work nodes, they are created inside this box and run — parallel where possible — with no human intervention. Downstream nodes receive the aggregated results.'}</pre>
          </section>
          <section>
            <h3>Title</h3>
            <input value={d.title ?? ''} placeholder="Orchestrator" onChange={e => set({ title: e.target.value })} />
          </section>
          <section>
            <h3>Goal — what the orchestrated work must achieve</h3>
            <textarea rows={3} placeholder="(optional — the upstream task list drives the plan)"
              value={d.goal ?? ''} onChange={e => set({ goal: e.target.value || undefined })} />
          </section>
          <section>
            <h3>Spawned nodes — minimum / maximum</h3>
            <div className="nodes-editor-row">
              <select
                aria-label="Minimum spawned nodes"
                value={d.minNodes ?? 1}
                onChange={e => {
                  const min = Number(e.target.value);
                  set({ minNodes: min, ...(min > (d.maxNodes ?? 5) ? { maxNodes: min } : {}) });
                }}
              >
                {Array.from({ length: 20 }, (_, i) => i + 1).map(n => <option key={n} value={n}>min {n}</option>)}
              </select>
              <select
                aria-label="Maximum spawned nodes"
                value={d.maxNodes ?? 5}
                onChange={e => {
                  const max = Number(e.target.value);
                  set({ maxNodes: max, ...(max < (d.minNodes ?? 1) ? { minNodes: max } : {}) });
                }}
              >
                {Array.from({ length: 20 }, (_, i) => i + 1).map(n => <option key={n} value={n}>max {n}</option>)}
              </select>
            </div>
            <div className="settings-hint">
              Bounds how many work nodes the planning call may create (default 1–5).
            </div>
          </section>
          <section>
            <h3>Effort level</h3>
            <select value={d.effort ?? DEFAULT_EFFORT} onChange={e => set({ effort: e.target.value })}>
              {EFFORT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </section>
          <section>
            <h3>Extra instructions — appended to the planning prompt</h3>
            <textarea rows={4} placeholder="(optional) e.g. prefer few, larger nodes; always include a test node…"
              value={d.instructions ?? ''} onChange={e => set({ instructions: e.target.value || undefined })} />
          </section>
          <section>
            <h3>Planner worker</h3>
            <WorkerPicker worker={d.worker} models={models} activeModels={activeModels} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
          </section>
          <section>
            <h3>Creates</h3>
            <pre>{nodePorts(node).map(p => `${p.label} — ${p.description}`).join('\n')}</pre>
          </section>
        </>}

        {node.type === 'output' && (
          <section>
            <h3>Output</h3>
            <pre>Collects every upstream node's output into result.md when the flow runs.</pre>
          </section>
        )}

        {(node.type === 'agentTask' || node.type === 'aiStep' || node.type === 'orchestrator') && !readOnly && (
          <section>
            <label className="check-row">
              <input type="checkbox" checked={Boolean(d.requiresApproval)}
                onChange={e => set({ requiresApproval: e.target.checked })} />
              Pause for human approval before this step
            </label>
          </section>
        )}

        {node.parentId && (
          <ContainmentSection
            parent={flow.nodes.find(n => n.id === node.parentId)}
            onDetach={onDetachNode ? () => onDetachNode(node.id) : null}
          />
        )}
        {!readOnly && !isStructuralNode(node) && (
          <section>
            <button className="reject" onClick={() => onDeleteNode(node.id)}>Delete node</button>
          </section>
        )}
        {isStructuralNode(node) && (
          <section>
            <div className="settings-hint">
              {node.type === 'input' ? 'User Input' : 'Output'} is a pinned structural node — every flow keeps one, so it cannot be deleted.
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

// --- Template-instance editor -----------------------------------------------
// A workflow node that references a Node Library template. Fields show the
// EFFECTIVE value; anything changed here lands in node.overrides and is
// clearly marked "override (this workflow only)". Clearing an override
// reverts to the template default. Templates are edited on the Nodes page.

function OverrideTag({ active, onReset, label = 'override (this workflow only)', defaultLabel = 'template default' }) {
  if (!active) return <span className="override-tag default">{defaultLabel}</span>;
  return (
    <span className="override-tag">
      {label}
      {onReset && <button type="button" className="ghost mini" onClick={onReset} title="Revert to the template default">↺</button>}
    </span>
  );
}

// Containment: the node lives inside an orchestrator's box and runs in its
// inline sub-walk (no planning call — the canvas placement was the plan).
// One way out, stated plainly.
function ContainmentSection({ parent, onDetach }) {
  if (!parent) return null;
  return (
    <section>
      <h3>Inside {nodeLabel(parent)}</h3>
      <pre>This node runs inside the orchestrator&rsquo;s box when the flow runs — the box skips its own planning and runs exactly the nodes placed inside.</pre>
      {onDetach && <button className="ghost mini" onClick={onDetach}>Remove from box</button>}
    </section>
  );
}

function InstanceInspector({ node, parent, template, models, activeModels, onChangeOverrides, onDeleteNode, onDetachNode, banner = null }) {
  const ov = node.overrides ?? {};
  const eff = resolveInstance(node, template).data; // effective (merged) values
  const set = patch => onChangeOverrides(node.id, patch);
  const unset = key => onChangeOverrides(node.id, { [key]: undefined });

  return (
    <aside className="inspector">
      {banner}
      <div className="inspector-header">
        <span className="node-icon">{template?.icon ?? '✦'}</span>
        <div className="inspector-title">
          <h2>{eff.title}</h2>
          <div className="node-sub">{template ? `${template.name} · from the Node Library` : `missing template "${node.templateId}"`}</div>
        </div>
        <span className="status-pill pill-accent">ai</span>
      </div>
      <div className="inspector-body node-editor">
        {!template && (
          <section>
            <h3>Missing template</h3>
            <pre>{`This node references "${node.templateId}", which no longer exists in the Node Library. Re-create it on the Nodes page or delete this node.`}</pre>
          </section>
        )}

        <section>
          <h3>Title <OverrideTag active={ov.title != null} onReset={() => unset('title')} /></h3>
          <input
            value={ov.title ?? ''}
            placeholder={template?.name ?? node.templateId}
            onChange={e => set({ title: e.target.value || undefined })}
          />
        </section>

        {template?.id === 'work' && (
          <section>
            <h3>Task type <OverrideTag active={ov.category != null} onReset={() => unset('category')} /></h3>
            <select value={eff.category ?? WORK_CATEGORIES[0]} onChange={e => set({ category: e.target.value })}>
              {WORK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="settings-hint">
              Picks the tools and the default model. Test-creation can run commands, so it gates each call by default.
            </div>
          </section>
        )}

        {template?.role === 'evaluation' && (
          <section>
            <h3>Evaluation type <OverrideTag active={ov.evalType != null} onReset={() => unset('evalType')} /></h3>
            <select value={eff.evalType ?? 'step'} onChange={e => set({ evalType: e.target.value })}>
              <option value="plan">Plan evaluation — creates the work nodes</option>
              <option value="step">Step evaluation — pass / retry / escalate</option>
              <option value="final">Final evaluation — completeness report</option>
            </select>
          </section>
        )}

        <section>
          <h3>Effort level <OverrideTag active={ov.effort != null} onReset={() => unset('effort')} /></h3>
          <select value={eff.effort ?? DEFAULT_EFFORT} onChange={e => set({ effort: e.target.value })}>
            {EFFORT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <div className="settings-hint">
            Drives the default model pick and the response budget. An explicit worker below overrides the model choice.
          </div>
        </section>

        {eff.role === 'translate' && (
          <section>
            <h3>Target language <OverrideTag active={ov.language != null} onReset={() => unset('language')} /></h3>
            <input
              value={ov.language ?? ''}
              placeholder={eff.language ?? 'English'}
              onChange={e => set({ language: e.target.value || undefined })}
            />
          </section>
        )}

        <section>
          <h3>Worker <OverrideTag active={ov.worker != null} onReset={() => unset('worker')} /></h3>
          {ov.worker == null && (
            <pre>{template?.worker
              ? `${template.worker.provider}/${template.worker.model} (template)`
              : 'app default worker (template)'}</pre>
          )}
          {ov.worker != null
            ? <WorkerPicker worker={ov.worker} models={models} activeModels={activeModels} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
            : <button type="button" className="ghost mini"
                onClick={() => set({ worker: template?.worker ?? { provider: 'mock', model: 'mock-large' } })}>
                Override worker for this workflow
              </button>}
        </section>

        <section>
          <h3>Extra instructions <OverrideTag active={Boolean(ov.instructions)} onReset={() => unset('instructions')} /></h3>
          {template?.instructions?.trim() && (
            <pre className="muted">{`Template instructions:\n${template.instructions.trim()}`}</pre>
          )}
          <textarea
            rows={4}
            placeholder="Appended after the template's instructions — this workflow only."
            value={ov.instructions ?? ''}
            onChange={e => set({ instructions: e.target.value || undefined })}
          />
        </section>

        <section>
          <h3>Goal — what this node must produce in this workflow</h3>
          <textarea
            rows={3}
            placeholder="(optional — the task description and upstream context drive the prompt)"
            value={ov.goal ?? ''}
            onChange={e => set({ goal: e.target.value || undefined })}
          />
        </section>

        {(template?.baseType === 'agentTask' || template?.baseType === 'aiStep') && (
          <section>
            <h3>Tools <OverrideTag active={ov.tools != null} onReset={() => unset('tools')} /></h3>
            {/* An aiStep is offered read-effect tools only: anything else is
                dropped at run time (TOOLS-PLAN §6.4), and a checkbox for a
                tool that will be dropped is worse than no checkbox. */}
            {grantableTools(template?.baseType).map(tool => {
              const effective = ov.tools ?? template?.tools ?? grantableTools(template?.baseType);
              return (
                <label className="check-row" key={tool}>
                  <input
                    type="checkbox"
                    checked={effective.includes(tool)}
                    onChange={() => {
                      const next = effective.includes(tool)
                        ? effective.filter(t => t !== tool)
                        : [...effective, tool];
                      set({ tools: next });
                    }}
                  />
                  <span className="mono">{tool}</span>
                </label>
              );
            })}
          </section>
        )}

        <section>
          <h3>Approval <OverrideTag active={ov.requiresApproval != null || ov.approveToolCalls != null} onReset={() => { unset('requiresApproval'); unset('approveToolCalls'); }} /></h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={Boolean(eff.requiresApproval)}
              onChange={e => set({ requiresApproval: e.target.checked })}
            />
            Pause for human approval before this node runs
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={Boolean(eff.approveToolCalls)}
              onChange={e => set({ approveToolCalls: e.target.checked })}
            />
            Pause before each file/shell tool call (approve every write &amp; command)
          </label>
        </section>

        <section>
          <h3>Context spec <OverrideTag active={ov.contextSpec != null} onReset={() => unset('contextSpec')} /></h3>
          <div className="settings-hint">
            Only these files (with the given descriptions) are given to the node. Leave empty for normal upstream context.
          </div>
          {(ov.contextSpec?.files ?? []).map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                style={{ flex: '1 1 40%' }}
                placeholder="path/to/file"
                value={f.path || ''}
                onChange={e => {
                  const files = [...(ov.contextSpec?.files || [])];
                  files[i] = { ...files[i], path: e.target.value };
                  set({ contextSpec: { files } });
                }}
              />
              <input
                style={{ flex: '1 1 60%' }}
                placeholder="Exactly which part is needed (keeps context small)"
                value={f.description || ''}
                onChange={e => {
                  const files = [...(ov.contextSpec?.files || [])];
                  files[i] = { ...files[i], description: e.target.value };
                  set({ contextSpec: { files } });
                }}
              />
              <button type="button" onClick={() => {
                const files = (ov.contextSpec?.files || []).filter((_, idx) => idx !== i);
                set({ contextSpec: files.length ? { files } : undefined });
              }}>✕</button>
            </div>
          ))}
          <button type="button" className="ghost mini" onClick={() => {
            const files = [...(ov.contextSpec?.files || []), { path: '', description: '' }];
            set({ contextSpec: { files } });
          }}>+ Add file</button>
        </section>

        {parent && (
          <ContainmentSection
            parent={parent}
            onDetach={onDetachNode ? () => onDetachNode(node.id) : null}
          />
        )}
        <section>
          <button className="reject" onClick={() => onDeleteNode(node.id)}>Delete node</button>
        </section>
      </div>
    </aside>
  );
}

// --- Config edit target (CONFIGS-COMPARE P1) ---------------------------------
// The Inspector's Config mode: shows/edits ONE config's override map for the
// selected node. Fields are exactly the launch-override whitelist for that
// node (overridableFields — the same set the runner enforces and the linter
// checks), shown with the same override tags as the flow editor. Values
// display EFFECTIVE (flow default + this config's override layered on);
// writes land only in the config; clearing a field removes it from the config.
function ConfigNodeEditor({ node, mode, template, models, activeModels, onChangeConfigOverrides, banner = null }) {
  const ov = mode.overrides?.[node.id] ?? {};
  // Effective values: the flow default with this config's overrides on top —
  // for an instance, through the template merge; for a raw node, onto data.
  const effNode = node.templateId
    ? resolveInstance({ ...node, overrides: { ...(node.overrides ?? {}), ...ov } }, template)
    : { ...node, data: { ...(node.data ?? {}), ...ov } };
  const eff = effNode.data ?? {};
  const allowed = overridableFields(effNode);
  const set = patch => onChangeConfigOverrides(mode.id, node.id, patch);
  const unset = key => set({ [key]: undefined });
  const tag = field => <OverrideTag active={ov[field] !== undefined} onReset={() => unset(field)} label="config override" defaultLabel="flow default" />;
  const has = f => allowed.has(f);

  return (
    <aside className="inspector">
      {banner}
      <div className="inspector-header">
        <span className="node-icon">{template?.icon ?? TYPE_META[node.type]?.icon ?? '▢'}</span>
        <div className="inspector-title">
          <h2>{eff.title ?? node.id}</h2>
          <div className="node-sub">config ◑ {mode.name || mode.id} · overrides for this node</div>
        </div>
        <span className="status-pill pill-accent">config</span>
      </div>
      <div className="inspector-body node-editor">
        {allowed.size === 0 ? (
          <section>
            <h3>No overridable fields</h3>
            <pre>{node.type} nodes accept no launch overrides — configs cannot change this node.</pre>
          </section>
        ) : (
          <>
            {has('worker') && (
              <section>
                <h3>Worker {tag('worker')}</h3>
                {ov.worker == null && (
                  <pre>{eff.worker ? `${eff.worker.provider}/${eff.worker.model} (flow default)` : 'app default worker (flow default)'}</pre>
                )}
                {ov.worker != null
                  ? <WorkerPicker worker={ov.worker} models={models} activeModels={activeModels} idPrefix={`c-${node.id}`} onChange={worker => set({ worker })} />
                  : <button type="button" className="ghost mini"
                      onClick={() => set({ worker: eff.worker ?? { provider: 'mock', model: 'mock-large' } })}>
                      Set a worker for this config
                    </button>}
              </section>
            )}

            {has('effort') && (
              <section>
                <h3>Effort level {tag('effort')}</h3>
                <select value={eff.effort ?? DEFAULT_EFFORT} onChange={e => set({ effort: e.target.value })}>
                  {EFFORT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </section>
            )}

            {has('category') && (
              <section>
                <h3>Task type {tag('category')}</h3>
                <select value={eff.category ?? WORK_CATEGORIES[0]} onChange={e => set({ category: e.target.value })}>
                  {WORK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </section>
            )}

            {has('evalType') && (
              <section>
                <h3>Evaluation type {tag('evalType')}</h3>
                <select value={eff.evalType ?? 'step'} onChange={e => set({ evalType: e.target.value })}>
                  <option value="plan">Plan evaluation — creates the work nodes</option>
                  <option value="step">Step evaluation — pass / retry / escalate</option>
                  <option value="final">Final evaluation — completeness report</option>
                </select>
              </section>
            )}

            {has('language') && (
              <section>
                <h3>Target language {tag('language')}</h3>
                <input
                  value={ov.language ?? ''}
                  placeholder={eff.language ?? 'English'}
                  onChange={e => set({ language: e.target.value || undefined })}
                />
              </section>
            )}

            {(has('minNodes') || has('maxNodes')) && (
              <section>
                <h3>Spawned nodes — minimum / maximum {tag('minNodes')}{has('maxNodes') && tag('maxNodes')}</h3>
                <div className="nodes-editor-row">
                  <select
                    aria-label="Minimum spawned nodes"
                    value={eff.minNodes ?? 1}
                    onChange={e => {
                      const min = Number(e.target.value);
                      set({ minNodes: min, ...(min > (eff.maxNodes ?? 5) ? { maxNodes: min } : {}) });
                    }}
                  >
                    {Array.from({ length: 20 }, (_, i) => i + 1).map(n => <option key={n} value={n}>min {n}</option>)}
                  </select>
                  <select
                    aria-label="Maximum spawned nodes"
                    value={eff.maxNodes ?? 5}
                    onChange={e => {
                      const max = Number(e.target.value);
                      set({ maxNodes: max, ...(max < (eff.minNodes ?? 1) ? { minNodes: max } : {}) });
                    }}
                  >
                    {Array.from({ length: 20 }, (_, i) => i + 1).map(n => <option key={n} value={n}>max {n}</option>)}
                  </select>
                </div>
              </section>
            )}

            {has('system') && (
              <section>
                <h3>System prompt {tag('system')}</h3>
                <textarea
                  rows={5}
                  placeholder="(blank — the role default is used)"
                  value={ov.system ?? ''}
                  onChange={e => set({ system: e.target.value || undefined })}
                />
              </section>
            )}

            {has('instructions') && (
              <section>
                <h3>Extra instructions {tag('instructions')}</h3>
                <textarea
                  rows={4}
                  placeholder="(blank — no extra instructions from this config)"
                  value={ov.instructions ?? ''}
                  onChange={e => set({ instructions: e.target.value || undefined })}
                />
              </section>
            )}

            {has('tools') && (
              <section>
                <h3>Tools {tag('tools')}</h3>
                {grantableTools(eff.type ?? node?.type).map(tool => {
                  const effective = ov.tools ?? eff.tools ?? grantableTools(eff.type ?? node?.type);
                  return (
                    <label className="check-row" key={tool}>
                      <input
                        type="checkbox"
                        checked={effective.includes(tool)}
                        onChange={() => {
                          const next = effective.includes(tool)
                            ? effective.filter(t => t !== tool)
                            : [...effective, tool];
                          set({ tools: next });
                        }}
                      />
                      <span className="mono">{tool}</span>
                    </label>
                  );
                })}
              </section>
            )}

            {(has('requiresApproval') || has('approveToolCalls')) && (
              <section>
                <h3>Approval {tag('requiresApproval')}{tag('approveToolCalls')}</h3>
                {has('requiresApproval') && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={Boolean(eff.requiresApproval)}
                      onChange={e => set({ requiresApproval: e.target.checked })}
                    />
                    Pause for human approval before this node runs
                  </label>
                )}
                {has('approveToolCalls') && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={Boolean(eff.approveToolCalls)}
                      onChange={e => set({ approveToolCalls: e.target.checked })}
                    />
                    Pause before each file/shell tool call (approve every write &amp; command)
                  </label>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

// What the agent actually did with its tools: one entry per call, straight
// from the executor retrospective ({ tool, args, ok, result|error, ms }).
function toolCallsSection(retro) {
  const calls = retro?.toolCalls;
  if (!calls?.length) return null;
  const lines = calls.map(c => [
    `[${c.ok ? 'ok' : 'FAILED'}] ${c.tool}${c.ms != null ? ` · ${c.ms} ms` : ''}`,
    c.args !== undefined ? `  args: ${JSON.stringify(c.args)}` : null,
    c.ok
      ? (c.result !== undefined ? `  result${c.truncated ? ' (preview)' : ''}: ${JSON.stringify(c.result)}` : null)
      : `  error: ${c.error}`,
    c.artifact
      ? `  full result: ${c.artifact}${c.bytes ? ` (${c.bytes.toLocaleString('en-US')} bytes)` : ''}${c.handle ? ` · ${c.handle}` : ''}`
      : null
  ].filter(Boolean).join('\n'));
  return [`Tool calls (${calls.length})`, lines.join('\n\n'), calls.filter(c => c.artifact).map(c => c.artifact)];
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
// Since P2 the result shown here may be a bounded preview — the full,
// untruncated result is the artifact named on the last line, and the whole
// point of writing it is that you can go and read it.
