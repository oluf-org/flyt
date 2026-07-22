import React, { useEffect, useMemo, useState } from 'react';
import { APPROVAL_MODE_OPTIONS } from './ApprovalModePicker.jsx';

// Settings page (PROVIDERS-PLAN §5): two tabs behind a slim rail.
//   Providers — five compact cards (keys, test, Kimi key-kind), overview-first:
//               a collapsed card is one line — name, status pill, model count.
//   Models    — provider-priority chips, the curated active-models list with
//               per-model source pins, add-a-model search, default worker.
// The renderer never sees a stored key — only per-provider hasKey flags come
// back over IPC, and saving sends a key one way into the main process.

const PROVIDER_ORDER = ['anthropic', 'openai', 'kimi', 'openrouter', 'mock'];
const PROVIDER_META = {
  anthropic: {
    name: 'Anthropic', blurb: 'Claude models — key from console.anthropic.com',
    placeholder: 'sk-ant-…',
    note: "Subscription login isn't permitted by Anthropic for third-party tools — use an API key."
  },
  openai: {
    name: 'OpenAI', blurb: 'GPT models — key from platform.openai.com',
    placeholder: 'sk-…',
    note: "Sign-in with ChatGPT can't pay for third-party model calls — use an API key."
  },
  kimi: {
    name: 'Kimi', blurb: 'Kimi K2 models — platform key or Kimi Code subscription key',
    placeholder: 'sk-…'
  },
  openrouter: {
    name: 'OpenRouter', blurb: 'One key, many providers — openrouter.ai',
    placeholder: 'sk-or-…'
  },
  mock: { name: 'Mock', blurb: 'Built-in fake provider for dry runs — no key, no cost' }
};

// Mirrors the adapters' canServe rules (presentational only — the main process
// stays the authority for actual resolution).
const SERVE = {
  anthropic: id => id.startsWith('claude-'),
  openai: id => /^(gpt-|o\d)/.test(id),
  kimi: id => /^(kimi-|moonshot-)/.test(id),
  openrouter: id => id.includes('/'),
  mock: id => id.startsWith('mock-')
};
const canServe = (provider, id) => SERVE[provider]?.(id) ?? false;

const MOCK_MODELS = ['mock-large', 'mock-small'];
const CATALOG_PROVIDERS = ['anthropic', 'openai', 'kimi']; // curated lists; openrouter fetches live

export default function Settings({ onClose }) {
  const [tab, setTab] = useState('providers');
  const [s, setS] = useState(null); // the public settings payload
  const [error, setError] = useState('');

  useEffect(() => { window.llmflow.getSettings().then(setS).catch(e => setError(String(e?.message ?? e))); }, []);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async patch => {
    setError('');
    try { setS(await window.llmflow.setSettings(patch)); }
    catch (err) { setError(String(err?.message ?? err)); }
  };

  return (
    <div className="settings-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-panel" role="dialog" aria-label="Settings">
        <div className="settings-header">
          <span className="node-icon">⚙</span>
          <div className="inspector-title">
            <h2>Settings</h2>
            <div className="node-sub">
              {s ? `${s.summary.connected} provider${s.summary.connected === 1 ? '' : 's'} connected · ${s.summary.activeModelCount} active model${s.summary.activeModelCount === 1 ? '' : 's'}` : 'providers & models'}
            </div>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {[['providers', 'Providers'], ['models', 'Models'], ['safety', 'Safety']].map(([id, label]) => (
            <button
              key={id} role="tab" aria-selected={tab === id}
              className={'settings-tab' + (tab === id ? ' active' : '')}
              onClick={() => setTab(id)}
            >{label}</button>
          ))}
        </div>

        <div className="settings-body">
          {!s && !error && <div className="muted">Loading…</div>}
          {s && tab === 'providers' && <ProvidersTab s={s} save={save} />}
          {s && tab === 'models' && <ModelsTab s={s} save={save} />}
          {s && tab === 'safety' && <SafetyTab s={s} save={save} />}
          {error && <div className="settings-error mono">{error}</div>}
        </div>
      </div>
    </div>
  );
}

// --- Providers tab ----------------------------------------------------------

function ProvidersTab({ s, save }) {
  const [expanded, setExpanded] = useState(null);
  const [keyInputs, setKeyInputs] = useState({});
  const [savedTick, setSavedTick] = useState(null);
  const [tests, setTests] = useState({}); // provider -> { state: 'running'|'ok'|'err', error? }

  const activeCount = p => (s.activeModels ?? []).filter(m => m.enabled !== false && canServe(p, m.id)).length;

  const saveKey = async p => {
    const key = (keyInputs[p] ?? '').trim();
    if (!key) return;
    await save({ providerKeys: { [p]: key } });
    setKeyInputs(k => ({ ...k, [p]: '' }));
    setSavedTick(p);
    setTimeout(() => setSavedTick(t => (t === p ? null : t)), 2000);
  };

  const test = async p => {
    setTests(t => ({ ...t, [p]: { state: 'running' } }));
    const r = await window.llmflow.testProvider(p);
    setTests(t => ({ ...t, [p]: r.ok ? { state: 'ok' } : { state: 'err', error: r.error } }));
  };

  return (
    <>
      <section>
        <div className="settings-section-head">
          <span className="section-label">Providers</span>
        </div>
        <p className="settings-hint">
          Keys are stored locally in the app&rsquo;s user-data folder — never in the project, never shown again.
        </p>
        <div className="provider-cards">
          {PROVIDER_ORDER.map(p => {
            const meta = PROVIDER_META[p];
            const connected = s.providers[p]?.hasKey;
            const open = expanded === p;
            const t = tests[p];
            return (
              <div className={'provider-card' + (open ? ' open' : '')} key={p}>
                <button
                  className="provider-card-head"
                  onClick={() => setExpanded(open ? null : p)}
                  aria-expanded={open}
                >
                  <span className="provider-name">{meta.name}</span>
                  {p === 'mock'
                    ? <span className="status-pill pill-neutral">built in</span>
                    : connected
                      ? <span className="status-pill">connected</span>
                      : <span className="status-pill pill-err">no key</span>}
                  <span className="provider-count muted">{activeCount(p)} model{activeCount(p) === 1 ? '' : 's'}</span>
                  <span className="provider-caret">{open ? '▾' : '▸'}</span>
                </button>
                {open && (
                  <div className="provider-card-body">
                    <p className="settings-hint">{meta.blurb}</p>
                    {meta.note && <p className="settings-hint provider-note">{meta.note}</p>}
                    {p === 'kimi' && (
                      <div className="keykind-row" role="radiogroup" aria-label="Kimi key kind">
                        {[['platform', 'Platform key — pay per token'], ['code', 'Kimi Code key — uses your Kimi membership']].map(([kind, label]) => (
                          <label key={kind} className="keykind-option">
                            <input
                              type="radio"
                              name="kimi-keykind"
                              checked={(s.providers.kimi?.keyKind ?? 'platform') === kind}
                              onChange={() => save({ kimiKeyKind: kind })}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    )}
                    {p !== 'mock' && (
                      <>
                        <div className="settings-row">
                          <input
                            type="password"
                            placeholder={connected ? 'Enter a new key to replace the saved one' : meta.placeholder}
                            value={keyInputs[p] ?? ''}
                            onChange={e => setKeyInputs(k => ({ ...k, [p]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') saveKey(p); }}
                            aria-label={`${meta.name} API key`}
                          />
                          <button className="primary" onClick={() => saveKey(p)} disabled={!(keyInputs[p] ?? '').trim()}>
                            {savedTick === p ? 'Saved ✓' : 'Save key'}
                          </button>
                        </div>
                        <div className="settings-row provider-test-row">
                          <button onClick={() => test(p)} disabled={!connected || t?.state === 'running'}>
                            {t?.state === 'running' ? 'Testing…' : 'Test connection'}
                          </button>
                          {t?.state === 'ok' && <span className="status-pill">ok</span>}
                          {t?.state === 'err' && <span className="provider-test-err mono" title={t.error}>{t.error}</span>}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Project storage</span>
        </div>
        <p className="settings-hint">
          Where a project tab&rsquo;s files (runs, artifacts) are written. Read when a project is
          opened — already-open tabs keep their current location.
        </p>
        <div className="settings-row">
          <select
            value={s.projectStorage}
            onChange={e => save({ projectStorage: e.target.value })}
            aria-label="Project storage location"
          >
            <option value="workspace">Inside the project — .llmflow/ in the folder, gitignored</option>
            <option value="appdata">App data — keyed by project path, repo untouched</option>
          </select>
        </div>
      </section>
    </>
  );
}

// --- Safety tab -------------------------------------------------------------
// Two settings, in the order they matter: what a run does before it touches
// your files, and — only if you picked the mode that needs one — which model
// makes that judgement. The mode list is shared with the chatbox picker so the
// two places can never drift into describing the same mode differently.

function SafetyTab({ s, save }) {
  const mode = s.approvalMode ?? 'ask';
  const candidates = s.safetyCandidates ?? [];
  const configured = s.safetyModel ?? 'auto';
  // A saved id that isn't one of the candidates is by definition a custom one,
  // so the free-text field opens itself rather than hiding what is in effect.
  const isCustom = configured !== 'auto' && !candidates.some(c => c.id === configured);
  const [showCustom, setShowCustom] = useState(isCustom);
  const [custom, setCustom] = useState(isCustom ? configured : '');

  return (
    <>
      <section>
        <div className="settings-section-head">
          <span className="section-label">Tool approval</span>
        </div>
        <p className="settings-hint">
          What happens before an agent writes a file or runs a shell command in your project.
          This is the default for new runs — the chip beside the Run button changes it per run.
        </p>
        <div className="approval-modes" role="radiogroup" aria-label="Default tool approval mode">
          {APPROVAL_MODE_OPTIONS.map(o => (
            <label
              key={o.id}
              className={'approval-mode-row' + (mode === o.id ? ' active' : '') + (o.danger ? ' danger' : '')}
            >
              <input
                type="radio"
                name="approval-mode"
                checked={mode === o.id}
                onChange={() => save({ approvalMode: o.id })}
              />
              <span className="approval-mode-glyph" aria-hidden>{o.glyph}</span>
              <span className="approval-mode-text">
                <span className="approval-mode-label">
                  {o.label}
                  {o.danger && <span className="approval-danger-tag">dangerous</span>}
                </span>
                <span className="approval-mode-detail">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === 'always' && (
          <p className="settings-hint approval-warning">
            Every command runs unattended, including ones that delete files or rewrite git history.
            Keep a clean working tree, or a backup, while this is on.
          </p>
        )}
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Safety model</span>
          {s.resolvedSafetyModel
            ? <span className="status-pill pill-neutral mono">{s.resolvedSafetyModel}</span>
            : <span className="status-pill pill-err">no provider</span>}
        </div>
        <p className="settings-hint">
          Used by <strong>Smart approval</strong> to judge each command. A small, cheap model is the
          right tool here — the answer is one word, and obviously-destructive commands are caught by
          a built-in pattern check that never calls a model at all.
        </p>
        <div className="settings-row">
          <select
            value={isCustom ? 'custom' : configured}
            onChange={e => {
              if (e.target.value === 'custom') { setShowCustom(true); return; }
              setShowCustom(false);
              save({ safetyModel: e.target.value });
            }}
            aria-label="Safety model"
            disabled={mode !== 'smart'}
          >
            <option value="auto">
              Auto — cheapest connected{s.resolvedSafetyModel ? ` (${s.resolvedSafetyModel})` : ''}
            </option>
            {candidates.filter(c => c.provider !== 'mock').map(c => (
              <option key={c.id} value={c.id} disabled={!c.connected}>
                {c.label}{c.connected ? '' : ' — no key'}
              </option>
            ))}
            <option value="custom">Another model…</option>
          </select>
        </div>
        {(showCustom || isCustom) && (
          <div className="settings-row">
            <input
              type="text"
              placeholder="Model id, e.g. moonshotai/kimi-k2.6"
              value={custom}
              onChange={e => setCustom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) save({ safetyModel: custom.trim() }); }}
              disabled={mode !== 'smart'}
            />
            <button className="primary" onClick={() => custom.trim() && save({ safetyModel: custom.trim() })} disabled={!custom.trim()}>
              Use
            </button>
          </div>
        )}
        {mode !== 'smart' && (
          <p className="settings-hint muted">Switch to Smart approval above to use this.</p>
        )}
        <p className="settings-hint">
          If the check fails, times out, or no provider is connected, the run asks you instead of
          guessing — a safety check that fails open is not a safety check.
        </p>
      </section>
    </>
  );
}

// --- Models tab -------------------------------------------------------------

function ModelsTab({ s, save }) {
  const [catalog, setCatalog] = useState([]); // [{ id, name, provider, contextLength?, supportsTools? }]
  const [fetching, setFetching] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [search, setSearch] = useState('');

  const active = s.activeModels ?? [];
  const priority = s.providerPriority ?? PROVIDER_ORDER;
  const connected = p => Boolean(s.providers[p]?.hasKey);

  // Catalogs for the add-a-model search: curated lists always, the openrouter
  // live catalog only after an explicit fetch (it's huge and key-gated).
  useEffect(() => {
    let alive = true;
    Promise.all(CATALOG_PROVIDERS.map(p =>
      window.llmflow.listModels(p)
        .then(list => list.map(m => ({ ...m, provider: p })))
        .catch(() => [])
    )).then(lists => { if (alive) setCatalog(lists.flat()); });
    return () => { alive = false; };
  }, []);

  const fetchOpenRouter = async () => {
    setFetching(true);
    setCatalogError('');
    try {
      const list = await window.llmflow.listModels('openrouter');
      setCatalog(c => [...c.filter(m => m.provider !== 'openrouter'), ...list.map(m => ({ ...m, provider: 'openrouter' }))]);
    } catch (err) {
      setCatalogError(String(err?.message ?? err));
    } finally {
      setFetching(false);
    }
  };

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    const notActive = catalog.filter(m => !active.some(a => a.id === m.id));
    if (!q) return notActive.slice(0, 200);
    return notActive.filter(m => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)).slice(0, 200);
  }, [catalog, search, active]);

  const addModel = id => {
    const modelId = (id ?? search).trim();
    if (!modelId || active.some(m => m.id === modelId)) return;
    save({ activeModels: [...active, { id: modelId, source: 'auto', enabled: true }] });
    setSearch('');
  };

  const patchModel = (id, patch) =>
    save({ activeModels: active.map(m => (m.id === id ? { ...m, ...patch } : m)) });
  const removeModel = id => save({ activeModels: active.filter(m => m.id !== id) });

  const move = (p, dir) => {
    const order = [...priority];
    const i = order.indexOf(p);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save({ providerPriority: order });
  };

  // The provider that would serve a model right now (pin wins, else the
  // priority walk) — shown as the resolved source, and as the warning pill
  // when there is none.
  const resolved = m => {
    if (m.source && m.source !== 'auto') {
      return connected(m.source) && canServe(m.source, m.id) ? m.source : null;
    }
    return priority.find(p => connected(p) && canServe(p, m.id)) ?? null;
  };

  const workers = s.workers;
  const workerValue = workers?.executor
    ? (workers.executor.provider === 'mock' ? `mock:${workers.executor.model}` : `active:${workers.executor.model}`)
    : null;
  const workerMatchesOption = workerValue && (
    MOCK_MODELS.some(m => workerValue === `mock:${m}`) || active.some(m => m.enabled !== false && workerValue === `active:${m.id}`)
  );

  return (
    <>
      <section>
        <div className="settings-section-head">
          <span className="section-label">Provider priority</span>
        </div>
        <p className="settings-hint">
          When a model is available from several sources, the first connected one wins.
        </p>
        <div className="priority-chips">
          {priority.map((p, i) => (
            <span className={'priority-chip' + (connected(p) ? '' : ' off')} key={p}>
                              <span className="priority-chip-label">{PROVIDER_META[p]?.name ?? p}</span>
              <button aria-label={`Move ${p} earlier`} disabled={i === 0} onClick={() => move(p, -1)}>◀</button>
              <button aria-label={`Move ${p} later`} disabled={i === priority.length - 1} onClick={() => move(p, 1)}>▶</button>
            </span>
          ))}
        </div>
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Active models</span>
          <span className="status-pill pill-neutral">{active.filter(m => m.enabled !== false).length} active</span>
        </div>
        <p className="settings-hint">
          The whole app offers only these models — node pickers, worker defaults, category routing.
        </p>
        {active.length === 0 && <div className="muted">No active models yet — add one below.</div>}
        {active.map(m => {
          const r = resolved(m);
          return (
            <div className={'model-row' + (m.enabled === false ? ' off' : '')} key={m.id}>
              <input
                type="checkbox"
                checked={m.enabled !== false}
                onChange={e => patchModel(m.id, { enabled: e.target.checked })}
                aria-label={`Activate ${m.id}`}
                title={m.enabled !== false ? 'Active' : 'Inactive'}
              />
              <span className="model-id mono" title={m.id}>{m.id}</span>
              {m.enabled !== false && !r && (
                <span className="status-pill pill-err" title="No connected provider can serve this model">unrouted</span>
              )}
              <select
                value={m.source ?? 'auto'}
                onChange={e => patchModel(m.id, { source: e.target.value })}
                aria-label={`Source for ${m.id}`}
              >
                <option value="auto">{r && (m.source === 'auto' || !m.source) ? `Auto (${r})` : 'Auto (priority)'}</option>
                {PROVIDER_ORDER.filter(p => p !== 'mock' && canServe(p, m.id)).map(p => (
                  <option key={p} value={p} disabled={!connected(p)}>
                    {PROVIDER_META[p]?.name ?? p}{connected(p) ? '' : ' — no key'}
                  </option>
                ))}
              </select>
              <button className="link" onClick={() => removeModel(m.id)} aria-label={`Remove ${m.id}`} title="Remove">✕</button>
            </div>
          );
        })}
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Add a model</span>
          {catalog.length > 0 && <span className="status-pill pill-neutral">{catalog.length} in catalog</span>}
        </div>
        <div className="settings-row">
          <input
            list="settings-catalog"
            type="search"
            placeholder="Search the catalogs, or type any model id…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addModel(); }}
          />
          <button className="primary" onClick={() => addModel()} disabled={!search.trim() || active.some(m => m.id === search.trim())}>
            Add
          </button>
          {connected('openrouter') && (
            <button onClick={fetchOpenRouter} disabled={fetching} title="Fetch the full OpenRouter catalog">
              {fetching ? 'Fetching…' : 'Fetch OpenRouter'}
            </button>
          )}
        </div>
        <datalist id="settings-catalog">
          {filteredCatalog.map(m => (
            <option key={`${m.provider}:${m.id}`} value={m.id}>
              {m.name}{m.provider ? ` · ${PROVIDER_META[m.provider]?.name ?? m.provider}` : ''}{m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ''}{m.supportsTools ? ' · tools' : ''}
            </option>
          ))}
        </datalist>
        {catalogError && <div className="settings-error mono">{catalogError}</div>}
      </section>

      <section>
        <div className="settings-section-head">
          <span className="section-label">Default worker</span>
        </div>
        <p className="settings-hint">Used whenever a node template (or workflow override) doesn&rsquo;t pick its own model.</p>
        {workers && (
          <div className="settings-row">
            <select
              value={workerMatchesOption ? workerValue : 'legacy'}
              onChange={e => {
                const v = e.target.value;
                if (v.startsWith('mock:')) save({ workers: { executor: { provider: 'mock', model: v.slice(5) } } });
                else if (v.startsWith('active:')) save({ workers: { executor: { provider: 'auto', model: v.slice(7) } } });
              }}
              aria-label="Default worker model"
            >
              {!workerMatchesOption && (
                <option value="legacy" disabled>{workers.executor.provider}/{workers.executor.model} (current)</option>
              )}
              {active.filter(m => m.enabled !== false).map(m => (
                <option key={m.id} value={`active:${m.id}`}>{m.id}</option>
              ))}
              {MOCK_MODELS.map(m => <option key={m} value={`mock:${m}`}>{m} (mock)</option>)}
            </select>
          </div>
        )}
      </section>
    </>
  );
}
