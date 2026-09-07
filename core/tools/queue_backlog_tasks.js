import { createHash } from 'node:crypto';
import { validateArgs } from './schema.js';

const strings = { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 64 };
export const backlogTaskSchema = {
  type: 'object', required: ['title', 'goal'], additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    goal: { type: 'string', minLength: 1 },
    doneWhen: strings, blastRadius: strings, dependsOn: strings, skills: strings, gates: strings,
    value: { type: 'integer', minimum: 1, maximum: 5 },
    effort: { type: 'integer', minimum: 1, maximum: 5 },
  },
};
const parameters = { type: 'object', required: ['tasks'], additionalProperties: false,
  properties: { tasks: { type: 'array', items: backlogTaskSchema, maxItems: 32 } } };

export default {
  name: 'queue_backlog_tasks', title: 'Hand off backlog tasks',
  description: 'Queue the explicit task objects supplied to a Backlog handoff block. Returns durable task receipts; never starts execution. Replaying the same handoff does not create duplicates.',
  effects: ['write'], scope: 'workspace', risk: 'caution', parameters,
  result: { preview: 'json', maxPreviewChars: 24000, artifact: true },
  run(args, ctx) {
    const errors = validateArgs(parameters, args);
    if (errors.length) throw new Error(`No tasks were queued. ${errors.join('; ')}`);
    if (!ctx?.backlog || !ctx.runId || !ctx.nodeId) throw new Error('No tasks were queued. Backlog handoff needs a bound project backlog and run block identity.');
    // Validate the entire batch before the first mutation. Dependencies must
    // name existing tasks, not invented ids in a plan that would never run.
    for (const task of args.tasks) {
      if (!task.title.trim() || !task.goal.trim()) throw new Error('No tasks were queued. Task title and goal cannot be blank.');
      for (const dependency of task.dependsOn ?? []) {
        if (!ctx.backlog.get(dependency)) throw new Error(`No tasks were queued. Unknown backlog dependency: ${dependency}`);
      }
    }
    const createdBy = `handoff:${ctx.runId}:${ctx.nodeId}`;
    const queued = [];
    for (const [index, task] of args.tasks.entries()) {
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(task).sort(([a], [b]) => a.localeCompare(b))));
      const digest = createHash('sha256').update(`${createdBy}:${index}:${canonical}`).digest('hex').slice(0, 24);
      const id = `t-handoff-${digest}`;
      try {
        const prior = ctx.backlog.get(id);
        if (prior && prior.createdBy !== createdBy) throw new Error(`Backlog task identity collision: ${id}`);
        const saved = prior ?? ctx.backlog.add({ ...task, id, createdBy });
        queued.push({ id: saved.id, title: saved.title, status: saved.status });
      } catch (error) {
        return { queued, refused: `Backlog handoff stopped after ${queued.length} of ${args.tasks.length} tasks: ${error.message}. Retry the same handoff to resume without duplicates.` };
      }
    }
    return { queued };
  },
};
