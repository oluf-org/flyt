import React, { useEffect, useMemo, useRef, useState } from 'react';
import { APPROVAL_MODE_OPTIONS } from './ApprovalModePicker.jsx';
import { APP_NAME, CONFIG_DIR } from '../core/brand.js';
import { canServe, MOCK_MODELS, PROVIDER_ORDER } from './providerMirror.js';
import { FactChips } from './ModelPicker.jsx';
import { proposeStarterSet, modelSetId, MODEL_SET_MAX } from '../core/modelSource.js';
import ReposPanel from './ReposPanel.jsx';
import ProjectColorSettings from './components/settings/ProjectColorSettings.tsx';

// Settings page (DESIGN-SPEC.md §6): tabs behind a slim rail.
//   Providers — five compact cards (keys, test, Kimi key-kind), overview-first:
//               a collapsed card is one line — name, status pill, model count.
//   Models    — provider-priority chips, the curated active-models list with
//               per-model source pins, add-a-model search, default worker.
//   Project   — the active project's theme color (per-project theming):
//               9 preset swatches + a custom picker, persisted immediately.
// The renderer never sees a stored key — only per-provider hasKey flags come
// back over IPC, and saving sends a key one way into the main process.

// Providers whose "connection" is the vendor CLI's own sign-in, not a key.
const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];
const PROVIDER_META = {
  anthropic: {
    name: 'Anthropic', blurb: 'Claude models — key from console.anthropic.com',
    placeholder: 'sk-ant-…',
    note: 'Pay-per-token API key. To use a Claude Pro/Max plan instead, see the Claude subscription card below.'
  },
  'claude-code': {
    name: 'Claude subscription', subscription: true,
    blurb: `Your Claude Pro/Max plan, via the Claude Code CLI you are already signed in to. ${APP_NAME} never sees a token — it launches the official CLI, which authenticates itself.`,
    loginHint: <>Not signed in — run <code className="mono">claude</code> in a terminal and use <code className="mono">/login</code>, then re-open Settings.</>,
    warning: `Heads-up before enabling: every call here spends your Claude plan’s usage limits (5-hour and weekly windows) — a multi-node workflow can burn through them quickly. Anthropic permits subscription sign-in only through its own Claude Code app, which is exactly what ${APP_NAME} launches, but the usage still lands on your personal account and is governed by your plan’s terms. Prefer an API key for heavy or unattended runs.`
  },
  openai: {
    name: 'OpenAI', blurb: 'GPT models — key from platform.openai.com',
    placeholder: 'sk-…',
    note: 'Pay-per-token API key. To use a ChatGPT plan instead, see the ChatGPT subscription card below.'
  },
  codex: {
    name: 'ChatGPT subscription', subscription: true,
    blurb: `Your ChatGPT Plus/Pro plan, via the Codex CLI you are already signed in to. ${APP_NAME} never sees a token — it launches the official CLI, which authenticates itself.`,
    loginHint: <>Not signed in — run <code className="mono">codex login</code> in a terminal, then re-open Settings.</>,
    warning: 'Calls here spend your ChatGPT plan’s Codex usage limits and are governed by your ChatGPT workspace policies.'
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

// canServe / PROVIDER_ORDER / MOCK_MODELS now live in providerMirror.js — the
// model pickers need the same answers, and two copies of a rule that must
// agree is one too many.
const CATALOG_PROVIDERS = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi']; // curated lists; openrouter fetches live
const SEARCH_PROVIDER_META = {
  brave: {
    name: 'Brave Search', placeholder: 'BSA…',
    blurb: 'Preferred for web_search when configured. Create a key in the Brave Search API dashboard.',
  },
  tavily: {
    name: 'Tavily', placeholder: 'tvly-…',
    blurb: 'Used when Brave is not configured. Create a key in the Tavily dashboard.',
  },
};

export default function Settings({ onClose, onOpenProject = null, onOpenModels = null, projects = null, onColorChange = null }) {
  const [tab, setTab] = useState('providers');
  const [s, setS] = useState(null); // the public settings payload
  const [sandboxDiagnostic, setSandboxDiagnostic] = useState(null);
  const [sandboxDiagnosticBusy, setSandboxDiagnosticBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { window.flyt.getSettings().then(setS).catch(e => setError(String(e?.message ?? e))); }, []);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshSandboxDiagnostic = async (refresh = false) => {
    setSandboxDiagnosticBusy(true);
    try { setSandboxDiagnostic(await window.flyt.sandboxDiagnostics(refresh)); }
    catch (err) {
      const message = String(err?.message ?? err);
      setError(message);
      setSandboxDiagnostic({ backend: null, enforcement: null,
        probe: { available: false, checkedAt: new Date().toISOString(), reason: message } });
    }
    finally { setSandboxDiagnosticBusy(false); }
  };

  useEffect(() => {
    if (tab === 'safety' && s && !sandboxDiagnostic && !sandboxDiagnosticBusy) void refreshSandboxDiagnostic(false);
  }, [tab, s, sandboxDiagnostic, sandboxDiagnosticBusy]);

  const save = async patch => {
    setError('');
    try {
      setS(await window.flyt.setSettings(patch));
      if (patch?.sandbox) setSandboxDiagnostic(null);
    }
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
              {s ? `${s.summary.connected} provider${s.summary.connected === 1 ? '' : 's'} connected · ${s.summary.activeModelCount} pinned model${s.summary.activeModelCount === 1 ? '' : 's'}` : 'providers, repositories & safety'}
            </div>
          </div>
          {onOpenModels && <button className="ghost" onClick={onOpenModels}>Models</button>}
          <button className="ghost" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {[['providers', 'Providers'], ['repos', 'Repositories'], ['safety', 'Safety'], ['project', 'Project']].map(([id, label]) => (
            <button
              key={id} role="tab" aria-selected={tab === id}
              className={'settings-tab' + (tab === id ? ' active' : '')}
              onClick={() => setTab(id)}
            >{label}</button>
          ))}
        </div>

        <div className="settings-body">
          {!s && !error && <div className="muted">Loading…</div>}
          {s && tab === 'providers' && <ProvidersTab s={s} save={save} onKeySaved={onOpenModels} />}
          {s && tab === 'repos' && <ReposPanel onOpenProject={onOpenProject} />}
          {s && tab === 'safety' && <SafetyTab s={s} save={save} sandboxDiagnostic={sandboxDiagnostic}
            sandboxDiagnosticBusy={sandboxDiagnosticBusy} refreshSandboxDiagnostic={refreshSandboxDiagnostic} />}
          {tab === 'project' && (
            <ProjectColorSettings projects={projects} onColorChange={onColorChange} />
          )}
          {error && <div className="settings-error mono">{error}</div>}
        </div>
      </div>
    </div>
  );
}

// --- Providers tab ----------------------------------------------------------

// Where the flow files live, with a Reveal button. In a packaged build this is
// userData/flows (D28) — not a path anyone would guess, and the folder you copy
// a hand-designed flow out of when promoting it to a shipped default.
function FlowFilesSection() {
  const [info, setInfo] = useState(null);
  useEffect(() => { window.flyt.flowFolder?.().then(setInfo).catch(() => {}); }, []);
  if (!info?.dir) return null;
  return (
    <section>
      <div className="settings-section-head">
        <span className="section-label">Flow files</span>
      </div>
      <p className="settings-hint">
        Every flow is a plain <code className="mono">&lt;id&gt;.flow.yaml</code> plus a{' '}
        <code className="mono">.layout.json</code> sidecar in this folder — editable, copyable,
        diffable. To turn a flow you designed here into one the app ships with, run{' '}
        <code className="mono">npm run workflow -- adopt</code> in the repo checkout.
      </p>
      <div className="settings-row">
        <code className="mono settings-path">{info.dir}</code>
        <button onClick={() => window.flyt.openFlowFolder()}>Reveal</button>
      </div>
    </section>
  );
}

function ProvidersTab({ s, save, onKeySaved }) {
  const [expanded, setExpanded] = useState(null);
  const [keyInputs, setKeyInputs] = useState({});
  const [savedTick, setSavedTick] = useState(null);
  const [tests, setTests] = useState({}); // provider -> { state: 'running'|'ok'|'err', error? }

  const activeCount = p => (s.activeModels ?? []).filter(m => m.enabled !== false && m.pinned !== false && canServe(p, m.id)).length;

  const saveKey = async p => {
    const key = (keyInputs[p] ?? '').trim();
    if (!key) return;
    await save({ providerKeys: { [p]: key } });
    setKeyInputs(k => ({ ...k, [p]: '' }));
    setSavedTick(p);
    setTimeout(() => setSavedTick(t => (t === p ? null : t)), 2000);
    // P0.1: the first key is the moment the app can start being useful. Don't
    // make the user find the Models tab and a Fetch button to discover that.
    if ((s.activeModels ?? []).length === 0) onKeySaved?.(p);
  };

  const test = async p => {
    setTests(t => ({ ...t, [p]: { state: 'running' } }));
    const r = await window.flyt.testProvider(p);
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
            const sub = s.providers[p]?.subscription;
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
                    : meta.subscription
                      ? (connected
                        ? <span className="status-pill">connected</span>
                        : sub?.enabled
                          ? <span className="status-pill pill-err">not signed in</span>
                          : sub?.signedIn
                            ? <span className="status-pill pill-neutral">signed in · off</span>
                            : <span className="status-pill pill-neutral">off</span>)
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
                    {meta.subscription && (
                      <SubscriptionCard
                        p={p} meta={meta} sub={sub} connected={connected} save={save}
                        test={test} t={t}
                      />
                    )}
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
                    {p !== 'mock' && !meta.subscription && (
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

      <SearchProvidersSection searchProviders={s.searchProviders} save={save} />

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
            <option value="workspace">Inside the project — {CONFIG_DIR}/ in the folder, gitignored</option>
            <option value="appdata">App data — keyed by project path, repo untouched</option>
          </select>
        </div>
      </section>

      <FlowFilesSection />
    </>
  );
}

export function searchProviderKeyPatch(provider, raw) {
  const key = String(raw ?? '').trim();
  return SEARCH_PROVIDER_META[provider] && key ? { providerKeys: { [provider]: key } } : null;
}

export function SearchProvidersSection({ searchProviders = {}, save }) {
  const [inputs, setInputs] = useState({});
  const [saved, setSaved] = useState(null);

  const saveKey = async provider => {
    const patch = searchProviderKeyPatch(provider, inputs[provider]);
    if (!patch) return;
    await save(patch);
    setInputs(current => ({ ...current, [provider]: '' }));
    setSaved(provider);
    setTimeout(() => setSaved(current => (current === provider ? null : current)), 2000);
  };

  return (
    <section data-search-providers>
      <div className="settings-section-head">
        <span className="section-label">Web search</span>
      </div>
      <p className="settings-hint">
        Optional provider keys make <code className="mono">web_search</code> use a JSON search API.
        Without one, Flyt keeps using its keyless DuckDuckGo fallback. Keys stay local and are never shown again.
      </p>
      <div className="provider-cards">
        {Object.entries(SEARCH_PROVIDER_META).map(([provider, meta]) => {
          const connected = Boolean(searchProviders?.[provider]?.hasKey);
          const value = inputs[provider] ?? '';
          return (
            <div className="provider-card open" key={provider}>
              <div className="provider-card-head">
                <span className="provider-name">{meta.name}</span>
                <span className={'status-pill' + (connected ? '' : ' pill-neutral')}>
                  {connected ? 'configured' : 'optional'}
                </span>
              </div>
              <div className="provider-card-body">
                <p className="settings-hint">{meta.blurb}</p>
                <div className="settings-row">
                  <input
                    type="password"
                    placeholder={connected ? 'Enter a new key to replace the saved one' : meta.placeholder}
                    value={value}
                    onChange={event => setInputs(current => ({ ...current, [provider]: event.target.value }))}
                    onKeyDown={event => { if (event.key === 'Enter') saveKey(provider); }}
                    aria-label={`${meta.name} API key`}
                  />
                  <button className="primary" onClick={() => saveKey(provider)} disabled={!value.trim()}>
                    {saved === provider ? 'Saved ✓' : 'Save key'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Subscription provider card (DESIGN-SPEC.md §6) -------------------
// The vendor CLI is the authentication authority: this card never takes a
// key. It shows sign-in state, carries the usage warning, and gates the
// provider behind an explicit enable toggle. Advanced: a credential-home
// override (selects an account — a credential directory IS an account) and an
// explicit CLI path for unusual installs.

function SubscriptionCard({ p, meta, sub, connected, save, test, t }) {
  const [home, setHome] = useState(sub?.home ?? '');
  const [cliPath, setCliPath] = useState(sub?.cliPath ?? '');
  const [advanced, setAdvanced] = useState(Boolean(sub?.home || sub?.cliPath));
  const dirty = home !== (sub?.home ?? '') || cliPath !== (sub?.cliPath ?? '');

  return (
    <>
      {meta.warning && <p className="settings-hint provider-warning">⚠ {meta.warning}</p>}

      <label className="sub-enable-row">
        <input
          type="checkbox"
          checked={Boolean(sub?.enabled)}
          onChange={e => save({ subscriptions: { [p]: { enabled: e.target.checked } } })}
          aria-label={`Use ${meta.name}`}
        />
        <span>Use my subscription for model calls</span>
      </label>

      {!sub?.cliFound && (
        <p className="settings-hint provider-note">
          CLI not found on PATH — install it, or point at the binary under Advanced below.
        </p>
      )}
      {sub?.cliFound && !sub?.signedIn && (
        <p className="settings-hint provider-note">{meta.loginHint}</p>
      )}
      {connected && (
        <p className="settings-hint">
          Signed in — credentials stay with the CLI (<span className="mono">{sub.credentialPath}</span>); {APP_NAME} only launches it.
        </p>
      )}

      <div className="settings-row provider-test-row">
        <button onClick={() => test(p)} disabled={!connected || t?.state === 'running'}>
          {t?.state === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {t?.state === 'ok' && <span className="status-pill">ok</span>}
        {t?.state === 'err' && <span className="provider-test-err mono" title={t.error}>{t.error}</span>}
        <button className="link" onClick={() => setAdvanced(a => !a)} aria-expanded={advanced}>
          {advanced ? 'Hide advanced' : 'Advanced…'}
        </button>
      </div>

      {advanced && (
        <>
          <div className="settings-row">
            <input
              type="text"
              placeholder={p === 'codex' ? 'Credential home (CODEX_HOME) — blank for default' : 'Credential home (HOME with a .claude/) — blank for default'}
              value={home}
              onChange={e => setHome(e.target.value)}
              aria-label={`${meta.name} credential home`}
            />
          </div>
          <div className="settings-row">
            <input
              type="text"
              placeholder="CLI path — blank to find it on PATH"
              value={cliPath}
              onChange={e => setCliPath(e.target.value)}
              aria-label={`${meta.name} CLI path`}
            />
            <button
              className="primary"
              disabled={!dirty}
              onClick={() => save({ subscriptions: { [p]: { home, cliPath } } })}
            >Save</button>
          </div>
        </>
      )}
    </>
  );
}

// --- Safety tab -------------------------------------------------------------
// Two settings, in the order they matter: what a run does before it touches
// your files, and — only if you picked the mode that needs one — which model
// makes that judgement. The mode list is shared with the chatbox picker so the
// two places can never drift into describing the same mode differently.

function SafetyTab({ s, save, sandboxDiagnostic, sandboxDiagnosticBusy, refreshSandboxDiagnostic }) {
  const mode = s.approvalMode ?? 'ask';
  const sandbox = s.sandbox ?? { mode: 'workspace-write', minimumEnforcement: 'partial', network: 'ambient' };
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
          <span className="section-label">Command sandbox</span>
          <span className={`status-pill ${sandboxDiagnostic?.probe?.available === false ? 'pill-err' : 'pill-neutral'} mono`}>
            {sandboxDiagnosticBusy ? 'probing…' : sandboxDiagnostic?.backend ?? 'local backend'}
            {sandboxDiagnostic?.enforcement ? ` · ${sandboxDiagnostic.enforcement}` : ` · minimum ${sandbox.minimumEnforcement}`}
          </span>
        </div>
        <p className="settings-hint">
          File tools and commands share this local execution world. Network access remains ambient in every mode.
        </p>
        <div className="approval-modes" role="radiogroup" aria-label="Default command sandbox mode">
          {[
            { id: 'read-only', label: 'Read only', detail: 'File tools and child processes cannot write project files.' },
            { id: 'workspace-write', label: 'Workspace write', detail: 'Writes are limited to the project and a private per-call temp directory.' },
            { id: 'danger-full-access', label: 'Danger: full access', detail: 'Commands can modify files anywhere your account can access.', danger: true },
          ].map(o => (
            <label key={o.id} className={'approval-mode-row' + (sandbox.mode === o.id ? ' active' : '') + (o.danger ? ' danger' : '')}>
              <input type="radio" name="sandbox-mode" checked={sandbox.mode === o.id} onChange={() => {
                if (o.danger && !window.confirm('Danger full access lets commands modify files outside the project. Use it for new runs?')) return;
                save({ sandbox: { ...sandbox, mode: o.id } });
              }} />
              <span className="approval-mode-glyph" aria-hidden>{o.danger ? '!' : o.id === 'read-only' ? 'R' : 'W'}</span>
              <span className="approval-mode-text">
                <span className="approval-mode-label">{o.label}{o.danger && <span className="approval-danger-tag">dangerous</span>}</span>
                <span className="approval-mode-detail">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="settings-row">
          <label htmlFor="sandbox-enforcement">Minimum enforcement</label>
          <select id="sandbox-enforcement" value={sandbox.minimumEnforcement ?? 'partial'} onChange={e => save({ sandbox: { ...sandbox, minimumEnforcement: e.target.value } })}>
            <option value="partial">Partial or stronger</option>
            <option value="full">Full only</option>
          </select>
        </div>
        <p className="settings-hint muted">
          Flyt refuses confined commands when the platform backend cannot meet this minimum; it never silently continues unconfined.
        </p>
        <div className="settings-row">
          <div>
            <strong>Functional probe</strong>
            <div className="settings-hint muted">
              {sandbox.mode === 'danger-full-access'
                ? 'Unconfined by explicit choice; managed process ownership and environment scrubbing still apply.'
                : sandboxDiagnostic?.probe
                  ? `${sandboxDiagnostic.probe.available ? 'Passed' : 'Failed'} at ${sandboxDiagnostic.probe.checkedAt}${sandboxDiagnostic.probe.reason ? ` — ${sandboxDiagnostic.probe.reason}` : ''}`
                  : 'Waiting for the active project backend check.'}
            </div>
          </div>
          <button type="button" className="ghost" disabled={sandboxDiagnosticBusy || sandbox.mode === 'danger-full-access'}
            onClick={() => refreshSandboxDiagnostic(true)}>{sandboxDiagnosticBusy ? 'Checking…' : 'Refresh'}</button>
        </div>
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
  const [catalog, setCatalog] = useState([]); // [{ id, name, provider, contextLength?, supportsTools?, inUsdPerM? }]
  const [fetching, setFetching] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [search, setSearch] = useState('');

  const active = s.activeModels ?? [];
  const priority = s.providerPriority ?? PROVIDER_ORDER;
  const connected = p => Boolean(s.providers[p]?.hasKey);
  // What the catalogs told us each model costs and can read (D36 P0.2). Kept
  // main-side at fetch time so it survives a restart without re-fetching.
  const facts = s.modelFacts ?? {};

  // Catalogs for the add-a-model search: curated lists always, the openrouter
  // live catalog only after an explicit fetch (it's huge and key-gated).
  useEffect(() => {
    let alive = true;
    Promise.all(CATALOG_PROVIDERS.map(p =>
      window.flyt.listModels(p)
        .then(list => list.map(m => ({ ...m, provider: p })))
        .catch(() => [])
    )).then(lists => {
      if (!alive) return;
      // The subscription catalogs repeat their API sibling's ids — keep the
      // first occurrence so each id is offered once. Merge rather than
      // replace: the openrouter fetch below now starts at mount too, and
      // whichever lands second must not wipe the other.
      setCatalog(prev => {
        const seen = new Set();
        const curated = lists.flat().filter(m => !seen.has(m.id) && seen.add(m.id));
        return [...curated, ...prev.filter(m => m.provider === 'openrouter' && !seen.has(m.id))];
      });
    });
    return () => { alive = false; };
  }, []);

  const fetchOpenRouter = async () => {
    setFetching(true);
    setCatalogError('');
    try {
      const list = await window.flyt.listModels('openrouter');
      setCatalog(c => [...c.filter(m => m.provider !== 'openrouter'), ...list.map(m => ({ ...m, provider: 'openrouter' }))]);
    } catch (err) {
      setCatalogError(String(err?.message ?? err));
    } finally {
      setFetching(false);
    }
  };

  // P0.1: a saved key is the whole trigger. The old path was Settings →
  // Providers → key → Models → Fetch → add ids one at a time; six steps before
  // the app does anything. Now the fetch fires itself the moment a key exists.
  // Once per mount — the button beside the search is the way to refetch.
  const autoFetched = useRef(false);
  const orConnected = connected('openrouter');
  useEffect(() => {
    if (autoFetched.current || !orConnected) return;
    autoFetched.current = true;
    fetchOpenRouter();
  }, [orConnected]);

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
      <StarterSetSection
        catalog={catalog}
        active={active}
        fetching={fetching}
        anyProvider={PROVIDER_ORDER.some(p => p !== 'mock' && connected(p))}
        onActivate={ids => save({
          activeModels: [
            ...active,
            ...ids.filter(id => !active.some(m => m.id === id)).map(id => ({ id, source: 'auto', enabled: true }))
          ]
        })}
      />

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
              {/* P0.2: price, context and tool support, on the row where the
                  model is kept — picking one is a cost decision. */}
              <FactChips facts={facts[m.id]} />
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
              {fetching ? 'Fetching…' : 'Refetch OpenRouter'}
            </button>
          )}
        </div>
        {/* A <datalist> rendered these facts and then threw them away — it
            cannot show a price column. P0.2: a real list, so the number is
            visible at the moment of choosing. */}
        {search.trim() && (
          <div className="catalog-results">
            {filteredCatalog.length === 0
              ? <div className="muted">Nothing in the catalogs matches — “Add” still takes any id you type.</div>
              : filteredCatalog.slice(0, 12).map(m => (
                <button
                  key={`${m.provider}:${m.id}`}
                  type="button"
                  className="catalog-result"
                  onClick={() => addModel(m.id)}
                  title={`Add ${m.id}`}
                >
                  <span className="model-id mono">{m.id}</span>
                  <FactChips facts={facts[m.id] ?? m} />
                  <span className="catalog-result-provider">{PROVIDER_META[m.provider]?.name ?? m.provider}</span>
                </button>
              ))}
          </div>
        )}
        {catalogError && <div className="settings-error mono">{catalogError}</div>}
      </section>

      <ModelSetsSection
        sets={s.modelSets ?? {}}
        active={active}
        facts={facts}
        save={save}
      />

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

      <JudgeModelSection s={s} save={save} active={active} />
    </>
  );
}

// --- Starter set (DECISIONS.md D36) ----------------------------------------------
// A key on its own does nothing. This proposes four models covering the four
// roles the app actually needs — cheap, strong, long-context, wildcard — and
// activates them in one click. It disappears once anything is active; it is
// onboarding, not a permanent panel.
function StarterSetSection({ catalog, active, fetching, anyProvider, onActivate }) {
  const proposal = useMemo(() => proposeStarterSet(catalog), [catalog]);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || active.length > 0) return null;
  if (!anyProvider) return null;
  if (fetching && !proposal.length) {
    return (
      <section className="starter-set">
        <div className="settings-section-head"><span className="section-label">Starter set</span></div>
        <p className="settings-hint">Reading the catalog…</p>
      </section>
    );
  }
  if (!proposal.length) return null;

  return (
    <section className="starter-set">
      <div className="settings-section-head">
        <span className="section-label">Starter set</span>
        <span className="status-pill pill-accent">suggested</span>
      </div>
      <p className="settings-hint">
        Four models covering the four jobs this app gives a model. Activate them and every picker
        in the app has something sensible to offer — you can change any of them afterwards.
      </p>
      <div className="starter-list">
        {proposal.map(p => (
          <div className="starter-row" key={p.role}>
            <span className="starter-role">{p.label}</span>
            <span className="model-id mono" title={p.id}>{p.id}</span>
            <FactChips facts={p.facts} />
            <span className="starter-hint muted">{p.hint}</span>
          </div>
        ))}
      </div>
      <div className="settings-row">
        <button className="primary" onClick={() => onActivate(proposal.map(p => p.id))}>
          Activate these {proposal.length}
        </button>
        <button className="ghost" onClick={() => setDismissed(true)}>Not now</button>
      </div>
    </section>
  );
}

// --- Model sets (DECISIONS.md D36) -------------------------------------
// A named list of active models: one thing to pick in a fan-out, a mode, or a
// comparison, instead of N pickers. Prerequisite for lanes (P2) being pleasant
// to author, and useful on its own as a filter in every model picker.
function ModelSetsSection({ sets, active, facts, save }) {
  const [newName, setNewName] = useState('');
  const entries = Object.entries(sets);
  const usable = active.filter(m => m.enabled !== false);

  const write = next => save({ modelSets: next });
  const createSet = () => {
    const name = newName.trim();
    const id = modelSetId(name);
    if (!id || sets[id]) return;
    write({ ...sets, [id]: { name, models: [] } });
    setNewName('');
  };
  const toggle = (id, modelId) => {
    const set = sets[id];
    if (!set) return;
    const has = set.models.includes(modelId);
    if (!has && set.models.length >= MODEL_SET_MAX) return;
    write({
      ...sets,
      [id]: { ...set, models: has ? set.models.filter(m => m !== modelId) : [...set.models, modelId] }
    });
  };
  const remove = id => {
    const { [id]: _gone, ...rest } = sets;
    write(rest);
  };

  return (
    <section>
      <div className="settings-section-head">
        <span className="section-label">Model sets</span>
        {entries.length > 0 && <span className="status-pill pill-neutral">{entries.length}</span>}
      </div>
      <p className="settings-hint">
        Name a group of models once — “analysts”, “cheap”, “the ones good at Rust” — then pick the
        group instead of the models. Sets filter every model picker, and a fan-out node will mint
        one lane per member.
      </p>
      {entries.length === 0 && <div className="muted">No sets yet.</div>}
      {entries.map(([id, set]) => (
        <div className="model-set" key={id}>
          <div className="model-set-head">
            <span className="model-set-name">{set.name}</span>
            <span className="mono muted">{id}</span>
            <span className="status-pill pill-neutral">{set.models.length} model{set.models.length === 1 ? '' : 's'}</span>
            <button className="link" onClick={() => remove(id)} aria-label={`Delete set ${set.name}`} title="Delete this set">✕</button>
          </div>
          {usable.length === 0
            ? <div className="muted">Activate some models first.</div>
            : (
              <div className="model-set-members">
                {usable.map(m => (
                  <label key={m.id} className={'model-set-member' + (set.models.includes(m.id) ? ' on' : '')}>
                    <input
                      type="checkbox"
                      checked={set.models.includes(m.id)}
                      onChange={() => toggle(id, m.id)}
                    />
                    <span className="mono">{m.id}</span>
                    <FactChips facts={facts[m.id]} />
                  </label>
                ))}
              </div>
            )}
        </div>
      ))}
      <div className="settings-row">
        <input
          type="text"
          value={newName}
          placeholder="New set name — e.g. analysts"
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createSet(); }}
          aria-label="New model set name"
        />
        <button
          onClick={createSet}
          disabled={!newName.trim() || Boolean(sets[modelSetId(newName)])}
          title={sets[modelSetId(newName)] ? 'A set with that name already exists' : 'Create this set'}
        >Create set</button>
      </div>
    </section>
  );
}

// --- Judge model (DECISIONS.md D27) ---------------------------------------
// Which model judges two runs side by side. Unset = the default worker (the
// same fallback triage uses); any active model can be pinned instead, and a
// free-text id covers everything else — it resolves at call time, exactly
// like the safety model.
function JudgeModelSection({ s, save, active }) {
  const configured = s.judgeModel ?? '';
  const known = active.some(m => m.id === configured);
  const isCustom = Boolean(configured) && !known;
  const [showCustom, setShowCustom] = useState(isCustom);
  const [custom, setCustom] = useState(isCustom ? configured : '');

  return (
    <section>
      <div className="settings-section-head">
        <span className="section-label">Judge model</span>
        {configured
          ? <span className="status-pill pill-neutral mono">{configured}</span>
          : <span className="status-pill pill-neutral">default worker</span>}
      </div>
      <p className="settings-hint">
        Used by the <strong>Judge</strong> action when comparing two runs. The default worker is a
        reasonable judge; pin a stronger model here if you want verdicts graded by your best brain.
      </p>
      <div className="settings-row">
        <select
          value={isCustom ? 'custom' : configured}
          onChange={e => {
            if (e.target.value === 'custom') { setShowCustom(true); return; }
            setShowCustom(false);
            save({ judgeModel: e.target.value });
          }}
          aria-label="Judge model"
        >
          <option value="">Default worker{s.workers?.executor?.model ? ` (${s.workers.executor.model})` : ''}</option>
          {active.filter(m => m.enabled !== false).map(m => (
            <option key={m.id} value={m.id}>{m.id}</option>
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
            onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) save({ judgeModel: custom.trim() }); }}
          />
          <button className="primary" onClick={() => custom.trim() && save({ judgeModel: custom.trim() })} disabled={!custom.trim()}>
            Use
          </button>
        </div>
      )}
    </section>
  );
}
