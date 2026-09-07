import { callModel } from './adapters/index.js';
import { authoringResponseFormat, SCHEMA_INSTRUCTIONS } from './goalAuthoringProtocol.js';

// Public capability metadata only. Never send user prompts or API keys here.
export function createAuthoringModelCaller({ call = callModel, fetchCatalog = signal => fetch('https://openrouter.ai/api/v1/models', { signal }) } = {}) {
  let catalogue = null, expires = 0;
  async function formatFor(target, facts, signal) {
    if (!['openrouter', 'openai', 'kimi'].includes(target.provider)) return { mode: 'prompt', source: 'Adapter has no authoring schema integration' };
    let parameters = facts.supportedParameters ?? facts.supported_parameters;
    let source = 'Saved model capability metadata';
    if (target.provider === 'openrouter' && !Array.isArray(parameters)) {
      try {
        if (!catalogue || expires < Date.now()) {
          const response = await fetchCatalog(AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]));
          if (!response.ok) throw new Error(`Catalogue HTTP ${response.status}`);
          catalogue = (await response.json()).data ?? []; expires = Date.now() + 3600000;
        }
        parameters = catalogue.find(model => model.id === target.model)?.supported_parameters;
        source = 'OpenRouter public model catalogue';
      } catch (error) {
        signal?.throwIfAborted();
        return { mode: 'prompt', source: 'Capability lookup unavailable', capabilityError: String(error.message).slice(0, 300) };
      }
    }
    if (parameters?.includes('structured_outputs')) return { mode: 'json_schema', source };
    if (parameters?.includes('response_format')) return { mode: 'json_object', source };
    if (target.provider === 'openai' && !Array.isArray(parameters)) {
      const { defaultModelCapabilityRegistry } = await import('#kernel');
      const fact = defaultModelCapabilityRegistry.get(target.model, target.provider).structuredOutput.jsonSchema;
      if (fact.value === true) return { mode: 'json_schema', source: fact.source };
    }
    return { mode: 'prompt', source: `${source}: structured output not advertised` };
  }
  return async function callAuthoringModel({ target, facts = {}, disableStructuredOutput = false, correction = false, writableAddresses, ...request }) {
    const format = disableStructuredOutput ? { mode: 'prompt', source: 'Provider rejected structured output in this request' } : await formatFor(target, facts, request.signal);
    const responseFormat = format.mode === 'json_schema' ? authoringResponseFormat(writableAddresses) : format.mode === 'json_object' ? { type: 'json_object' } : undefined;
    const settings = { maxTokens: correction ? 4096 : 12000, retry: { attempts: 1 }, timeout: { idleMs: 90000, hardMs: correction ? 90000 : 180000 } };
    request.onFormat?.(format);
    const { onFormat, onCall, ...modelRequest } = request;
    try {
      return await call({ ...target, ...modelRequest, ...settings, tools: [], responseFormat,
        ...(format.mode === 'json_schema' ? { system: `${request.system}\n\n${SCHEMA_INSTRUCTIONS}` } : {}),
        ...(target.provider === 'openrouter' && responseFormat ? { requireParameters: true } : {}),
        onCall: record => onCall?.({ ...record, responseMode: format.mode, capabilitySource: format.source }) });
    } catch (error) {
      // Only an explicit lack of format support permits a counted fallback.
      // Invalid schemas, authentication errors and timeouts remain real errors.
      if (responseFormat && /(?:400|404|422)/.test(String(error.status ?? error.message))
        && /response_format|json_schema|structured.?output|required parameters/i.test(error.message)
        && /not support|unsupported|no endpoints|not available/i.test(error.message)) error.authoringFormatUnsupported = true;
      throw error;
    }
  };
}
