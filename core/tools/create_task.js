// create_task: lets an agent spawn follow-up work. Appends a task to the
// run's tasks.json using the exact schema router.js/executor.js already use,
// so the pipeline's execution loop picks it up like any routed task.
export default {
  name: 'create_task',
  description: 'Create a new task in this run\'s task queue. It will be executed after the current task, by the given worker or the default executor.',
  parameters: {
    type: 'object',
    required: ['title', 'goal'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Short human-readable task title.' },
      goal: { type: 'string', description: 'What the task must produce, fully self-describing.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Hard requirements the task must respect.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Prerequisite task ids (e.g. ["task-1"]). Their outputs become inputs.' },
      worker: {
        type: 'object',
        required: ['provider', 'model'],
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: 'Provider name, e.g. "openrouter" or "mock".' },
          model: { type: 'string', description: 'Model id for that provider.' }
        },
        description: 'Worker to run the task; omit to use the default executor worker.'
      }
    }
  },
  run(args, ctx) {
    const doc = ctx.store.readTasks(ctx.runId) ?? { tasks: [] };
    // Next free task-N id (ids are not guaranteed dense once agents spawn work).
    const maxN = doc.tasks.reduce((m, t) => Math.max(m, Number((t.id.match(/^task-(\d+)$/) ?? [])[1] ?? 0)), 0);
    const id = `task-${maxN + 1}`;
    const known = new Set(doc.tasks.map(t => t.id));
    const dependsOn = (args.dependsOn ?? []).filter(d => known.has(d));
    // A spawned task inherits its parent's tool-approval gate. Without this an
    // agent under approveToolCalls could delegate its destructive work to a
    // child task and have it run unapproved — the child has no flow node, which
    // is where the gate used to be read from.
    const parent = doc.tasks.find(t => t.id === ctx.taskId);
    const task = {
      id,
      title: args.title,
      goal: args.goal,
      inputs: ['prompt.md', ...dependsOn.map(d => `${d} output`)],
      constraints: args.constraints ?? [],
      dependsOn,
      ...(parent?.approveToolCalls ? { approveToolCalls: true } : {}),
      // Never persist an apiKey into tasks.json — provider/model only.
      worker: args.worker?.provider && args.worker?.model
        ? { provider: args.worker.provider, model: args.worker.model }
        : ctx.defaultWorker,
      status: 'pending',
      createdBy: ctx.taskId ?? 'agent'
    };
    doc.tasks.push(task);
    ctx.store.writeTasks(ctx.runId, doc);
    return { created: id, title: task.title, worker: task.worker };
  }
};
