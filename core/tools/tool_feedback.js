// tool_feedback: the judgment half of a retrospective (LOOP-PLAN §12).
//
// The mechanical half — which tools ran, how often, how many failed — is
// derived from the run's own log and costs nothing. What it cannot know is the
// part only the agent holds: that `bash` needed three calls where one should
// have done, that `read_file` returned 400 lines when 20 were wanted, or that
// what was actually needed was `grep` and six shell calls went into faking it.
//
// A run where that happens still SUCCEEDS. It succeeds slowly, expensively and
// invisibly, and nothing in the system ever learns. This tool is where it gets
// written down.
//
// It is deliberately cheap to ignore and cheap to use: an agent with nothing to
// say never calls it and pays nothing, and one that does pays a single turn.
// That is why the judgment half is a tool rather than an extra model call per
// node — the loop cannot afford to double its call count to ask every instance
// how it felt.
export default {
  name: 'tool_feedback',
  title: 'Review the tools you used',
  description: [
    'Report on the tools available to you in this task. Call this ONCE, near the end.',
    'Two things, both optional:',
    '(1) `used` — for tools you called: were they good, awkward, or broken, and what',
    'specific change would have made them better (clearer errors, a missing argument,',
    'fewer calls needed).',
    '(2) `missing` — capabilities you did NOT have and wanted. Say what you needed, why,',
    'and how you worked around it. Be concrete: "search file contents by regex across',
    'the repo" is actionable, "better tools" is not.',
    'This is collected and reviewed later; it does not interrupt your task.'
  ].join(' '),
  effects: ['write'],
  scope: 'workspace', // .flyt/feedback/ — outside the run, inside the project
  risk: 'safe',
  // No autoExecute, and it gates under ask/smart like any other out-of-run
  // write. That is not the behaviour I wanted — reporting should be free, and
  // an approval prompt teaches an agent that reporting is expensive — but the
  // gate derives from what a tool DOES, and this does write project state that
  // outlives the run. Bending scope to 'run' to dodge the prompt would be a
  // lie in the one field the safety model reads.
  //
  // Under the loop's `always` mode it costs nothing, which is the case that
  // matters. Making `.flyt/`-confined metadata writes ungatable is a real
  // design question and is filed as Q-L9 rather than decided by a tool that
  // happened to want it.
  keywords: ['feedback', 'retrospective', 'review', 'missing', 'tooling', 'improve'],
  examples: [
    'report that grep was missing and six bash calls were used instead',
    'note that read_file has no line range, so whole files had to be read'
  ],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      used: {
        type: 'array',
        description: 'Your review of tools you actually called in this task.',
        items: {
          type: 'object',
          required: ['tool', 'rating'],
          additionalProperties: false,
          properties: {
            tool: { type: 'string', description: 'The tool name, exactly as you called it.' },
            rating: {
              type: 'string',
              enum: ['good', 'adequate', 'awkward', 'broken'],
              description: 'good = did the job cleanly; adequate = fine; awkward = worked but cost extra calls or context; broken = failed or misled you.'
            },
            note: { type: 'string', description: 'What happened, in one or two sentences.' },
            improvement: { type: 'string', description: 'The specific change that would have helped, e.g. "a line-range argument".' }
          }
        }
      },
      missing: {
        type: 'array',
        description: 'Capabilities you needed and did not have.',
        items: {
          type: 'object',
          required: ['want'],
          additionalProperties: false,
          properties: {
            want: { type: 'string', description: 'The capability, concretely: "search file contents by regex across the repo".' },
            why: { type: 'string', description: 'What you were trying to do when you needed it.' },
            workaround: { type: 'string', description: 'What you did instead, and what it cost.' }
          }
        }
      }
    }
  },
  run(args, ctx) {
    // Same rule as enqueue_task: throw rather than return a failure object, so
    // a call that went nowhere is recorded as a FAILED call and not a
    // successful one carrying bad news (DESIGN-SPEC §11.1).
    if (!ctx?.feedback) {
      throw new Error('No feedback store is bound to this run, so there is nowhere to record this.');
    }
    const used = Array.isArray(args.used) ? args.used : [];
    const missing = Array.isArray(args.missing) ? args.missing : [];
    if (!used.length && !missing.length) {
      throw new Error('Nothing to record: give at least one entry in `used` or `missing`.');
    }
    ctx.feedback.record({
      runId: ctx.runId,
      nodeId: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      task: ctx.taskId ?? null,
      model: ctx.model ?? null,
      review: used,
      missing
    });
    ctx.store?.appendLog?.(ctx.runId, {
      event: 'tool_feedback',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      reviewed: used.map(u => `${u.tool}:${u.rating}`),
      requested: missing.map(m => m.want)
    });
    return {
      recorded: { reviews: used.length, requests: missing.length },
      note: 'Collected for review. Continue with your task.'
    };
  }
};
