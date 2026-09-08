// Editable real-model example. Import makePlanGoal, supply an enabled worker,
// and pass the returned definition to goal:author-open for review in Goals.
// Nothing runs merely by importing this module.
import { serializeStack } from '../core/stackstore.js';

export function makePlanGoal(worker) {
  return {
    name: 'Improve a production Plan prompt',
    objective: 'Improve standing planning guidance so the production Plan block returns actionable tasks with explicit verification. The candidate is the complete proposed prompt, not a plan or a claim of measured success.',
    constraints: 'Preserve the user request and scope. Do not assume fewer tasks are better. Use only development feedback. Do not request reference answers or install the prompt in production.',
    worker, tools: [], criteria: [], tests: [], plateau: 3,
    limits: { iterations: 3, calls: 30, minutes: 5, usd: 1 },
    recipe: serializeStack({ id: 'improve-plan-guidance', name: 'Revise a planning prompt', root: { kind: 'sequence', id: 'root', children: [{
      kind: 'block', id: 'revise', use: 'flyt-blocks-core:general-analysis', title: 'Propose one complete prompt revision',
      config: {
        systemPrompt: 'You revise a production Plan system prompt. Use the fixed Goal objective, public development cases and runtime development feedback. Return exactly one JSON object with candidate.text containing the complete revised standing guidance, and findings containing one concise change rationale. Preserve task coverage and verifiability. Never claim that your own prompt passed evaluation.',
        instructions: 'Improve the best candidate or start with concise actionable planning guidance. Require a JSON array of complete task strings and include a Verify task for each requested outcome. Avoid hidden assumptions.',
      },
    }] } }),
    evaluation: {
      version: 1, target: 'plan', targetConfig: { maxTokens: 4096 },
      baseline: { text: 'Create a concise ordered implementation plan.', provenance: { kind: 'Authored example baseline' } },
      suite: {
        id: 'plan-actionability-example', version: 1, name: 'Actionable Plan development cases',
        evaluators: [
          { id: 'block-contract', version: 1, name: 'contract', mandatory: true, config: { block: 'plan' } },
          { id: 'json-schema', version: 1, name: 'raw-array', mandatory: true, config: { raw: true, schema: { type: 'array', minItems: 2, items: { type: 'string', minLength: 12 } } } },
          { id: 'contains', version: 1, name: 'verification', mandatory: true, config: { value: 'Verify' } },
          { id: 'runtime', version: 1, name: 'runtime', mandatory: false, config: {} },
        ],
        cases: [
          { id: 'api', split: 'development', repeats: 2, input: 'Plan a read-only service endpoint with input validation and tests. Include a task beginning Verify that names its observable acceptance conditions.', requirements: 'Cover implementation, invalid inputs, and verification.' },
          { id: 'migration', split: 'development', repeats: 2, input: 'Plan a reversible settings-file migration that preserves unknown keys. Include a task beginning Verify covering rollback and compatibility.', requirements: 'Preserve saved data and explicitly verify rollback.' },
        ],
      },
      ranking: { primary: 'gateRate', tieBreakers: [], minImprovement: 0 },
      targetThreshold: { metric: 'gateRate', value: 1, direction: 'higher' },
      finalVerification: { required: false },
      promotion: { mode: 'off', limit: 1, confirmation: 'fresh-evaluation' },
    },
  };
}
