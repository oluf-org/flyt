// Diagnostics (D40): answering "why did that run fail?" without re-running it,
// and "will this model work here?" without spending a flow to find out.
//
// The occasion was a flow that failed on its fan-out four evenings running.
// Every attempt ended on the same sentence — `openrouter/deepseek/
// deepseek-v4-pro-0813 returned an empty response` — which names the model and
// stops. Nothing on disk said whether the answer had been truncated, spent on
// reasoning, or never begun; nothing said whether the model was reachable at
// all. The only available next step was to run it again, at full cost, and
// watch harder.
//
// These three read what the black box now records and turn it into a verdict:
//
//   explainRun()   — a failed or stuck run, explained from its own log
//   probeModel()   — one representative call, reporting what came back
//   doctor()       — the standing configuration: keys, providers, library
//
// Every one returns plain data. The CLI renders it; an agent reads it as JSON;
// nothing here prints.
import fs from 'node:fs';
import path from 'node:path';
import { callModel } from './adapters/index.js';
import { SUBSCRIPTION_PROVIDERS } from './modelSource.js';
import { planDefaultRoute, TASK_KINDS } from './modelPriority.js';
import { effortBudget, DEFAULT_EFFORT } from '../src/flowTypes.js';
import { v2Flag } from './v2.js';

// --- explainRun -----------------------------------------------------------

// Node statuses that mean "this is where the run stopped".
const BLOCKING = new Set(['failed', 'active']);

/**
 * Explain one run: what it was doing, where it stopped, and what the model
 * calls at that point actually did.
 *
 * @param {RunStore} store
 * @param {string} runId
 * @returns {object} a structured explanation (see `summary` for the prose)
 */
export function explainRun(store, runId) {
  const meta = store.readMeta(runId);
  if (!meta) throw new Error(`No run "${runId}" in this project.`);
  const log = store.readLog(runId) ?? [];
  const nodeStatus = meta.nodeStatus ?? {};

  const blocked = Object.entries(nodeStatus)
    .filter(([, s]) => BLOCKING.has(s))
    .map(([id, status]) => ({ id, status }));

  // What is in flight RIGHT NOW, derived from the log rather than from
  // nodeStatus. On a live run "which node is this?" is the whole question, and
  // meta lags: a node deep in an agent loop can still read `pending` there,
  // which made this command useless for exactly the run you most want to look
  // at — the one that has been going for forty minutes.
  // ...minus anything meta already calls finished. Input and container nodes
  // complete without any of the terminal events a worker node emits, so on the
  // log alone they look like they never stopped.
  const inFlight = inFlightFrom(log).filter(f => !['done', 'failed'].includes(nodeStatus[f.node]));

  // Errors are per node in the log even when meta.error carries only the first
  // one to bubble. A fan-out fails four lanes at once and meta names one.
  const nodeErrors = log.filter(e => e.event === 'node_error')
    .map(e => ({ node: e.node, role: e.role ?? null, error: e.error }));

  // Executor tasks are nodes too, as far as evidence goes.
  //
  // An agentTask's calls are traced under `executor:<taskId>`, and nothing in
  // the log ties that name back to the flow node that spawned it — the executor
  // path logs `task_claimed`, not `node_start`. So a report built only from
  // flow-node ids explained the input node and the output node and had nothing
  // whatsoever to say about the one that made forty model calls and every tool
  // call in the run. `callTraceNodes` already knows every name that made a
  // call; a failing one belongs in the report whatever it is called.
  let traceNames = [];
  try { traceNames = store.callTraceNodes?.(runId) ?? []; } catch { /* no traces to add */ }

  const nodes = [...new Set([
    ...blocked.map(b => b.id), ...nodeErrors.map(e => e.node), ...inFlight.map(f => f.node),
    // On a failed run, every name that made a call. Nothing else is going to
    // explain what the money bought.
    ...(meta.stage === 'failed' ? traceNames : [])
  ])].map(id => explainNode(store, runId, log, id, nodeStatus[id] ?? 'unknown', nodeErrors, inFlight, traceNames.length > 0));

  // A run parked on a question has not failed and is not still working: it is
  // waiting for the person now typing `flyt why`. Saying only "awaiting_input"
  // and the call stats tells them nothing they did not already know — the one
  // thing they need is the question, and the fact that they are the answer.
  const asking = meta.stage === 'awaiting_input'
    ? {
      node: meta.pendingNodeId ?? null,
      title: nodeTitle(store, runId, meta.pendingNodeId) ?? meta.pendingNodeId ?? null,
      questions: Array.isArray(meta.pendingQuestions) ? meta.pendingQuestions : []
    }
    : null;

  return {
    runId,
    stage: meta.stage,
    flow: meta.flowName ?? meta.flowId ?? null,
    error: meta.error ?? null,
    ...(asking ? { asking } : {}),
    startedAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    // A run nobody stopped and nothing failed is simply still working; saying
    // so beats an empty report that reads like a broken tool.
    verdict: verdictFor(meta, nodes),
    nodes,
    // Run-wide signals that explain a slow or expensive run even when nothing
    // failed. Kept separate from the per-node view because the answer to "why
    // did this take an hour" is usually a count, not one line.
    signals: signalsFrom(log, store, runId),
    suggestions: [...new Set(nodes.flatMap(n => n.suggestions))]
  };
}

// The node's own title from the resolved run graph — "What are we actually
// building?" is a better answer to "who is asking" than the node id.
function nodeTitle(store, runId, nodeId) {
  if (!nodeId) return null;
  try {
    return store.readFlow(runId)?.nodes?.find(n => n.id === nodeId)?.data?.title ?? null;
  } catch { return null; }
}

function verdictFor(meta, nodes) {
  if (meta.stage === 'failed') return 'failed';
  // Not "still running": nothing is running, and nothing will until you answer.
  if (meta.stage === 'awaiting_input') return 'waiting for your answer';
  if (meta.stage === 'cancelled') return 'stopped by hand';
  if (meta.stage === 'done') return 'completed';
  if (nodes.some(n => n.inFlight || n.status === 'active')) return 'still running';
  return meta.stage;
}

// Nodes that started and have not been seen to finish, with how long ago they
// started. A node_start with no later node_error / node_aborted / node_start of
// its own is still going; a `wave_start` container reports its children, which
// are the entries that actually carry the work.
function inFlightFrom(log) {
  const open = new Map();
  for (const e of log) {
    if (e.event === 'node_start' && e.node) open.set(e.node, e);
    if ((e.event === 'node_error' || e.event === 'node_aborted') && e.node) open.delete(e.node);
    // A node whose output was written and status advanced shows up as the next
    // node starting; the terminal signals are what we can rely on.
    if (e.event === 'retrospective' && e.node) open.delete(e.node);
    if (e.event === 'stage_change' && ['done', 'failed', 'cancelled'].includes(e.stage)) open.clear();
  }
  const now = Date.now();
  return [...open.values()].map(e => ({
    node: e.node,
    role: e.role ?? null,
    startedAt: e.ts,
    forMs: Number.isFinite(Date.parse(e.ts)) ? now - Date.parse(e.ts) : null
  }));
}

function explainNode(store, runId, log, nodeId, status, nodeErrors, inFlight = [], runHasTraces = false) {
  const calls = store.readCallTrace(runId, nodeId);
  const failed = calls.filter(c => c.ok === false);
  const ok = calls.filter(c => c.ok);
  const last = calls[calls.length - 1] ?? null;
  const empties = log.filter(e => e.event === 'model_empty_turn' && e.node === nodeId);
  const retries = log.filter(e => e.event === 'model_retry' && e.node === nodeId);
  // A trace file flattens `:` out of the node id (state.js safeName), so a
  // report keyed by the FILE name — which is the only name an executor task
  // has here — would find none of its own tool calls. Compare flattened.
  const flat = v => String(v ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const toolCalls = log.filter(e => e.event === 'tool_call' && flat(e.node) === flat(nodeId));
  const start = log.find(e => e.event === 'node_start' && e.node === nodeId) ?? null;
  const error = nodeErrors.find(e => e.node === nodeId)?.error ?? null;

  // Only ANSWERING turns count toward the reasoning share. A turn that ends in
  // finish_reason "tool_calls" is supposed to carry no prose — counting those
  // reports every healthy agent loop as "100% reasoning" while it is still
  // reading, which is a false alarm on exactly the runs someone is watching.
  const answering = ok.filter(c => c.finishReason !== 'tool_calls');
  const reasoningChars = answering.reduce((n, c) => n + (c.reasoningChars ?? 0), 0);
  const contentChars = answering.reduce((n, c) => n + (c.contentChars ?? 0), 0);
  const spentMs = calls.reduce((n, c) => n + (c.ms ?? 0), 0);
  // Runs recorded before the black box existed have no trace, which is not the
  // same fact as "this node made no calls" — and reading it as the latter turns
  // every archived failure into a confident wrong diagnosis.
  //
  // `runHasTraces` is the third case, and the one that was being reported as
  // the first: this run HAS a black box, and this node's calls are simply
  // filed under another name (an agentTask's are traced as
  // `executor:<taskId>`). Telling someone to re-run a run whose evidence is
  // sitting on disk is worse than saying nothing.
  const traced = calls.length > 0 || log.some(e => e.event === 'model_call') || runHasTraces;

  const live = inFlight.find(f => f.node === nodeId) ?? null;

  return {
    node: nodeId,
    status,
    traced,
    ...(live ? { inFlight: true, runningForMs: live.forMs } : {}),
    role: start?.role ?? null,
    model: start?.worker ? `${start.worker.provider}/${start.worker.model}` : (last ? `${last.provider}/${last.model}` : null),
    error,
    calls: {
      total: calls.length,
      failed: failed.length,
      truncated: ok.filter(c => c.finishReason === 'length').length,
      emptyTurns: empties.length,
      transientRetries: retries.length,
      toolCalls: toolCalls.length,
      contentChars,
      reasoningChars,
      // The one number that explains a node nobody could see progress on.
      reasoningShare: contentChars + reasoningChars
        ? Math.round((reasoningChars / (contentChars + reasoningChars)) * 100)
        : null,
      totalMs: spentMs,
      slowestMs: calls.reduce((n, c) => Math.max(n, c.ms ?? 0), 0)
    },
    lastCall: last,
    // What the node itself said was wrong with the work, as opposed to what
    // went wrong with the call. A node can fail with every call green: the
    // `work` node rejects a plan that does not meet the backlog contract, and
    // the sentence that helps — "no JSON array of tasks found" — was written
    // into the retrospective while `flyt why` printed only "the upstream plan
    // violated the backlog task contract" and "0 call(s)". The useful half was
    // on disk the whole time.
    problems: retrospectiveProblems(store, runId, nodeId),
    suggestions: suggestFor({ status, error, calls, ok, empties, retries, reasoningChars, contentChars, traced, elsewhere: !calls.length && runHasTraces })
  };
}

// The point of the whole module: a next step, derived from evidence rather
// than from the shape of the error string.
// The problems a node recorded about the WORK, not about the call. Never
// throws: a run whose retrospectives were never written is an ordinary older
// run, not a broken one.
function retrospectiveProblems(store, runId, nodeId) {
  try {
    const problems = store.readRetrospectives?.(runId)?.[nodeId]?.problems;
    return Array.isArray(problems) ? problems.filter(p => typeof p === 'string').slice(0, 6) : [];
  } catch { return []; }
}

function suggestFor({ status, error, calls, ok, empties, retries, reasoningChars, contentChars, traced, elsewhere = false }) {
  const out = [];
  if (!traced) {
    out.push('This run predates the model-call black box, so there is no per-call evidence to read — '
      + 'only the error text above. Re-run it and `flyt why` will have the finish reason and token split.');
    // Everything below reasons from records this run does not have; the error
    // text is genuinely all there is, and inventing more would be worse.
    if (error && /No connected provider/i.test(error)) {
      out.push('No provider can serve that model id. Check the id against `flyt doctor`.');
    }
    if (error && /CLI failed|config\.toml/i.test(error)) {
      out.push('A subscription CLI provider failed at its own config, not at the model. '
        + 'Either fix that CLI or move it below `openrouter` in the provider priority.');
    }
    if (error && /empty response|no content/i.test(error)) {
      out.push('An empty response from a reasoning model is usually its whole budget going to reasoning. '
        + 'Probe it directly: flyt probe <model>');
    }
    return out;
  }
  const truncated = ok.filter(c => c.finishReason === 'length');
  if (truncated.length) {
    out.push(`${truncated.length} call(s) hit finish_reason "length" — the answer was cut off at max_tokens `
      + `${truncated[0].maxTokens}. Raise this node's effort (low 2048 / medium 4096 / high 8192), or move it to a model that answers shorter.`);
  }
  if (empties.length) {
    out.push('The model returned reasoning but no content, and the nudged retry is what you are paying for. '
      + 'A reasoning model that spends its whole budget thinking needs a bigger budget (raise effort) or a different model for this node.');
  }
  if (reasoningChars > contentChars * 2 && reasoningChars > 2000) {
    out.push(`Reasoning outweighs the answer ${reasoningChars}:${contentChars} characters. `
      + 'This node is paying mostly for thinking — worth checking the model choice against what the node actually needs.');
  }
  if (retries.length >= 3) {
    out.push(`${retries.length} transient retries (rate limits / timeouts). `
      + 'The provider is throttling; fewer parallel lanes or a second provider in the priority list would both help.');
  }
  if (!calls.length && status === 'failed') {
    // Unless the run has traces filed under another name — an agentTask's calls
    // live under `executor:<taskId>`. "It failed before any model call" is a
    // confident, wrong, and expensive diagnosis to hand someone whose forty
    // calls are sitting on disk two lines further down the same report.
    out.push(elsewhere
      ? 'This node made no calls under its own name. Its work ran as an executor task, whose calls are '
        + 'traced separately — see the `executor:` entry in this report for the model, the finish reasons and the cost.'
      : 'This node failed before any model call was made — the cause is upstream of the provider: '
        + 'a missing key, an unservable model id, or a tool/config error. The node error text says which.');
  }
  if (error && /No connected provider/i.test(error)) {
    out.push('No provider can serve that model id. Check the id against `flyt doctor`, or add a key for a provider that carries it.');
  }
  if (error && /CLI failed|config\.toml/i.test(error)) {
    out.push('A subscription CLI provider failed at its own config, not at the model. '
      + 'Either fix that CLI or move it below `openrouter` in the provider priority so it is not chosen.');
  }
  return out;
}

/**
 * Run-wide counts worth surfacing even on a healthy run.
 *
 * Model calls come from the CALL TRACES first and the log second, for the same
 * reason the ledger does (D47): the trace is the record of every settled call,
 * and the log is a convenience that not every execution path writes. The
 * executor path — which is to say every run the Loop makes — writes
 * `calls/<node>.jsonl` and no `model_call` log line, so reading only the log
 * reported "0 model call(s)" on a run that had just billed forty-one of them,
 * and `flyt why` went on to explain that the run predated the black box. It
 * did not; the box was full and nobody opened it.
 */
/**
 * Every tool this run called, most-used first, with how many failed.
 *
 * @param log — the run's event log.
 * @returns `[{ name, calls, failed }]`, or an empty list for a run that called none.
 */
function toolBreakdown(log) {
  const byName = new Map();
  for (const e of log) {
    if (e.event !== 'tool_call' || !e.tool) continue;
    const row = byName.get(e.tool) ?? { name: e.tool, calls: 0, failed: 0 };
    row.calls += 1;
    if (e.ok === false) row.failed += 1;
    byName.set(e.tool, row);
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function signalsFrom(log, store = null, runId = null) {
  const count = ev => log.filter(e => e.event === ev).length;
  const logged = log.filter(e => e.event === 'model_call');
  const traced = [];
  try {
    for (const nodeId of store?.callTraceNodes?.(runId) ?? []) {
      traced.push(...(store.readCallTrace(runId, nodeId) ?? []));
    }
  } catch { /* an unreadable trace leaves the log's account standing */ }
  const modelCalls = traced.length ? traced : logged;
  return {
    modelCalls: modelCalls.length,
    modelMs: modelCalls.reduce((n, c) => n + (c.ms ?? 0), 0),
    toolCalls: count('tool_call'),
    // WHICH tools, and how many of them failed.
    //
    // "64 tool calls" is a number you cannot act on. "58 read_file, 4 glob, 2
    // bash, 0 writes" is a diagnosis: the attempt spent its budget on discovery
    // and never got to the work, which is the most common shape of an expensive
    // run that changed nothing. Counted by NAME rather than by a classification
    // — the names already say which is which, and a classification computed
    // here is a second one to keep in step with the tool definitions.
    tools: toolBreakdown(log),
    transientRetries: count('model_retry'),
    emptyTurns: count('model_empty_turn'),
    // Tasks that answered but did not do the thing they owed (WR-01). A run
    // whose count here is non-zero spent money producing descriptions of work
    // rather than work, which is the single most useful number for "why did
    // this run cost that much and change nothing".
    effectMissing: count('effect_missing'),
    // Accepted on the artifact because the workspace could not be measured —
    // the one case where landing's empty-diff check is the only backstop.
    effectUnverified: count('effect_unverified'),
    truncatedOutputs: count('output_truncated'),
    nodeRestarts: count('node_restart'),
    // Cost, when the provider reported it. Summed from the calls themselves so
    // it covers every round of every agent loop, not just the node's last one.
    usd: Number(modelCalls.reduce((n, c) => n + (c.usage?.cost ?? 0), 0).toFixed(4)) || 0
  };
}

// --- probeModel -----------------------------------------------------------

// A prompt that forces a real answer without being expensive: short input,
// short expected output, and a question a model cannot answer from its
// preamble. It is deliberately NOT trivial ("say hi") — a reasoning model will
// skip thinking entirely on those, which is exactly the behavior a probe needs
// to observe.
const PROBE_SYSTEM = 'Answer in at most three sentences. Be specific.';
const PROBE_PROMPT = 'A run of four parallel readers over one repository keeps failing on one lane. '
  + 'Name the single most likely cause and one way to confirm it.';

/**
 * Send one representative call and report what the app would have seen.
 *
 * This is the answer to "the flow says this model returns an empty response —
 * is that the model, the budget, or us?". It reports the content/reasoning
 * split and the finish reason, which is precisely the evidence that was
 * missing.
 *
 * @param {object} target  { provider, model, apiKey, ...adapter extras }
 * @param {object} opts    { maxTokens, stream, timeout, retry }
 */
export async function probeModel(target, { maxTokens = effortBudget(DEFAULT_EFFORT), stream = true, timeout = null, retry = null } = {}) {
  const started = Date.now();
  const base = {
    ...target,
    system: PROBE_SYSTEM,
    prompt: PROBE_PROMPT,
    maxTokens,
    ...(timeout ? { timeout } : {}),
    // One attempt: a probe reporting "it worked on the third try" as success
    // hides the thing worth knowing.
    retry: retry ?? { attempts: 1 }
  };
  let firstTextMs = null;
  if (stream) base.onText = () => { firstTextMs ??= Date.now() - started; };

  try {
    const res = await callModel(base);
    const content = String(res.text ?? '');
    const reasoning = String(res.reasoning ?? '');
    const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? null;
    return {
      provider: target.provider,
      model: target.model,
      ok: Boolean(content.trim()),
      ms: Date.now() - started,
      firstTextMs,
      finishReason: res.finishReason ?? null,
      contentChars: content.length,
      reasoningChars: reasoning.length,
      reasoningTokens,
      // Whether this model reasons at all decides how much budget it needs and
      // how long it will look frozen — both of which the app has to plan for.
      reasons: Boolean(reasoning.length || reasoningTokens),
      usage: res.usage ?? null,
      servedBy: res.resolvedModel && res.resolvedModel !== target.model ? res.resolvedModel : null,
      sample: content.trim().slice(0, 200),
      verdict: probeVerdict({ content, reasoning, finishReason: res.finishReason, maxTokens })
    };
  } catch (err) {
    return {
      provider: target.provider,
      model: target.model,
      ok: false,
      ms: Date.now() - started,
      error: String(err?.message ?? err).slice(0, 400),
      verdict: 'unreachable — the call itself failed; see error'
    };
  }
}

function probeVerdict({ content, reasoning, finishReason, maxTokens }) {
  if (!content.trim() && reasoning) {
    return `answers with reasoning only at max_tokens ${maxTokens} — this model will empty-turn in a flow `
      + 'unless the node runs at higher effort';
  }
  if (!content.trim()) return 'returned nothing at all — not usable as configured';
  if (finishReason === 'length') {
    return `truncated at max_tokens ${maxTokens} — usable, but this node's effort is too low for it`;
  }
  if (reasoning.length > content.length * 2) {
    return 'usable, but spends most of its budget reasoning — budget and latency accordingly';
  }
  return 'usable';
}

// --- doctor ---------------------------------------------------------------

/**
 * The standing configuration, checked.
 *
 * Deliberately offline by default: it reports what IS configured, and only
 * reaches the network when asked to (`probe: true`), because the commonest
 * failures here — no key, a provider ahead of the working one in the priority
 * list, a broken subscription CLI — are all visible without spending anything.
 *
 * @param {object} engine  the created engine (paths, settings, references)
 * @param {object} opts    { probe: boolean, models: string[] }
 */
/**
 * A `.git/index.lock` that nothing is using.
 *
 * git takes this lock to refresh or write the index. A killed git — a timeout,
 * an app quitting, a machine sleeping — leaves it behind, and from then on
 * every git WRITE in that repository fails, including the person's own
 * commits. Flyt polls `git status` on a schedule, so Flyt is a likely author.
 *
 * The test is "empty and old", not "no git is running": a git mid-operation
 * has written the new index into the lock, so an empty one is nobody's work in
 * progress, and one older than the longest operation we would wait for is not
 * about to be finished. Scanning the process table would be less accurate, not
 * more — an unrelated git anywhere on the machine would suppress the finding.
 *
 * Reports only. Deleting another process's lock is how a real concurrent write
 * gets corrupted, and that trade is not this function's to make.
 *
 * @param root — the repository to look at.
 * @param options.now — the clock, for tests.
 * @param options.staleMs — how old an empty lock has to be.
 * @returns the finding, or null.
 */
export function staleIndexLock(root, { now = Date.now(), staleMs = 5 * 60 * 1000 } = {}) {
  if (!root) return null;
  const lock = path.join(root, '.git', 'index.lock');
  let stat;
  try { stat = fs.statSync(lock); } catch { return null; }
  if (!stat.isFile() || stat.size > 0) return null;
  const ageMs = now - stat.mtimeMs;
  if (ageMs < staleMs) return null;
  return {
    level: 'warn',
    message: `${lock} has been empty for ${Math.round(ageMs / 60000)} minute(s). `
      + 'Until it is removed, every git write in this repository fails — including your own commits. '
      + 'It is usually left by a git that was killed mid-read; Flyt polls `git status`, so it may well be ours. '
      + `Check that no git is running, then: rm "${lock}"`
  };
}

export async function doctor(engine, { probe = false, models = [], project = null } = {}) {
  const settings = engine.settings ?? {};
  const priority = settings.providerPriority ?? [];

  const providers = priority.map(id => {
    const connected = engine.hasKey?.(id) ?? false;
    const sub = SUBSCRIPTION_PROVIDERS.includes(id) ? (engine.subscriptionStatus?.(id) ?? null) : null;
    return {
      id,
      connected,
      kind: SUBSCRIPTION_PROVIDERS.includes(id) ? 'subscription' : (id === 'mock' ? 'built-in' : 'api-key'),
      ...(sub ? { subscription: sub } : {})
    };
  });

  const findings = [];
  const lock = staleIndexLock(project?.folder ?? null);
  if (lock) findings.push(lock);
  if (!providers.some(p => p.connected && p.id !== 'mock')) {
    findings.push({ level: 'error', message: 'No real provider is connected — every run will fall back to the mock adapter.' });
  }
  // The failure this exists to catch: a provider sitting ABOVE the working one
  // in the priority list, taking every `provider: auto` call and failing it.
  for (const p of providers) {
    if (p.kind !== 'subscription' || !p.connected) continue;
    const ahead = providers.filter(q => q.connected && q.kind === 'api-key'
      && priority.indexOf(q.id) > priority.indexOf(p.id));
    if (ahead.length) {
      findings.push({
        level: 'warn',
        message: `"${p.id}" is a subscription CLI ranked above ${ahead.map(a => `"${a.id}"`).join(', ')}. `
          + `Every "provider: auto" call tries it first, so if that CLI is misconfigured the failure looks like a model problem. `
          + `Probe it with: flyt probe --provider ${p.id}`
      });
    }
  }

  const references = (engine.references?.list?.() ?? []).map(r => ({
    name: r.name, cloned: Boolean(r.cloned), commit: r.commit ?? null
  }));
  const uncloned = references.filter(r => !r.cloned);
  if (uncloned.length) {
    findings.push({
      level: 'info',
      message: `${uncloned.length} reference(s) declared but not cloned (${uncloned.map(r => r.name).join(', ')}). `
        + '`search_references` cannot see them. Run: flyt ref update'
    });
  }

  // How much of the key is left, for the one provider that publishes it.
  //
  // `connected` only ever meant "a key is present", and an EXHAUSTED key is
  // present. Twice now a night has ended on `403 Key limit exceeded` with
  // doctor reporting a healthy tick beside the provider that was refusing
  // every call: the first time it destroyed a backlog, the second it killed a
  // reading four lanes deep. The credit endpoint is free and answers in one
  // call, which is cheaper than any of the ways of finding out afterwards.
  const credit = await openrouterCredit(engine);
  if (credit) {
    const or = providers.find(p => p.id === 'openrouter');
    if (or) or.credit = credit;
    if (credit.limit != null && credit.usage != null) {
      const left = credit.limit - credit.usage;
      if (left <= 0) {
        findings.push({
          level: 'error',
          message: `The OpenRouter key is spent: $${credit.usage.toFixed(2)} used of a $${credit.limit.toFixed(2)} limit. `
            + 'Every call will 403 until the limit is raised or another key is set.'
        });
      } else if (left < credit.limit * 0.1) {
        findings.push({
          level: 'warn',
          message: `The OpenRouter key has $${left.toFixed(2)} left of $${credit.limit.toFixed(2)}. `
            + 'A long run will end partway through.'
        });
      }
    }
  }

  // Where an UNPINNED node of each task kind would actually go, computed by the
  // same function the runner uses (WR-04). This is the check that catches
  // "Settings says OpenRouter first but my code nodes keep going to Anthropic":
  // the preview and the run now read one policy, so if they ever disagree
  // again, this line is where it shows.
  const routes = TASK_KINDS.map(kind => {
    const node = kind === 'planning' ? { type: 'orchestrator', data: {} }
      : kind === 'code' ? { type: 'agentTask', data: { role: 'execute', category: 'Code general' } }
      : { type: 'aiStep', data: { role: kind === 'analysis' ? 'analyze' : kind === 'evaluation' ? 'evaluation' : kind === 'translation' ? 'translate' : 'custom' } };
    const plan = planDefaultRoute(node, engine.runtimeConfig ?? {});
    return {
      kind, provider: plan.provider, model: plan.model,
      order: plan.order, reason: plan.reason
    };
  });
  if (routes.every(r => !r.provider) && providers.some(p => p.connected && p.id !== 'mock')) {
    findings.push({
      level: 'warn',
      message: 'A provider is connected but no task kind resolves to a default model — '
        + 'unpinned nodes will fall back to the configured executor default.'
    });
  }

  const report = {
    settingsPath: engine.settingsPath,
    dataRoot: engine.dataRoot,
    // Which stack is running, and who decided (D62). A flag whose state you
    // cannot read is a flag you end up guessing about at the exact moment a
    // run behaves strangely.
    v2: v2Flag({ settings: engine.settings ?? null }),
    ...(project ? { project } : {}),
    providers,
    priority,
    // The effective default route per task kind, so `flyt doctor`, the node
    // start log and the adapter call all quote the same answer.
    routes,
    references,
    findings
  };

  if (probe && models.length) {
    report.probes = [];
    for (const model of models) {
      const target = engine.resolveModelSource(model);
      report.probes.push(target?.provider
        ? await probeModel({ ...target, model })
        : { model, ok: false, verdict: 'no connected provider can serve this model id' });
    }
    for (const p of report.probes) {
      if (!p.ok) findings.push({ level: 'error', message: `${p.model}: ${p.verdict}` });
      else if (p.verdict !== 'usable') findings.push({ level: 'warn', message: `${p.model}: ${p.verdict}` });
    }
  }
  return report;
}

/**
 * What OpenRouter says about the key it was handed: its ceiling and what has
 * been spent against it. Never throws and never returns the key — an offline
 * machine, a proxy, or a provider that changed its API must not take `doctor`
 * down, since a broken doctor is worse than a quiet one.
 */
async function openrouterCredit(engine) {
  const key = engine.settings?.providers?.openrouter?.apiKey;
  if (!key) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const d = (await res.json())?.data ?? {};
    const num = v => (typeof v === 'number' ? v : null);
    return { limit: num(d.limit), usage: num(d.usage), freeTier: Boolean(d.is_free_tier) };
  } catch (err) { return { error: String(err?.message ?? err).slice(0, 120) }; }
}

/**
 * Every model id a flow pins, so `doctor` can check the ones that will actually
 * be called rather than a curated list nobody's flow uses.
 */
export function modelsInFlow(flow) {
  const out = new Set();
  const add = w => { if (w?.model) out.add(String(w.model)); };
  for (const node of flow?.nodes ?? []) {
    add(node.data?.worker);
    for (const lane of node.data?.lanes ?? []) add(lane.worker);
  }
  return [...out];
}
