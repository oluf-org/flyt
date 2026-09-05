import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FactChips, formatContext, formatUsdPerM } from './ModelPicker.jsx';
import { routeFor } from './providerMirror.js';
import { groupModels, popularGroupKeys, presentModel } from './modelPresentation.js';
import { ModelProvidersSection } from './Settings.jsx';
import { connectedModelCatalog, providerUsageSummary } from './connectedModelCatalog.js';

const CURATED_PROVIDERS = ['anthropic', 'claude-code', 'openai', 'codex', 'kimi'];

function mergeCatalog(catalog, active, facts) {
  const byId = new Map();
  const pinned = new Set((active ?? [])
    .filter(model => model.enabled !== false && model.pinned !== false)
    .map(model => model.id));
  for (const entry of catalog ?? []) {
    const stored = facts?.[entry.id] ?? {};
    byId.set(entry.id, { ...entry, ...stored, id: entry.id });
  }
  for (const entry of active ?? []) {
    const previous = byId.get(entry.id) ?? {};
    byId.set(entry.id, { ...previous, ...(facts?.[entry.id] ?? {}), ...entry, id: entry.id });
  }
  // A direct API id and its OpenRouter-qualified alias are routes to the same
  // human-facing model, not two models. Consolidate them by creator + tail,
  // retaining the exact pinned id when one exists and merging richer facts
  // (usually price/context from OpenRouter) onto that primary route.
  const presented = new Map();
  for (const model of byId.values()) {
    const view = presentModel(model, model.provider);
    const key = `${view.creatorKey}/${view.modelPart.toLowerCase()}`;
    const previous = presented.get(key);
    if (!previous) {
      presented.set(key, model);
      continue;
    }
    const primary = pinned.has(model.id) && !pinned.has(previous.id)
      ? model
      : pinned.has(previous.id) && !pinned.has(model.id)
        ? previous
        : previous.id.includes('/') && !model.id.includes('/')
          ? model
          : previous;
    const secondary = primary === model ? previous : model;
    presented.set(key, { ...secondary, ...primary, aliases: [previous.id, model.id] });
  }
  return [...presented.values()];
}

function priceText(model) {
  const input = formatUsdPerM(model.inUsdPerM);
  const output = formatUsdPerM(model.outUsdPerM);
  if (!input && !output) return null;
  return `${input ?? '—'} input · ${output ?? '—'} output`;
}

function rankingDate(popularity) {
  const raw = popularity?.endDate ?? popularity?.asOf;
  if (!raw) return null;
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
  });
}

function Stat({ value, label }) {
  return (
    <div className="models-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function PinButton({ pinned, onClick, label, disabled = false }) {
  return (
    <button
      type="button"
      className={'model-pin' + (pinned ? ' pinned' : '')}
      aria-pressed={pinned}
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
      title={pinned ? 'Remove from model pickers' : 'Show in model pickers'}
      onClick={onClick}
      disabled={disabled}
    >
      <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
      {pinned ? 'Pinned' : 'Pin'}
    </button>
  );
}

const HARNESS_META = {
  'claude-code': { label: 'Claude Code harness' },
  codex: { label: 'Codex harness' },
};

function usageText(usage) {
  if (!usage) return null;
  const tokens = Number(usage.promptTokens ?? 0) + Number(usage.completionTokens ?? 0);
  const success = usage.successRate == null ? null : `${Math.round(usage.successRate * 100)}% success`;
  const cost = usage.costUsd == null ? null : `$${Number(usage.costUsd).toFixed(usage.costUsd < 1 ? 4 : 2)}`;
  return [`${usage.calls ?? 0} calls`, success, tokens ? `${tokens.toLocaleString()} tokens` : null, cost].filter(Boolean).join(' · ');
}

const compactNumber = value => Number(value ?? 0).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const compactCost = value => `$${Number(value ?? 0).toFixed(Number(value ?? 0) < 1 ? 4 : 2)}`;

function ModelRow({ model, pinned, routedBy, onPin, saving, usage = null }) {
  const p = model.presentation ?? presentModel(model, model.provider);
  const price = priceText(model);
  const context = formatContext(model.contextLength);
  const harness = HARNESS_META[routedBy];
  return (
    <article className={'models-row' + (pinned ? ' is-pinned' : '') + (harness ? ' is-harness' : '')}
      data-model-id={model.id} data-route={routedBy ?? undefined}>
      <div className="models-row-main">
        <div className="models-row-title">
          <h3>{p.name}</h3>
          <code className="model-version" title={model.id}>{p.modelPart}</code>
        </div>
        <div className="models-row-sub">
          {harness
            ? <span className="model-harness-badge">{harness.label}</span>
            : routedBy
            ? <span className="model-route-ok">Available via {routedBy}</span>
            : <span className="model-route-off">No connected route</span>}
          {model.supportsTools === false && <span>Text tool fallback</span>}
        </div>
        {usage && <div className="models-row-usage" title="Observed across the last 30 days">30d · {usageText(usage)}</div>}
      </div>
      <dl className="models-row-facts">
        <div>
          <dt>Price / 1M tokens</dt>
          <dd title={price ?? 'The connected catalog did not provide a price'}>{price ?? 'Not listed'}</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{context ?? 'Not listed'}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{model.supportsTools === true ? 'Native' : model.supportsTools === false ? 'Fallback' : 'Unknown'}</dd>
        </div>
      </dl>
      <FactChips facts={model} className="models-row-chips" />
      <PinButton pinned={pinned} onClick={onPin} label={p.name} disabled={saving} />
    </article>
  );
}

function PinnedModelButton({ model, routedBy, onClick }) {
  const harness = HARNESS_META[routedBy];
  return <button type="button" className={harness ? 'is-harness' : ''} data-route={routedBy ?? undefined}
    onClick={onClick} title={`Unpin ${model.presentation.name}`}>
    <span className="models-pinned-creator">{model.presentation.creatorName}</span>
    <strong>{model.presentation.name}</strong>
    <span>{priceText(model) ?? 'Price not listed'}</span>
    {harness && <span className="models-pinned-route">{harness.label}</span>}
    <span className="models-pinned-star" aria-hidden="true">★</span>
  </button>;
}

export default function ModelsPage({ onChanged }) {
  const [settings, setSettings] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState({});
  const [custom, setCustom] = useState('');
  const [fetching, setFetching] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState('');
  const [popularity, setPopularity] = useState(null);
  const [popularityError, setPopularityError] = useState('');
  const [usage, setUsage] = useState(null);
  const [pinnedMinimized, setPinnedMinimized] = useState(false);
  const loadedOpenRouter = useRef(false);
  const loadedRankings = useRef(false);

  useEffect(() => {
    let alive = true;
    window.flyt.getSettings()
      .then(value => {
        if (!alive) return;
        setSettings(value);
        if (value.modelPopularity) setPopularity(value.modelPopularity);
      })
      .catch(err => { if (alive) setError(String(err?.message ?? err)); });
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    window.flyt.historySummary?.({ from })
      .then(value => { if (alive) setUsage(value); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Catalogs are capabilities, not advertising: only ask providers that are
  // authenticated. This also removes stale models from a disconnected route
  // immediately instead of leaving cards that fail only when selected.
  useEffect(() => {
    if (!settings) return;
    let alive = true;
    const providers = CURATED_PROVIDERS.filter(provider => settings.providers?.[provider]?.hasKey);
    Promise.all(providers.map(provider => window.flyt.listModels(provider)
      .then(list => list.map(model => ({ ...model, provider })))
      .catch(() => [])))
      .then(lists => {
        if (!alive) return;
        const seen = new Set();
        const curated = lists.flat().filter(model => !seen.has(model.id) && seen.add(model.id));
        setCatalog(current => [...curated, ...current.filter(model => model.provider === 'openrouter')]);
      });
    return () => { alive = false; };
  }, [settings && CURATED_PROVIDERS.map(provider => Boolean(settings.providers?.[provider]?.hasKey)).join(':')]);

  const fetchPopularity = async (force = false) => {
    setPopularityError('');
    try {
      const result = await window.flyt.modelRankings(force);
      setPopularity(result);
      if (result.warning) setPopularityError(result.warning);
    } catch (err) {
      setPopularityError(String(err?.message ?? err));
    }
  };

  const fetchOpenRouter = async (refreshRanking = false) => {
    if (!settings?.providers?.openrouter?.hasKey) return;
    setFetching(true);
    setError('');
    try {
      const list = await window.flyt.listModels('openrouter');
      setCatalog(current => {
        const curated = current.filter(model => model.provider !== 'openrouter');
        return [...curated, ...list.map(model => ({ ...model, provider: 'openrouter' }))];
      });
      // The main process persists the latest catalog facts as it fetches.
      setSettings(await window.flyt.getSettings());
      if (refreshRanking) await fetchPopularity(true);
      onChanged?.();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    if (!settings?.providers?.openrouter?.hasKey || loadedOpenRouter.current) return;
    loadedOpenRouter.current = true;
    fetchOpenRouter(false);
  }, [settings?.providers?.openrouter?.hasKey]);

  useEffect(() => {
    if (!settings?.providers?.openrouter?.hasKey || loadedRankings.current) return;
    loadedRankings.current = true;
    fetchPopularity(false);
  }, [settings?.providers?.openrouter?.hasKey]);

  const active = settings?.activeModels ?? [];
  const pinnedIds = useMemo(() => new Set(active
    .filter(model => model.enabled !== false && model.pinned !== false)
    .map(model => model.id)), [active]);
  const allModels = useMemo(
    () => mergeCatalog(catalog, active, settings?.modelFacts),
    [catalog, active, settings?.modelFacts]
  );
  const connectedCatalog = useMemo(
    () => connectedModelCatalog(allModels, active, settings),
    [allModels, active, settings?.providers, settings?.providerPriority]
  );
  const models = connectedCatalog.models;
  const routes = connectedCatalog.routes;
  const providerUsage = useMemo(
    () => providerUsageSummary(usage?.models, active, settings),
    [usage?.models, active, settings?.providers, settings?.providerPriority]
  );
  const usageByModel = useMemo(
    () => new Map((usage?.models ?? []).map(row => [row.model, row])),
    [usage?.models]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(model => {
      const p = presentModel(model, model.provider);
      return [model.id, p.name, p.creatorName, p.modelPart].some(value => value.toLowerCase().includes(q));
    });
  }, [models, query]);
  const groups = useMemo(() => groupModels(filtered), [filtered]);
  const popularKeys = useMemo(() => popularGroupKeys(popularity, groups), [popularity, groups]);
  const popularKeySet = useMemo(() => new Set(popularKeys), [popularKeys]);
  const popularGroups = useMemo(() => {
    const byKey = new Map(groups.map(group => [group.key, group]));
    return popularKeys.map(key => byKey.get(key)).filter(Boolean);
  }, [groups, popularKeys]);
  const otherGroups = useMemo(() => groups.filter(group => !popularKeySet.has(group.key)), [groups, popularKeySet]);
  const pinnedModels = useMemo(() => models
    .filter(model => pinnedIds.has(model.id))
    .map(model => ({ ...model, presentation: presentModel(model, model.provider) })), [models, pinnedIds]);

  const saveModels = async next => {
    const value = await window.flyt.setSettings({ activeModels: next });
    setSettings(value);
    onChanged?.();
  };

  const togglePin = async model => {
    setSavingId(model.id);
    setError('');
    try {
      const aliases = new Set([model.id, ...(model.aliases ?? [])]);
      const matching = active.filter(entry => aliases.has(entry.id));
      const anyPinned = matching.some(entry => entry.enabled !== false && entry.pinned !== false);
      const next = matching.length
        ? active.map(entry => aliases.has(entry.id)
          ? { ...entry, enabled: true, pinned: anyPinned ? false : entry.id === model.id }
          : entry)
        : [...active, { id: model.id, source: 'auto', enabled: true, pinned: true }];
      await saveModels(next);
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setSavingId(null);
    }
  };

  const addCustom = async () => {
    const id = custom.trim();
    if (!id) return;
    if (!routeFor(id, { providers: settings?.providers, providerPriority: settings?.providerPriority })) {
      setError('That model ID has no authenticated provider route. Connect its provider first.');
      return;
    }
    const found = models.find(model => model.id === id) ?? { id, provider: null };
    await togglePin(found);
    setCustom('');
  };

  const renderCreator = group => {
    const hasPinned = group.models.some(model => pinnedIds.has(model.id));
    const open = Boolean(query.trim()) || Boolean(expanded[group.key]);
    return (
      <section className={'model-creator' + (open ? ' is-open' : '')} key={group.key}>
        <button
          type="button"
          className="model-creator-head"
          aria-expanded={open}
          aria-controls={`creator-${group.key}`}
          onClick={() => setExpanded(value => ({ ...value, [group.key]: !open }))}
        >
          <span className="model-creator-mark" aria-hidden="true">{group.name.slice(0, 1)}</span>
          <span>
            <strong>{group.name}</strong>
            <small>{group.models.length} model{group.models.length === 1 ? '' : 's'}</small>
          </span>
          {hasPinned && <span className="model-creator-pinned">★ pinned</span>}
          <span className="model-creator-caret" aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
        {open && (
          <div className="model-creator-body" id={`creator-${group.key}`}>
            {group.models.map(model => (
              <ModelRow
                key={model.id}
                model={model}
                pinned={pinnedIds.has(model.id)}
                routedBy={routes.get(model.id)}
                usage={(usage?.models ?? []).find(row => row.model === model.id)}
                saving={savingId === model.id}
                onPin={() => togglePin(model)}
              />
            ))}
          </div>
        )}
      </section>
    );
  };

  if (!settings) {
    return <main className="models-page"><div className="models-loading">{error || 'Loading model catalog…'}</div></main>;
  }

  const priced = models.filter(model => Number.isFinite(model.inUsdPerM) || Number.isFinite(model.outUsdPerM)).length;
  const connectedIds = Object.entries(settings.providers ?? {}).filter(([, value]) => value?.hasKey).map(([id]) => id);
  const harnesses = connectedIds.filter(id => HARNESS_META[id]).length;
  const nativeTools = models.filter(model => model.supportsTools === true).length;
  const usageTotals = usage?.totals ?? {};

  return (
    <main className="models-page" aria-labelledby="models-title">
      <header className="models-hero">
        <div>
          <p className="models-eyebrow">Model catalog</p>
          <h1 id="models-title">Models</h1>
          <p>Browse by creator, compare the facts that affect a run, and pin the models you want offered everywhere else.</p>
        </div>
        <div className="models-hero-actions">
          {settings.providers?.openrouter?.hasKey && (
            <button type="button" onClick={() => fetchOpenRouter(true)} disabled={fetching}>
              {fetching ? 'Refreshing…' : 'Refresh catalog'}
            </button>
          )}
        </div>
      </header>

      <section className="models-stats" aria-label="Catalog summary">
        <Stat value={models.length} label="models" />
        <Stat value={groups.length} label="creators" />
        <Stat value={pinnedModels.length} label="pinned" />
        <Stat value={priced} label="with pricing" />
        <Stat value={nativeTools} label="native tools" />
        <Stat value={connectedIds.length} label="providers" />
        <Stat value={harnesses} label="CLI harnesses" />
        <Stat value={usage ? compactNumber(usageTotals.modelCalls) : '—'} label="30d calls" />
        <Stat value={usage ? compactNumber(Number(usageTotals.promptTokens ?? 0) + Number(usageTotals.completionTokens ?? 0)) : '—'} label="30d tokens" />
        <Stat value={usage ? compactCost(usageTotals.costUsd) : '—'} label="30d recorded cost" />
      </section>

      <ModelProvidersSection
        s={settings}
        usage={providerUsage}
        save={async patch => {
          setError('');
          try {
            const next = await window.flyt.setSettings(patch);
            setSettings(next);
            onChanged?.();
            return next;
          } catch (err) {
            setError(String(err?.message ?? err));
            throw err;
          }
        }}
      />

      <section className="models-pinned" aria-labelledby="pinned-title">
        <div className="models-section-heading">
          <div>
            <p className="models-eyebrow">Available in pickers</p>
            <h2 id="pinned-title">Pinned alternatives</h2>
          </div>
          <div className="models-section-actions">
            <span>{pinnedModels.length} model{pinnedModels.length === 1 ? '' : 's'}</span>
            <button type="button" className="ghost mini" onClick={() => setPinnedMinimized(value => !value)} aria-expanded={!pinnedMinimized}>
              {pinnedMinimized ? 'Show' : 'Minimize'}
            </button>
          </div>
        </div>
        {!pinnedMinimized && (pinnedModels.length ? (
          <div className="models-pinned-grid">
            {pinnedModels.map(model => <PinnedModelButton key={model.id} model={model}
              routedBy={routes.get(model.id)}
              onClick={() => togglePin(model)} />)}
          </div>
        ) : <p className="models-empty">Nothing pinned. Pin a model below and it will appear in model pickers throughout the app.</p>)}
      </section>

      <section className="models-catalog" aria-labelledby="catalog-title">
        <div className="models-catalog-tools">
          <div>
            <p className="models-eyebrow">Everything available</p>
            <h2 id="catalog-title">Browse creators</h2>
          </div>
          <label className="models-search">
            <span className="sr-only">Search models</span>
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models or creators…" />
          </label>
        </div>

        {query.trim() ? (
          <div className="models-creator-grid">{groups.map(renderCreator)}</div>
        ) : (
          <>
            {popularGroups.length > 0 && (
              <section className="models-creator-section" aria-labelledby="popular-creators-title">
                <div className="models-subsection-heading">
                  <div>
                    <h3 id="popular-creators-title">Popular on OpenRouter</h3>
                    <p>Top creators by public token usage over the trailing 30 days.</p>
                  </div>
                  <small>
                    Source: OpenRouter (openrouter.ai/rankings){rankingDate(popularity) ? `, as of ${rankingDate(popularity)}` : ''}
                    {popularity?.stale ? ' · cached' : ''}
                  </small>
                </div>
                <div className="models-creator-grid">{popularGroups.map(renderCreator)}</div>
              </section>
            )}
            {otherGroups.length > 0 && (
              <section className="models-creator-section" aria-labelledby={popularGroups.length ? 'other-creators-title' : undefined}>
                {popularGroups.length > 0 && (
                  <div className="models-subsection-heading compact">
                    <div><h3 id="other-creators-title">All other creators</h3></div>
                    <small>Alphabetical</small>
                  </div>
                )}
                <div className="models-creator-grid">{otherGroups.map(renderCreator)}</div>
              </section>
            )}
            {popularityError && settings.providers?.openrouter?.hasKey && (
              <p className="models-popularity-note">Popularity could not be refreshed; the catalog remains available alphabetically. {popularityError}</p>
            )}
          </>
        )}
        {groups.length === 0 && <p className="models-empty">No models match “{query}”.</p>}
      </section>

      <section className="models-custom" aria-labelledby="custom-model-title">
        <div>
          <h2 id="custom-model-title">Pin a model by ID</h2>
          <p>For a model missing from the connected catalogs. Provider-qualified IDs are grouped by the part before the slash.</p>
        </div>
        <div className="models-custom-form">
          <input
            type="text"
            value={custom}
            onChange={event => setCustom(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') addCustom(); }}
            placeholder="creator/model-name"
            aria-label="Custom model ID"
          />
          <button type="button" className="primary" disabled={!custom.trim()} onClick={addCustom}>Pin model</button>
        </div>
      </section>

      {error && <div className="models-error" role="alert">{error}</div>}
    </main>
  );
}
