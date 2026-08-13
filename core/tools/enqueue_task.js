// enqueue_task: work an agent noticed but should not do right now.
//
// The distinction from `create_task` is the whole point, and the description
// below has to teach it to a model that has both: `create_task` adds work to
// THIS run, executed by this pipeline, in this context, now. `enqueue_task`
// adds work to the PROJECT'S BACKLOG (LOOP-PLAN §5), for a future run with its
// own context, its own budget and its own verification — possibly tomorrow,
// possibly by a different model.
//
// This is how the loop grows its own to-do list. An agent that discovers the
// codebase needs a tool it doesn't have, or that a fix wants a refactor first,
// or that a test is flaky, records it here instead of either doing it inline
// (blowing the current task's scope and budget) or forgetting it (which is what
// happens today).
//
// It writes OUTSIDE the run — into `.flyt/backlog/` — so it carries `write`
// with workspace scope and therefore gates under `ask`/`smart` like any other
// out-of-run write. Under the loop's `always` mode it runs straight through.
// That asymmetry is correct: attended, "an agent wants to add to your backlog"
// is worth one glance; unattended, the whole design depends on it being free.
export default {
  name: 'enqueue_task',
  title: 'Add a task to the backlog',
  description: [
    "Add a task to the PROJECT'S BACKLOG for a future run to pick up.",
    'Use this for work that is worth doing but is NOT part of the current task:',
    'a missing tool, a refactor a later change would need, a bug you noticed in',
    'passing, a test that should exist. It is queued, not executed — it will be',
    'prioritized against everything else and run later with its own context and budget.',
    'To add work that must happen inside THIS run, use create_task instead.'
  ].join(' '),
  effects: ['write'],
  scope: 'workspace', // .flyt/backlog/ — outside the run, inside the project
  risk: 'caution',
  keywords: ['backlog', 'todo', 'later', 'follow-up', 'queue', 'idea', 'improvement'],
  examples: [
    'queue a task to add a lint script, since the gate runner needs one',
    'note that the retry helper should be extracted before the next change here'
  ],
  parameters: {
    type: 'object',
    required: ['title', 'goal'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short imperative title, e.g. "Add a per-task timeout to the gate runner".' },
      goal: {
        type: 'string',
        description: 'What the task must achieve, self-contained. Assume the reader has NOT seen this run: state the problem, where it is, and why it matters.'
      },
      doneWhen: {
        type: 'array',
        items: { type: 'string' },
        description: 'Acceptance criteria — how a future run knows it is finished.'
      },
      value: { type: 'integer', minimum: 1, maximum: 5, description: 'How valuable, 1-5 (default 3).' },
      effort: { type: 'integer', minimum: 1, maximum: 5, description: 'How much work, 1-5 (default 3).' },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Backlog task ids that must land first, e.g. ["t-0007"].'
      },
      blastRadius: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths the work is expected to touch, if you already know them.'
      }
    }
  },
  run(args, ctx) {
    // The backlog is supplied by whoever assembled the run, and is resolved
    // from OUTSIDE any worktree (§5.2). A run with no backlog wired is an
    // honest error rather than a file written into whatever directory happened
    // to be current — which, inside a worktree, would be the one place it must
    // never go.
    // Throw rather than return { ok: false }: executeTool's `ok` means the tool
    // RAN, so a soft-failure object would be recorded as a successful call —
    // the exact ambiguity that makes bash's exit codes untrustworthy
    // (DESIGN-SPEC §11.1). A throw fails the call and lands in the retrospective.
    if (!ctx?.backlog) {
      throw new Error('No backlog is bound to this run, so there is nowhere to queue work. Use create_task for work that belongs to this run.');
    }
    const task = ctx.backlog.add({
      title: args.title,
      goal: args.goal,
      doneWhen: args.doneWhen ?? [],
      value: args.value,
      effort: args.effort,
      dependsOn: args.dependsOn ?? [],
      blastRadius: args.blastRadius ?? [],
      // Provenance: which run and node asked for this. The picker reports it,
      // and a burst of near-identical tasks from one node is exactly the
      // pathology the overseer watches for (§11.6).
      createdBy: ctx.nodeId ? `agent:${ctx.runId}:${ctx.nodeId}` : `agent:${ctx.runId}`
    });
    ctx.store?.appendLog?.(ctx.runId, {
      event: 'task_enqueued',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      task: task.id,
      title: task.title
    });
    return { id: task.id, title: task.title, status: task.status };
  }
};
