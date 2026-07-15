import React from 'react';
import {
  TYPE_META, AI_ROLES, NODE_CATEGORIES, NODE_TEMPLATES, AGENT_TOOLS,
  nodeLabel, isInstance, resolveInstance, nodePorts
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
  const { meta, prompt, plan, tasks, retrospectives, taskOutputs, flow, nodeOutputs } = snapshot;

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
    // Flow-run node: artifacts by node type, straight from the run's files.
    title = nodeLabel(flowNode);
    icon = TYPE_META[flowNode.type]?.icon ?? '▢';
    typeLabel = `${TYPE_META[flowNode.type]?.label.toLowerCase() ?? flowNode.type} · ${flowNode.kind}`;
    status = meta.nodeStatus?.[selectedNode];
    if (flowNode.type === 'input') {
      sections = [['prompt.md', prompt]];
    } else if (flowNode.type === 'agentTask') {
      const task = tasks?.tasks.find(t => t.id === flowNode.data?.taskId);
      sections = [
        ['Goal', flowNode.data?.goal || '(none)'],
        flowNode.data?.constraints?.length ? ['Constraints', flowNode.data.constraints.join('\n')] : null,
        task ? [`Output — ${task.id}`, taskOutputs?.[task.id] ?? '(not yet produced)'] : ['Output', '(task not yet created)'],
        task ? toolCallsSection(retrospectives?.[`executor-${task.id}`]) : null,
        task ? retroSection(retrospectives?.[`executor-${task.id}`]) : null
      ];
    } else if (flowNode.type === 'aiStep') {
      sections = [
        [`nodes/${flowNode.id}.md`, nodeOutputs?.[flowNode.id] ?? '(not yet produced)'],
        retroSection(retrospectives?.[flowNode.id])
      ];
    } else if (flowNode.type === 'orchestrator') {
      // Port sidecars are stored with sanitized filenames (id.port -> id_port).
      const sidecar = port => nodeOutputs?.[`${flowNode.id}_${port}`.replace(/[^a-zA-Z0-9_-]/g, '_')];
      const children = flow.nodes.filter(n => n.data?.managedBy === flowNode.id);
      sections = [
        ['Orchestration plan', sidecar('plan') ?? '(not yet produced)'],
        children.length
          ? ['Created nodes', children.map(n => `${n.id} [${meta.nodeStatus?.[n.id] ?? 'pending'}] — ${n.data?.title ?? n.id}`).join('\n')]
          : ['Created nodes', '(none yet — nodes appear inside the box once planning completes)'],
        ['Aggregated results', nodeOutputs?.[flowNode.id] ?? '(not yet produced)'],
        retroSection(retrospectives?.[flowNode.id])
      ];
    } else {
      sections = [['result.md', nodeOutputs?.[flowNode.id] ?? '(not yet produced)']];
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

// --- Flow-definition editing (flow builder view) ---
// Same aside, but the sections are editable fields writing through to the
// flow definition via onChangeData. Worker pickers mirror the Settings page.

const MOCK_MODELS = ['mock-large', 'mock-small'];

export function WorkerPicker({ worker, models, onChange, idPrefix }) {
  const w = worker?.provider ? worker : { provider: 'mock', model: 'mock-large' };
  const setProvider = provider => {
    if (provider === 'mock') onChange({ provider, model: MOCK_MODELS.includes(w.model) ? w.model : MOCK_MODELS[0] });
    else onChange({ provider, model: MOCK_MODELS.includes(w.model) ? (models[0]?.id ?? '') : w.model });
  };
  return (
    <div className="worker-picker">
      <select value={w.provider} onChange={e => setProvider(e.target.value)} aria-label="provider">
        <option value="mock">mock</option>
        <option value="openrouter">openrouter</option>
      </select>
      {w.provider === 'mock' ? (
        <select value={w.model} onChange={e => onChange({ ...w, model: e.target.value })} aria-label="model">
          {MOCK_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <>
          <input
            list={`${idPrefix}-models`}
            value={w.model}
            placeholder={models.length ? 'Pick or type a model id' : 'e.g. openai/gpt-4o-mini'}
            onChange={e => onChange({ ...w, model: e.target.value })}
            aria-label="model"
          />
          <datalist id={`${idPrefix}-models`}>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </datalist>
        </>
      )}
    </div>
  );
}

export function FlowInspector({ flow, selectedNode, models, templates, onChangeData, onChangeOverrides, onDeleteNode }) {
  const node = flow.nodes.find(n => n.id === selectedNode);

  if (!node) {
    return (
      <aside className="inspector">
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
            <pre>Select a node to edit it, drag between handles to connect, or add nodes from the palette above the canvas.</pre>
          </section>
        </div>
      </aside>
    );
  }

  // Template instances get the override editor: template defaults come from
  // the Node Library; every change here is saved in this workflow only.
  if (isInstance(node)) {
    return (
      <InstanceInspector
        node={node}
        template={templates?.find(t => t.id === node.templateId) ?? null}
        models={models}
        onChangeOverrides={onChangeOverrides}
        onDeleteNode={onDeleteNode}
      />
    );
  }

  const meta = TYPE_META[node.type] ?? { icon: '▢', label: node.type };
  const set = patch => onChangeData(node.id, patch);
  const d = node.data ?? {};
  const readOnly = false;

  return (
    <aside className="inspector">
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
            <WorkerPicker worker={d.worker} models={models} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
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
          <section>
            <h3>System prompt — blank uses the role default</h3>
            <textarea rows={5} value={d.system ?? ''} disabled={readOnly} onChange={e => set({ system: e.target.value })} />
          </section>
          <section>
            <h3>Worker</h3>
            <WorkerPicker worker={d.worker} models={models} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
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
            <h3>Extra instructions — appended to the planning prompt</h3>
            <textarea rows={4} placeholder="(optional) e.g. prefer few, larger nodes; always include a test node…"
              value={d.instructions ?? ''} onChange={e => set({ instructions: e.target.value || undefined })} />
          </section>
          <section>
            <h3>Planner worker</h3>
            <WorkerPicker worker={d.worker} models={models} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
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

        {!readOnly && (
          <section>
            <button className="reject" onClick={() => onDeleteNode(node.id)}>Delete node</button>
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

function OverrideTag({ active, onReset }) {
  if (!active) return <span className="override-tag default">template default</span>;
  return (
    <span className="override-tag">
      override (this workflow only)
      {onReset && <button type="button" className="ghost mini" onClick={onReset} title="Revert to the template default">↺</button>}
    </span>
  );
}

function InstanceInspector({ node, template, models, onChangeOverrides, onDeleteNode }) {
  const ov = node.overrides ?? {};
  const eff = resolveInstance(node, template).data; // effective (merged) values
  const set = patch => onChangeOverrides(node.id, patch);
  const unset = key => onChangeOverrides(node.id, { [key]: undefined });

  return (
    <aside className="inspector">
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

        <section>
          <h3>Worker <OverrideTag active={ov.worker != null} onReset={() => unset('worker')} /></h3>
          {ov.worker == null && (
            <pre>{template?.worker
              ? `${template.worker.provider}/${template.worker.model} (template)`
              : 'app default worker (template)'}</pre>
          )}
          {ov.worker != null
            ? <WorkerPicker worker={ov.worker} models={models} idPrefix={`w-${node.id}`} onChange={worker => set({ worker })} />
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

        {template?.baseType === 'agentTask' && (
          <section>
            <h3>Tools <OverrideTag active={ov.tools != null} onReset={() => unset('tools')} /></h3>
            {AGENT_TOOLS.map(tool => {
              const effective = ov.tools ?? template?.tools ?? AGENT_TOOLS;
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

        <section>
          <button className="reject" onClick={() => onDeleteNode(node.id)}>Delete node</button>
        </section>
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
      ? (c.result !== undefined ? `  result: ${JSON.stringify(c.result)}` : null)
      : `  error: ${c.error}`
  ].filter(Boolean).join('\n'));
  return [`Tool calls (${calls.length})`, lines.join('\n\n')];
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
