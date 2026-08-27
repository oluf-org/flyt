// Tool registry: the single toolbox both agent execution paths (native
// tool-calling and the text protocol) draw from. A registry entry is
//   { name, description, parameters (JSON Schema), run(args, ctx),
//     effects, scope, risk, trust, autoExecute, provider }
// where ctx = { store, runId, taskId, defaultWorker } gives sandboxed access
// to the run's files.
//
// The DEFINITIONS live in files (tools/<id>.json, owned by core/toolstore.js);
// this module is the in-memory cache the run loop reads. The built-ins are
// registered at import so anything that doesn't run a ToolStore — the test
// suite, the CLI — still has a working toolbox; a host with a library calls
// loadLibrary() to replace the registry with what is actually on disk.
import { BUILTIN_MODULES, builtinDefinition } from './builtins.js';
import { getProvider } from './providers.js';
import { previewResult, handleNote } from './preview.js';
import { redactArgs } from './redact.js';
import { normalizeToolset, SEED_TOOLSETS } from '../toolsets.js';
import { makeContext, resolveGrant } from '../../src/toolGrants.js';
import { normalizeTool, isDestructive as effectsAreDestructive } from '../../src/toolTypes.js';

export { validateArgs, schemaProblems, MAX_SCHEMA_DEPTH } from './schema.js';
import { validateArgs } from './schema.js';

const registry = new Map();

// Tools that MUTATE something outside the run (write the bound project or run
// shell commands). These are the calls a per-node approval gate pauses on (V1
// task 4 safety envelope); read-only tools like read_file are never gated.
//
// Derived from the record's `effects`/`scope` rather than a literal name list,
// so an imported tool is gated on what it does instead of on whether someone
// remembered to add it here. Unknown names gate: fail-closed is the house rule
// (core/safetyCheck.js).
export function isDestructive(nameOrTool) {
  if (typeof nameOrTool !== 'string') return effectsAreDestructive(nameOrTool);
  const tool = registry.get(nameOrTool);
  return tool ? effectsAreDestructive(tool) : true;
}

// Deprecated alias, kept for one release (DESIGN-SPEC.md §5): a Set-shaped view
// over the registry so `DESTRUCTIVE_TOOLS.has(name)` keeps working. Use
// isDestructive() — the Set cannot express "unknown tools gate".
export const DESTRUCTIVE_TOOLS = { has: name => isDestructive(name) };

// Register a runnable tool module (built-in shape: { name, description,
// parameters, run }). Metadata absent from the module is defaulted through the
// same normalizer the files go through, so a registry entry and a stored
// definition always agree on effects/risk/trust.
export function registerTool(tool) {
  if (!tool?.name || typeof tool.run !== 'function' || !tool.parameters) {
    throw new Error('A tool needs { name, description, parameters, run }');
  }
  const def = normalizeTool(builtinDefinition(tool));
  const entry = { ...def, name: def.id, description: tool.description, parameters: tool.parameters, run: tool.run.bind(tool) };
  registry.set(entry.name, entry);
  return entry;
}

// Bind one stored definition through its provider. Never throws: an
// unresolvable tool (missing built-in module, provider not built yet) comes
// back as { ok: false, reason } so a bad definition degrades the library
// instead of failing the launch.
export function registerDefinition(def) {
  let tool;
  try { tool = normalizeTool(def); }
  catch (err) { return { ok: false, id: def?.id ?? null, reason: String(err?.message ?? err) }; }
  if (!tool.enabled) return { ok: false, id: tool.id, reason: tool.disabledReason ?? 'disabled' };
  const provider = getProvider(tool.provider);
  if (!provider) return { ok: false, id: tool.id, reason: `unknown provider "${tool.provider}"` };
  try {
    const run = provider.load(tool);
    registry.set(tool.id, { ...tool, name: tool.id, run });
    return { ok: true, id: tool.id };
  } catch (err) {
    return { ok: false, id: tool.id, reason: String(err?.message ?? err) };
  }
}

// Replace the registry with a library's definitions (what the app does at
// startup with ToolStore.listFull()). Returns what loaded and what didn't,
// with reasons — resolution is never silent (DESIGN-SPEC.md §5).
export function loadLibrary(defs = [], sets = null) {
  registry.clear();
  const loaded = [], skipped = [];
  for (const def of defs) {
    const r = registerDefinition(def);
    if (r.ok) loaded.push(r.id); else skipped.push({ id: r.id, reason: r.reason });
  }
  if (sets) loadToolsets(sets);
  return { loaded, skipped };
}

// Toolsets are the names ceilings are written in (DESIGN-SPEC.md §5). They live
// beside the library in tools/sets/ and are cached here so grant resolution
// has one source at run time, whether or not a ToolStore exists.
let toolsets = SEED_TOOLSETS.map(normalizeToolset);
export function loadToolsets(sets = []) {
  toolsets = sets.map(s => { try { return normalizeToolset(s); } catch { return null; } }).filter(Boolean);
  return toolsets;
}
export const getToolsets = () => toolsets;

// Everything grant resolution needs: the live library plus the sets ceilings
// are written in.
export const grantContext = () => makeContext({ library: [...registry.values()], sets: toolsets });

// The same pair in the shape the linter takes, so the pre-run gate judges
// ceilings against exactly what the run will bind.
export const toolLibraryForLint = () => ({ tools: [...registry.values()], sets: toolsets });

// Resolve one node's grant against its ceiling (DESIGN-SPEC.md §5). Returns the
// bound tool objects plus what was refused or missing, so the caller can log
// and surface both — a refused grant means something tried to exceed its
// envelope, which must never be silently absent.
export function resolveTools({ grant = null, ceiling = null } = {}) {
  const resolved = resolveGrant({ grant, ceiling, ctx: grantContext() });
  return { ...resolved, tools: getTools(resolved.tools) };
}

// The built-ins and the seeded sets, as a working default for every host
// without a library (the test suite, the CLI).
export function registerBuiltins() {
  for (const tool of BUILTIN_MODULES) registerTool(tool);
  toolsets = SEED_TOOLSETS.map(normalizeToolset);
}

// All registered tools, or the named subset (unknown names are ignored so a
// flow definition can't crash a run by naming a tool that no longer exists).
export function getTools(names) {
  if (!names) return [...registry.values()];
  return names.map(n => registry.get(n)).filter(Boolean);
}

// Registered ids — the live answer to "what may a node be granted?".
export const toolNames = () => [...registry.keys()];

// Validate + run + time one tool call. Never throws: failures (unknown tool,
// bad args, runtime error) come back as { ok: false, error } so the agent
// loop can hand them to the model for self-correction.
//
// The full result is written to runs/<id>/tools/<seq>-<tool>.json and the
// record carries a BOUNDED preview plus a handle (DESIGN-SPEC.md §5) — so a
// 200 KB command output survives on disk instead of being destroyed by
// truncation, and the model gets something it can ask more about. Without a
// store (a unit test, the planned Tools-page test-run) there is nowhere to
// put an artifact, so the full result stays inline exactly as before.
export async function executeTool(name, args, ctx) {
  const started = Date.now();
  const record = { tool: name, args, ok: false };
  const tool = registry.get(name);
  const activityNode = ctx?.taskId ? `executor-${ctx.taskId}` : (ctx?.nodeId ?? 'run');
  // The existing meta snapshot and audit log are the activity protocol. Keep
  // arguments out of the live edge; the completed tool_call below owns the
  // separately redacted detail record.
  const liveEdge = ctx.store?.writeToolActivity?.(ctx.runId, activityNode, { tool: name, active: true });
  if (liveEdge) {
    ctx.store?.appendLog?.(ctx.runId, { event: 'tool_start', node: callerOf(ctx), tool: name });
    try { ctx?.notify?.(); } catch { /* observability cannot break a tool */ }
  }
  try {
    if (!tool) throw new Error(`Unknown tool "${name}". Available: ${[...registry.keys()].join(', ')}`);
    const errors = validateArgs(tool.parameters, args ?? {});
    if (errors.length) throw new Error(`Invalid arguments: ${errors.join('; ')}`);
    record.result = await tool.run(args, ctx) ?? { ok: true };
    record.ok = true;
  } catch (err) {
    record.error = String(err?.message ?? err);
  }
  record.ms = Date.now() - started;

  // The audit trail must be safe to read, share and attach to a bug report:
  // credentials are redacted from the arguments before anything is written,
  // and the record the caller gets back is the redacted one.
  record.args = redactArgs(record.args, ctx?.secrets);
  archiveResult(record, tool, ctx);

  // Stores predating the live projection still receive their completed audit
  // record. A RunStore with no run metadata is a standalone tool invocation:
  // it has nowhere truthful to persist either edge, so both are skipped.
  if (!ctx.store?.writeToolActivity || liveEdge) {
    ctx.store?.appendLog?.(ctx.runId, { event: 'tool_call', node: callerOf(ctx), ...record });
  }
  if (liveEdge) {
    ctx.store.writeToolActivity(ctx.runId, activityNode, { tool: name, active: false });
    try { ctx?.notify?.(); } catch { /* observability cannot break a tool */ }
  }
  return record;
}

// Which node made this call. The executor path has always stamped its task; an
// aiStep's calls were stamped `undefined` and the runner passes `nodeId`, so
// every tool call a fan-out lane made landed in the log anonymously — four
// lanes reading one repository in parallel produced a few hundred interleaved
// entries with nothing to sort them by, and "what did THIS lane open" was
// unanswerable. `flyt why` counts per node, so it read every lane as having
// made no tool calls at all.
function callerOf(ctx) {
  if (ctx?.taskId) return `executor:${ctx.taskId}`;
  return ctx?.nodeId ?? undefined;
}

// Writes the artifact and swaps the record's result for its preview. Failing
// to write must never fail a call that already succeeded: a full disk should
// cost you the archive, not the work.
function archiveResult(record, tool, ctx) {
  if (!ctx?.store?.writeToolResult || !ctx.runId || record.result === undefined) return;
  const shape = tool?.result ?? {};
  if (shape.artifact === false) return;
  let written;
  try {
    written = ctx.store.writeToolResult(ctx.runId, {
      tool: record.tool, node: callerOf(ctx), task: ctx.taskId ?? undefined,
      args: record.args, ok: record.ok, ms: record.ms,
      ...(record.ok ? { result: record.result } : { error: record.error })
    });
  } catch (err) {
    ctx.store.appendLog?.(ctx.runId, { event: 'tool_artifact_failed', tool: record.tool, error: String(err?.message ?? err) });
    return;
  }
  record.artifact = written.path;
  record.handle = written.handle;
  if (!record.ok) return;

  const { value, truncated } = previewResult(record.result, shape);
  if (!truncated) return;
  record.bytes = Buffer.byteLength(JSON.stringify(record.result) ?? '', 'utf8');
  record.result = value;
  record.truncated = true;
  record.note = handleNote({ handle: written.handle, path: written.path, bytes: record.bytes });
}

registerBuiltins();
