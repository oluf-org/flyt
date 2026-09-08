// SYNTHETIC provider boundary: these are scripted acceptance cases, not
// measurements of live-model quality or reliability.
import { serializeStack } from '../../core/stackstore.js';
export const artifacts = {
  data: ['{"items":["A","B"],"total":2}', '{"items":["A","B"],"total":2,"note":"normalized"}', '{"items":["A"],"total":1}', '{"items":["A","B"],"total":2,"note":"judge error"}', '{"items":["A","B"],"total":2,"note":"normalized and checked"}'],
  writing: ['Audience: residents. Date: Friday.', 'Audience: residents. Date: Friday. Bring a reusable cup.', 'Audience: residents. Bring a cup.', 'Audience: residents. Date: Friday. JUDGE_ERROR.', 'Audience: residents. Date: Friday. Bring a reusable cup. Meet at the library at 10am.'],
  planning: ['["Design A","Verify B"]', '["Design A with interfaces","Verify B with acceptance checks"]', '["Design A with interfaces"]', '["Design A","Verify B JUDGE_ERROR"]', '["Design A with interfaces and ownership","Verify B with explicit acceptance checks and rollback"]'],
};
const spec = (id, name, config, mandatory = true) => ({ id, version: 1, name, mandatory, config });
export function fixtureDefinition(kind = 'data', overrides = {}) {
  const outputs = artifacts[kind], target = kind === 'planning' ? 'plan' : 'artifact';
  const rubric = { model: 'mock-evaluator', rubric: 'Judge completeness and usefulness against the case. Synthetic acceptance fixture.', dimensions: [{ id: 'utility', description: 'Usefulness of the deliverable for its stated request', mandatory: true, minimum: 2, minGain: 2 }], repairs: 0 };
  const checks = kind === 'data' ? [spec('json-schema', 'schema', { raw: true, schema: { type: 'object', required: ['items', 'total'], properties: { items: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' } } } }), spec('field', 'coverage', { path: '/items', op: 'includes', value: 'B' })]
    : kind === 'writing' ? [spec('contains', 'audience', { value: 'Audience: residents' }), spec('contains', 'date', { value: 'Date: Friday' })]
    : [spec('block-contract', 'contract', { block: 'plan' }), spec('contains', 'coverage', { value: 'Verify B' })];
  return { name: `Synthetic ${kind} evaluation loop`, objective: `EVALUATOR_FIXTURE_${kind}: Improve the ${kind} candidate on the CURRENT iteration.`,
    constraints: 'Synthetic acceptance fixture. No tools or live-model reliability claims.', criteria: [], tests: [], tools: [],
    recipe: serializeStack({ id: 'evaluator-example', name: 'Propose a candidate revision', root: { kind: 'sequence', id: 'root', children: [{ kind: 'block', id: 'improve', use: 'flyt-blocks-core:general-analysis', config: { inputOnly: true, systemPrompt: 'ROLE: evaluator-fixture-optimizer. Produce one Goal candidate for the current iteration only. Consume development feedback. Never request reference answers or final verification details.' } }] } }),
    worker: { provider: 'mock', model: 'mock-evaluator' }, limits: { iterations: 4, calls: 60, minutes: 4, usd: 1 }, plateau: 4,
    evaluation: { version: 1, target, baseline: { text: target === 'plan' ? 'BASELINE' : outputs[0], provenance: { kind: 'synthetic fixture' } },
      suite: { id: `synthetic-${kind}`, version: 1, name: `Synthetic ${kind} benchmark`, evaluators: [...checks, spec('ai-rubric', 'quality', rubric), spec('reference', 'comparison', rubric, false), spec('runtime', 'runtime', {}, false)],
        cases: [{ id: kind, input: `EVALUATOR_FIXTURE_${kind}: ${kind === 'data' ? 'Normalize A and B into items and total.' : kind === 'writing' ? 'Write a resident event notice for Friday.' : 'Plan Design A and Verify B.'}`, split: 'development', repeats: 1, references: [{ text: outputs[0], provenance: { kind: 'synthetic curated fixture' }, limitations: 'Minimal initial reference' }] }] },
      ranking: { primary: 'quality.utility', minImprovement: 0.1 }, targetThreshold: { metric: 'quality.utility', direction: 'higher', value: 4 }, finalVerification: { required: false }, promotion: { mode: 'automatic', limit: 1, confirmation: 'fresh-evaluation' } }, ...overrides };
}
export async function syntheticProvider(request) {
  const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const input = request.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  let text;
  if (system.includes('robust-evaluation-judge')) {
    const first = input.indexOf('{"data":');
    const packet = JSON.parse(input.slice(first)).data;
    const values = Object.values(artifacts).flat();
    const score = value => { const i = Object.values(artifacts).find(a => a.includes(value))?.indexOf(value); return [2, 3, 1, 3, 4][i] ?? 2; };
    if (packet.artifacts.A.includes('judge error') || packet.artifacts.A.includes('JUDGE_ERROR')) text = 'invalid synthetic judge JSON';
    else text = JSON.stringify({ dimensions: [{ id: 'utility', a: score(packet.artifacts.A), ...(packet.artifacts.B != null ? { b: score(packet.artifacts.B) } : {}), abstain: !values.includes(packet.artifacts.A), locations: [`A:${packet.artifacts.A}`, ...(packet.artifacts.B != null ? [`B:${packet.artifacts.B}`] : [])], rationale: 'Synthetic provider boundary: known fixture rubric dimension.' }] });
  } else if (system.includes('evaluator-fixture-optimizer')) {
    const kind = /EVALUATOR_FIXTURE_(data|writing|planning)/.exec(input)?.[1] ?? 'data';
    const iteration = Math.min(4, Number(/"iteration"\s*:\s*(\d+)/.exec(input)?.[1] ?? 1));
    text = JSON.stringify({ candidate: { text: kind === 'planning' ? `PROMPT_V${iteration}` : artifacts[kind][iteration] }, findings: [`Synthetic revision ${iteration}; runtime evaluation decides.`] });
  } else {
    const version = Number(/PROMPT_V(\d)/.exec(system)?.[1] ?? 0);
    text = artifacts.planning[version];
  }
  request.onText?.(text);
  return { text, finishReason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 30, cost: 0 } };
}
syntheticProvider.canServe = model => model === 'mock-evaluator';
