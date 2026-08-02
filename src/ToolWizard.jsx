import React, { useEffect, useRef, useState } from 'react';
import { TOOL_EFFECTS, RISK_LEVELS } from './toolTypes.js';
import { parametersOf, schemaFromRows } from './toolBoard.js';

// The creation wizard — the right sheet of the Tool Library page. Three steps,
// authored left to right: what it is, what it takes, what it costs.
//
// It PUSHES the board rather than overlaying it (no backdrop, no modal). That
// is not a styling preference: you are filing a new capability into a library,
// and being able to see the library — the column it will land in, the six
// tools already in that column, the id you are about to collide with — is the
// whole reason the board is there.

const SOURCES = [
  { id: 'http', label: 'HTTP / REST', hint: 'A declarative manual for an ordinary API. No server to write.' },
  { id: 'builtin', label: 'Code', hint: "Bind to a module Flyt ships. Read-only here — the run() lives in source." },
  { id: 'mcp', label: 'MCP server', hint: 'Import from a connected server. Arrives untrusted until promoted.' },
  { id: 'describe', label: 'Describe it', hint: 'Hand the brief to the copilot and edit what it drafts.' }
];

const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'enum'];
const STEPS = ['Source', 'Parameters', 'Auth & test'];
const NEXT_LABEL = ['Next · Parameters', 'Next · Auth & test', 'Add to library'];

// A tool id is the model-visible name, so it is the one field the wizard
// derives rather than asks for — until the user overrides it, at which point
// it stops tracking the title. Same rule the Flows page uses for slugs.
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 't$1');

export default function ToolWizard({ seed, categories, existingIds = [], onCancel, onSave, onHandToCopilot }) {
  const [step, setStep] = useState(0);
  const [source, setSource] = useState(seed?.provider === 'builtin' ? 'builtin' : (seed?.provider ?? 'http'));
  const [title, setTitle] = useState(seed?.title ?? '');
  const [id, setId] = useState(seed?.id ?? '');
  const [idTouched, setIdTouched] = useState(Boolean(seed?.id));
  const [description, setDescription] = useState(seed?.description ?? '');
  const [method, setMethod] = useState(seed?.http?.method ?? 'GET');
  const [url, setUrl] = useState(seed?.http?.url ?? '');
  const [rows, setRows] = useState(() => parametersOf(seed ?? {}));
  const [returns, setReturns] = useState(seed?.outputSchema ? JSON.stringify(seed.outputSchema, null, 2) : '');
  const [secretName, setSecretName] = useState('');
  const [effects, setEffects] = useState(seed?.effects ?? ['network']);
  const [risk, setRisk] = useState(seed?.risk ?? 'caution');
  const [autoExecute, setAutoExecute] = useState(Boolean(seed?.autoExecute));
  const [artifact, setArtifact] = useState(seed?.result?.artifact !== false);
  const [categoryId, setCategoryId] = useState(seed?.categoryId ?? categories[0]?.id ?? null);
  const [preflight, setPreflight] = useState(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const firstFieldRef = useRef(null);

  useEffect(() => { firstFieldRef.current?.focus(); }, [step]);
  // Esc closes the sheet — the shortcut the page contract promises. Captured
  // here rather than on the page so it can't fire while a nested control (a
  // native select, an open menu) wants the key first.
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const effectiveId = idTouched ? id : slug(title);
  const collision = effectiveId && existingIds.includes(effectiveId) && effectiveId !== seed?.id;

  const definition = () => ({
    id: effectiveId,
    title: title.trim() || effectiveId,
    description: description.trim(),
    provider: source === 'describe' ? 'http' : source,
    effects,
    risk,
    autoExecute,
    categoryId,
    parameters: schemaFromRows(rows),
    ...(returns.trim() ? { outputSchema: safeJson(returns) } : {}),
    result: { preview: 'json', maxPreviewChars: 2000, artifact },
    ...(source === 'http' ? {
      http: {
        method, url: url.trim(),
        ...(secretName.trim() ? { headers: { Authorization: `Bearer \${secrets.${secretName.trim()}}` } } : {}),
        body: null
      }
    } : {})
  });

  const canAdvance =
    step === 0 ? Boolean(effectiveId && description.trim() && !collision && (source !== 'http' || url.trim()))
    : true;

  const runPreflight = async () => {
    setTesting(true);
    setPreflight(null);
    try { setPreflight(await window.flyt.preflightTool(definition())); }
    catch (err) { setPreflight({ ok: false, checks: [{ ok: false, label: 'preflight', detail: String(err?.message ?? err) }] }); }
    setTesting(false);
  };

  const finish = async () => {
    setError('');
    try { await onSave(definition()); }
    catch (err) { setError(String(err?.message ?? err)); }
  };

  const advance = () => {
    if (step < 2) { setStep(step + 1); return; }
    finish();
  };

  return (
    <aside className="tool-sheet" aria-label="Create a tool">
      <header className="tool-sheet-head">
        <div className="tool-sheet-title">
          <h2>New tool</h2>
          <span className="mono tool-sheet-step">step {step + 1} of 3</span>
        </div>
        <button className="ghost mini" onClick={onCancel} aria-label="Close the wizard">✕</button>
      </header>

      <div className="tool-steps" role="tablist" aria-label="Wizard steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            role="tab"
            type="button"
            aria-selected={i === step}
            // Forward jumps are refused, not hidden: step 2 can't validate
            // parameters for a source that hasn't been chosen.
            disabled={i > step}
            className={'tool-step' + (i <= step ? ' done' : '')}
            onClick={() => setStep(i)}
          >
            <span className="tool-step-bar" aria-hidden="true" />
            <span className="tool-step-label mono">{label}</span>
          </button>
        ))}
      </div>

      <div className="tool-sheet-body">
        {step === 0 && (
          <>
            <section>
              <h3 className="section-label">Source</h3>
              <div className="tool-source-grid">
                {SOURCES.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className={'tool-source-tile' + (source === s.id ? ' selected' : '')}
                    aria-pressed={source === s.id}
                    onClick={() => (s.id === 'describe' ? onHandToCopilot?.() : setSource(s.id))}
                  >
                    <span className="tool-source-label">{s.label}</span>
                    <span className="tool-source-hint">{s.hint}</span>
                  </button>
                ))}
              </div>
            </section>

            {source === 'mcp' && (
              <div className="tool-note">
                <span className="tool-note-glyph" aria-hidden="true">✦</span>
                <span>The MCP client lands in P6. You can author the record now — it will resolve as
                  missing with a logged reason until a server claims it, which is the same graceful
                  degradation a server being down produces.</span>
              </div>
            )}

            {source === 'http' && (
              <section>
                <h3 className="section-label">Endpoint</h3>
                <div className="tool-endpoint">
                  <select value={method} onChange={e => setMethod(e.target.value)} aria-label="HTTP method">
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(m => <option key={m}>{m}</option>)}
                  </select>
                  <input
                    ref={firstFieldRef}
                    className="mono"
                    value={url}
                    placeholder="https://api.example.com/weather?q={{city}}"
                    onChange={e => setUrl(e.target.value)}
                    aria-label="URL template"
                  />
                </div>
                <p className="settings-hint">
                  <span className="mono">{'{{arg}}'}</span> interpolates a validated argument;{' '}
                  <span className="mono">{'${secrets.NAME}'}</span> resolves a secret. Two syntaxes on
                  purpose — one would eventually let an argument name a secret.
                </p>
              </section>
            )}

            <section>
              <h3 className="section-label">Name</h3>
              <input
                ref={source === 'http' ? undefined : firstFieldRef}
                value={title}
                placeholder="Create a Jira issue"
                onChange={e => setTitle(e.target.value)}
              />
              <div className="tool-id-row">
                <span className="mono tool-id-prefix">tools/</span>
                <input
                  className="mono"
                  value={effectiveId}
                  onChange={e => { setIdTouched(true); setId(slug(e.target.value)); }}
                  aria-label="Tool id — the model-visible name"
                />
                <span className="mono tool-id-prefix">.json</span>
              </div>
              {collision && <div className="settings-error mono">{effectiveId} already exists.</div>}
            </section>

            <section>
              <h3 className="section-label">Description — what the model sees</h3>
              <textarea
                rows={3}
                value={description}
                placeholder="Create an issue in a Jira project. Returns the issue key and URL."
                onChange={e => setDescription(e.target.value)}
              />
              <p className="settings-hint">
                This is the entire basis on which an agent decides to reach for this tool. Say what it
                does, what it returns, and when it is the right choice.
              </p>
            </section>
          </>
        )}

        {step === 1 && (
          <>
            <section>
              <h3 className="section-label">Parameters</h3>
              <div className="tool-param-table">
                {rows.map((row, i) => (
                  <div className="tool-param-row" key={i}>
                    <div className="tool-param-head">
                      <input
                        ref={i === 0 ? firstFieldRef : undefined}
                        className="mono"
                        value={row.name}
                        placeholder="name"
                        aria-label={`Parameter ${i + 1} name`}
                        onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, name: e.target.value } : r))}
                      />
                      <select
                        value={row.type}
                        aria-label={`Parameter ${i + 1} type`}
                        onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, type: e.target.value } : r))}
                      >
                        {PARAM_TYPES.map(t => <option key={t}>{t}</option>)}
                      </select>
                      <label className="tool-param-req">
                        <input
                          type="checkbox"
                          checked={Boolean(row.required)}
                          onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, required: e.target.checked } : r))}
                        />
                        required
                      </label>
                      <button className="ghost mini" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${row.name || 'parameter'}`}>✕</button>
                    </div>
                    <input
                      className="tool-param-desc"
                      value={row.description}
                      placeholder="What goes here — the only thing the model reads to decide."
                      aria-label={`Parameter ${i + 1} description`}
                      onChange={e => setRows(rows.map((r, j) => j === i ? { ...r, description: e.target.value } : r))}
                    />
                  </div>
                ))}
                {rows.length === 0 && <div className="muted">No parameters — the tool takes no arguments.</div>}
              </div>
              <button className="ghost mini" onClick={() => setRows([...rows, { name: '', type: 'string', description: '', required: false }])}>＋ Add</button>
            </section>

            <section>
              <h3 className="section-label">Returns — optional output schema</h3>
              <textarea
                className="mono"
                rows={5}
                value={returns}
                placeholder={'{\n  "type": "object",\n  "properties": { "key": { "type": "string" } }\n}'}
                onChange={e => setReturns(e.target.value)}
              />
            </section>
          </>
        )}

        {step === 2 && (
          <>
            <section>
              <h3 className="section-label">Auth</h3>
              {source === 'http' ? (
                <>
                  <div className="tool-auth-row">
                    <span className="mono">${'{secrets.'}</span>
                    <input
                      ref={firstFieldRef}
                      className="mono"
                      value={secretName}
                      placeholder="JIRA_TOKEN"
                      aria-label="Secret name"
                      onChange={e => setSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                    />
                    <span className="mono">{'}'}</span>
                    {secretName && <span className="tool-pill ok">referenced</span>}
                  </div>
                  <p className="settings-hint">
                    A reference, never a value. The secret is resolved in the provider at request time,
                    so it reaches the endpoint and never the model — and the audit trail stores the URL
                    with <span className="mono">${'{secrets.NAME}'}</span> still in it, safe to attach to a bug report.
                  </p>
                </>
              ) : (
                <p className="settings-hint">A {source} tool authenticates through its module or its server — nothing to link here.</p>
              )}
            </section>

            <section>
              <h3 className="section-label">What a call costs if it misbehaves</h3>
              <div className="tool-effects">
                {TOOL_EFFECTS.map(e => (
                  <label key={e} className={'tool-effect' + (effects.includes(e) ? ' on' : '')}>
                    <input
                      type="checkbox"
                      checked={effects.includes(e)}
                      onChange={() => setEffects(effects.includes(e) ? effects.filter(x => x !== e) : [...effects, e])}
                    />
                    <span className="mono">{e}</span>
                  </label>
                ))}
              </div>
              <div className="tool-risk-row">
                <span className="section-label">Risk</span>
                <select value={risk} onChange={e => setRisk(e.target.value)} aria-label="Risk level">
                  {RISK_LEVELS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              {effects.includes('destructive') && (
                <div className="tool-note warn">
                  <span className="tool-note-glyph" aria-hidden="true">!</span>
                  <span><span className="mono">destructive</span> always gates. No configuration and no
                    approval mode can switch that off — irreversibility is where the opt-out stops.</span>
                </div>
              )}
            </section>

            <section>
              <h3 className="section-label">Guardrails</h3>
              <label className="check-row">
                <input type="checkbox" checked={autoExecute} onChange={e => setAutoExecute(e.target.checked)} />
                May run unattended inside code mode
              </label>
              <label className="check-row">
                <input type="checkbox" checked={artifact} onChange={e => setArtifact(e.target.checked)} />
                Write every result to <span className="mono">&nbsp;runs/&lt;id&gt;/tools/</span>
              </label>
            </section>

            <section>
              <h3 className="section-label">Preflight</h3>
              <button className="ghost mini" onClick={runPreflight} disabled={testing}>
                {testing ? 'Checking…' : 'Run preflight'}
              </button>
              <p className="settings-hint">
                Validates the schema and runs the URL through the network policy — the two checks that
                decide whether this tool loads. It does not call the endpoint: the HTTP provider ships
                in P5, and a button that pretended otherwise would be theatre.
              </p>
              {preflight && (
                <pre className="tool-response mono">
                  {preflight.checks.map(c => `${c.ok ? '✓' : c.warn ? '!' : '✕'} ${c.label} — ${c.detail}`).join('\n')}
                </pre>
              )}
            </section>

            <section>
              <h3 className="section-label">Destination</h3>
              <select value={categoryId ?? ''} onChange={e => setCategoryId(e.target.value || null)} aria-label="Destination category">
                <option value="">(file it automatically)</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
              </select>
            </section>
          </>
        )}

        {error && <div className="settings-error mono">{error}</div>}
      </div>

      <footer className="tool-sheet-foot">
        <button className="ghost" onClick={() => (step === 0 ? onCancel() : setStep(step - 1))}>← Back</button>
        <button onClick={finish} disabled={!effectiveId || collision}>Save draft</button>
        <button className="primary" onClick={advance} disabled={!canAdvance}>{NEXT_LABEL[step]}</button>
      </footer>
    </aside>
  );
}

// A malformed Returns block is dropped rather than thrown: the field is
// optional, and losing the whole save because of a stray comma in a field the
// user could have left blank is the wrong trade.
function safeJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}
