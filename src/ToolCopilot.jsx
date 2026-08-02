import React, { useEffect, useRef, useState } from 'react';
import { WorkerPicker } from './Inspector.jsx';
import { parametersOf } from './toolBoard.js';

// The Tool copilot — the left column of the Tool Library page.
//
// Its product job is authoring by description: a sentence, a pasted cURL or a
// spec URL becomes a DRAFT tool card rendered inline in the thread. The draft
// is not a file. `Add to library` is a separate, human gesture, and that
// separation is load-bearing rather than decorative — user-authored tools sit
// at `review` trust (§12.2) precisely because a person looked at one, and a
// copilot that saved its own output would launder model text into that tier.
//
// The model is the user's choice, not the app's. A tool schema is a contract
// an agent reads on every call, so which model drafted it is exactly the kind
// of thing GOALS.md principle 3 says should never be baked in.

const SEED_SUGGESTIONS = [
  'Wrap an OpenAPI endpoint',
  'Turn this cURL into a tool',
  'A tool that reads our status page'
];

export default function ToolCopilot({
  models, activeModels, mockEnabled, categories, existingIds,
  worker, onWorkerChange, onAddDraft, onEditDraft, focusSignal
}) {
  const [thread, setThread] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState(SEED_SUGGESTIONS);
  const [attachment, setAttachment] = useState(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { if (focusSignal) inputRef.current?.focus(); }, [focusSignal]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [thread, busy]);

  // A file dropped anywhere on the page arrives here as an attachment rather
  // than as a sent message: an import is still a brief the user gets to frame
  // ("only the two order endpoints") before the model reads 400 lines of spec.
  useEffect(() => {
    const onImport = e => { setAttachment(e.detail); inputRef.current?.focus(); };
    window.addEventListener('flyt:tool-import', onImport);
    return () => window.removeEventListener('flyt:tool-import', onImport);
  }, []);

  const send = async (text = input, file = attachment) => {
    const brief = String(text ?? '').trim();
    if ((!brief && !file) || busy) return;
    setInput('');
    setAttachment(null);
    const history = thread.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, text: m.text ?? '' }));
    setThread(t => [...t, { role: 'user', text: brief || `(imported ${file?.name})`, file: file?.name ?? null }]);
    setBusy(true);
    try {
      const res = await window.flyt.draftTool({
        brief: brief || `Import this file as one or more tools: ${file?.name}`,
        modelId: worker?.model ?? null,
        attachment: file,
        history
      });
      if (!res?.ok) {
        setThread(t => [...t, { role: 'error', text: res?.error ?? 'The copilot call failed.' }]);
      } else {
        setThread(t => [...t, {
          role: 'assistant',
          text: res.prose,
          draft: res.tool ?? null,
          notes: res.notes ?? '',
          error: res.error ?? null,
          model: res.model,
          saved: false
        }]);
        if (res.suggestions?.length) setSuggestions(res.suggestions);
      }
    } catch (err) {
      setThread(t => [...t, { role: 'error', text: String(err?.message ?? err) }]);
    }
    setBusy(false);
  };

  const add = async (msgIndex, draft) => {
    await onAddDraft(draft);
    // Idempotent by construction: the CTA flips on the message, so a second
    // click has nothing left to press rather than writing the file twice.
    setThread(t => t.map((m, i) => i === msgIndex ? { ...m, saved: true } : m));
  };

  const onKeyDown = e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  };

  return (
    <div className="tool-copilot">
      <div className="tool-copilot-head">
        <span className="section-label">Tool copilot</span>
        <WorkerPicker
          worker={worker}
          models={models}
          activeModels={activeModels}
          mockEnabled={mockEnabled}
          idPrefix="tool-copilot"
          onChange={onWorkerChange}
        />
      </div>

      <div className="tool-thread">
        {thread.length === 0 && (
          <p className="tool-thread-empty">
            Describe a capability, paste a cURL command, or drop a spec on the page. You get a draft
            record to read — nothing is written until you say so.
          </p>
        )}

        {thread.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div className="tool-bubble" key={i}>
                {m.text}
                {m.file && <span className="tool-bubble-file mono">📎 {m.file}</span>}
              </div>
            );
          }
          if (m.role === 'error') {
            return <p className="tool-reply error mono" key={i}>{m.text}</p>;
          }
          return (
            <div key={i}>
              {m.text && <p className="tool-reply">{m.text}</p>}
              {m.error && <p className="tool-reply error mono">{m.error}</p>}
              {m.draft && (
                <DraftCard
                  draft={m.draft}
                  saved={m.saved}
                  categories={categories}
                  collides={!m.saved && existingIds.includes(m.draft.id)}
                  onAdd={() => add(i, m.draft)}
                  onEdit={() => onEditDraft(m.draft)}
                />
              )}
              {m.notes && <p className="tool-reply dim">{m.notes}</p>}
            </div>
          );
        })}
        {busy && <p className="tool-reply dim">Drafting…</p>}
        <div ref={endRef} />
      </div>

      {suggestions.length > 0 && (
        <div className="tool-suggestions">
          {suggestions.map(s => (
            <button key={s} className="tool-chip" onClick={() => send(s)} disabled={busy}>{s}</button>
          ))}
        </div>
      )}

      <div className="tool-composer">
        {attachment && (
          <div className="tool-attachment mono">
            📎 {attachment.name}
            <button className="ghost mini" onClick={() => setAttachment(null)} aria-label="Remove attachment">✕</button>
          </div>
        )}
        <div className="tool-composer-row">
          <input
            ref={inputRef}
            value={input}
            placeholder="Describe a tool, or paste a cURL…"
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Ask the tool copilot"
          />
          <button className="primary tool-send" onClick={() => send()} disabled={busy || (!input.trim() && !attachment)} aria-label="Send">↑</button>
        </div>
        <div className="tool-composer-hint mono">⌘↵ send · drop a file to import</div>
      </div>
    </div>
  );
}

// The draft card, rendered inline in the thread. It shows the same three facts
// the board's cards show — id, category, parameters — so what you approve here
// is recognisably what lands there.
function DraftCard({ draft, saved, categories, collides, onAdd, onEdit }) {
  const category = categories.find(c => c.id === draft.categoryId);
  const params = parametersOf(draft);
  return (
    <div className="tool-draft">
      <div className="tool-draft-head">
        <span className="tool-icon-chip" aria-hidden="true">{category?.icon ?? '✦'}</span>
        <div className="tool-draft-title">
          <strong>{draft.title}</strong>
          <span className="mono tool-draft-id">{draft.id} · {saved ? 'saved' : 'draft'}</span>
        </div>
        {category && <span className="tool-pill">{category.name}</span>}
      </div>

      <pre className="tool-draft-params mono">
        {params.length
          ? params.map(p => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join('\n')
          : '(no parameters)'}
      </pre>

      <div className="tool-draft-meta mono">
        {draft.effects.join(' · ')} · risk {draft.risk} · trust {draft.trust}
      </div>

      {collides && (
        <p className="tool-reply error mono">{draft.id} already exists — saving overwrites it.</p>
      )}

      <div className="tool-draft-actions">
        <button className="primary" onClick={onAdd} disabled={saved}>
          {saved ? '✓ In library' : 'Add to library'}
        </button>
        <button className="ghost" onClick={onEdit}>Edit schema</button>
        <span className="mono tool-draft-state">{saved ? `${draft.categoryId ?? 'filed'} · review` : 'not saved'}</span>
      </div>
    </div>
  );
}
