// search_references: find how someone else already solved this (LOOP-PLAN §16).
//
// The reference library is a set of read-only clones of repositories that
// solved problems this harness keeps hitting — a headless server/client split,
// a self-improvement loop, long-running sessions. Citing them in a document is
// nearly worthless because nobody opens it; making them greppable at task time
// is leverage.
//
// This is the entry point, and search rather than read is deliberate: "how did
// opencode handle X" is a question about a place you do not know yet. The
// results carry file and line, so the next step is `read_file` on a specific
// spot rather than on a whole repository.
export default {
  name: 'search_references',
  title: 'Search the reference library',
  description: [
    'Search read-only clones of reference repositories for a pattern (a regular expression).',
    'Use this when you are about to design something non-trivial that another project has',
    'already solved — an event stream, a scheduler, a plugin protocol, a retry policy.',
    'Results give `reference:<repo>/<path>` and a line number; read that path with read_file',
    'to see the surrounding code. These repositories are READ-ONLY: you cannot edit them, and',
    'nothing you read there is part of this project until you write it yourself.'
  ].join(' '),
  effects: ['read'],
  scope: 'workspace',
  risk: 'safe',
  keywords: ['reference', 'search', 'grep', 'example', 'prior art', 'how did', 'opencode'],
  examples: [
    'search the references for how a session event stream is fanned out to clients',
    'find prior art for pinning a supervisor to a known-good revision'
  ],
  parameters: {
    type: 'object',
    required: ['pattern'],
    additionalProperties: false,
    properties: {
      pattern: {
        type: 'string',
        description: 'A JavaScript regular expression, e.g. "createServer|serve\\\\(" — case-insensitive by default.'
      },
      repo: {
        type: 'string',
        description: 'Limit to one reference repository by name. When this run was given a subject repository, that is the default — pass "*" to deliberately search every reference instead.'
      },
      context: {
        type: 'integer', minimum: 0, maximum: 20,
        description: 'Lines of surrounding context to include per hit (default 0).'
      },
      maxResults: { type: 'integer', minimum: 1, maximum: 100, description: 'Cap on hits (default 40).' },
      maxPerFile: {
        type: 'integer', minimum: 1, maximum: 20,
        description: 'Cap on hits from any one file (default 3), so a noisy file cannot hide the one that answers the question.'
      }
    }
  },
  run(args, ctx) {
    if (!ctx?.references) {
      throw new Error('No reference library is available in this run.');
    }
    const catalog = ctx.references.catalog();
    const cloned = catalog.filter(r => r.cloned);
    if (!cloned.length) {
      // An empty library is a setup problem, and saying so beats returning zero
      // hits — which a model reads as "there is no prior art" and moves on.
      throw new Error(
        `The reference library is empty (${catalog.map(r => r.name).join(', ') || 'nothing configured'}). `
        + 'Run `flyt ref update` to clone it, or proceed without prior art.');
    }
    // The library is shared and pinned, so an unscoped search over it is a
    // search of OTHER people's repositories too (HOME-CONTEXT §0.2): a lane
    // reading repo X matches a line in `opencode`, reads it, and cites it as a
    // finding about X. When this run was handed a subject, that is the default
    // scope; "*" is how you opt out, deliberately and visibly.
    const asked = typeof args.repo === 'string' ? args.repo.trim() : '';
    const scoped = asked === '*' ? null : (asked || ctx.subject?.repo || null);
    const defaulted = !asked && Boolean(scoped);
    const out = ctx.references.search(args.pattern, {
      repo: scoped,
      maxResults: args.maxResults ?? 40,
      maxPerFile: args.maxPerFile ?? 3,
      contextLines: args.context ?? 0
    });
    ctx.store?.appendLog?.(ctx.runId, {
      event: 'reference_search',
      node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
      pattern: args.pattern,
      repo: scoped,
      ...(defaulted ? { scopedToSubject: true } : {}),
      hits: out.results.length
    });
    // Asking for a DIFFERENT repository by name overrides the subject silently,
    // and the whole point of the default scope is that a finding about the
    // wrong repository must not be one plausible tool call away. Not blocked —
    // comparing two references is legitimate — but never invisible, and the
    // model is told which repository it is actually standing in.
    const elsewhere = ctx.subject?.repo && scoped && scoped !== ctx.subject.repo;
    if (elsewhere) {
      ctx.store?.appendLog?.(ctx.runId, {
        event: 'tool_target_unexpected',
        node: ctx.nodeId ?? (ctx.taskId ? `executor:${ctx.taskId}` : null),
        tool: 'search_references', repo: scoped, expected: ctx.subject.repo
      });
    }
    return {
      pattern: args.pattern,
      ...(scoped ? { scopedTo: scoped } : {}),
      ...(defaulted ? { note: `Scoped to the subject repository "${scoped}". Pass repo: "*" to search every reference instead.` } : {}),
      ...(elsewhere ? { note: `This is "${scoped}", NOT the repository you were asked to read ("${ctx.subject.repo}"). Anything you find here is about a different codebase.` } : {}),
      searched: scoped ? [scoped] : cloned.map(r => r.name),
      hits: out.results.length,
      truncated: out.truncated,
      results: out.results,
      // Repeating what is available costs a line and saves a model from
      // concluding the library is empty when its pattern simply missed.
      available: catalog.map(r => `${r.name}: ${r.about ?? ''}`.trim())
    };
  }
};
