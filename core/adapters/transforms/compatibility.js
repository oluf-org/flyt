/** Cross-provider outcomes after provider-specific wire transforms have run. */

export function classifyCompletion({ text = '', reasoning = '', finishReason = null, interrupted = false } = {}) {
  if (interrupted) return { status: 'interrupted', retryable: true };
  if (!text && reasoning && finishReason === 'length') {
    return { status: 'reasoning_only_length_exhaustion', retryable: true };
  }
  if (!text && !reasoning && !finishReason) return { status: 'empty_interrupted_stream', retryable: true };
  return { status: 'settled', retryable: false };
}

export function parseStructuredPayload(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, value: raw, diagnostics: [] };
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, value: null, diagnostics: ['structured response was empty'] };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value, diagnostics: [] }
      : { ok: false, value: null, diagnostics: ['structured response must be a JSON object'] };
  } catch (error) {
    return { ok: false, value: null, diagnostics: [`structured response was invalid JSON: ${error.message}`] };
  }
}
