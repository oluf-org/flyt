import React, { useState } from 'react';

// The node's prompt (PIVOT-PLAN §5.2) and its retry/timeout limits.
//
// The prompt field is the pivot's most visible change to the graph. `GOALS.md`
// used to state as non-negotiable that "templates do not contain hand-written
// prompts" — the model generated its own from the task and upstream context,
// and the template only constrained HOW. Decision 2 inverts that. The
// replacement principle, and the reason this component exists:
//
//   Nothing is sent to a model that the user cannot see and could not have
//   written. Prompts are authored artifacts. A model may draft one; it may
//   never conjure one at runtime.
//
// *Draft with AI* therefore FILLS THE FIELD — it never bypasses it. That is the
// same separation src/ToolCopilot.jsx already relies on for tool trust: the
// model produces a draft, and adding it is a separate human gesture. It is
// load-bearing there and it is load-bearing here.

export default function PromptField({
  value, inherited = null, onChange, onDraft = null, overrideTag = null, rows = 8
}) {
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);

  const runDraft = async () => {
    if (!onDraft) return;
    setDrafting(true);
    setError(null);
    try {
      const text = await onDraft();
      if (text?.trim()) setDraft(text.trim());
      else setError('The model returned nothing to use.');
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setDrafting(false);
    }
  };

  return (
    <section className="prompt-field">
      <h3>Prompt {overrideTag}</h3>
      <div className="settings-hint">
        What this node tells its model, every run. Assembled upstream context is added
        automatically — you do not need to ask for it.
      </div>
      {inherited?.trim() && value == null && (
        <pre className="muted">{`From the template:\n${inherited.trim()}`}</pre>
      )}
      <textarea
        rows={rows}
        className="prompt-textarea"
        placeholder={inherited?.trim()
          ? 'Write here to replace the template’s prompt for this workflow.'
          : 'Say what this node should do, and what its output must look like.'}
        value={value ?? ''}
        onChange={e => onChange(e.target.value || undefined)}
      />
      <div className="prompt-actions">
        {onDraft && (
          <button type="button" className="ghost mini" onClick={runDraft} disabled={drafting}>
            {drafting ? 'Drafting…' : '✎ Draft with AI'}
          </button>
        )}
        {value?.trim() && (
          <span className="prompt-count mono">{value.trim().length} chars</span>
        )}
      </div>
      {error && <p className="prompt-error">{error}</p>}
      {/* A draft is offered, never applied. Keeping the two apart is the whole
          point: you read what a model wrote before it becomes what you send. */}
      {draft != null && (
        <div className="prompt-draft">
          <div className="prompt-draft-head">
            <span className="section-label">Draft — not yours until you take it</span>
          </div>
          <pre className="prompt-draft-body">{draft}</pre>
          <div className="prompt-actions">
            <button type="button" className="primary mini" onClick={() => { onChange(draft); setDraft(null); }}>
              Use this
            </button>
            <button type="button" className="ghost mini" onClick={() => { onChange(`${(value ?? '').trim()}\n\n${draft}`.trim()); setDraft(null); }}>
              Append
            </button>
            <button type="button" className="ghost mini" onClick={() => setDraft(null)}>Discard</button>
          </div>
        </div>
      )}
    </section>
  );
}

// Retries and timeout as a per-node graph decision (§5.2).
//
// `timeoutMs` is the field that closes the gap DESIGN-SPEC §11.1 recorded: an
// AbortSignal was threaded everywhere, but nothing ever fired it on a timer, so
// a provider that went quiet hung a node forever. Per node rather than global
// because the right answer genuinely differs — a 30-second classifier and a
// ten-minute agent task are not the same call.
const TIMEOUTS = [
  ['', 'App default'],
  ['0', 'No timeout'],
  ['60000', '1 minute'],
  ['300000', '5 minutes'],
  ['600000', '10 minutes'],
  ['1800000', '30 minutes']
];

export function LimitsField({ limits, inherited = null, onChange, overrideTag = null }) {
  const eff = limits ?? inherited ?? {};
  const patch = next => {
    const merged = { ...(limits ?? inherited ?? {}), ...next };
    for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
    onChange(Object.keys(merged).length ? merged : undefined);
  };
  return (
    <section>
      <h3>Retries &amp; timeout {overrideTag}</h3>
      <div className="settings-hint">
        How many tries this node’s model call gets, and how long one try may take before it
        is aborted and retried. Blank follows the app defaults.
      </div>
      <div className="limits-row">
        <label className="limits-cell">
          <span className="limits-label">attempts</span>
          <input
            type="number" min={1} max={20}
            placeholder="default"
            value={eff.attempts ?? ''}
            onChange={e => patch({ attempts: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label className="limits-cell">
          <span className="limits-label">timeout</span>
          <select
            value={eff.timeoutMs == null ? '' : String(eff.timeoutMs)}
            onChange={e => patch({ timeoutMs: e.target.value === '' ? null : Number(e.target.value) })}
          >
            {TIMEOUTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
