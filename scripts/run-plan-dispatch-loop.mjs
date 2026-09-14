// Drive the running development app through its existing preload command API.
// No credentials or model responses are fabricated; all trials belong to Flyt.
import fs from 'node:fs';
import path from 'node:path';
import { serializeStack } from '../core/stackstore.js';
import { parseStack } from '#kernel';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'docs/reviews/plan-dispatch-performance');
const indexFile = path.join(root, '.flyt/plan-dispatch-experiment.json');
const model = 'z-ai/glm-5.3-flash';
fs.mkdirSync(evidence, { recursive: true });
const pages = await (await fetch('http://127.0.0.1:9337/json/list')).json();
const page = pages.find(p => p.type === 'page' && p.title === 'Flyt');
if (!page) throw new Error('Open the development Flyt app with --remote-debugging-port=9337 first');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let seq = 0;
const pending = new Map();
socket.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const cdp = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const api = async (method, ...args) => {
  const result = await cdp('Runtime.evaluate', { expression: `window.flyt[${JSON.stringify(method)}](...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const block = (id, use, config) => ({ kind: 'block', id, use: `flyt-blocks-${use}`, config });
const stack = (id, children) => serializeStack({ id, name: id, root: { kind: 'sequence', id: 'root', children } });
const check = (name, schema) => ({ id: 'json-schema', version: 1, name, mandatory: true, config: { schema } });
// Draft-07 contains does not support minContains; count-independent roots by
// requiring all tasks in the explicitly independent case to have no edges.
const independent = { type: 'object', properties: { tasks: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', properties: { dependsOn: { type: 'array', maxItems: 0 }, writeFiles: { type: 'array', maxItems: 0 } } } } } };
const merge = { type: 'object', properties: { tasks: { type: 'array', minItems: 3, maxItems: 3, contains: { type: 'object', properties: { dependsOn: { type: 'array', minItems: 2 }, requires: { type: 'array', minItems: 2 } } } } } };

export const dispatchInput = `Read-only benchmark using only the facts in this request. Produce exactly three independent worker answers, each covering its own numbered work package. Do not write files, use tools, or add a coordinator. Each worker verifies its own arithmetic and quotes the input values it used.
1. INVENTORY: apples=12, pears=0, plums=8. Report TOTAL=20, preserve the zero stock item, and name pears as out of stock.
2. LATENCY: before=240 ms, after=150 ms. Report REDUCTION=37.5% with (240-150)/240*100, and state these two numbers alone do not establish statistical significance.
3. RELEASE: API work=2 days, UI work=3 days, run concurrently from day 1; QA=1 day after both, release=day 5. Report QA=day 4, RELEASE=day 5, and one rollback verification check. This is an analysis work package, not instructions to split more workers.
Return each result in no more than 130 words. Preserve all requested outputs. No invented measurements.`;

const mixedInput = `Read-only, use only the supplied facts; no tools or file writes. Create exactly FOUR tasks in this order, with stable IDs audit, sum, double, range. All workers should answer directly and verify their own result.
audit: Independently produce a table covering each of these operational concerns: corrupt JSON, unknown fields, interrupted write, missing backup, stale cache, duplicate retry, network timeout, full disk, invalid encoding, zero quantity, empty collection, incompatible version. Each of the twelve rows needs a failure symptom, prevention, and concrete observable verification. Do not add a separate checking worker. Produce artifact audit-report.
sum: Independently compute 7+11+13, showing input and result. Produce artifact computed-sum. No dependencies; all inputs are already supplied.
double: Consume computed-sum from sum and report exactly twice that finished result with its calculation. Require computed-sum and depend on sum only. Produce doubled-sum.
range: Independently report min and max of [4,0,9] and explain why zero must remain. Produce range-report. No dependencies.
The audit is unrelated to the other tasks. The double task must wait only for sum, not audit. Keep the final answers complete and avoid redundant introductions.`;

try {
  const command = process.argv[2] ?? 'status';
  if (command === 'inspect') {
    const projects = await api('listProjects');
    const models = await api('listModels', 'openrouter');
    console.log(JSON.stringify({ projects, models: (Array.isArray(models) ? models : models.models ?? []).filter(m => m.id === model) }, null, 2));
  } else if (command === 'inspect-renderer') {
    const result = await cdp('Runtime.evaluate', { expression: '({ready:document.readyState,text:document.body.innerText.slice(0,6000),html:document.getElementById("root")?.innerHTML.slice(0,1500),scripts:[...document.scripts].map(s=>s.src)})', returnByValue: true });
    console.log(JSON.stringify(result.result.value, null, 2));
  } else if (command === 'create') {
    if (fs.existsSync(indexFile)) throw new Error('Experiment already exists; use status or collect');
    await api('openProject', root);
    const project = { id: root };
    const definition = {
      name: 'Plan & dispatch — GLM 5.3 Flash performance',
      objective: 'Improve supplemental Plan & dispatch planner guidance for efficient parallel work and complete, verifiable outputs. Produce the complete reusable prompt as candidate.text. Optimize against development feedback; the runtime evaluates actual production planning calls. Full dispatch latency is measured separately and must not be claimed from planner-only results.',
      constraints: 'Keep task coverage, hard dependencies, artifact handoffs and declared write conflicts correct. Avoid unnecessary sequential phases and redundant workers. Never claim timings or passing checks yourself. Do not embed benchmark-specific answers, IDs or domain facts in the reusable prompt. No tools or changes to project code.',
      folder: root, worker: { provider: 'openrouter', model }, tools: [], criteria: [], tests: [], maxParallel: 3,
      plateau: 3, limits: { iterations: 3, calls: 50, minutes: 25, usd: 2 }, selfRedesign: false, reviewResults: false,
      recipe: stack('improve-dispatch-planning', [block('improve', 'core:general-analysis', {
        maxTokens: 8192,
        systemPrompt: 'Revise reusable supplemental task-graph planning guidance using the fixed objective and actual development feedback. Return exactly one JSON object {"candidate":{"text":"complete guidance under 250 words"},"findings":["one concise evidence-based rationale"]}. Do not return a task graph. Do not simulate subsequent iterations. Do not claim your candidate passed evaluation. Keep the block invariant safety contract intact.',
        instructions: 'Improve the best available candidate or begin from the production invariant guidance. Explicitly distinguish independent deliverables from necessary consolidation. Require self-contained worker goals with source facts and observable acceptance checks. Only add dependencies for actual required outputs or write conflicts. Keep guidance short and do not overfit the development cases.',
      })]),
      evaluation: {
        version: 1, target: 'task-graph', targetConfig: { minTasks: 1, maxTasks: 6, parallelism: 'high' },
        baseline: { text: 'Follow the task-graph block invariant guidance.', provenance: { kind: 'Production planner with neutral supplemental instruction' } },
        suite: { id: 'plan-dispatch-performance', version: 1, name: 'Concurrency and executable output coverage', evaluators: [
          { id: 'block-contract', version: 1, name: 'contract', mandatory: true, config: { block: 'task-graph', options: { readOnly: true } } },
          { id: 'runtime', version: 1, name: 'runtime', mandatory: false, config: {} },
          { id: 'ai-rubric', version: 1, name: 'quality', mandatory: true, config: { model, repairs: 1,
            rubric: 'Evaluate executable planning quality, not self-claims. Full marks require all requested facts and checks to reach the right worker; edges must reflect real input requirements. Penalize missing coverage, duplicate effort, serial busywork, and unsafe implied parallel writes. Do not reward verbosity or number of tasks.',
            dimensions: [
              { id: 'coverage', description: 'Self-contained goals preserve each requested deliverable, source facts, constraints, and observable verification.', mandatory: true, minimum: 3 },
              { id: 'parallelism', description: 'Independent work can overlap; true prerequisite outputs are produced and required; no redundant stages.', mandatory: true, minimum: 3 },
            ] } },
        ], cases: [
          { id: 'independent-reports', split: 'development', repeats: 2, input: dispatchInput, requirements: 'Three independent self-verifying read-only work packages; no coordination dependency.', evaluators: [check('independent', independent)] },
          { id: 'required-consolidation', split: 'development', repeats: 2,
            input: 'Read-only, no tools. Produce three worker deliverables: (1) analyze import validation using facts: reject corrupt JSON, preserve unknown fields, support version 1; (2) independently analyze recovery using facts: backup before replacing data, atomic writes, restore on failure; (3) produce one acceptance checklist using BOTH finished analyses. First two tasks must run independently; final checklist requires both outputs. Each analysis verifies its own coverage. Do not write files.',
            requirements: 'Exactly two independent analyses and one consolidation requiring both artifacts; all facts and observable checks survive.', evaluators: [check('merge-dependencies', merge)] },
          { id: 'held-out-independent', split: 'held-out', repeats: 2,
            input: 'Read-only no tools. Give exactly three independent, self-verifying work packages with final answers: calculate solar panel totals from east=7 west=5; calculate water use reduction from 80 liters to 60 liters and explain sampling limitations; plan independent paint=2 days and plumbing=4 days followed by 1 inspection day, completion by day 6. No coordinator, files, or shared outputs.',
            requirements: 'Three independent complete goals with arithmetic, limitations and schedule checks.', evaluators: [check('held-out-independent', independent)] },
        ] },
        ranking: { primary: 'gateRate', tieBreakers: ['runtime.tokens', 'runtime.latencyMs'], minImprovement: 0 },
        targetThreshold: { metric: 'runtime.latencyMs', value: 6000, direction: 'lower' },
        finalVerification: { required: true }, promotion: { mode: 'off', limit: 0, confirmation: 'fresh-evaluation' },
      },
    };
    const draft = await api('goal', 'author-open', { projectId: project.id, definition });
    const published = await api('goal', 'author-publish', { projectId: project.id, draftId: draft.id, baseRevision: draft.revision });
    const index = { projectId: project.id, goalId: published.goalId, draftId: draft.id, model, createdAt: new Date().toISOString(), runs: [] };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    save('definition.json', definition); save('improvement-loop.stack.yaml', definition.recipe);
    await api('goal', 'start', { projectId: project.id, goalId: published.goalId });
    console.log(JSON.stringify(index));
  } else {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const goal = await api('goal', 'get', { projectId: index.projectId, goalId: index.goalId });
    if (command === 'status' || command === 'collect') {
      console.log(JSON.stringify({ goalId: goal.id, status: goal.status, reason: goal.reason, live: goal.live, iteration: goal.iteration, calls: goal.calls, knownUsd: goal.knownUsd, elapsedMs: goal.elapsedMs, activeChild: goal.activeChild && { runId: goal.activeChild.runId, phase: goal.activeChild.phase }, best: goal.best && { iteration: goal.best.iteration, eligible: goal.best.eligible, metrics: goal.best.evaluation?.metrics }, baseline: goal.baseline?.metrics }, null, 2));
      if (command === 'collect') save('goal-result.json', goal);
    } else if (command === 'feedback') {
      const revision = goal.pendingRevision ?? goal.activeRevision;
      const record = await api('goal', 'inspect', { projectId: index.projectId, goalId: index.goalId, record: `recipe-${revision}` });
      const program = parseStack(record.source);
      const note = 'Observed development baseline: all four planning trials required a repair. Static diagnostics showed requires containing facts already in the user brief, with no producer task. In this block, requires is ONLY for named outputs produced by another task in the graph. Supplied facts and existing workspace evidence belong in goal text, not requires. Independent roots use dependsOn:[] and requires:[]. A consolidation uses matching produces/requires names and actual predecessor IDs. Incorporate this general contract clarification into the reusable prompt and evaluate the complete candidate. This is measured development feedback, not evidence that a new prompt passed.';
      program.root.children[0].config.instructions += `\n\n${note}`;
      const source = serializeStack(program);
      await api('goal', 'revise', { projectId: index.projectId, goalId: index.goalId, baseRevision: revision, source, rationale: 'Feed observed development repair diagnostics into the next improvement iteration; keep fixed criteria and limits unchanged.' });
      save('development-feedback.txt', note); save('improvement-loop-revised.stack.yaml', source);
      console.log('Recorded measured development feedback for the next iteration.');
    } else if (command === 'dispatch') {
      const label = process.argv[3] ?? 'baseline';
      const mixed = label.includes('mixed');
      const heldout = label.includes('heldout');
      const prompt = /^(baseline|production)/.test(label) ? 'Follow the task-graph block invariant guidance.' : fs.readFileSync(path.join(evidence, 'best-planner-prompt.txt'), 'utf8');
      const created = await api('v2CreateStack', { name: `dispatch-perf-${label}` });
      const id = created.stackId;
      const source = serializeStack({ id, name: `Plan & dispatch performance: ${label}`, launchable: true, root: { kind: 'sequence', id: 'root', children: [block('dispatch', 'core:task-graph', { model, parallelism: 'high', maxParallel: mixed ? 2 : 3, minTasks: mixed ? 4 : 3, maxTasks: mixed ? 4 : 3,
        systemPrompt: prompt, workerMaxTokens: mixed ? 16384 : 8192, workerMaxSteps: 4, workerMaxOutputWords: mixed ? 1000 : 160, taskAttempts: 1,
        workerInstructions: `This is a read-only supplied-facts benchmark. Do not use any tools. Produce the requested final result directly, verify arithmetic and preserve uncertainty. ${mixed ? 'Keep short calculations concise; cover every requested row in the audit, using one short phrase per table cell.' : 'Keep each answer under 130 words.'}`,
      })] } });
      await api('v2SaveStackSource', source);
      save(`${label}.stack.yaml`, source);
      const trialInput = heldout ? goal.contract.evaluation.suite.cases.find(c => c.split === 'held-out').input : mixed ? mixedInput : dispatchInput;
      const run = await api('runWorkflow', index.projectId, id, trialInput, null, null, { defaultWorker: { model, provider: 'openrouter' }, blocks: { dispatch: { model, provider: 'openrouter' } }, defaultFallbacks: [] });
      index.runs.push({ label, ...run, startedAt: new Date().toISOString() });
      fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
      console.log(JSON.stringify(run));
    }
  }
} finally { socket.close(); }
