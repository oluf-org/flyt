// ask_human: stop and ask the person running the flow (TOOLS-PLAN §14.5).
//
// Reuses the gate that already exists rather than inventing one: the run parks
// at `awaiting_input` exactly as a refine node's questions do, the user answers
// in the composer, and the agent continues with the answer in context. One
// gate, three uses — the refiner, this, and (later) an MCP server's
// elicitation.
//
// Two bounds, both deliberate:
//   * A CAP PER TASK, mirroring the refiner's one-round cap. An agent that can
//     interrogate indefinitely will, and a wall of questions is how
//     human-in-the-loop actually fails. Exhaustion returns a truthful "no more
//     questions available", not an error.
//   * ANSWERS ARE FILES. Every answer is written to runs/<id>/answers/<task>.json,
//     so asking the same question twice costs nothing and — the restart story —
//     a task re-run after the app died recalls what it was already told
//     instead of asking again. The call stack does not survive a crash; the
//     answer does.
const MAX_QUESTIONS_PER_TASK = 3;

export default {
  name: 'ask_human',
  title: 'Ask the person running this flow',
  description: 'Ask the user a question and wait for their answer. Use it when a decision is genuinely theirs — an ambiguous requirement, a missing credential, which of two approaches they want — not for anything you can determine yourself. The run pauses until they reply. Bounded: at most 3 questions per task.',
  effects: ['read'],
  scope: 'run',
  risk: 'safe',
  // Never unattended: the whole point is a human in the loop, and a script
  // that could "ask" inside code mode with nobody watching would deadlock.
  autoExecute: false,
  keywords: ['ask', 'human', 'user', 'question', 'clarify', 'decide', 'confirm'],
  examples: ['ask which database they want to use', 'confirm the breaking change is intended'],
  result: { preview: 'json', maxPreviewChars: 2000, artifact: true },
  parameters: {
    type: 'object',
    required: ['question'],
    additionalProperties: false,
    properties: {
      question: { type: 'string', description: 'One clear question, in plain language. Ask about the decision, not about your implementation.' },
      context: { type: 'string', description: 'Optional one or two lines of background so the question makes sense on its own.' },
      options: {
        type: 'array', items: { type: 'string' },
        description: 'Optional concrete choices. Offering options usually gets a faster, clearer answer than an open question.'
      }
    }
  },
  async run(args, ctx) {
    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('question is required.');
    if (!ctx?.askHuman || !ctx.store || !ctx.runId) {
      throw new Error('ask_human is only available inside a run that can reach the user.');
    }

    // Already answered — including in a previous life of this process.
    const prior = ctx.store.readAskAnswers?.(ctx.runId, ctx.taskId) ?? [];
    const recalled = prior.find(a => a.question === question);
    if (recalled) {
      return { question, answer: recalled.answer, recalled: true, asked: prior.length };
    }
    if (prior.length >= MAX_QUESTIONS_PER_TASK) {
      return {
        question,
        answer: `No more questions available for this task (${MAX_QUESTIONS_PER_TASK} already asked). Proceed on your stated assumptions and say what you assumed.`,
        exhausted: true,
        asked: prior.length
      };
    }

    const answer = await ctx.askHuman({
      question,
      ...(args.context ? { context: String(args.context) } : {}),
      ...(args.options?.length ? { options: args.options.map(String) } : {})
    });
    // A cancelled run settles the gate with null: say so rather than inventing
    // an answer the user never gave.
    if (answer == null) throw new Error('The run was stopped while waiting for an answer.');

    const text = String(answer).trim() || '(no answer given — proceed on your stated assumptions)';
    ctx.store.writeAskAnswer?.(ctx.runId, ctx.taskId, { question, answer: text });
    return { question, answer: text, asked: prior.length + 1, remaining: MAX_QUESTIONS_PER_TASK - prior.length - 1 };
  }
};

export { MAX_QUESTIONS_PER_TASK };
