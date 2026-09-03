// update_task: correct a backlog task's own description of itself.
//
// The fields are an ALLOWLIST, and the allowlist is the tool. An agent may
// sharpen what a task says — its effort band, what it depends on, which gates
// judge it, the paths it will touch, its body — and it may not touch `status`,
// `attempts`, `claimedBy`, `runIds` or anything else the supervisor owns.
//
// The reason is not politeness. `status: 'landed'` is the single most valuable
// field in this system and the one an agent optimizing for "done" has every
// incentive to write. Gates being unremovable (core/gates.js §7.3) is the same
// rule one layer down: an agent that can edit the exam is not being examined.
// So the restriction is enforced HERE, in the tool, not asked for in a prompt.
import { requireBacklog } from './list_tasks.js';

// Everything an agent may write. Anything else is refused by name, so a model
// that tries learns the rule from the error instead of from silence.
export const EDITABLE = ['value', 'effort', 'level', 'dependsOn', 'gates', 'blastRadius', 'references', 'body'];

export default {
  name: 'update_task',
  title: 'Update a backlog task',
  description: [
    'Correct the description of a task in the project backlog: its value/effort estimate, its',
    'effort band, what it depends on, the gates that judge it, the paths it will touch, or its body.',
    'Use it when you discover a task is under-specified, depends on something nobody noticed, or',
    'declares a gate this project cannot run.',
    `Only these fields can be changed: ${EDITABLE.join(', ')}.`,
    'A task\'s status, attempt count and run history belong to the supervisor and cannot be set here —',
    'finish the work and let the gates decide.'
  ].join(' '),
  effects: ['write'],
  scope: 'workspace',
  risk: 'caution',
  keywords: ['backlog', 'task', 'update', 'edit', 'gates', 'depends'],
  examples: [
    'this task declares a pytest gate and there is no Python here — fix its gates',
    'record that t-0009 must land before this one'
  ],
  parameters: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Task id, e.g. "t-0006".' },
      value: { type: 'integer', minimum: 1, maximum: 5, description: 'How valuable, 1-5.' },
      effort: { type: 'integer', minimum: 1, maximum: 5, description: 'How much work, 1-5.' },
      level: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        description: 'Effort band the next attempt runs at.'
      },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must land first.' },
      gates: { type: 'array', items: { type: 'string' }, description: 'Extra gate commands, beyond the project defaults.' },
      blastRadius: { type: 'array', items: { type: 'string' }, description: 'Paths the work is expected to touch.' },
      references: { type: 'array', items: { type: 'string' }, description: 'Reference repositories this task was learned from.' },
      body: { type: 'string', description: 'The task text: goal, context, acceptance criteria.' }
    }
  },
  run(args, ctx) {
    const backlog = requireBacklog(ctx);
    const id = String(args?.id ?? '').trim();
    const task = backlog.get(id);
    if (!task) throw new Error(`No task "${id}" in the backlog.`);

    const patch = {};
    for (const key of EDITABLE) if (args[key] !== undefined) patch[key] = args[key];
    // `additionalProperties: false` already refuses an unknown field at
    // validation, so reaching here with nothing means the call named only `id`.
    if (!Object.keys(patch).length) {
      throw new Error(`Nothing to change. Pass at least one of: ${EDITABLE.join(', ')}.`);
    }

    // A task another worker is holding is one whose file the supervisor is
    // also writing (core/backlog.js update() is read-modify-write), and two
    // writers to one file silently lose a field. Refuse rather than race.
    if (task.status === 'claimed' || task.status === 'running' || task.status === 'verifying') {
      throw new Error(`Task "${id}" is ${task.status} — a worker holds it and the supervisor is writing the same file. Edit it once it is released.`);
    }

    const next = backlog.update(id, patch);
    if (!ctx?.canonicalSession) ctx?.store?.appendLog?.(ctx.runId, {
      event: 'task_updated',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      task: id, fields: Object.keys(patch)
    });
    return { id: next.id, title: next.title, changed: Object.keys(patch), status: next.status };
  }
};
