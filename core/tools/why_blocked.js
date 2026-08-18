// why_blocked: why a task is not moving, in the same words the board uses.
//
// The value is not the answer for one task — it is that an agent working a
// backlog can find out that its own dependency is dead, or that a gate it
// declared cannot run here, WITHOUT running a build to discover it. The
// alternative is what the loop did before: notice at landing time, park with a
// stack trace, and cost an attempt.
//
// It reads core/blockers.js — the same module core/api.js and the supervisor
// read — so an agent and a human looking at the same stuck task see the same
// sentence.
import { blockersFor, boardBlockers } from '../blockers.js';
import { requireBacklog } from './list_tasks.js';

export default {
  name: 'why_blocked',
  title: 'Why a task is blocked',
  description: [
    'Explain why a backlog task cannot be picked up — a missing or failed dependency, a dependency',
    'cycle, a gate this machine cannot run, an expired lease, an exhausted attempt ladder.',
    'Omit `id` to get every blocked task plus anything blocking the whole project',
    '(no reviewer configured, a spending cap reached, no loop running).'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['blocked', 'stuck', 'why', 'dependency', 'cycle', 'backlog'],
  examples: ['why is t-0008 not being picked up', 'what is stopping the queue'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'One task id, e.g. "t-0008". Omit for everything that is blocked.' }
    }
  },
  run(args, ctx) {
    const backlog = requireBacklog(ctx);
    const tasks = backlog.list();
    const base = {
      tasks,
      problems: backlog.problems ?? [],
      config: ctx.projectConfig ?? {},
      settings: ctx.settings ?? {},
      cwd: ctx.workspace?.root ?? undefined
    };

    const id = String(args?.id ?? '').trim();
    if (id) {
      const task = tasks.find(t => t.id === id)
        ?? (backlog.problems ?? []).find(p => p.id === id);
      if (!task) throw new Error(`No task "${id}" in the backlog.`);
      const blockers = blockersFor(task, base);
      return {
        id,
        status: task.status ?? 'unreadable',
        blocked: blockers.some(b => b.severity === 'blocked'),
        blockers: blockers.map(plain),
        // An empty list is the answer "nothing is in its way", and saying so
        // beats an empty array a model has to interpret.
        ...(blockers.length ? {} : { note: 'Nothing is blocking this task.' })
      };
    }

    const perTask = [];
    for (const task of tasks) {
      const blockers = blockersFor(task, base).filter(b => b.severity === 'blocked');
      if (blockers.length) perTask.push({ id: task.id, title: task.title, status: task.status, blockers: blockers.map(plain) });
    }
    const project = boardBlockers(base).map(plain);
    return {
      blocked: perTask,
      project,
      ...(perTask.length || project.length ? {} : { note: 'Nothing is blocked.' })
    };
  }
};

// The model does not need `remedy.args` — those address UI buttons. It needs
// the sentence, the kind, and what the sentence points at.
const plain = b => ({
  kind: b.kind,
  severity: b.severity,
  summary: b.summary,
  ...(b.detail ? { detail: b.detail } : {}),
  ...(b.subjects?.length ? { subjects: b.subjects } : {})
});
