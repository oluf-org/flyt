/**
 * Provider-neutral model capability registry and request resolution.
 *
 * Unknown is data, not an absent property.  Every leaf is an attributed fact
 * so a caller can distinguish provider documentation from a catalog report,
 * a local probe, and a conservative harness default.
 */
import type { JsonValue, Message } from '../types.js';
import { mergeReasoningDetails } from './replay.js';

export type FactConfidence = 'verified' | 'reported' | 'inferred' | 'unknown';

export interface Fact<T extends JsonValue> {
  value: T;
  confidence: FactConfidence;
  source: string;
  observedAt?: string;
}

export interface CapabilityLimit {
  contextTokens: Fact<number | null>;
  maxInputTokens: Fact<number | null>;
  maxOutputTokens: Fact<number | null>;
}

export interface ModelCapabilityProfile {
  id: string;
  provider: string;
  provenance: Fact<string>;
  limits: CapabilityLimit;
  modalities: {
    text: Fact<boolean | null>;
    image: Fact<boolean | null>;
    pdf: Fact<boolean | null>;
    audio: Fact<boolean | null>;
    video: Fact<boolean | null>;
  };
  tools: {
    native: Fact<boolean | null>;
    parallel: Fact<boolean | null>;
    builtins: Fact<string[]>;
  };
  structuredOutput: {
    jsonSchema: Fact<boolean | null>;
    strict: Fact<boolean | null>;
    syntheticTool: Fact<boolean | null>;
  };
  reasoning: {
    supported: Fact<boolean | null>;
    variants: Fact<string[]>;
    acceptedRequestFields: Fact<string[]>;
    replay: Fact<'none' | 'items' | 'signed' | 'encrypted' | 'provider-dependent'>;
    replayRequired: Fact<boolean | null>;
    replayRequiredWhen: Fact<string[]>;
  };
  pricing: {
    currency: Fact<string>;
    inputPerMillion: Fact<number | null>;
    cachedInputPerMillion: Fact<number | null>;
    outputPerMillion: Fact<number | null>;
  };
  cache: {
    behavior: Fact<string>;
    writeMultiplier: Fact<number | null>;
    replayImprovesCache: Fact<boolean | null>;
  };
  providerOverheadTokens: Fact<number>;
}

export interface RequestValueResolution<T extends JsonValue = JsonValue> {
  field: string;
  requested: T;
  modelLimit: T | null;
  providerLimit: T | null;
  effective: T;
  reason: string;
}

const HARNESS = 'Flyt conservative default (kernel/src/models/capabilities.ts)';
const OPENAI_GUIDE = 'https://developers.openai.com/api/docs/guides/latest-model';
const OPENAI_COMPARE = 'https://developers.openai.com/api/docs/models/compare';

const fact = <T extends JsonValue>(value: T, confidence: FactConfidence, source: string): Fact<T> =>
  ({ value, confidence, source });
const unknown = <T extends JsonValue>(value: T): Fact<T> => fact(value, 'unknown', HARNESS);

/** A complete, conservative profile for a model with no attributed catalog row. */
export function unknownCapability(id: string, provider = 'unknown'): ModelCapabilityProfile {
  const profile: ModelCapabilityProfile = {
    id, provider,
    provenance: fact(`${provider}/${id}`, 'inferred', HARNESS),
    limits: {
      contextTokens: unknown(null), maxInputTokens: unknown(null), maxOutputTokens: unknown(null),
    },
    modalities: {
      text: unknown(null), image: unknown(null), pdf: unknown(null), audio: unknown(null), video: unknown(null),
    },
    tools: { native: unknown(null), parallel: unknown(null), builtins: unknown([]) },
    structuredOutput: { jsonSchema: unknown(null), strict: unknown(null), syntheticTool: unknown(null) },
    reasoning: {
      supported: unknown(null), variants: unknown([]), acceptedRequestFields: unknown([]),
      replay: unknown('provider-dependent'), replayRequired: unknown(null), replayRequiredWhen: unknown([]),
    },
    pricing: {
      currency: fact('USD', 'verified', HARNESS), inputPerMillion: unknown(null),
      cachedInputPerMillion: unknown(null), outputPerMillion: unknown(null),
    },
    cache: { behavior: unknown('provider-dependent'), writeMultiplier: unknown(null), replayImprovesCache: unknown(null) },
    // Kept nonzero so an unknown wire format never receives a mathematically
    // exact-looking 100% context request.
    providerOverheadTokens: fact(1_024, 'inferred', HARNESS),
  };
  const protocolSource = `${provider} adapter protocol contract (provider/model support may vary)`;
  if (['openai', 'openrouter', 'anthropic', 'kimi'].includes(provider)) {
    profile.tools.native = fact(true, 'reported', protocolSource);
    profile.tools.parallel = fact(true, 'inferred', protocolSource);
    profile.structuredOutput.syntheticTool = fact(true, 'reported', protocolSource);
  }
  if (provider === 'openai') {
    profile.structuredOutput.jsonSchema = fact(true, 'reported', 'https://developers.openai.com/api/docs/guides/structured-outputs');
    profile.structuredOutput.strict = fact(true, 'reported', 'https://developers.openai.com/api/docs/guides/structured-outputs');
  }
  if (provider === 'openrouter') {
    profile.structuredOutput.jsonSchema = fact(null, 'unknown', 'OpenRouter capability is model-dependent');
  }
  return profile;
}

function openAi56(id: string, input: number, cached: number, output: number): ModelCapabilityProfile {
  const base = unknownCapability(id, 'openai');
  return {
    ...base,
    provenance: fact(`OpenAI API model ${id}`, 'verified', OPENAI_COMPARE),
    limits: {
      contextTokens: fact(1_050_000, 'verified', OPENAI_COMPARE),
      maxInputTokens: fact(1_050_000, 'reported', OPENAI_COMPARE),
      maxOutputTokens: fact(128_000, 'verified', OPENAI_COMPARE),
    },
    modalities: {
      text: fact(true, 'verified', OPENAI_COMPARE), image: fact(true, 'verified', OPENAI_COMPARE),
      pdf: fact(true, 'reported', 'https://developers.openai.com/api/docs/guides/pdf-files'),
      audio: fact(false, 'inferred', OPENAI_COMPARE), video: fact(false, 'inferred', OPENAI_COMPARE),
    },
    tools: {
      native: fact(true, 'verified', OPENAI_COMPARE), parallel: fact(true, 'reported', OPENAI_GUIDE),
      builtins: unknown([]),
    },
    structuredOutput: {
      jsonSchema: fact(true, 'verified', OPENAI_COMPARE), strict: fact(true, 'reported', 'https://developers.openai.com/api/docs/guides/structured-outputs'),
      syntheticTool: fact(true, 'verified', OPENAI_COMPARE),
    },
    reasoning: {
      supported: fact(true, 'verified', OPENAI_COMPARE),
      variants: fact(['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'verified', OPENAI_GUIDE),
      acceptedRequestFields: fact(['reasoning.effort', 'reasoning.mode', 'reasoning.context', 'reasoning.summary'], 'verified', OPENAI_GUIDE),
      replay: fact('encrypted', 'verified', OPENAI_GUIDE), replayRequired: fact(false, 'reported', OPENAI_GUIDE),
      replayRequiredWhen: fact(['store:false', 'zero-data-retention', 'manual history replay without previous_response_id'], 'verified', OPENAI_GUIDE),
    },
    pricing: {
      currency: fact('USD', 'verified', OPENAI_COMPARE), inputPerMillion: fact(input, 'verified', OPENAI_COMPARE),
      cachedInputPerMillion: fact(cached, 'verified', OPENAI_COMPARE), outputPerMillion: fact(output, 'verified', OPENAI_COMPARE),
    },
    cache: {
      behavior: fact('implicit or explicit prefix caching', 'verified', OPENAI_GUIDE),
      writeMultiplier: fact(1.25, 'verified', OPENAI_GUIDE), replayImprovesCache: fact(true, 'verified', OPENAI_GUIDE),
    },
    providerOverheadTokens: fact(1_024, 'inferred', HARNESS),
  };
}

const BUILTINS = new Map<string, ModelCapabilityProfile>([
  ['openai/gpt-5.6-sol', openAi56('gpt-5.6-sol', 4, .4, 20)],
  ['openai/gpt-5.6-terra', openAi56('gpt-5.6-terra', 2, .2, 12)],
  ['openai/gpt-5.6-luna', openAi56('gpt-5.6-luna', .2, .02, 1.2)],
]);

/** Merge catalog/probe facts without ever erasing the attribution wrapper. */
export class ModelCapabilityRegistry {
  #profiles = new Map<string, ModelCapabilityProfile>(BUILTINS);

  register(profile: ModelCapabilityProfile): void {
    this.#profiles.set(`${profile.provider}/${profile.id}`, structuredClone(profile));
  }

  get(model: string, provider?: string): ModelCapabilityProfile {
    const explicit = model.includes('/') ? model : `${provider ?? 'unknown'}/${model}`;
    const direct = this.#profiles.get(explicit);
    if (direct) return structuredClone(direct);
    // OpenRouter and other relays retain their own provenance even when the
    // underlying model slug resembles a first-party id.
    return unknownCapability(model, provider ?? explicit.split('/')[0] ?? 'unknown');
  }

  list(): ModelCapabilityProfile[] { return [...this.#profiles.values()].map(profile => structuredClone(profile)); }
}

export interface AttachmentBudget {
  handle: string;
  estimatedTokens: number;
}

export interface ContextBudgetBreakdown {
  systemInstructions: number;
  messages: number;
  toolSchemas: number;
  attachments: number;
  reservedOutput: number;
  providerOverhead: number;
  total: number;
}

export type ContextPolicyAction =
  | 'none'
  | 'assemble_reasoning_replay'
  | 'prune_superseded_tool_previews'
  | 'retain_recent_turns'
  | 'bound_tool_previews'
  | 'load_explicit_artifacts_by_handle'
  | 'durable_compaction_checkpoint';

export interface ContextBudgetDecision {
  requested: ContextBudgetBreakdown;
  effective: ContextBudgetBreakdown;
  contextLimit: number;
  contextUtilization: number;
  requestedOutput: number;
  effectiveOutput: number;
  resolutions: RequestValueResolution[];
  actions: { action: ContextPolicyAction; reason: string; affectedMessages: number; handles: string[] }[];
  messages: Message[];
  checkpoint?: string;
}

const estimate = (value: unknown): number => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

function breakdown(
  messages: readonly Message[], tools: readonly unknown[], attachments: readonly AttachmentBudget[],
  output: number, overhead: number,
): ContextBudgetBreakdown {
  const system = messages.filter(message => message.role === 'system');
  const ordinary = messages.filter(message => message.role !== 'system');
  const parts = {
    systemInstructions: estimate(system), messages: estimate(ordinary), toolSchemas: estimate(tools),
    attachments: attachments.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens), 0),
    reservedOutput: output, providerOverhead: overhead,
  };
  return { ...parts, total: Object.values(parts).reduce((sum, value) => sum + value, 0) };
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function replaceToolPreviews(messages: readonly Message[]): { messages: Message[]; changed: number; handles: string[] } {
  const callKeyById = new Map<string, string>();
  for (const message of messages) if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) callKeyById.set(call.id, `${call.name}:${stableJson(call.args)}`);
  }
  const resultKey = (message: Message): string | null => {
    if (message.role !== 'tool' || !message.name) return null;
    // Legacy/provider messages without a correlatable call retain the prior
    // conservative behavior. Canonical calls are only superseded by the same
    // tool with the same normalized arguments; distinct searches are evidence,
    // not duplicate previews.
    return message.toolCallId ? callKeyById.get(message.toolCallId) ?? `name:${message.name}` : `name:${message.name}`;
  };
  const lastByQuery = new Map<string, number>();
  messages.forEach((message, index) => { const key = resultKey(message); if (key) lastByQuery.set(key, index); });
  let changed = 0;
  const handles: string[] = [];
  const out = messages.map((message, index) => {
    const key = resultKey(message);
    if (!key || lastByQuery.get(key) === index || message.content.length < 256) return { ...message };
    const handle = message.handle ?? `tool-call:${message.toolCallId ?? index}`;
    handles.push(handle); changed += 1;
    return { ...message, content: `[Superseded tool preview pruned; load explicit artifact ${handle} if needed.]`, handle };
  });
  return { messages: out, changed, handles };
}

const INSPECTED_CALL_LIMIT = 48;
const PRIMARY_ARGUMENT_KEYS = ['path', 'pattern', 'query', 'command', 'glob', 'name', 'id'] as const;

/**
 * `name(primary argument)` for every tool call in the given turns, deduplicated
 * in order. The most recent calls survive a long list; an earlier remainder is
 * counted rather than dropped silently.
 *
 * @param maxChars — optional budget for the joined list, applied after the
 *   entry cap so the most recent calls still win.
 */
export function describeInspectedCalls(messages: readonly Message[], maxChars = Infinity): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? call.args as Record<string, unknown> : {};
      const primary = PRIMARY_ARGUMENT_KEYS.map(key => args[key])
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const offset = typeof args.offset === 'number' && args.offset > 0 ? `@${args.offset}` : '';
      const label = `${call.name}(${primary ? primary.trim().slice(0, 80) : ''}${offset})`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  let kept = out.length <= INSPECTED_CALL_LIMIT ? out : out.slice(-INSPECTED_CALL_LIMIT);
  const fits = (items: string[]): boolean => items.join(', ').length <= maxChars;
  while (kept.length > 1 && !fits(kept)) kept = kept.slice(1);
  if (!fits(kept)) return [];
  const hidden = out.length - kept.length;
  return hidden > 0 ? [`+${hidden} earlier`, ...kept] : kept;
}

/**
 * Fit a request without mutating or deleting its canonical trace.  The return
 * value is the exact effective request plus a durable-action record.
 */
export function manageContextBudget(input: {
  messages: readonly Message[];
  tools?: readonly unknown[];
  attachments?: readonly AttachmentBudget[];
  requestedOutput?: number;
  profile: ModelCapabilityProfile;
  providerContextLimit?: number | null;
  providerOutputLimit?: number | null;
  checkpointInputTokens?: number | null;
  /** Application request bound, measured after provider serialization. */
  maxMessageChars?: number;
  measureMessages?: (messages: Message[]) => number;
}): ContextBudgetDecision {
  const tools = input.tools ?? [];
  const attachments = input.attachments ?? [];
  const modelContext = input.profile.limits.contextTokens.value;
  const providerContext = input.providerContextLimit ?? null;
  const knownContextLimits = [modelContext, providerContext].filter((v): v is number => Number.isFinite(v) && Number(v) > 0);
  const contextLimit = Math.max(1, knownContextLimits.length ? Math.min(...knownContextLimits) : 128_000);
  const requestedOutput = Math.max(1, Math.floor(input.requestedOutput ?? 4_096));
  const modelOutput = input.profile.limits.maxOutputTokens.value;
  const providerOutput = input.providerOutputLimit ?? null;
  let effectiveOutput = Math.min(requestedOutput, ...[modelOutput, providerOutput].filter((v): v is number => Number.isFinite(v) && Number(v) > 0));
  const overhead = Math.max(0, input.profile.providerOverheadTokens.value);
  const original = input.messages.map(message => ({ ...message }));
  const requested = breakdown(original, tools, attachments, requestedOutput, overhead);
  let messages = original.map(message => message.replay?.provider === 'openrouter'
    ? { ...message, replay: { ...message.replay, items: mergeReasoningDetails(message.replay.items) } } : message);
  const actions: ContextBudgetDecision['actions'] = [];
  const assembled = messages.filter((message, index) => message.replay && message.replay.items.length < (original[index].replay?.items.length ?? 0)).length;
  if (assembled) actions.push({ action: 'assemble_reasoning_replay', affectedMessages: assembled, handles: [],
    reason: 'reassembled streamed reasoning text fragments without dropping their content or changing opaque items' });
  if (attachments.length) actions.push({
    action: 'load_explicit_artifacts_by_handle', affectedMessages: 0,
    handles: attachments.map(item => item.handle),
    reason: 'explicit attachment handles were selected and included in the attachment budget',
  });

  // Keep the requested/model/provider output allowance while compacting the
  // input. Clamping against the *uncompacted* request here used to make that
  // clamp permanent: a large history reduced max_tokens to 1, compaction then
  // freed almost the entire context window, but the request still went out
  // with one output token. Reasoning models predictably answered that with
  // finish_reason=length, and a continuation loop could repeat forever. The
  // output is the final elastic component, so it is clamped only after input
  // policy has done all the space-reclaiming it can do (below).
  let current = breakdown(messages, tools, attachments, effectiveOutput, overhead);
  const checkpointInput = Number.isFinite(input.checkpointInputTokens) && Number(input.checkpointInputTokens) > 0
    ? Math.floor(Number(input.checkpointInputTokens)) : null;
  const overCheckpoint = (): boolean => checkpointInput != null
    && current.total - current.reservedOutput - current.providerOverhead >= checkpointInput;
  const measureMessages = input.measureMessages ?? (messages => JSON.stringify(messages).length);
  const overMessages = (value = messages): boolean => input.maxMessageChars != null
    && measureMessages(value) > input.maxMessageChars;
  if (current.total > contextLimit || overCheckpoint() || overMessages()) {
    const pruned = replaceToolPreviews(messages);
    messages = pruned.messages;
    if (pruned.changed) actions.push({
      action: 'prune_superseded_tool_previews', affectedMessages: pruned.changed, handles: pruned.handles,
      reason: 'older previews from the same tool were superseded; their durable handles remain loadable',
    });
    current = breakdown(messages, tools, attachments, effectiveOutput, overhead);
  }

  if (current.total > contextLimit || overCheckpoint() || overMessages()) {
    const systems = messages.filter(message => message.role === 'system');
    const nonSystems = messages.filter(message => message.role !== 'system');
    const originalAssignment = nonSystems.find(message => message.role === 'user');
    // Preserve enough of a real worker envelope to retain its task and scope,
    // while keeping the anchor proportional on genuinely small context models.
    const assignmentCharLimit = Math.min(4_000, Math.max(400, Math.floor(contextLimit * 0.04)));
    const assignmentAnchor = originalAssignment ? {
      ...originalAssignment,
      content: `Original assignment (authoritative; retained across context compaction):\n${originalAssignment.content.slice(0, assignmentCharLimit)}${originalAssignment.content.length > assignmentCharLimit ? `\n[Original assignment truncated to ${assignmentCharLimit.toLocaleString('en-US')} characters by context policy.]` : ''}`,
    } : null;
    let start = Math.max(0, nonSystems.length - 8);
    while (start < nonSystems.length && nonSystems[start].role !== 'user') start += 1;
    if (start >= nonSystems.length) start = Math.max(0, nonSystems.length - 2);
    // A parallel tool batch is one exchange. Never retain its results without
    // the assistant message that declared every tool_call_id.
    while (start > 0 && nonSystems[start]?.role === 'tool') start -= 1;
    let kept = nonSystems.slice(start);
    while (kept.length > 2) {
      const retainedAssignment = assignmentAnchor && !kept.includes(originalAssignment!) ? [assignmentAnchor] : [];
      const candidate = breakdown([...systems, ...retainedAssignment, ...kept], tools, attachments, effectiveOutput, overhead);
      const candidateInput = candidate.total - candidate.reservedOutput - candidate.providerOverhead;
      if (candidate.total <= contextLimit && (checkpointInput == null || candidateInput < checkpointInput)
        && !overMessages([...systems, ...retainedAssignment, ...kept])) break;
      const nextUser = kept.findIndex((message, index) => index > 0 && message.role === 'user');
      const nextTurn = nextUser > 0 ? nextUser : kept.findIndex((message, index) => index > 0 && message.role === 'assistant');
      kept = nextTurn > 0 ? kept.slice(nextTurn) : kept;
      if (nextTurn <= 0) break;
      start += nextTurn;
    }
    const removed = nonSystems.length - kept.length;
    if (removed > 0) {
      const priorAssistant = nonSystems.slice(0, start).filter(message => message.role === 'assistant' && message.content.trim()).slice(-3);
      const handles = nonSystems.slice(0, start).filter(message => message.role === 'tool' && message.handle).map(message => message.handle as string);
      const remaining = [...kept].reverse().find(message => message.role === 'user')?.content ?? 'Continue the assigned task.';
      // What the compacted turns already inspected. Without this list the
      // model's only memory of a read is whatever finding it wrote about it,
      // so a worker re-read the same files after every checkpoint until a
      // person stopped it. Naming the calls lets it cite what it learned, or
      // read a narrower range, instead of opening the whole file again.
      // The checkpoint itself lives in the window, so it scales with the
      // window: a small-context model keeps the terse form, a worker-sized
      // one can afford real findings and the inspected list.
      const findingChars = Math.min(500, Math.max(200, Math.floor(contextLimit * 0.005)));
      const inspectedChars = Math.min(2_400, Math.floor(contextLimit * 0.012));
      const inspected = inspectedChars >= 120 ? describeInspectedCalls(nonSystems.slice(0, start), inspectedChars) : [];
      const checkpoint = [
        'Context checkpoint (authoritative resume state).',
        `Compacted messages: ${removed}.`,
        `Completed findings: ${priorAssistant.length ? priorAssistant.map(message => message.content.slice(0, findingChars)).join(' | ') : 'See durable tool results and artifacts.'}`,
        ...(inspected.length ? [`Already inspected (compacted; do not repeat these calls, cite the findings above or read a narrower range): ${inspected.join(', ')}`] : []),
        `Remaining work: ${remaining.slice(0, 400)}`,
        `Artifact handles: ${handles.length ? [...new Set(handles)].slice(-24).join(', ') : 'none'}.`,
        'Do not replay completed work. Continue from this checkpoint; the immutable trace remains available for diagnostics.',
      ].join('\n');
      const retainedAssignment = assignmentAnchor && !kept.includes(originalAssignment!) ? [assignmentAnchor] : [];
      messages = [...systems, ...retainedAssignment, { role: 'system', content: checkpoint }, ...kept];
      actions.push({
        action: 'retain_recent_turns', affectedMessages: removed, handles: [],
        reason: 'retained the most recent complete turns after lower-cost preview pruning was insufficient',
      });
      actions.push({
        action: 'durable_compaction_checkpoint', affectedMessages: removed, handles: [],
        reason: 'recorded a checkpoint instead of altering the immutable original trace',
      });
      current = breakdown(messages, tools, attachments, effectiveOutput, overhead);
    }
  }

  // A single large read (or parallel batch) can exceed an application's bound
  // even after old exchanges were removed. Shorten only loadable tool previews;
  // keep calls, instructions, and the immutable evidence intact.
  if (overMessages()) {
    let changed = 0;
    const handles = new Set<string>();
    for (let previewChars = 8_000; overMessages() && previewChars >= 250; previewChars = Math.floor(previewChars / 2)) {
      messages = messages.map(message => {
        if (message.role !== 'tool' || !message.handle || message.content.length <= previewChars) return message;
        changed += 1; handles.add(message.handle);
        return { ...message, content: `${message.content.slice(0, previewChars)}\n[Preview shortened by context policy. Retrieve a narrow range with read_tool_result using handle ${message.handle}; full evidence remains on disk.]` };
      });
    }
    if (changed) actions.push({ action: 'bound_tool_previews', affectedMessages: handles.size, handles: [...handles],
      reason: 'loadable tool previews were shortened to fit the application request bound' });
    current = breakdown(messages, tools, attachments, effectiveOutput, overhead);
    if (overMessages()) throw Object.assign(new Error(`Context cannot fit: instructions, assignment or the latest exchange exceed the ${input.maxMessageChars}-character application limit. Reduce fixed input or request smaller tool results.`), { code: 'context_budget_exhausted', requested, effective: current });
  }

  // Output is the final elastic component.  If fixed input itself is too big,
  // fail explicitly; sending an over-limit request would produce a provider
  // error with no record of the policy decision.
  const fixed = current.total - effectiveOutput;
  if (fixed >= contextLimit) {
    throw Object.assign(new Error(`Context cannot fit: fixed input uses ${fixed} tokens against a ${contextLimit}-token effective limit.`), {
      code: 'context_budget_exhausted', requested, effective: current,
    });
  }
  effectiveOutput = Math.min(effectiveOutput, contextLimit - fixed);
  current = breakdown(messages, tools, attachments, effectiveOutput, overhead);
  if (!actions.length) actions.push({ action: 'none', affectedMessages: 0, handles: [], reason: 'the full request fits the effective context limit' });

  return {
    requested, effective: current, contextLimit,
    contextUtilization: Number((current.total / contextLimit).toFixed(6)),
    requestedOutput, effectiveOutput, messages,
    resolutions: [
      {
        field: 'context_tokens', requested: requested.total, modelLimit: modelContext,
        providerLimit: providerContext, effective: current.total,
        reason: 'effective request is the post-policy token estimate bounded by the smallest known context limit',
      },
      {
        field: 'max_output_tokens', requested: requestedOutput, modelLimit: modelOutput,
        providerLimit: providerOutput, effective: effectiveOutput,
        reason: effectiveOutput === requestedOutput ? 'requested output fits all known limits' : 'clamped to the smallest model, provider, or remaining-context limit',
      },
    ],
    actions,
    ...(actions.some(item => item.action === 'durable_compaction_checkpoint')
      ? { checkpoint: messages.find(message => message.role === 'system' && message.content.startsWith('Context checkpoint'))?.content }
      : {}),
  };
}

export const defaultModelCapabilityRegistry = new ModelCapabilityRegistry();
