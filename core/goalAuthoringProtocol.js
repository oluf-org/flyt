// Keep text/YAML as native strings: double-encoding long prompts and YAML is
// error-prone. Only non-string values need JSON encoding in the closed schema.
const operation = {
  type: 'object', additionalProperties: false, required: ['op', 'address', 'valueText', 'valueJson'],
  properties: { op: { type: 'string', enum: ['replace'] }, address: { type: 'string' },
    valueText: { type: ['string', 'null'], description: 'The replacement string as plain text, including complete YAML for recipe/setup. Set valueJson to null when using this field.' },
    valueJson: { type: ['string', 'null'], description: 'JSON text for a non-string replacement (array, object, number, boolean or null). Set valueText to null when using this field.' } },
};
const operations = { type: ['array', 'null'], items: operation };
export const AUTHORING_RESPONSE_FORMAT = { name: 'goal_authoring_response', strict: true, schema: {
  type: 'object', additionalProperties: false,
  required: ['type', 'text', 'rationale', 'operations', 'name', 'arguments'],
  properties: {
    type: { type: 'string', enum: ['message', 'question', 'proposal', 'tool'] },
    text: { type: ['string', 'null'] }, rationale: { type: ['string', 'null'] }, operations,
    name: { type: ['string', 'null'], enum: ['read_project_file', 'inspect_block', 'validate_proposal', null] },
    arguments: { type: ['object', 'null'], additionalProperties: false, required: ['path', 'use', 'operations'],
      properties: { path: { type: ['string', 'null'] }, use: { type: ['string', 'null'] }, operations } },
  },
} };
export const SCHEMA_INSTRUCTIONS = `The response schema supplied with this API call takes precedence over the example shapes. Include all its required fields; set unused fields to null. For string replacements use valueText directly, with valueJson:null. Example: {"op":"replace","address":"goal/objective","valueText":"Audit the repository","valueJson":null}. Recipe/setup YAML and block instructions are string replacements: use valueText, without another layer of JSON encoding. Only for arrays, objects, numbers, booleans or null, use valueJson containing JSON text, with valueText:null. Example: {"op":"replace","address":"goal/maxParallel","valueText":null,"valueJson":"1"}. The host decodes these fields before validating edits. For tool arguments include path, use and operations, with unused fields null.`;

export function authoringResponseFormat(addresses) {
  const format = structuredClone(AUTHORING_RESPONSE_FORMAT);
  if (Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 500) {
    format.schema.properties.operations.items.properties.address.enum = addresses;
    format.schema.properties.arguments.properties.operations.items.properties.address.enum = addresses;
  }
  return format;
}

export function authoringEditContract(definition, grant, locks, fields, blocks, started) {
  const addresses = new Set();
  for (const address of fields.keys()) if (address.startsWith('goal/') || /^(recipe|setup)\/[^/]+\/(title|config\/[^/]+)$/.test(address)) addresses.add(address);
  // Block defaults are editable even when absent from the authored config.
  for (const phase of ['recipe', 'setup']) {
    const structure = fields.get(`${phase}/structure`);
    for (const node of structure?.nodes ?? []) {
      if (node.parent === null) { addresses.delete(`${phase}/${node.id}/title`); continue; }
      const block = blocks.find(item => item.use === node.use);
      for (const key of Object.keys(block?.settings?.properties ?? {})) if (!['model', 'modelTier', 'modelFallbacks'].includes(key)) addresses.add(`${phase}/${node.id}/config/${key}`);
    }
  }
  addresses.add('recipe'); addresses.add('setup');
  const inherited = new Set(['goal/worker', 'goal/tools', 'goal/folder', 'goal/folderMode', 'goal/createFolder', 'goal/maxParallel']);
  const allowed = [...addresses].filter(address => {
    if (started && (address.startsWith('goal/') || address === 'setup' || address.startsWith('setup/'))) return false;
    if (locks.some(lock => address === lock || address.startsWith(`${lock}/`))) return false;
    if (locks.some(lock => !lock.startsWith('goal/')) && inherited.has(address)) return false;
    if (grant.scope?.type === 'fields' || grant.quotes.length) return grant.quotes.some(quote => quote.address === address);
    if (grant.scope?.type === 'step') return address === `${grant.scope.address}/title` || address.startsWith(`${grant.scope.address}/config/`);
    return true;
  });
  return { addresses: allowed,
    operations: 'Only replace. Use an exact address from this list. To add/remove/reorder steps, replace recipe or setup with the COMPLETE canonical YAML string. Internal /structure, /name and whole /config objects are not edit addresses. Do not submit edits to newly created node paths: put their full config in the replacement YAML.',
    values: {
      'goal/criteria': { description: 'Array of mechanical checks, not strings. file_contains checks one concrete file, not a directory or glob.', examples: [{ type: 'output_contains', value: 'Audit summary' }, { type: 'file_contains', path: 'findings/summary.md', value: 'Reviewed areas' }] },
      'goal/evaluation': { description: 'Optional robust-v1 fixed policy: version:1, embedded immutable suite with id/version/name/evaluators/cases, target artifact|plan|task-graph|workflow, ranking with named primary metric and minImprovement, finalVerification.required, and promotion mode/limit/confirmation:"fresh-evaluation". Evaluators are {id,version:1,name,mandatory,config}. Cases have id/input/split:development|held-out/repeats and optional immutable references, fixtures and extra evaluators. Use registered typed evaluators. A prompt candidate is evaluated through production outputs. Started policies cannot change.' },
      'goal/tests': { description: 'Optional tests of a generated workflow candidate; leave empty for an ordinary repository audit.', example: [{ input: 'What is 2 + 2?', contains: '4' }] },
      'goal/folder': 'Project binding, not part of the reusable loop. Empty uses the current project; a relative folder resolves inside that project. Preserve unless explicitly asked to change it. Never embed an absolute project path into prompts.',
      'goal/createFolder': 'False works directly in the project (appropriate for a repository audit). True creates an empty subfolder with no project files copied; setup must supply required inputs.',
      'goal/requiredPaths': { description: 'Optional list of relative input files or directories the project must provide to implement the loop. Missing paths are advisory warnings, never a reason to reject reuse. Keep output paths in acceptance checks, not in this list.', example: ['src', 'docs/security.md'] },
      'goal/tools': 'Execution tool names explicitly granted to the loop. A block ceiling does not grant tools; file-reading/writing steps need the corresponding names enabled here. Goals forbid tools whose names contain task, reference, run_log, read_run, other_run, agent, workflow or goal, even when a block ceiling lists them. In particular search_references is unavailable. Standard file tools are read_file, glob, search_files, create_file, write_file, edit_file, bash, run_gate, read_tool_result.',
      recipe: 'Complete version 2 YAML string with blocks; never a JSON graph. Preserve existing node IDs where retained. Match each step to its block ceiling: orient and general-analysis can read but cannot write files. Use flyt-blocks-core:work for steps that create reports or other files, and grant the required file tools in goal/tools. Read-only project review can still use work with file tools to write only the explicitly authorized report folder; it does not require shell tools. A review with no confirmed vulnerabilities is a valid outcome; record reviewed areas without inventing findings.',
      setup: 'Complete version 2 YAML string or null. Runs once.',
    },
    executionResult: 'The last recipe step must return the Goal result envelope: {"candidate":{"text":"complete current result"},"findings":[]} (optional findings). Do not change fixed checks to force success.',
  };
}

export function decodeAuthoringResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const decodeOperations = items => items?.map(item => {
    if (!item || (!Object.hasOwn(item, 'valueJson') && !Object.hasOwn(item, 'valueText'))) return item;
    if (Object.hasOwn(item, 'value') || (item.valueText != null && item.valueJson != null)) throw new Error('Ambiguous replacement: provide exactly one of value, valueText or valueJson');
    const { valueJson, valueText, ...rest } = item;
    if (valueText != null) {
      if (typeof valueText !== 'string') throw new Error('valueText must be a string');
      return { ...rest, value: valueText };
    }
    if (typeof valueJson !== 'string') throw new Error('Replacement must include valueText or JSON text in valueJson');
    try { return { ...rest, value: JSON.parse(valueJson) }; }
    catch (error) { throw new Error(`Invalid valueJson at ${item.address ?? 'unknown address'}: ${error.message}. Use valueText for strings/YAML, or valid JSON text for other values.`); }
  });
  const result = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
  if (Array.isArray(result.operations)) result.operations = decodeOperations(result.operations);
  if (result.arguments && typeof result.arguments === 'object' && !Array.isArray(result.arguments)) {
    result.arguments = Object.fromEntries(Object.entries(result.arguments).filter(([, item]) => item !== null));
    if (Array.isArray(result.arguments.operations)) result.arguments.operations = decodeOperations(result.arguments.operations);
  }
  return result;
}

export function responseProblem(result) {
  const hasText = typeof result?.text === 'string' && Boolean(result.text.trim());
  if (['length', 'max_tokens'].includes(result?.finishReason)) return {
    code: hasText ? 'TRUNCATED_RESPONSE' : 'REASONING_BUDGET_EXHAUSTED',
    message: hasText ? 'The model reached its output limit before completing the response.' : 'The model exhausted its output budget without returning an answer.',
  };
  if (result?.message?.refusal || ['content_filter', 'refusal'].includes(result?.finishReason)) return { code: 'MODEL_REFUSAL', message: 'The provider declined to produce this response.' };
  if (!hasText) return { code: 'EMPTY_RESPONSE', message: 'The model returned no answer text.' };
  return null;
}

export const REPAIR_SYSTEM = `Correct one failed Flyt Goal authoring response. Return exactly one JSON message, question, or proposal using the supplied response contract. Do not inspect files, request tools, execute work, or redesign the whole loop. Preserve the user's request, the host-issued grant, locks and existing choices. Repair only the reported issue. If the previous response was empty or truncated, produce the smallest useful in-scope proposal or a concise question about a genuinely missing requirement; do not invent missing output. Finish the response within the smaller output budget. Never claim edits were applied or runtime verification occurred.`;

export function repairContext(context, exchanges, failure) {
  // Omit the full catalogue, examples, duplicate address/value map and chat history.
  // Retain the authoritative definition/grant and contracts referenced by the
  // current recipe or failed response, so correction cannot invent a new API.
  const referenced = JSON.stringify([context.definition.recipe, context.definition.setup, failure.response]);
  return { request: context.request, grant: context.grant, locks: context.locks, started: context.started,
    definition: context.definition, editContract: context.editContract, failure,
    responseContract: { types: ['message', 'question', 'proposal'], proposal: '{"type":"proposal","operations":[{"op":"replace","address":"...","value":...}],"rationale":"..."}', reply: '{"type":"message or question","text":"..."}' },
    blocks: context.capabilities.blocks.filter(block => referenced.includes(block.use)),
    restrictions: context.capabilities.restrictions,
    evidence: exchanges.filter(item => item.tool?.ok).slice(-2).map(item => ({ name: item.tool.name, result: JSON.stringify(item.tool.result).slice(0, 10000) })),
    toolsAvailable: false, callsRemaining: 1 };
}

export function boundedResponse(text, limit = 64000) {
  text = String(text ?? '');
  return { rawResponse: text.length <= limit ? text : `${text.slice(0, limit / 2)}\n[response truncated in diagnostics]\n${text.slice(-limit / 2)}`,
    rawResponseTruncated: text.length > limit };
}
