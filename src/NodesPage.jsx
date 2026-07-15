import React, { useEffect, useState } from 'react';
import { WorkerPicker } from './Inspector.jsx';
import { AI_ROLES, NODE_CATEGORIES, AGENT_TOOLS } from './flowTypes.js';

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

export default function NodesPage({ templates, selectedId, models, onChanged, onSelect }) {
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState('');

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
      await window.llmflow.saveNodeTemplate(draft);
      setSaved(true);
      await onChanged();
    } catch (err) {
      setError(String(err.message ?? err));
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!window.confirm(`Delete node template "${draft.name}"?\n\nWorkflows using it will flag the missing template.`)) return;
    await window.llmflow.deleteNodeTemplate(draft.id);
    onSelect?.(null);
    await onChanged();
  };

  const toggleTool = tool => {
    // tools: null = full registry; an explicit array otherwise.
    const current = draft.tools ?? [...AGENT_TOOLS];
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
              <WorkerPicker worker={draft.worker} models={models} idPrefix={`tpl-${draft.id}`}
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

          {draft.baseType === 'agentTask' && (
            <section>
              <h3>Tool availability</h3>
              {AGENT_TOOLS.map(tool => (
                <label className="check-row" key={tool}>
                  <input
                    type="checkbox"
                    checked={(draft.tools ?? AGENT_TOOLS).includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  <span className="mono">{tool}</span>
                </label>
              ))}
            </section>
          )}

          <section>
            <h3>Skills — comma-separated (optional)</h3>
            <input
              value={(draft.skills ?? []).join(', ')}
              placeholder="e.g. refactoring, api-design"
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
