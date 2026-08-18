// read_task: one backlog task, in full.
//
// The counterpart to list_tasks. A dependency's id in a frontmatter list tells
// you nothing about whether it overlaps with what you are doing; its body tells
// you exactly that, and it is already written for a reader who has not seen the
// run (DESIGN-SPEC.md §8).
import { requireBacklog } from './list_tasks.js';

export default {
  name: 'read_task',
  title: 'Read a backlog task',
  description: [
    'Read one task from the project backlog by id, body included — the task as its author wrote it.',
    'Use it to read a dependency before assuming what it covers, or to re-read your own task.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['backlog', 'task', 'read', 'dependency'],
  examples: ['read t-0006', 'what does the task I depend on actually say'],
  parameters: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Task id, e.g. "t-0006".' }
    }
  },
  run(args, ctx) {
    const backlog = requireBacklog(ctx);
    const id = String(args?.id ?? '').trim();
    const task = backlog.get(id);
    if (!task) {
      // Name what does exist. "No task t-006" plus nothing sends the next turn
      // back with another guess at the id.
      const known = backlog.list().slice(0, 20).map(t => t.id);
      throw new Error(`No task "${id}" in the backlog.${known.length ? ` Known ids: ${known.join(', ')}.` : ''}`);
    }
    return task;
  }
};
