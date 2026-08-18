import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canServe, routeFor, MOCK_MODELS, PROVIDER_ORDER } from './providerMirror.js';
import { groupModels, presentModel } from './modelPresentation.js';

// One model picker, used everywhere a model is chosen (D36 P0.4 / B14):
// the Inspector's field, the node-library editor, the launch composer, and the
// badge on a node card. Selecting a model should not require finding the right
// panel, and it should not require remembering what the model costs — so the
// picker carries the catalog facts (P0.2) and says out loud when a model no
// connected provider can serve is chosen (P0.5).
//
// The popover renders through a portal on purpose: React Flow's viewport is a
// transformed ancestor, and `position: fixed` inside a transform is not fixed.

// --- Shared model metadata --------------------------------------------------
// activeModels stays a prop (every call site already passes it); the rest —
// facts, sets, provider connection state — rides in context so adding them did
// not mean touching six call sites.
const ModelMetaContext = createContext({
  modelFacts: {}, modelSets: {}, providers: {}, providerPriority: PROVIDER_ORDER, catalog: []
});

export function ModelMetaProvider({ value, children }) {
  const v = useMemo(() => ({
    modelFacts: value?.modelFacts ?? {},
    modelSets: value?.modelSets ?? {},
    providers: value?.providers ?? {},
    providerPriority: value?.providerPriority ?? PROVIDER_ORDER,
    catalog: value?.catalog ?? []
  }), [value?.modelFacts, value?.modelSets, value?.providers, value?.providerPriority, value?.catalog]);
  return <ModelMetaContext.Provider value={v}>{children}</ModelMetaContext.Provider>;
}

export const useModelMeta = () => useContext(ModelMetaContext);

// --- Formatting -------------------------------------------------------------

// Prices are per-million USD. Significant digits shift with magnitude because
// the range is enormous: $0.015/M and $75/M are both ordinary numbers here.
export function formatUsdPerM(n) {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'free';
  const s = n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return '$' + (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
}

export function formatContext(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return `${Math.round(n / 1000)}k`;
}

// The facts as short chips. Cost first: picking a model for a lane is a cost
// decision, and the number belongs where the decision is.
export function factChips(facts) {
  if (!facts) return [];
  const chips = [];
  const inP = formatUsdPerM(facts.inUsdPerM);
  const outP = formatUsdPerM(facts.outUsdPerM);
  if (inP && outP) chips.push({ key: 'price', text: `${inP}/${outP}`, title: `${inP} per 1M input tokens · ${outP} per 1M output tokens` });
  else if (inP) chips.push({ key: 'price', text: inP, title: `${inP} per 1M input tokens` });
  const ctx = formatContext(facts.contextLength);
  if (ctx) chips.push({ key: 'ctx', text: ctx, title: `${facts.contextLength.toLocaleString()} token context window` });
  if (facts.supportsTools === true) chips.push({ key: 'tools', text: 'tools', title: 'Calls tools natively' });
  if (facts.supportsTools === false) chips.push({ key: 'notools', text: 'no tools', title: 'No native tool calling — the agent loop falls back to the text protocol', warn: true });
  return chips;
}

export function FactChips({ facts, className = '' }) {
  const chips = factChips(facts);
  if (!chips.length) return null;
  return (
    <span className={'model-facts ' + className}>
      {chips.map(c => (
        <span key={c.key} className={'model-fact' + (c.warn ? ' warn' : '')} title={c.title}>{c.text}</span>
      ))}
    </span>
  );
}

// --- Worker value helpers ---------------------------------------------------

const isMock = w => w?.provider === 'mock';
export const workerModelId = w => (w?.model ? w.model : null);

// What the control shows when closed. `placeholder` is what UNSET means at
// this call site: "default worker" is right in the Inspector and wrong on the
// Loop view, where an empty work picker means effort bands and an empty
// reviewer means nothing lands. Same control, different absences.
export function workerLabel(worker, placeholder = 'default worker') {
  if (!worker?.model) return placeholder;
  if (isMock(worker)) return worker.model;
  return presentModel(worker.model).modelPart;
}

// --- The menu body ----------------------------------------------------------

function ModelMenu({ worker, activeModels, onChange, onClose, idPrefix }) {
  const { modelFacts, modelSets, providers, providerPriority, catalog } = useModelMeta();
  const [query, setQuery] = useState('');
  const [setFilter, setSetFilter] = useState(null);
  const [custom, setCustom] = useState('');
  const searchRef = useRef(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const actives = useMemo(
    () => (activeModels ?? []).filter(m => m && m.enabled !== false && m.pinned !== false),
    [activeModels]);

  const sets = useMemo(() => Object.entries(modelSets ?? {})
    .map(([id, set]) => ({ id, name: set?.name ?? id, models: set?.models ?? [] }))
    .filter(s => s.models.length), [modelSets]);

  const route = useCallback(
    (id, source) => routeFor(id, { providers, providerPriority, source }),
    [providers, providerPriority]);

  const q = query.trim().toLowerCase();
  const inSet = setFilter ? new Set(sets.find(s => s.id === setFilter)?.models ?? []) : null;
  const matches = m => {
    if (inSet && !inSet.has(m.id)) return false;
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || (modelFacts[m.id]?.name ?? '').toLowerCase().includes(q);
  };

  const shown = actives.filter(matches);
  // A person can have both a direct id and its OpenRouter alias left over from
  // older settings. They are still two valid routes, but one visible model.
  const shownUnique = shown.filter((m, index, list) => {
    const p = presentModel(m);
    return list.findIndex(other => {
      const o = presentModel(other);
      return o.creatorKey === p.creatorKey && o.modelPart.toLowerCase() === p.modelPart.toLowerCase();
    }) === index;
  });
  const shownGroups = groupModels(shownUnique.map(m => ({ ...m, name: modelFacts[m.id]?.name })));
  // Nothing activated yet: offer the fetched catalog rather than a dead list.
  // The old picker's free-text-only fallback is still here, one field down.
  const fallback = useMemo(() => {
    if (actives.length || !q) return [];
    return (catalog ?? []).filter(m => m.id.toLowerCase().includes(q)).slice(0, 40);
  }, [actives.length, catalog, q]);
  const fallbackGroups = useMemo(() => groupModels(fallback), [fallback]);

  const mocks = MOCK_MODELS.filter(id => !q || id.includes(q));
  const current = workerModelId(worker);

  const pick = (provider, model) => { onChange({ provider, model }); onClose?.(); };
  const pickCustom = () => {
    const id = custom.trim();
    if (!id) return;
    pick(id.startsWith('mock-') ? 'mock' : 'auto', id);
  };

  return (
    <div className="model-menu" role="dialog" aria-label="Choose a model">
      <div className="model-menu-search">
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={actives.length ? 'Search pinned models…' : 'Search the catalog…'}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}
          aria-label="Search models"
        />
      </div>

      {sets.length > 0 && (
        <div className="model-menu-sets" role="group" aria-label="Model sets">
          <button
            type="button"
            className={'model-set-chip' + (setFilter === null ? ' on' : '')}
            onClick={() => setSetFilter(null)}
          >All</button>
          {sets.map(s => (
            <button
              key={s.id}
              type="button"
              className={'model-set-chip' + (setFilter === s.id ? ' on' : '')}
              title={`${s.name}: ${s.models.join(', ')}`}
              onClick={() => setSetFilter(f => (f === s.id ? null : s.id))}
            >{s.name}</button>
          ))}
        </div>
      )}

      <div className="model-menu-list">
        {shown.length === 0 && actives.length > 0 && (
          <div className="model-menu-empty muted">No pinned model matches “{query}”.</div>
        )}
        {actives.length === 0 && (
          <div className="model-menu-empty muted">
            No models pinned yet — pin some on the Models page, or type an id below.
          </div>
        )}
        {shownGroups.map(group => (
          <React.Fragment key={group.key}>
            <div className="model-menu-head">{group.name}</div>
            {group.models.map(m => {
              const r = route(m.id, m.source);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={'model-option' + (current === m.id && !isMock(worker) ? ' on' : '')}
                  onClick={() => pick('auto', m.id)}
                  title={m.id}
                >
                  <span className="model-option-id">{m.presentation.name}</span>
                  <FactChips facts={modelFacts[m.id]} />
                  {r
                    ? <span className="model-option-route" title={`Served by ${r}`}>{r}</span>
                    : <span className="status-pill pill-err" title="No connected provider can serve this model — add a key in Settings → Providers">unrouted</span>}
                </button>
              );
            })}
          </React.Fragment>
        ))}
        {fallback.length > 0 && (
          <>
            <div className="model-menu-head">Catalog (not pinned)</div>
            {fallbackGroups.map(group => (
              <React.Fragment key={group.key}>
                <div className="model-menu-subhead">{group.name}</div>
                {group.models.map(m => (
                  <button key={m.id} type="button" className="model-option" onClick={() => pick('auto', m.id)} title={m.id}>
                    <span className="model-option-id">{m.presentation.name}</span>
                    <FactChips facts={modelFacts[m.id] ?? m} />
                  </button>
                ))}
              </React.Fragment>
            ))}
          </>
        )}
        {mocks.length > 0 && (
          <>
            <div className="model-menu-head">Dry run</div>
            {mocks.map(id => (
              <button
                key={id}
                type="button"
                className={'model-option' + (current === id && isMock(worker) ? ' on' : '')}
                onClick={() => pick('mock', id)}
              >
                <span className="model-option-id mono">{id}</span>
                <span className="model-option-route">mock</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="model-menu-custom">
        <input
          type="text"
          value={custom}
          placeholder="…or type any model id"
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); pickCustom(); }
            if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
          }}
          aria-label="Model id"
          id={idPrefix ? `${idPrefix}-custom` : undefined}
        />
        <button type="button" className="primary" disabled={!custom.trim()} onClick={pickCustom}>Use</button>
      </div>
      {custom.trim() && !route(custom.trim(), 'auto') && (
        <div className="model-menu-warn">
          No connected provider can serve <code className="mono">{custom.trim()}</code>. It will fail at run time
          unless you add a key in Settings → Providers.
        </div>
      )}
    </div>
  );
}

// --- The floating shell -----------------------------------------------------

// Anchored to the trigger's client rect, flipped up when it would fall off the
// bottom, and rendered into <body> so a transformed or clipping ancestor
// cannot swallow it.
function Popover({ anchorRect, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(() => ({ left: anchorRect?.left ?? 0, top: (anchorRect?.bottom ?? 0) + 6 }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchorRect) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - width);
    if (top + height > window.innerHeight - margin) top = Math.max(margin, anchorRect.top - height - 6);
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [anchorRect]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = e => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div className="model-popover nodrag nowheel nopan" ref={ref} style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>,
    document.body
  );
}

// --- The control ------------------------------------------------------------

// The button-plus-popover used as a form field (Inspector, node library,
// launch composer). `worker` is { provider, model }; provider 'auto' means an
// active model resolved by priority at call time.
export function ModelPicker({ worker, activeModels, onChange, idPrefix, className = '', placeholder = 'default worker' }) {
  const { modelFacts, providers, providerPriority } = useModelMeta();
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  const id = workerModelId(worker);
  const source = (activeModels ?? []).find(m => m.id === id)?.source ?? (isMock(worker) ? 'mock' : 'auto');
  const r = id ? routeFor(id, { providers, providerPriority, source }) : null;
  const unrouted = Boolean(id) && !r;

  const open = () => setRect(btnRef.current?.getBoundingClientRect() ?? null);

  return (
    <div className={'worker-picker ' + className}>
      <button
        type="button"
        ref={btnRef}
        className={'model-trigger nodrag' + (unrouted ? ' unrouted' : '')}
        onClick={e => { e.stopPropagation(); open(); }}
        aria-haspopup="dialog"
        aria-expanded={Boolean(rect)}
        aria-label="model"
        title={unrouted ? 'No connected provider can serve this model' : (r ? `Served by ${r}` : 'Choose a model')}
      >
        <span className={'model-trigger-id mono' + (id ? '' : ' unset')}>{workerLabel(worker, placeholder)}</span>
        <FactChips facts={id ? modelFacts[id] : null} />
        {unrouted && <span className="status-pill pill-err">unrouted</span>}
        <span className="model-trigger-caret" aria-hidden>▾</span>
      </button>
      {rect && (
        <Popover anchorRect={rect} onClose={() => setRect(null)}>
          <ModelMenu
            worker={worker}
            activeModels={activeModels}
            onChange={onChange}
            onClose={() => setRect(null)}
            idPrefix={idPrefix}
          />
        </Popover>
      )}
    </div>
  );
}

// The compact form for a node card (B14): the model id alone, sized to sit in
// a title row, opening the same menu.
export function ModelBadge({ worker, activeModels, onChange, title }) {
  const { modelFacts, providers, providerPriority } = useModelMeta();
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);

  const id = workerModelId(worker);
  const facts = id ? modelFacts[id] : null;
  const source = (activeModels ?? []).find(m => m.id === id)?.source ?? (isMock(worker) ? 'mock' : 'auto');
  const unrouted = Boolean(id) && !isMock(worker) && !routeFor(id, { providers, providerPriority, source });
  const price = formatUsdPerM(facts?.inUsdPerM);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={'node-model-badge nodrag' + (unrouted ? ' unrouted' : '')}
        title={title ?? (unrouted ? `${id} — no connected provider can serve this` : `Model: ${workerLabel(worker)} — click to change`)}
        onClick={e => {
          e.stopPropagation();
          setRect(btnRef.current?.getBoundingClientRect() ?? null);
        }}
        onDoubleClick={e => e.stopPropagation()}
        aria-haspopup="dialog"
        aria-expanded={Boolean(rect)}
      >
        <span className="node-model-id">{workerLabel(worker)}</span>
        {price && <span className="node-model-price">{price}</span>}
        {unrouted && <span className="node-model-warn" aria-label="unrouted">!</span>}
      </button>
      {rect && (
        <Popover anchorRect={rect} onClose={() => setRect(null)}>
          <ModelMenu
            worker={worker}
            activeModels={activeModels}
            onChange={w => onChange(w)}
            onClose={() => setRect(null)}
          />
        </Popover>
      )}
    </>
  );
}

export { canServe, PROVIDER_ORDER };
