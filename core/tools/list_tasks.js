// list_tasks: what else is in the queue this task came out of.
//
// `enqueue_task` gave an agent a way to ADD to the backlog and no way to look
// at it, which produces the obvious pathology: five runs queue five versions of
// the same idea because none of them could see the other four. It also makes
// "is this already covered" unanswerable, and that question is the difference
// between a backlog and a pile.
//
// Bodies are omitted here on purpose — forty task bodies is a context window
// spent on reading rather than working. `read_task` opens one.
export default {
  name: 'list_tasks',
  title: 'List backlog tasks',
  description: [
    "List the tasks in the PROJECT'S BACKLOG — the queue this task was picked from.",
    'Use it before enqueueing work, to check whether it is already queued, and to see what',
    'depends on what. Titles and metadata only; call read_task for one task\'s full text.',
    'Filter by status: queued, claimed, running, verifying, review, landed, failed, parked.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace', // .flyt/backlog/ — outside the run, inside the project
  risk: 'safe',
  autoExecute: true,
  keywords: ['backlog', 'queue', 'tasks', 'todo', 'list'],
  examples: ['what else is in the backlog', 'is there already a task for the board columns'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum: ['queued', 'claimed', 'running', 'verifying', 'review', 'landed', 'failed', 'parked'],
        description: 'Only tasks in this status. Omit for all of them.'
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many tasks (default 50).' }
    }
  },
  run(args, ctx) {
    const backlog = requireBacklog(ctx);
    const limit = Math.min(200, Math.max(1, Number(args?.limit) || 50));
    const all = backlog.list({ status: args?.status ?? null });
    return {
      total: all.length,
      // Newest-status-first ordering is the backlog's own; slicing rather than
      // sorting keeps this tool from having an opinion the picker does not.
      tasks: all.slice(0, limit).map(summarize),
      ...(all.length > limit ? { truncated: all.length - limit } : {}),
      // Files in the queue directory that would not parse. Reported rather than
      // hidden: an entry nobody can see is an entry nobody can fix.
      ...(backlog.problems?.length ? { problems: backlog.problems } : {})
    };
  }
};

// Everything but the body. `status`, `dependsOn` and `blockedReason` are what
// make the list answer questions; the body is what makes it long.
export function summarize(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    level: t.level ?? null,
    value: t.value,
    effort: t.effort,
    attempts: t.attempts ?? 0,
    ...(t.dependsOn?.length ? { dependsOn: t.dependsOn } : {}),
    ...(t.gates?.length ? { gates: t.gates } : {}),
    ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
    ...(t.createdBy ? { createdBy: t.createdBy } : {})
  };
}

// Shared by every backlog tool: throw rather than return a soft failure, for
// the reason enqueue_task documents — executeTool's `ok` means the tool RAN, so
// a `{ ok: false }` object would be logged as a successful call.
export function requireBacklog(ctx) {
  if (!ctx?.backlog) {
    throw new Error('No backlog is bound to this run, so there is no queue to read.');
  }
  return ctx.backlog;
}
