// ask_human: park the task with a QUESTION instead of a failure.
//
// This closes the worst loop in the system. Today an agent that hits a genuine
// ambiguity — two reasonable designs, a missing decision, a constraint the task
// file does not name — has three moves, and all of them are bad: guess and
// probably be wrong, burn the whole attempt ladder re-rolling the same
// ambiguity at increasing expense, or park with a stack trace that tells the
// person nothing they can answer.
//
// A question is none of those. It costs one call, it stops the spend
// immediately, and what lands in the pile a person reads at breakfast is a
// sentence they can reply to in ten seconds. The reply goes into the task body
// and the task requeues, so the next attempt starts with the answer that the
// last three attempts were guessing at.
//
// The marker is `Q:` on the front of `blockedReason` — the board reads that
// prefix and renders an answer box instead of an error. A prefix rather than a
// new field because every reader of a parked task already prints
// `blockedReason`, so an older reader shows the question rather than nothing.
export const QUESTION_PREFIX = 'Q:';

export default {
  name: 'ask_human',
  title: 'Ask a human',
  description: [
    'Stop and ask the person who owns this project a question, instead of guessing or failing.',
    'Use it when the task is genuinely ambiguous — two defensible designs, a decision nobody has',
    'made, a constraint the task does not state — and no amount of reading the repository would',
    'settle it. Do NOT use it for something you could find out by reading a file or running a gate.',
    'The task is parked with your question and will come back to you with the answer.',
    'This ENDS your work on this task: say everything you need in the question.'
  ].join(' '),
  effects: ['write'],
  scope: 'workspace',
  risk: 'caution',
  keywords: ['ask', 'question', 'human', 'clarify', 'ambiguous', 'decision'],
  examples: [
    'the plan does not say whether the drawer should remember its height per project or globally',
    'there are two existing patterns for this and the task does not say which to follow'
  ],
  parameters: {
    type: 'object',
    required: ['question'],
    additionalProperties: false,
    properties: {
      question: {
        type: 'string',
        description: 'The question, in one or two sentences, answerable without reading this run. State what you would do by default if nobody answers.'
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'The candidate answers you are choosing between, if it is a choice. Makes the reply a click rather than an essay.'
      },
      context: {
        type: 'string',
        description: 'What you already established — what you read, what you ruled out — so the reply does not repeat your work.'
      }
    }
  },
  run(args, ctx) {
    if (!ctx?.backlog) {
      throw new Error('This run is not working a backlog task, so there is nobody to ask. State the ambiguity in your output instead.');
    }
    const taskId = ctx.store?.readMeta?.(ctx.runId)?.loopTaskId ?? null;
    if (!taskId) {
      throw new Error('This run is not working a backlog task, so there is nobody to ask. State the ambiguity in your output instead.');
    }

    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('The question is empty.');
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [];
    const context = String(args.context ?? '').trim();

    const blockedReason = [
      `${QUESTION_PREFIX} ${question}`,
      options.length ? `Options: ${options.map((o, i) => `(${i + 1}) ${o}`).join('  ')}` : '',
      context ? `Already established: ${context}` : ''
    ].filter(Boolean).join('\n');

    ctx.backlog.update(taskId, { status: 'parked', blockedReason });
    if (!ctx.canonicalSession) ctx.store?.appendLog?.(ctx.runId, {
      event: 'question_asked',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      task: taskId, question
    });

    // A terminal result, said in the imperative, because the next thing the
    // model does is decide whether to keep going. "Parked" reads as a status
    // update; "stop now" reads as an instruction, and this has to read as an
    // instruction — an agent that asks a question and then guesses anyway has
    // spent the call and kept the bug.
    return {
      asked: true,
      task: taskId,
      question,
      ...(options.length ? { options } : {}),
      terminal: true,
      instruction: 'The task is parked with your question. STOP HERE — do not continue working on it and do not guess. Write a one-line summary of what you asked and end your turn.'
    };
  }
};
