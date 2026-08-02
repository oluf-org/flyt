import React, { useEffect, useMemo, useState } from 'react';
import { APPROVAL_MODE_OPTIONS } from './ApprovalModePicker.jsx';
import { APP_NAME, CONFIG_DIR } from '../core/brand.js';
import { priceRange, formatPriceRange } from './modelCost.js';

// Settings page: four tabs behind a slim rail.
//   Providers — two bands (yours / available) of paired provider groups, each
//               card a one-line summary: status, models enabled, price range.
//   Models    — the curated active-models list with per-model source pins,
//               add-a-model search, default worker.
//   Safety    — tool approval mode + safety model.
//   Advanced  — project storage, flow files, provider priority, and the
//               Developer <details> holding the mock provider (G8): mock is a
//               developer tool, not a first-class provider, so it appears in
//               exactly this one place and is gated behind settings.mock.enabled.
// (SETTINGS-MODELS-PLAN §4/§6, P3.)
// The renderer never sees a stored key — only per-provider hasKey flags come
// back over IPC, and saving sends a key one way into the main process.

const PROVIDER_ORDER = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi', 'openrouter'];
// Providers whose "connection" is the vendor CLI's own sign-in, not a key.
const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'];

// Providers tab structure (SETTINGS-MODELS-PLAN §4, P5). An API key and its
// subscription sibling are ONE group, because the choice between them — pay
// per token, or spend the plan you already have — is the actual decision being
// made. As seven flat siblings that relationship existed only in prose.
const PROVIDER_GROUPS = [
  {
    id: 'claude', label: 'Claude', members: ['anthropic', 'claude-code'],
    choice: 'Pay per token with an API key, or spend the Claude plan you already have.'
  },
  {
    id: 'gpt', label: 'GPT', members: ['openai', 'codex'],
    choice: 'Pay per token with an API key, or spend your ChatGPT plan through Codex.'
  },
  { id: 'kimi', label: 'Kimi', members: ['kimi'] },
  { id: 'openrouter', label: 'OpenRouter', members: ['openrouter'] }
];
const PROVIDER_META = {
  anthropic: {
    name: 'Anthropic', blurb: 'Claude models — key from console.anthropic.com',
    placeholder: 'sk-ant-…',
    note: 'Pay-per-token API key. To use a Claude Pro/Max plan instead, see the Claude subscription card below.'
  },
  'claude-code': {
    name: 'Claude subscription', subscription: true,
    billing: 'spends your Claude plan',
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
    billing: 'spends your ChatGPT plan',
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

// Mirrors the adapters' canServe rules (presentational only — the main process
// stays the authority for actual resolution).
const SERVE = {
  anthropic: id => id.startsWith('claude-'),
  'claude-code': id => id.startsWith('claude-'),
  openai: id => /^(gpt-|o\d)/.test(id),
  codex: id => /^(gpt-|o\d|codex)/.test(id),
  kimi: id => /^(kimi-|moonshot-)/.test(id),
  openrouter: id => id.includes('/'),
  mock: id => id.startsWith('mock-')
};
const canServe = (provider, id) => SERVE[provider]?.(id) ?? false;

const MOCK_MODELS = ['mock-large', 'mock-small'];
const CATALOG_PROVIDERS = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi']; // curated lists; openrouter fetches live

export default function Settings({ onClose }) {
  const [tab, setTab] = useState('providers');
  const [s, setS] = useState(null); // the public settings payload
  const [error, setError] = useState('');

  useEffect(() => { window.flyt.getSettings().then(setS).catch(e => setError(String(e?.message ?? e))); }, []);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async patch => {
    setError('');
    try { setS(await window.flyt.setSettings(patch)); }
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
          {[['providers', 'Providers'], ['models', 'Models'], ['safety', 'Safety'], ['advanced', 'Advanced']].map(([id, label]) => (
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
          {s && tab === 'advanced' && <AdvancedTab s={s} save={save} />}
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
        <code className="mono">npm run flow -- adopt</code> in the repo checkout.
      </p>
      <div className="settings-row">
        <code className="mono settings-path">{info.dir}</code>
        <button onClick={() => window.flyt.openFlowFolder()}>Reveal</button>
      </div>
    </section>
  );
}

// Is this provider connected? Subscription providers are "connected" when the
// vendor CLI reports a signed-in account AND the user opted in — main-side
// hasKey already folds both, so this stays one flag.
const isConnected = (s, p) => Boolean(s.providers[p]?.hasKey);

// The one-line summary under a card head: how many models this provider will
// actually offer, and what buying there costs. Subscription providers (and a
// Kimi Code key) are billed against a plan, so they get the plan label in the
// same visual slot as dollars — the "a multi-node run burns your 5-hour
// window" point is a cost signal and belongs beside the prices, not buried in
// an expanded card (§2, subscription pricing).
function providerSummary(s, p) {
  const enabled = (s.activeModels ?? []).filter(m => m.enabled !== false && canServe(p, m.id)).length;
  const catalog = (s.catalog ?? []).filter(m => (m.providers ?? []).includes(p));
  const planBilled = SUBSCRIPTION_PROVIDERS.includes(p)
    || (p === 'kimi' && s.providers.kimi?.keyKind === 'code');
  const parts = [];
  if (isConnected(s, p)) {
    parts.push(`${enabled} model${enabled === 1 ? '' : 's'} enabled`);
  } else if (catalog.length) {
    parts.push(`${catalog.length} model${catalog.length === 1 ? '' : 's'} in catalog`);
  }
  const cost = planBilled ? 'your plan’s limits' : formatPriceRange(priceRange(catalog));
  if (cost) parts.push(cost);
  return { text: parts.join(' · '), enabled, planBilled };
}

function ProvidersTab({ s, save }) {
  const [expanded, setExpanded] = useState(null);
  const [keyInputs, setKeyInputs] = useState({});
  const [savedTick, setSavedTick] = useState(null);
  const [tests, setTests] = useState({}); // provider -> { state: 'running'|'ok'|'err', error? }

  // Two bands (§4): what you have, then what you could have. A paired group
  // sits with its connected half — splitting Anthropic from the Claude plan
  // across two bands would break the very comparison the pairing exists for.
  const yours = PROVIDER_GROUPS.filter(g => g.members.some(p => isConnected(s, p)));
  const available = PROVIDER_GROUPS.filter(g => !g.members.some(p => isConnected(s, p)));

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
    const r = await window.flyt.testProvider(p);
    setTests(t => ({ ...t, [p]: r.ok ? { state: 'ok' } : { state: 'err', error: r.error } }));
  };

  const card = p => {
    const meta = PROVIDER_META[p];
    const connected = isConnected(s, p);
    const sub = s.providers[p]?.subscription;
    const open = expanded === p;
    const t = tests[p];
    const summary = providerSummary(s, p);
    return (
      <div className={'provider-card' + (open ? ' open' : '') + (connected ? ' connected' : '')} key={p}>
        <button
          className="provider-card-head"
          onClick={() => setExpanded(open ? null : p)}
          aria-expanded={open}
        >
          <span className="provider-head-line">
            <span className="provider-name">{meta.name}</span>
            {meta.subscription
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
            {/* The billing pill is persistent, not a detail of the expanded
                body: "which of my balances does this spend?" is the question
                the card exists to answer (G7). */}
            {meta.billing && <span className="billing-pill">{meta.billing}</span>}
            {!connected && <span className="provider-connect">{open ? 'Close' : 'Connect'}</span>}
            <span className="provider-caret">{open ? '▾' : '▸'}</span>
          </span>
          {summary.text && <span className="provider-summary">{summary.text}</span>}
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
            {!meta.subscription && (
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
  };

  const group = g => (
    <div className={'provider-group' + (g.members.length > 1 ? ' paired' : '')} key={g.id}>
      {g.members.length > 1 && (
        <div className="provider-group-head">
          <span className="provider-group-label">{g.label}</span>
          <span className="provider-group-choice">{g.choice}</span>
        </div>
      )}
      <div className="provider-cards">{g.members.map(card)}</div>
    </div>
  );

  return (
    <>
      {yours.length > 0 && (
        <section>
          <div className="settings-section-head">
            <span className="section-label">Your providers</span>
          </div>
          <div className="provider-groups">{yours.map(group)}</div>
        </section>
      )}

      <section>
        <div className="settings-section-head">
          <span className="section-label">{yours.length ? 'Available' : 'Connect a provider'}</span>
        </div>
        <p className="settings-hint">
          Keys are stored locally in the app&rsquo;s user-data folder — never in the project, never shown again.
        </p>
        {s.summary?.connected === 0 && (
          <p className="settings-hint provider-note">
            No providers connected yet — add a key (or enable a subscription) below to get started.
            Just exploring? The mock provider runs dry-run flows with no key and no cost — enable it
            under <strong>Advanced → Developer</strong>.
          </p>
        )}
        {available.length === 0
          ? <p className="settings-hint">Everything the app knows about is connected.</p>
          : <div className="provider-groups">{available.map(group)}</div>}
      </section>
    </>
  );
}

// --- Advanced tab (SETTINGS-MODELS-PLAN §4) -----------------------------------
// Routing-mechanics and developer concerns that are not provider or model
// choices: project storage, flow files, provider priority, and — behind a
// closed <details> — the mock provider (G8).

function AdvancedTab({ s, save }) {
  return (
    <>
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

      <RecordingSection s={s} save={save} />

      <FlowFilesSection />

      <ProviderPrioritySection s={s} save={save} />

      <section>
        <details className="developer-details">
          <summary>
            <span className="section-label">Developer</span>
          </summary>
          <MockSection s={s} save={save} />
        </details>
      </section>
    </>
  );
}

// Recording (PIVOT-PLAN §4.3, §5.2). Every model call already writes a record —
// usage, cost, latency, throughput — and that is not optional: the ledger is
// what the app is for. What IS optional is how much of the CONVERSATION rides
// along, and how long a stalled provider gets to hold a node.
//
// The wire setting is the one control in the app with a real data-loss
// dimension, so it says so plainly rather than hiding behind a word like
// "verbose": a full capture is source code and pasted credentials, uncapped, on
// disk, for as long as the run folder exists.
const WIRE_MODES = [
  ['bounded', 'Bounded — capped at 256 KB per body, credentials redacted (default)'],
  ['full', 'Full — whole request and response bodies, credentials redacted'],
  ['off', 'Off — record metrics only, never the conversation']
];
const TIMEOUTS = [
  [0, 'No timeout — wait indefinitely'],
  [120_000, '2 minutes'],
  [600_000, '10 minutes (default)'],
  [1_800_000, '30 minutes']
];

function RecordingSection({ s, save }) {
  const wire = s.wireCapture ?? 'bounded';
  const timeout = Number.isFinite(s.timeoutMs) ? s.timeoutMs : 600_000;
  return (
    <section>
      <div className="settings-section-head">
        <span className="section-label">Recording</span>
      </div>
      <p className="settings-hint">
        Every model call is recorded to <code>runs/&lt;id&gt;/calls/</code> — what it cost, how long it
        took, how fast it generated. This is how much of the request and response is kept alongside
        those numbers.
      </p>
      <div className="settings-row">
        <select value={wire} onChange={e => save({ wireCapture: e.target.value })} aria-label="Wire capture">
          {WIRE_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
      {wire === 'full' && (
        <p className="settings-warn">
          Full capture writes everything you send a model — including source code and anything
          pasted into a prompt — to disk, uncapped, for as long as the run folder exists.
          Credentials are redacted; nothing else is.
        </p>
      )}
      <div className="settings-section-head" style={{ marginTop: 14 }}>
        <span className="section-label">Call timeout</span>
      </div>
      <p className="settings-hint">
        How long one attempt may take before it is aborted and retried. A provider that simply stops
        answering used to hang a node indefinitely.
      </p>
      <div className="settings-row">
        <select
          value={timeout}
          onChange={e => save({ timeoutMs: Number(e.target.value) })}
          aria-label="Per-call timeout"
        >
          {TIMEOUTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>
    </section>
  );
}

// Provider priority: the first connected provider that can serve a model wins.
// Relocated from the Models tab (§4) — once source-pinning is one click on
// every row, this is a routing-mechanics control, not an everyday one.
function ProviderPrioritySection({ s, save }) {
  const priority = s.providerPriority ?? PROVIDER_ORDER;
  const connected = p => Boolean(s.providers[p]?.hasKey);
  const move = (p, dir) => {
    const order = [...priority];
    const i = order.indexOf(p);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    save({ providerPriority: order });
  };
  return (
    <section>
      <div className="settings-section-head">
        <span className="section-label">Provider priority</span>
      </div>
      <p className="settings-hint">
        When a model is available from several sources, the first connected one wins.
      </p>
      <div className="priority-chips">
        {priority.filter(p => p !== 'mock').map((p, i, list) => (
          <span className={'priority-chip' + (connected(p) ? '' : ' off')} key={p}>
            <span className="priority-chip-label">{PROVIDER_META[p]?.name ?? p}</span>
            <button aria-label={`Move ${p} earlier`} disabled={i === 0} onClick={() => move(p, -1)}>◀</button>
            <button aria-label={`Move ${p} later`} disabled={i === list.length - 1} onClick={() => move(p, 1)}>▶</button>
          </span>
        ))}
      </div>
    </section>
  );
}

// --- Mock provider (G8, SETTINGS-MODELS-PLAN §6) -------------------------------
// A development affordance, gated behind settings.mock.enabled: while disabled
// it appears in no picker and offers nothing. The adapter stays registered in
// core regardless — canServe fences it to mock-* ids, and the test suite drives
// it directly. P4 wires these fields into runtimeConfig.mock; the state is
// already fully writable here.

const MOCK_MODE_OPTIONS = [
  ['roles', 'Canned per-role output', 'the default — keeps every existing behaviour and test green'],
  ['custom', 'Custom response', 'whatever you type below is returned verbatim for every call'],
  ['echo', 'Echo the prompt', 'the fastest way to inspect assembled context'],
  ['error', 'Always fail', 'exercises retry and failure UI']
];

function MockSection({ s, save }) {
  const mock = s.mock ?? {};
  const enabled = mock.enabled === true;
  const [custom, setCustom] = useState(mock.customResponse ?? '');
  const [newRole, setNewRole] = useState('');
  const perRole = mock.perRole ?? {};

  return (
    <div className="mock-section">
      <p className="settings-hint">
        The mock provider fakes model calls for dry runs — no key, no cost. While enabled it appears
        in model pickers; while disabled it is hidden everywhere. Tests use it directly either way.
      </p>
      <label className="sub-enable-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => save({ mock: { enabled: e.target.checked } })}
          aria-label="Enable mock provider"
        />
        <span>Enable mock provider</span>
      </label>

      {enabled && (
        <>
          <div className="settings-section-head">
            <span className="section-label">Response mode</span>
          </div>
          <div className="approval-modes" role="radiogroup" aria-label="Mock response mode">
            {MOCK_MODE_OPTIONS.map(([id, label, detail]) => (
              <label key={id} className={'approval-mode-row' + ((mock.mode ?? 'roles') === id ? ' active' : '')}>
                <input
                  type="radio"
                  name="mock-mode"
                  checked={(mock.mode ?? 'roles') === id}
                  onChange={() => save({ mock: { mode: id } })}
                />
                <span className="approval-mode-text">
                  <span className="approval-mode-label">{label}</span>
                  <span className="approval-mode-detail">{detail}</span>
                </span>
              </label>
            ))}
          </div>

          {mock.mode === 'custom' && (
            <>
              <div className="settings-row">
                <textarea
                  className="mono mock-custom-response"
                  rows={6}
                  placeholder={'Returned verbatim for every call.\nA fenced ```tool block exercises the agent tool loop;\na fenced ```json block satisfies evaluator nodes.'}
                  value={custom}
                  onChange={e => setCustom(e.target.value)}
                  aria-label="Mock custom response"
                />
              </div>
              <div className="settings-row">
                <button
                  className="primary"
                  disabled={custom === (mock.customResponse ?? '')}
                  onClick={() => save({ mock: { customResponse: custom } })}
                >Save response</button>
              </div>
            </>
          )}

          <div className="settings-section-head">
            <span className="section-label">Per-role overrides</span>
            {Object.keys(perRole).length > 0 && <span className="status-pill pill-neutral">{Object.keys(perRole).length}</span>}
          </div>
          <p className="settings-hint">
            Optional <code className="mono">role → text</code> rows; an override beats the response mode
            above for that role, so one mock run can drive a whole multi-node flow with distinct outputs.
          </p>
          {Object.entries(perRole).map(([role, text]) => (
            <div className="settings-row" key={role}>
              <code className="mono mock-role-name" title={role}>{role}</code>
              <input
                type="text"
                value={text}
                onChange={e => save({ mock: { perRole: { ...perRole, [role]: e.target.value } } })}
                aria-label={`Mock response for role ${role}`}
              />
              <button
                className="link"
                aria-label={`Remove override for ${role}`}
                onClick={() => {
                  const next = { ...perRole };
                  delete next[role];
                  save({ mock: { perRole: next } });
                }}
              >✕</button>
            </div>
          ))}
          <div className="settings-row">
            <input
              type="text"
              placeholder="Role name, e.g. documentation"
              value={newRole}
              onChange={e => setNewRole(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newRole.trim() && !perRole[newRole.trim()]) {
                  save({ mock: { perRole: { ...perRole, [newRole.trim()]: '' } } });
                  setNewRole('');
                }
              }}
              aria-label="New override role"
            />
            <button
              disabled={!newRole.trim() || Boolean(perRole[newRole.trim()])}
              onClick={() => { save({ mock: { perRole: { ...perRole, [newRole.trim()]: '' } } }); setNewRole(''); }}
            >Add override</button>
          </div>

          <div className="settings-section-head">
            <span className="section-label">Behaviour</span>
          </div>
          <div className="settings-row">
            <label className="mock-field">
              Latency (ms)
              <input
                type="number" min="0" max="60000" step="100"
                value={mock.latencyMs ?? 700}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0) save({ mock: { latencyMs: v } });
                }}
                aria-label="Mock latency in milliseconds"
              />
            </label>
            <label className="mock-field">
              Failure rate (0–1)
              <input
                type="number" min="0" max="1" step="0.05"
                value={mock.failureRate ?? 0}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0 && v <= 1) save({ mock: { failureRate: v } });
                }}
                aria-label="Mock failure rate"
              />
            </label>
            <label className="keykind-option">
              <input
                type="checkbox"
                checked={mock.streaming !== false}
                onChange={e => save({ mock: { streaming: e.target.checked } })}
              />
              Stream output
            </label>
          </div>
          <p className="settings-hint">
            Latency 0 tests that the canvas doesn&rsquo;t flicker on instant nodes; a failure rate above 0
            injects adapter errors for testing retry and gate paths.
          </p>
        </>
      )}
    </div>
  );
}

// --- Subscription provider card (SUBSCRIPTION-AUTH-GUIDE) -------------------
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
      window.flyt.listModels(p)
        .then(list => list.map(m => ({ ...m, provider: p })))
        .catch(() => [])
    )).then(lists => {
      if (!alive) return;
      // The subscription catalogs repeat their API sibling's ids — keep the
      // first occurrence so the datalist offers each id once.
      const seen = new Set();
      setCatalog(lists.flat().filter(m => !seen.has(m.id) && seen.add(m.id)));
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
    (s.mock?.enabled && MOCK_MODELS.some(m => workerValue === `mock:${m}`)) ||
    active.some(m => m.enabled !== false && workerValue === `active:${m.id}`)
  );

  return (
    <>
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
              {/* G8: mock models are only offered while the mock provider is
                  explicitly enabled in Advanced → Developer. */}
              {s.mock?.enabled && MOCK_MODELS.map(m => <option key={m} value={`mock:${m}`}>{m} (mock)</option>)}
            </select>
          </div>
        )}
      </section>

      <JudgeModelSection s={s} save={save} active={active} />
    </>
  );
}

// --- Judge model (CONFIGS-COMPARE P3) ---------------------------------------
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
