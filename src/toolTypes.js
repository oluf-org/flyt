// Tool definitions: the shared vocabulary and the normalizer, peer to
// flowTypes.js (which does the same job for node templates). Kept in src/ so
// the renderer can reason about a tool record without importing core, and
// imported by core/toolstore.js the way nodestore.js imports flowTypes.js.
//
// A tool is a FILE (tools/<id>.json, app-level) carrying — beside its schema —
// what it costs you if it misbehaves (`effects`, `risk`), where it came from
// (`source`, `trust`), and how its result is handled (`result`). See
// See DESIGN-SPEC.md §5 for the full record and trust model.
import { schemaProblems } from '../core/tools/schema.js';

// The model-visible name is also the file name, so it is deliberately narrow.
export const TOOL_ID = /^[a-z][a-z0-9_]*$/;

// What a call costs you if it misbehaves (DESIGN-SPEC.md §5).
export const TOOL_EFFECTS = ['read', 'write', 'network', 'shell', 'destructive'];
export const RISK_LEVELS = ['safe', 'caution', 'danger'];
export const TRUST_TIERS = ['trusted', 'review', 'untrusted'];
export const TOOL_PROVIDERS = ['builtin', 'http', 'mcp', 'flow'];
export const PREVIEW_KINDS = ['json', 'text', 'image', 'none'];

// How far a call reaches. `run` = the run's own directory and nothing else
// (create_task, write_task_md — the same category as log.jsonl); `workspace` =
// the bound project or the world beyond it. Default `workspace`, so anything
// imported is treated as reaching outside until it says otherwise.
export const TOOL_SCOPES = ['run', 'workspace'];

// Effects that mutate something. This — not a hardcoded name list — is what
// the per-call approval gate reads (DESIGN-SPEC.md §5). `network` is absent on
// purpose: an outbound request is bounded by network policy, not by a prompt.
export const GATED_EFFECTS = new Set(['write', 'shell', 'destructive']);

// The gate protects what lies OUTSIDE the run: a mutating tool confined to
// runs/<id>/ can't touch the user's repo, and prompting for it would be the
// approval-fatigue failure the research warns about (§2.5). This reproduces
// exactly the pre-P1 hardcoded set {write_file, create_file, bash} while
// deriving it from the record instead of a literal name list.
export const isDestructive = tool =>
  (tool?.effects ?? []).some(e => GATED_EFFECTS.has(e)) && (tool?.scope ?? 'workspace') !== 'run';

// `destructive` is the one effect configuration cannot switch off: everything
// else in the app is overridable at the user's risk (D16), and irreversibility
// is where that stops.
export const isIrreversible = tool => (tool?.effects ?? []).includes('destructive');

const RISK_ORDER = { safe: 0, caution: 1, danger: 2 };
export const maxRisk = (a, b) => ((RISK_ORDER[a] ?? 1) >= (RISK_ORDER[b] ?? 1) ? a : b);

// The risk an effect set implies, used both as the default and — for untrusted
// tools — as a floor under whatever the definition claims.
export function inferRisk(effects = []) {
  if (effects.includes('destructive')) return 'danger';
  if (effects.includes('shell') || effects.includes('write')) return 'caution';
  if (effects.includes('network')) return 'caution';
  return 'safe';
}

// An untrusted tool's self-report can only ever gate it HARDER (§12.3): a
// server claiming readOnlyHint on a tool named delete_everything gets no
// benefit from the claim.
export const effectiveRisk = tool =>
  tool?.trust === 'untrusted'
    ? maxRisk(tool.risk ?? 'caution', inferRisk(tool.effects))
    : (tool?.risk ?? 'caution');

// Trust follows the SOURCE, never the definition's own say-so (§12.2).
export function trustForSource(kind) {
  if (kind === 'builtin') return 'trusted';
  if (kind === 'mcp' || kind === 'registry') return 'untrusted';
  return 'review'; // user-authored: believed once the user saves it
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);

function normalizeSource(source, provider) {
  const kind = str(source?.kind) || (provider === 'builtin' ? 'builtin' : 'user');
  return {
    kind,
    ...(source?.server ? { server: str(source.server) } : {}),
    importedFrom: source?.importedFrom ?? null,
    importedAt: source?.importedAt ?? null
  };
}

// Fill defaults, clamp every enum to its vocabulary, and refuse — by DISABLING
// with a visible reason rather than throwing — a definition whose schema we
// cannot validate against. Throws only when the id is unusable, because
// without an id there is nothing to show the reason on.
export function normalizeTool(def = {}) {
  const id = str(def.id).trim();
  if (!TOOL_ID.test(id)) {
    throw new Error(`Invalid tool id ${JSON.stringify(def.id ?? null)} — lowercase letters, digits and underscores, starting with a letter.`);
  }
  const provider = TOOL_PROVIDERS.includes(def.provider) ? def.provider : 'builtin';
  const source = normalizeSource(def.source, provider);
  const trust = TRUST_TIERS.includes(def.trust) ? def.trust : trustForSource(source.kind);

  const effects = TOOL_EFFECTS.filter(e => (Array.isArray(def.effects) ? def.effects : ['read']).includes(e));
  if (!effects.length) effects.push('read');
  const risk = RISK_LEVELS.includes(def.risk) ? def.risk : inferRisk(effects);

  const scope = TOOL_SCOPES.includes(def.scope) ? def.scope : 'workspace';
  const problems = schemaProblems(def.parameters);
  // An untrusted tool never auto-executes until it is explicitly promoted
  // (§12.2), and nothing auto-executes that reaches outside the run to mutate.
  const autoExecute = def.autoExecute === true &&
    trust !== 'untrusted' && !isDestructive({ effects, scope });

  const tool = {
    id,
    title: str(def.title).trim() || id,
    description: str(def.description).trim(),
    provider,
    enabled: def.enabled !== false && problems.length === 0,
    effects,
    scope,
    risk,
    autoExecute,
    source,
    trust,
    // The offending schema is KEPT (so the reason can be shown against what
    // caused it); it is the `enabled: false` above that keeps it out of the
    // registry, and only a registered tool is ever validated against.
    parameters: def.parameters && typeof def.parameters === 'object' ? def.parameters : { type: 'object', properties: {} },
    ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    keywords: strList(def.keywords),
    examples: strList(def.examples),
    result: {
      preview: PREVIEW_KINDS.includes(def.result?.preview) ? def.result.preview : 'json',
      maxPreviewChars: Number.isInteger(def.result?.maxPreviewChars) ? def.result.maxPreviewChars : 2000,
      artifact: def.result?.artifact !== false
    },
    ...(def[provider] && typeof def[provider] === 'object' ? { [provider]: def[provider] } : {})
  };
  const reason = problems.length ? problems.join('; ') : str(def.disabledReason).trim();
  if (reason && !tool.enabled) tool.disabledReason = reason;
  return tool;
}

// The summary shape the pickers and the (planned) Tools page list from.
export const toolSummary = t => ({
  id: t.id, title: t.title, description: t.description, provider: t.provider,
  effects: t.effects, scope: t.scope, risk: t.risk, trust: t.trust, enabled: t.enabled,
  autoExecute: t.autoExecute, source: t.source,
  ...(t.disabledReason ? { disabledReason: t.disabledReason } : {})
});
