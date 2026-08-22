// enqueue_task: work an agent noticed but should not do right now.
//
// The distinction from `create_task` is the whole point, and the description
// below has to teach it to a model that has both: `create_task` adds work to
// THIS run, executed by this pipeline, in this context, now. `enqueue_task`
// adds work to the PROJECT'S BACKLOG (DESIGN-SPEC.md §8), for a future run with its
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
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of project skills (.flyt/skills/<name>.md) the worker will need — the conventions this particular job has to follow. Instructions only; naming a skill never grants a tool.'
      },
      propose: {
        type: 'boolean',
        description: 'Propose the task WITHOUT writing it (default false). The id is reserved and the would-be task is returned, but nothing is queued — the caller (a chat) presents it to a human, who commits it with task:add. Loop workers must leave this false: an unattended agent has nobody to confirm with, so it writes directly.'
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
    // (DESIGN-SPEC.md §8). A throw fails the call and lands in the retrospective.
    if (!ctx?.backlog) {
      throw new Error('No backlog is bound to this run, so there is nowhere to queue work. Use create_task for work that belongs to this run.');
    }
    const spec = {
      title: args.title,
      goal: args.goal,
      doneWhen: args.doneWhen ?? [],
      value: args.value,
      effort: args.effort,
      dependsOn: args.dependsOn ?? [],
      blastRadius: args.blastRadius ?? [],
      // What the worker will need to KNOW, as distinct from what it may do.
      // Resolved from the bound project at run time (core/skills.js), so a task
      // written today still finds the convention the project keeps tomorrow.
      skills: args.skills ?? []
    };
    // PROPOSE mode: build the task it WOULD write and hand it back, unwritten.
    // The chat drawer needs "the model proposes; the human commits" — the card
    // appears with Queue it / Discard BEFORE anything exists on disk, because a
    // card that can only say "queued" is a confirmation of a decision the model
    // already made, not a decision the human is being offered. The id is
    // RESERVED so the proposal can name it and Queue it can claim exactly it;
    // reserveId spends the counter only, so nothing here touches .flyt/backlog/.
    //
    // Nothing about the throw above softens in this mode: a proposal is not a
    // write, so a call with no backlog bound still has nowhere to queue work
    // and fails the call the same way. The proposed body is exactly the input
    // task:add takes, so pressing Queue it is the human making the same call
    // the model would have made directly — with `id` added, so the task lands
    // on the id the proposal showed.
    // The mode has two sources: the CALL (args.propose) and the BINDING
    // (ctx.proposeTasks). A chat turn cannot change what the model will write,
    // so whoever binds a chat sets the flag on the tool ctx and every call in
    // that run proposes; a loop's workers never set it, so their calls stay
    // writes exactly as tests/backlog.test.js asserts.
    if (args.propose === true || ctx?.proposeTasks === true) {
      const id = ctx.backlog.reserveId();
      const createdBy = ctx.nodeId ? `agent:${ctx.runId}:${ctx.nodeId}` : `agent:${ctx.runId}`;
      return { id, title: spec.title, status: 'proposed', proposed: true, task: { id, ...spec, createdBy } };
    }
    const task = ctx.backlog.add({
      title: args.title,
      goal: args.goal,
      doneWhen: args.doneWhen ?? [],
      value: args.value,
      effort: args.effort,
      dependsOn: args.dependsOn ?? [],
      blastRadius: args.blastRadius ?? [],
      // What the worker will need to KNOW, as distinct from what it may do.
      // Resolved from the bound project at run time (core/skills.js), so a task
      // written today still finds the convention the project keeps tomorrow.
      skills: args.skills ?? [],
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
