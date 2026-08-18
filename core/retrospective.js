// The structured retrospective every node must emit — v1 backbone.
import { FeedbackStore } from './feedback.js';

export function makeRetrospective({
  node,            // which node produced this
  status,          // 'success' | 'partial' | 'failed'
  problems = [],   // list of strings describing what went wrong / was awkward
  resolution = '', // how problems were handled (or 'none needed')
  confidence,      // 0..1 self-assessed confidence in the output
  recommendation = '', // advice for future runs — feeds historyDigest()
  model = null,    // { provider, model } that did the work (audit trail)
  usage = null,
  durationMs = null,
  toolCalls = []   // [{ tool, args, ok, result|error, ms }] from the agent loop
}) {
  return {
    node, status, problems,
    resolution: resolution || (problems.length ? '' : 'none needed'),
    confidence, recommendation, model, usage, durationMs, toolCalls,
    // What this instance did with its toolbox (DESIGN-SPEC.md §8): per tool, how
    // many calls, how many failed, how long they took.
    //
    // DERIVED, never asked for. The facts are already in the tool calls, so
    // spending a model call — or a model's attention — on recounting them
    // would buy a worse answer at a higher price. What a model is asked for is
    // only the half it alone knows: whether the tool was any good, and what was
    // missing. That arrives separately, through `tool_feedback`.
    tools: FeedbackStore.usageFromToolCalls(toolCalls),
    at: new Date().toISOString()
  };
}
