/**
 * Agent-shaped planning and execution for work whose shape is only known at run time.
 *
 * The saved workflow contains one `task-graph` block.  Its planning turn emits a
 * small, validated DAG; the block then exposes every generated task as a child in
 * the session log and drains ready tasks in bounded waves.  Generated children
 * are run records, not edits to the authored stack: rerunning a workflow may
 * legitimately produce a different plan without rewriting Build behind the user.
 */
import type { JsonValue } from '../types.js';
import type { BlockDefinition, BlockOutcome, BlockRun } from '../blocks/types.js';
import { MAX_STEPS, runAgentLoop } from '../blocks/run.js';
import { DEFAULT_WORKER_MAX_TOKENS, executeWork, LOOP_CEILING } from './blocks-core.js';

export const name = 'flyt-blocks-task-graph';
export const inject = ['blocks', 'sessions'];

export const PARALLELISM_LEVELS = ['no', 'low', 'medium', 'high'] as const;
export type ParallelismLevel = (typeof PARALLELISM_LEVELS)[number];

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEFAULT_MAX_TASKS = 12;
const HARD_MAX_TASKS = 24;
// max_tokens bounds hidden reasoning and visible JSON together. The installed
// Fable run 2026-08-30T13-39-49 exhausted 4,069/4,096 and 4,094/4,096 tokens
// in reasoning on its plan and repair turns, leaving content empty both times.
// This is a ceiling, not prepaid spend: ordinary planners still pay only for
// what they use, while reasoning models have room left to emit the plan.
const PLANNER_MAX_TOKENS = 61_440;
const PLANNER_REPAIR_MAX_TOKENS = 81_920;
const PLANNER_REPAIR_ATTEMPTS = 3;
const DEFAULT_WAVE: Record<ParallelismLevel, number> = { no: 1, low: 2, medium: 4, high: 8 };

export interface GeneratedTask {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  produces: string[];
  requires: string[];
  optional: string[];
  writeFiles: string[];
}

export interface TaskGraphPlan {
  tasks: GeneratedTask[];
  summary: string;
}

export interface PlanParseResult {
  ok: boolean;
  plan: TaskGraphPlan | null;
  errors: string[];
}

const strings = (value: unknown): string[] | null => Array.isArray(value)
  && value.every(item => typeof item === 'string' && item.trim())
  ? [...new Set(value.map(item => String(item).trim()))]
  : null;

/** Pull one JSON object from a plain or fenced model answer. */
export function extractTaskGraphJson(text: string): unknown {
  const source = String(text ?? '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  for (const candidate of [fenced, source, first >= 0 && last > first ? source.slice(first, last + 1) : null]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate.trim()); } catch { /* try the next representation */ }
  }
  return null;
}

function cycleIn(tasks: readonly GeneratedTask[]): string[] | null {
  const deps = new Map(tasks.map(task => [task.id, task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id); path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop(); visiting.delete(id); visited.add(id);
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}

/**
 * Validate the whole generated graph before any child is announced or run.
 *
 * Data dependencies and overlapping declared writes are made structural here,
 * even if the planner omitted the edge.  The parallelism mode may be eager; it
 * may never race two tasks that both said they would write the same file.
 */
export function parseTaskGraphPlan(
  text: string,
  {
    minTasks = 1, maxTasks = DEFAULT_MAX_TASKS, parallelism = 'medium' as ParallelismLevel,
    readOnly = false,
  } = {},
): PlanParseResult {
  const raw = extractTaskGraphJson(text) as Record<string, unknown> | null;
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, plan: null, errors: ['no JSON plan object was found'] };
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return { ok: false, plan: null, errors: ['tasks must be a non-empty array'] };
  }
  const cap = Math.max(1, Math.min(HARD_MAX_TASKS, Math.floor(maxTasks)));
  const floor = Math.max(1, Math.min(cap, Math.floor(minTasks)));
  if (raw.tasks.length < floor) errors.push(`plan has ${raw.tasks.length} tasks; this block requires at least ${floor}`);
  if (raw.tasks.length > cap) errors.push(`plan has ${raw.tasks.length} tasks; this block allows ${cap}`);

  const tasks: GeneratedTask[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.tasks.entries()) {
    const task = value as Record<string, unknown> | null;
    const at = `tasks[${index}]`;
    if (!task || typeof task !== 'object' || Array.isArray(task)) { errors.push(`${at} must be an object`); continue; }
    const id = typeof task.id === 'string' ? task.id.trim() : '';
    if (!ID.test(id)) errors.push(`${at}.id must use lowercase letters, digits and hyphens (max 48 characters)`);
    else if (ids.has(id)) errors.push(`${at}.id duplicates "${id}"`);
    ids.add(id);
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const goal = typeof task.goal === 'string' ? task.goal.trim() : '';
    if (!title) errors.push(`${at}.title is required`);
    if (!goal) errors.push(`${at}.goal is required`);
    const fields = Object.fromEntries(['dependsOn', 'produces', 'requires', 'optional', 'writeFiles'].map(name => {
      const parsed = strings(task[name] ?? []);
      if (!parsed) errors.push(`${at}.${name} must be an array of non-empty strings`);
      return [name, parsed ?? []];
    })) as Record<'dependsOn' | 'produces' | 'requires' | 'optional' | 'writeFiles', string[]>;
    tasks.push({ id, title, goal, ...fields });
  }

  if (readOnly) for (const task of tasks) {
    if (task.writeFiles.length) {
      errors.push(`${task.id}.writeFiles must be empty because the brief is read-only`);
    }
  }

  const known = new Set(tasks.map(task => task.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!known.has(dep)) errors.push(`${task.id}.dependsOn names missing task "${dep}"`);
      if (dep === task.id) errors.push(`${task.id} depends on itself`);
    }
  }

  // One output has one producer. Required inputs create hard dependency edges;
  // optional inputs create an edge only when a producer exists.
  const producers = new Map<string, string>();
  for (const task of tasks) for (const output of task.produces) {
    const prior = producers.get(output);
    if (prior) errors.push(`output "${output}" is produced by both ${prior} and ${task.id}`);
    else producers.set(output, task.id);
  }
  for (const task of tasks) {
    for (const input of task.requires) {
      const producer = producers.get(input);
      if (!producer) errors.push(`${task.id} requires "${input}", but no task produces it`);
      else if (producer !== task.id && !task.dependsOn.includes(producer)) task.dependsOn.push(producer);
    }
    for (const input of task.optional) {
      const producer = producers.get(input);
      if (producer && producer !== task.id && !task.dependsOn.includes(producer)) task.dependsOn.push(producer);
    }
  }

  // Declared write collisions are always serial. The authored order is the
  // deterministic tie-breaker; this is the safety floor beneath every mode.
  const lastWriter = new Map<string, string>();
  for (const task of tasks) for (const file of task.writeFiles.map(value => value.replace(/\\/g, '/').toLowerCase())) {
    const prior = lastWriter.get(file);
    if (prior && prior !== task.id && !task.dependsOn.includes(prior)) task.dependsOn.push(prior);
    lastWriter.set(file, task.id);
  }

  // "No" is deterministic serial execution regardless of what the model
  // proposed. Other modes retain only real dependencies and safety edges.
  if (parallelism === 'no') {
    for (let index = 1; index < tasks.length; index++) {
      const prior = tasks[index - 1].id;
      if (!tasks[index].dependsOn.includes(prior)) tasks[index].dependsOn.push(prior);
    }
  }
  const cycle = cycleIn(tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return errors.length
    ? { ok: false, plan: null, errors }
    : { ok: true, plan: { tasks, summary: typeof raw.summary === 'string' ? raw.summary.trim() : '' }, errors: [] };
}

const POLICY: Record<ParallelismLevel, string> = {
  no: 'Produce a sensible task order. Execution will be fully serial.',
  low: 'Be conservative. Parallelize only tasks that are clearly independent and unlikely to touch related code.',
  medium: 'Balance throughput and safety. Add dependencies for real information flow or likely write conflicts; leave other tasks independent.',
  high: 'Be aggressive. Keep tasks independent unless there is an obvious producer/consumer dependency or an overlapping write target.',
};

function plannerSystem(parallelism: ParallelismLevel, minTasks: number, maxTasks: number): string {
  return [
    'ROLE: task-graph-planner',
    'Turn the brief into a bounded dependency graph that worker agents can execute.',
    POLICY[parallelism],
    `Create between ${minTasks} and ${maxTasks} tasks. Return ONLY one JSON object, with this shape:`,
    '{"summary":"...","tasks":[{"id":"lowercase-id","title":"...","goal":"complete worker brief with acceptance criteria","dependsOn":[],"produces":[],"requires":[],"optional":[],"writeFiles":[]}]}',
    'produces/requires/optional are named artifacts or facts, not filenames. writeFiles contains every file the task expects to modify.',
    'Keep each task independently verifiable. Do not create coordination-only tasks. Do not put two tasks in parallel when one needs the other\'s result.',
    'Every worker can inspect the bound workspace. Do not create a broad repository-inventory or exploration task for other workers; give each worker a focused deliverable and let it perform its own targeted reads.',
    'Do not narrate your analysis. Begin the visible response with { and finish the complete JSON object before stopping.',
  ].join('\n');
}

/** A static validator's feedback for the next planner turn. */
export function taskGraphRepairPrompt(
  invalidPlan: string,
  errors: readonly string[],
  originalBrief: string,
  attempt: number,
): string {
  return [
    `REPAIR ATTEMPT ${attempt}: the task-graph validator rejected the JSON below.`,
    'Make the smallest correction that resolves every diagnostic. Preserve valid task ids, goals and ordering.',
    'Do not re-plan from scratch. Return only one complete JSON object and no analysis.',
    '',
    'STATIC VALIDATION DIAGNOSTICS:',
    ...errors.map((error, index) => `${index + 1}. ${error}`),
    '',
    'REPAIR RULES:',
    '- Every requires item must be named by exactly one task in produces; add the artifact to the actual producer or remove a requirement that is not real.',
    '- Every dependsOn id must exist, self-dependencies are forbidden, and the final graph must be acyclic.',
    '- Keep all array fields as arrays of non-empty strings and respect the declared read-only/write scope.',
    '',
    'PRIOR INVALID JSON:',
    invalidPlan || '(the prior turn returned no visible JSON)',
    '',
    'ORIGINAL BRIEF:',
    originalBrief,
  ].join('\n');
}

function plannerFailure(
  result: Awaited<ReturnType<typeof runAgentLoop>>,
  errors: readonly string[],
  maxTokens: number,
): string {
  const completion = result.usage?.completionTokens;
  const reasoning = result.usage?.reasoningTokens;
  if (!result.content.trim() && result.finishReason === 'length') {
    const split = reasoning != null
      ? ` It spent ${reasoning}${completion != null ? ` of ${completion}` : ''} completion tokens on internal reasoning and returned no visible JSON.`
      : ' It returned no visible JSON.';
    return `Planner response was cut off at its ${maxTokens.toLocaleString('en-US')}-token ceiling.${split} Retry this block or choose another model.`;
  }
  if (!result.content.trim()) {
    return `Planner returned no visible plan (finish reason: ${result.finishReason}). Retry this block or choose another model.`;
  }
  return `Planner returned an invalid task graph: ${errors.join('; ')}`;
}

function taskInput(task: GeneratedTask, original: string, completed: ReadonlyMap<string, BlockOutcome>): string {
  const dependencies = task.dependsOn.map(id => {
    const output = completed.get(id)?.output ?? '(no output)';
    return `## ${id}\n${output}`;
  }).join('\n\n');
  return [
    `# Task: ${task.title}`,
    task.goal,
    task.writeFiles.length ? `\nExpected write scope:\n${task.writeFiles.map(file => `- ${file}`).join('\n')}` : '',
    `\nOriginal request:\n${original}`,
    dependencies ? `\nCompleted dependency outputs:\n${dependencies}` : '',
  ].filter(Boolean).join('\n');
}

async function priorChildOutcomes(run: BlockRun, session: Awaited<ReturnType<BlockRun['ctx']['sessions']['open']>>): Promise<Map<string, BlockOutcome>> {
  const outputs = new Map<string, string>();
  const states = new Map<string, { status: string; error?: string }>();
  for await (const event of session.read()) {
    const data = event.data as Record<string, unknown>;
    if (data?.parentId !== run.blockId || typeof data.taskId !== 'string') continue;
    if (event.type === 'block.output') outputs.set(data.taskId, String(data.content ?? ''));
    if (event.type === 'block.status') states.set(data.taskId, {
      status: String(data.status ?? ''), ...(data.error ? { error: String(data.error) } : {}),
    });
  }
  return new Map([...states].filter(([, state]) => state.status === 'done').map(([id, state]) => [id, {
    status: 'done' as const, output: outputs.get(id) ?? '', ...(state.error ? { error: state.error } : {}),
  }]));
}

const str = (value: JsonValue | undefined, fallback = ''): string => typeof value === 'string' && value ? value : fallback;
const integer = (value: JsonValue | undefined, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** A conservative, explicit read-only promise in the brief. */
function isReadOnlyBrief(input: string): boolean {
  return /\bread[- ]only\b|\bno (?:file )?(?:writes?|modifications?|changes?)\b|\bdo not (?:modify|write|edit|create (?:files?|artifacts?))\b/i.test(input);
}

export async function executeTaskGraph(run: BlockRun): Promise<BlockOutcome> {
  const session = await run.ctx.sessions.open(run.runId);
  const parallelism = PARALLELISM_LEVELS.includes(run.config.parallelism as ParallelismLevel)
    ? run.config.parallelism as ParallelismLevel : 'medium';
  const maxTasks = integer(run.config.maxTasks, DEFAULT_MAX_TASKS, 1, HARD_MAX_TASKS);
  const minTasks = integer(run.config.minTasks, 1, 1, maxTasks);
  const maxParallel = integer(run.config.maxParallel, DEFAULT_WAVE[parallelism], 1, HARD_MAX_TASKS);
  const model = str(run.config.model, 'openrouter/auto');
  const fallbackModels = Array.isArray(run.config.modelFallbacks)
    ? run.config.modelFallbacks.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
  const authoredPlannerSystem = str(run.config.systemPrompt);
  const system = authoredPlannerSystem || plannerSystem(parallelism, minTasks, maxTasks);
  const readOnly = isReadOnlyBrief(run.input);

  // Reuse the accepted plan on resume. The plan artifact is written before any
  // child is announced, so a crash cannot leave unexplainable generated work.
  let planText = '';
  for await (const event of session.read()) {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'block.output' && data.blockId === run.blockId && data.port === 'plan') planText = String(data.content ?? '');
  }
  let parsed = planText ? parseTaskGraphPlan(planText, { minTasks, maxTasks, parallelism, readOnly }) : null;
  if (!parsed?.ok) {
    const planned = await runAgentLoop({
      ctx: run.ctx, session, runId: run.runId, blockId: `${run.blockId}.planner`, turn: 1,
      model, fallbackModels, system, input: run.input,
      tools: [], ceiling: [], maxSteps: 1, maxTokens: PLANNER_MAX_TOKENS,
      temperature: 0.1, isolated: true, ...(run.signal ? { signal: run.signal } : {}),
    });
    if (planned.stopped !== 'answered') return { status: 'failed', output: planned.content, error: planned.reason ?? planned.stopped };
    planText = planned.content;
    parsed = parseTaskGraphPlan(planText, { minTasks, maxTasks, parallelism, readOnly });
    let lastPlanner = planned;
    let lastPlannerBudget = PLANNER_MAX_TOKENS;
    for (let attempt = 1; !parsed.ok && attempt <= PLANNER_REPAIR_ATTEMPTS; attempt++) {
      const invalidPlan = planText;
      const diagnostics = [...parsed.errors];
      await session.append({ type: 'block.warning', data: {
        blockId: run.blockId,
        code: 'invalid_task_graph', transient: true, attempt,
        maxAttempts: PLANNER_REPAIR_ATTEMPTS,
        diagnostics,
        reason: `Planner graph failed ${diagnostics.length} static validation check(s); requesting a minimal repair.`,
      } });
      const repaired = await runAgentLoop({
        ctx: run.ctx, session, runId: run.runId, blockId: `${run.blockId}.planner-repair-${attempt}`, turn: attempt + 1,
        model, fallbackModels, system,
        input: taskGraphRepairPrompt(invalidPlan, diagnostics, run.input, attempt),
        tools: [], ceiling: [], maxSteps: 1, maxTokens: PLANNER_REPAIR_MAX_TOKENS,
        temperature: 0, isolated: true, ...(run.signal ? { signal: run.signal } : {}),
      });
      if (repaired.stopped !== 'answered') return { status: 'failed', output: repaired.content, error: repaired.reason ?? repaired.stopped };
      planText = repaired.content;
      parsed = parseTaskGraphPlan(planText, { minTasks, maxTasks, parallelism, readOnly });
      lastPlanner = repaired;
      lastPlannerBudget = PLANNER_REPAIR_MAX_TOKENS;
    }
    if (!parsed.ok || !parsed.plan) return {
      status: 'failed', output: planText,
      error: plannerFailure(lastPlanner, parsed.errors, lastPlannerBudget),
    };
    await session.append({ type: 'block.output', data: { blockId: run.blockId, port: 'plan', content: planText } });
  }
  const plan = parsed.plan!;
  const completed = await priorChildOutcomes(run, session);
  const announced = new Set<string>();
  for await (const event of session.read()) {
    const data = event.data as Record<string, unknown>;
    if (event.type === 'block.status' && data.parentId === run.blockId && typeof data.taskId === 'string') announced.add(data.taskId);
  }
  for (const task of plan.tasks) if (!announced.has(task.id)) {
    await session.append({ type: 'block.status', data: {
      blockId: `${run.blockId}.${task.id}`, parentId: run.blockId, taskId: task.id,
      title: task.title, use: 'flyt-blocks-core:work', status: 'pending', dependsOn: task.dependsOn,
    } });
  }

  while (completed.size < plan.tasks.length) {
    if (run.signal?.aborted) return { status: 'failed', output: '', error: 'Stopped before the next task wave began.' };
    const ready = plan.tasks.filter(task => !completed.has(task.id)
      && task.dependsOn.every(dep => completed.has(dep))).slice(0, maxParallel);
    if (!ready.length) return { status: 'failed', output: '', error: 'The generated task graph has no ready task; its dependencies cannot be satisfied.' };
    const outcomes = await Promise.all(ready.map(async task => {
      const childId = `${run.blockId}.${task.id}`;
      await session.append({ type: 'block.status', data: {
        blockId: childId, parentId: run.blockId, taskId: task.id, title: task.title,
        use: 'flyt-blocks-core:work', status: 'active', dependsOn: task.dependsOn,
      } });
      let outcome: BlockOutcome;
      try {
        // A task that declares no writes is a read-only task, not merely a
        // writer that happens not to use its authority. Narrow its ceiling
        // before schemas reach the model, so it cannot churn through approval
        // prompts for create_file/bash while producing an analysis.
        const childCeiling = task.writeFiles.length
          ? run.ceiling
          : run.ceiling.filter(name => run.ctx.tools.get(name)?.classification?.effect === 'read');
        outcome = await executeWork({
          ...run, blockId: childId, input: taskInput(task, run.input, completed),
          ceiling: childCeiling,
          config: {
            model, ...(fallbackModels.length ? { modelFallbacks: fallbackModels } : {}),
            ...(run.config.workerSystemPrompt ? { systemPrompt: run.config.workerSystemPrompt } : {}),
            ...(run.config.effort ? { effort: run.config.effort } : {}),
            maxSteps: integer(run.config.workerMaxSteps, MAX_STEPS, 1, 100_000),
            maxTokens: integer(run.config.workerMaxTokens, DEFAULT_WORKER_MAX_TOKENS, 1, 131_072),
            isolated: true,
            instructions: `Work only on this generated task. Respect its expected write scope.\n${str(run.config.workerInstructions)}`.trim(),
          },
        });
      } catch (error) {
        outcome = { status: 'failed', output: '', error: String((error as Error)?.message ?? error) };
      }
      if (outcome.output) await session.append({ type: 'block.output', data: {
        blockId: childId, parentId: run.blockId, taskId: task.id, content: outcome.output,
      } });
      await session.append({ type: 'block.status', data: {
        blockId: childId, parentId: run.blockId, taskId: task.id, title: task.title,
        use: 'flyt-blocks-core:work', status: outcome.status, dependsOn: task.dependsOn,
        ...(outcome.error ? { error: outcome.error } : {}),
      } });
      return { task, outcome };
    }));
    const failed = outcomes.filter(item => item.outcome.status === 'failed');
    for (const item of outcomes) if (item.outcome.status === 'done') completed.set(item.task.id, item.outcome);
    if (failed.length) return {
      status: 'failed', output: failed.map(item => item.outcome.output).filter(Boolean).join('\n\n'),
      error: failed.length === 1
        ? `Generated task "${failed[0].task.title}" failed: ${failed[0].outcome.error ?? 'unknown error'}`
        : `${failed.length} generated tasks failed: ${failed.map(item => `"${item.task.title}": ${item.outcome.error ?? 'unknown error'}`).join('; ')}`,
    };
  }

  const aggregate = plan.tasks.map(task => `## ${task.title} (${task.id})\n${completed.get(task.id)?.output ?? ''}`).join('\n\n');
  return {
    status: 'done', output: [plan.summary, aggregate].filter(Boolean).join('\n\n'),
    structured: { tasks: plan.tasks as unknown as JsonValue, results: aggregate },
  };
}

export const TASK_GRAPH_SETTINGS = {
  type: 'object', additionalProperties: false,
  properties: {
    model: { type: 'string', description: 'Model used by the planner and generated workers.' },
    modelTier: { title: 'Model tier', enum: ['free', 'economy', 'standard', 'frontier'], description: 'Stable cost/quality profile.' },
    modelFallbacks: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    systemPrompt: {
      title: 'Planner system prompt', type: 'string', format: 'multiline',
      description: 'Replace the planning agent’s standing system prompt for this workflow instance.',
    },
    workerSystemPrompt: {
      title: 'Worker system prompt', type: 'string', format: 'multiline',
      description: 'Replace the generated workers’ standing system prompt for this workflow instance.',
    },
    parallelism: {
      title: 'Parallel work', enum: PARALLELISM_LEVELS,
      description: 'No is serial. Low is conservative, Medium balanced, High aggressive except for hard dependencies and declared write conflicts.',
    },
    minTasks: { title: 'Minimum tasks', type: 'integer', minimum: 1, maximum: HARD_MAX_TASKS },
    maxTasks: { title: 'Maximum tasks', type: 'integer', minimum: 1, maximum: HARD_MAX_TASKS },
    maxParallel: { title: 'Maximum simultaneous tasks', type: 'integer', minimum: 1, maximum: HARD_MAX_TASKS },
    effort: { enum: ['low', 'medium', 'high'], description: 'How hard generated workers should think.' },
    workerMaxSteps: { title: 'Warn after worker tool rounds', type: 'integer', minimum: 1, maximum: 100_000, description: 'Soft threshold only. The worker warns and continues.' },
    workerMaxTokens: { title: 'Worker tokens per query', type: 'integer', minimum: 1, maximum: 131_072, description: 'A worker cut off here automatically continues in another query.' },
    workerInstructions: { title: 'Worker instructions', type: 'string', format: 'multiline' },
  },
} as const;

export const taskGraphBlock: BlockDefinition = {
  use: 'flyt-blocks-core:task-graph',
  title: 'Plan & dispatch',
  description: 'Have an agent create a validated task graph, then run ready tasks in bounded parallel waves.',
  category: 'work',
  settings: TASK_GRAPH_SETTINGS as unknown as JsonValue,
  ceiling: LOOP_CEILING,
  outputs: [{ name: 'tasks', type: 'list' }, { name: 'results', type: 'string' }],
  execute: executeTaskGraph,
};

export function apply(ctx: BlockRun['ctx']): void {
  ctx.blocks.register(taskGraphBlock);
}
