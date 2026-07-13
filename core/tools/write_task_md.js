// write_task_md: writes/updates the structured spec markdown for the task the
// agent is currently executing (runs/<runId>/tasks/<taskId>.spec.md).
export default {
  name: 'write_task_md',
  description: 'Write or update the structured spec markdown for the CURRENT task (saved as tasks/<taskId>.spec.md). Use it to record your plan, interface decisions, or acceptance criteria before producing the deliverable.',
  parameters: {
    type: 'object',
    required: ['content'],
    additionalProperties: false,
    properties: {
      content: { type: 'string', description: 'Full markdown content of the task spec.' }
    }
  },
  run(args, ctx) {
    if (!ctx.taskId) throw new Error('write_task_md is only available while executing a task');
    const written = ctx.store.writeTaskSpec(ctx.runId, ctx.taskId, args.content);
    return { written };
  }
};
