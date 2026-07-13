// The structured retrospective every node must emit — v1 backbone.
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
    at: new Date().toISOString()
  };
}
