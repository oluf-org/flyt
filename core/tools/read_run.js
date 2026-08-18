// read_run: look at a run that already happened.
//
// This is what makes a RETRY smarter than the attempt before it. A task that
// failed carries one string — `blockedReason` — and the run that produced it is
// sitting on disk with its plan, its node outputs, its retrospectives and its
// tool calls. Without this tool the second attempt starts from the same brief
// as the first and re-derives the same wrong turn; with it, the second attempt
// starts by reading what the first one actually did.
//
// `what` is a deliberate menu rather than a dump: a whole snapshot of a
// forty-node run is tens of thousands of tokens, and the question is almost
// always one of four.
export default {
  name: 'read_run',
  title: 'Read a past run',
  description: [
    'Look at a run that already happened: its shape and outcome (summary), what its nodes and',
    'tasks produced (output), its event log including every tool call (log), or the code changes',
    "it left in its worktree (diff). Use it on a task's earlier runIds before retrying that task —",
    'the previous attempt is the cheapest information you will ever get about this problem.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  autoExecute: true,
  keywords: ['run', 'history', 'retry', 'previous', 'attempt', 'log', 'diff'],
  examples: ['read the run that failed on this task', 'what did the last attempt actually change'],
  parameters: {
    type: 'object',
    required: ['runId'],
    additionalProperties: false,
    properties: {
      runId: { type: 'string', description: 'The run id, e.g. from a task\'s runIds.' },
      what: {
        type: 'string',
        enum: ['summary', 'output', 'log', 'diff'],
        description: 'summary (shape + outcome, default), output (what nodes and tasks produced), log (events and tool calls), diff (files the run changed).'
      },
      taskId: {
        type: 'string',
        description: 'For what: "diff" — the backlog task whose worktree to diff. Defaults to the task this run belongs to.'
      }
    }
  },
  async run(args, ctx) {
    const store = ctx?.store;
    if (!store) throw new Error('No run store is available here.');
    const runId = String(args.runId ?? '').trim();
    const what = args.what ?? 'summary';

    if (what === 'diff') return await diffOf(args, ctx, runId);

    let snapshot;
    try { snapshot = store.snapshot(runId); }
    catch (err) { throw new Error(`Could not read run "${runId}": ${String(err?.message ?? err)}`); }
    if (!snapshot?.meta) throw new Error(`No run "${runId}" in this project.`);

    if (what === 'log') {
      const entries = store.readLog(runId) ?? [];
      // The tail: a run's log is its whole life and the interesting part is
      // always the end. Tool calls are pulled out separately because "what did
      // it actually try" is the question, and it is otherwise buried.
      const tail = entries.slice(-200);
      return {
        runId,
        events: tail.length,
        ...(entries.length > tail.length ? { earlierOmitted: entries.length - tail.length } : {}),
        toolCalls: entries.filter(e => e.event === 'tool_call')
          .slice(-60)
          .map(e => ({ tool: e.tool, node: e.node ?? null, ok: e.ok, ms: e.ms, ...(e.error ? { error: e.error } : {}) })),
        log: tail
      };
    }

    if (what === 'output') {
      return {
        runId,
        prompt: snapshot.prompt ?? null,
        nodeOutputs: snapshot.nodeOutputs ?? {},
        taskOutputs: snapshot.taskOutputs ?? {}
      };
    }

    // summary: the shape and the verdict, not the transcript.
    const tasks = snapshot.tasks?.tasks ?? [];
    const retros = snapshot.retrospectives ?? {};
    return {
      runId,
      stage: snapshot.meta.stage ?? null,
      status: snapshot.meta.status ?? null,
      flow: snapshot.meta.flowId ?? null,
      startedAt: snapshot.meta.createdAt ?? null,
      loopTaskId: snapshot.meta.loopTaskId ?? null,
      prompt: clip(snapshot.prompt, 2000),
      nodes: Object.entries(snapshot.meta.nodeStatus ?? {}).map(([id, status]) => ({ id, status })),
      tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      // The retrospectives are the run's own account of what went wrong, which
      // is exactly what a retry needs and exactly what nobody reads.
      retrospectives: Object.entries(retros).map(([name, r]) => ({
        node: name,
        status: r.status ?? null,
        summary: clip(r.summary ?? r.recommendation ?? null, 600)
      }))
    };
  }
};

async function diffOf(args, ctx, runId) {
  const taskId = String(
    args.taskId ?? ctx?.store?.readMeta?.(runId)?.loopTaskId ?? ''
  ).trim();
  if (!taskId) {
    throw new Error('That run is not attached to a backlog task, so there is no worktree to diff. Pass taskId, or use bash with git diff in this workspace.');
  }
  if (!ctx?.pool?.diff) {
    throw new Error('No worktree pool is available in this run, so a diff cannot be read here. Use bash with `git diff` in the workspace instead.');
  }
  const diff = await ctx.pool.diff(taskId, { base: 'HEAD' });
  return { runId, taskId, ...diff };
}

function clip(text, max) {
  const s = String(text ?? '');
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max)}\n…[${s.length - max} characters omitted]…`;
}
