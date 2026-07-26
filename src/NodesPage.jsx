import React, { useEffect, useState } from 'react';
import { WorkerPicker } from './Inspector.jsx';
import { AI_ROLES, NODE_CATEGORIES, AGENT_TOOLS, EFFORT_LEVELS, DEFAULT_EFFORT, EVAL_TYPES } from './flowTypes.js';
import { CONFIG_DIR } from '../core/brand.js';

// Node Library editor: edit/save/delete the reusable AI node template selected
// in the explorer (the list lives in the sidebar so Library shares the one
// explorer→editor model with Flows and Runs). Templates are plain files
// (nodes/<id>.json); this is a thin CRUD editor over them. Templates carry no
// hand-written prompts — instructions are short guidance appended to the
// auto-generated prompt; the template constrains HOW (model, tools, skills),
// never WHAT.

const BASE_TYPES = [
  { value: 'aiStep', label: 'AI step — single model call' },
  { value: 'agentTask', label: 'Agent task — full executor with tools' }
];

export default function NodesPage({ templates, tools = [], selectedId, models, activeModels, mockEnabled = false, onChanged, onSelect }) {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState('');

  // What this template may be granted, from the tool library (tools/<id>.json)
  // — falling back to the shipped built-ins before the first IPC round trip.
  // An AI step gets read-effect tools only: anything else is dropped at run
  // time (TOOLS-PLAN §6.4), so offering it here would be a lie.
  const grantable = tools
    .filter(t => t.enabled && (draft?.baseType === 'agentTask' || (t.effects ?? []).every(e => e === 'read')))
    .map(t => t.id);
  const toolIds = grantable.length ? grantable : AGENT_TOOLS;
  const toolMeta = Object.fromEntries(tools.map(t => [t.id, t]));

  // Load the selected template into the draft (fresh copy, never live-edited).
  useEffect(() => {
    const tpl = templates.find(t => t.id === selectedId) ?? null;
    setDraft(tpl ? structuredClone(tpl) : null);
    setSaved(true);
    setError('');
  }, [selectedId, templates]);

  const set = patch => { setDraft(d => ({ ...d, ...patch })); setSaved(false); };

  const save = async () => {
    if (!draft) return;
    setError('');
    try {
      await window.flyt.saveNodeTemplate(draft);
      setSaved(true);
      await onChanged();
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!window.confirm(`Delete node template "${draft.name}"?\n\nWorkflows using it will flag the missing template.`)) return;
    await window.flyt.deleteNodeTemplate(draft.id);
    onSelect?.(null);
    await onChanged();
  };

  const toggleTool = tool => {
    // tools: null = full registry; an explicit array otherwise.
    const current = draft.tools ?? [...toolIds];
    const next = current.includes(tool) ? current.filter(t => t !== tool) : [...current, tool];
    set({ tools: next });
  };

  return (
    <div className="nodes-page">
      {draft ? (
        <div className="nodes-editor node-editor">
          <div className="inspector-header">
            <span className="node-icon">{draft.icon || '✦'}</span>
            <div className="inspector-title">
              <h2>{draft.name}</h2>
              <div className="node-sub mono">nodes/{draft.id}.json</div>
            </div>
            <span className={'save-dot' + (saved ? ' saved' : '')}>{saved ? 'Saved' : 'Unsaved'}</span>
          </div>

          <section>
            <h3>Name</h3>
            <input value={draft.name} onChange={e => set({ name: e.target.value })} />
          </section>
          <section>
            <h3>Description — shown in the palette</h3>
            <textarea rows={2} value={draft.description ?? ''} onChange={e => set({ description: e.target.value })} />
          </section>
          <div className="nodes-editor-row">
            <section>
              <h3>Icon</h3>
              <input value={draft.icon ?? ''} maxLength={4} onChange={e => set({ icon: e.target.value })} />
            </section>
            <section>
              <h3>Category (drives model selection)</h3>
              <select value={draft.category ?? ''} onChange={e => set({ category: e.target.value || null })}>
                <option value="">(none)</option>
                {NODE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </section>
          </div>
          <div className="nodes-editor-row">
            <section>
              <h3>Execution</h3>
              <select value={draft.baseType} onChange={e => set({ baseType: e.target.value })}>
                {BASE_TYPES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            </section>
            <section>
              <h3>Role (picks the auto-generated prompt)</h3>
              <select value={draft.role} onChange={e => set({ role: e.target.value })}>
                {AI_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </section>
          </div>
          <div className="nodes-editor-row">
            <section>
              <h3>Effort level (default for instances)</h3>
              <select value={draft.effort ?? DEFAULT_EFFORT} onChange={e => set({ effort: e.target.value })}>
                {EFFORT_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </section>
            {draft.role === 'evaluation' && (
              <section>
                <h3>Evaluation type (default)</h3>
                <select value={draft.evalType ?? 'step'} onChange={e => set({ evalType: e.target.value })}>
                  {Object.keys(EVAL_TYPES).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </section>
            )}
            {draft.role === 'translate' && (
              <section>
                <h3>Target language (default)</h3>
                <input value={draft.language ?? ''} placeholder="English" onChange={e => set({ language: e.target.value })} />
              </section>
            )}
          </div>

          <section>
            <h3>Worker (provider + model)</h3>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!draft.worker}
                onChange={e => set({ worker: e.target.checked ? null : { provider: 'mock', model: 'mock-large' } })}
              />
              Use the app default worker
            </label>
            {draft.worker && (
              <WorkerPicker worker={draft.worker} models={models} activeModels={activeModels} idPrefix={`tpl-${draft.id}`}
                onChange={worker => set({ worker })} />
            )}
          </section>

          <section>
            <h3>Extra instructions — appended to the auto-generated prompt</h3>
            <textarea
              rows={4}
              placeholder="Short guidance, not a prompt. The model generates its own working prompt from the task."
              value={draft.instructions ?? ''}
              onChange={e => set({ instructions: e.target.value })}
            />
          </section>

          {toolIds.length > 0 && (
            <section>
              <h3>Tool availability{draft.baseType === 'agentTask' ? '' : ' — read-only on an AI step'}</h3>
              {toolIds.map(tool => (
                <label className="check-row" key={tool}>
                  <input
                    type="checkbox"
                    checked={(draft.tools ?? toolIds).includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  <span className="mono">{tool}</span>
                  {toolMeta[tool]?.effects?.length ? (
                    <span className="node-sub"> {toolMeta[tool].effects.join(' · ')}</span>
                  ) : null}
                </label>
              ))}
            </section>
          )}

          <section>
            <h3>Skills — comma-separated (optional)</h3>
            <div className="settings-hint">
              Expertise the <em>bound project</em> supplies. Each name loads{' '}
              <span className="mono">{CONFIG_DIR}/skills/&lt;name&gt;.md</span> from the run's workspace and
              appends it to this node's prompt — so the same template follows each project's own
              conventions. A name with no file is skipped and recorded in the run log.
            </div>
            <input
              value={(draft.skills ?? []).join(', ')}
              placeholder="e.g. house-style, api-design"
              onChange={e => set({ skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
            />
          </section>

          <section>
            <label className="check-row">
              <input
                type="checkbox"
                checked={Boolean(draft.requiresApproval)}
                onChange={e => set({ requiresApproval: e.target.checked })}
              />
              Pause for human approval before this node runs (default)
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={Boolean(draft.approveToolCalls)}
                onChange={e => set({ approveToolCalls: e.target.checked })}
              />
              Pause before each file/shell tool call (approve every write &amp; command)
            </label>
          </section>

          {error && <div className="settings-error mono">{error}</div>}

          <section className="nodes-editor-actions">
            <button className="primary" onClick={save} disabled={saved}>Save template</button>
            <button className="reject" onClick={remove}>Delete template</button>
          </section>
        </div>
      ) : (
        <div className="empty-state">
          <span className="section-label">Node Library</span>
          Create a node template to start building workflows from it.
        </div>
      )}
    </div>
  );
}
