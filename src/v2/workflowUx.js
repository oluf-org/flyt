import { defaultModeId, workflowModes } from '../workflowModes.js';

// Re-exported so the surfaces that already import from here keep one import,
// while the rule itself lives outside v2 where the composer can reach it too.
export { defaultModeId, workflowModes };

const QUEUE_LEVELS = new Set(['low', 'medium', 'high']);

export const effortCopy = Object.freeze({
  low: 'Fast and focused. Low changes reasoning effort, not the model chosen for each step.',
  medium: 'Balanced depth for ordinary work. Medium changes reasoning effort, not the model chosen for each step.',
  high: 'More deliberate planning for substantial work. High changes reasoning effort, not the model chosen for each step.',
});

const clean = value => String(value ?? '').trim();

/**
 * The mode a run will use: the one asked for, or the default.
 *
 * A workflow that declares modes always runs in one of them. There is no
 * fourth, unnamed way to run a stack that has three named ones, so an absent
 * id resolves rather than meaning "no mode".
 */
export function selectedWorkflowPreset(flow, presetId = null) {
  const modes = workflowModes(flow);
  return modes.find(mode => mode.id === presetId)
    ?? modes.find(mode => mode.id === defaultModeId(flow))
    ?? null;
}

export function workflowSteps(flow, presetId = null) {
  const preset = selectedWorkflowPreset(flow, presetId);
  return (flow?.steps ?? []).map(step => ({
    ...step,
    effort: preset?.overrides?.[step.id]?.effort ?? step.effort ?? null,
    model: preset?.overrides?.[step.id]?.model ?? step.model ?? null,
  }));
}

export function workflowOutcome(flow) {
  const uses = new Set((flow?.steps ?? []).map(step => step.use));
  if (uses.has('flyt-blocks-loop:loop-handoff')) return 'Prepares a Loop handoff';
  if (uses.has('flyt-blocks-core:work')) return 'Changes the project and reports the result here';
  if (uses.has('flyt-blocks-core:research')) return 'Returns a sourced answer here';
  if ([...uses].some(use => String(use).includes('interrogate'))) return 'Asks questions, then returns a finished artifact here';
  return 'Returns the workflow result here';
}

export function modelForWorkflow(worker = null) {
  if (!worker?.model) return { label: 'No execution model selected', detail: 'Choose the executor model in Models.' };
  const provider = worker.provider && worker.provider !== 'auto' ? worker.provider : 'automatic provider';
  return { label: worker.model, detail: `Model-backed steps use ${provider} unless a step override replaces it.` };
}

export function queueTaskFromPrompt(prompt, level = 'low') {
  const goal = clean(prompt);
  const firstLine = goal.split(/\r?\n/).find(Boolean) ?? 'Untitled task';
  const title = firstLine.replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 96);
  const normalizedLevel = QUEUE_LEVELS.has(level) ? level : 'low';
  return {
    title,
    goal,
    level: normalizedLevel,
    body: ['## Goal', '', goal, '', `## Starting effort`, '', normalizedLevel].join('\n'),
  };
}
