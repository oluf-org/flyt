// What Work shows about a run in flight (t-0077).
//
// Work is everything happening, and it stays calm: which block is live, what it
// is producing, how far the run has got. What it cost, which model answered and
// what it was asked belong one click away, in Trace.
//
// Derived from the same folded trace Trace renders, so a run watched in Work
// and the same run watched in Trace cannot disagree — there is one source, and
// a second read of the log would be a second answer.

/** A block's state, as the log tells it. */
export const BLOCK_STATES = ['pending', 'active', 'done', 'failed'];

/**
 * Which blocks a run has touched, and how they ended.
 *
 * From `block.status` and `block.output`, which the fold keeps in `others`
 * because they are the RUN's lifecycle rather than a turn's. Trace nests turns;
 * Work draws the stack. Same events, two questions.
 *
 * @param trace — a folded trace from src/traceModel.js.
 * @returns `{ [blockId]: { status, output, at } }`, latest status per block.
 */
export function blockStates(trace) {
  const states = {};
  for (const event of trace?.others ?? []) {
    const data = event?.data ?? {};
    const blockId = typeof data.blockId === 'string' ? data.blockId : null;
    if (!blockId) continue;
    const at = states[blockId] ?? { status: 'pending', output: null, at: null };
    if (event.type === 'block.status' && BLOCK_STATES.includes(data.status)) {
      at.status = data.status;
      at.at = event.at ?? at.at;
      if (data.error) at.error = String(data.error);
    }
    if (event.type === 'block.output') at.output = String(data.content ?? '');
    states[blockId] = at;
  }
  return states;
}

/**
 * What a block is producing RIGHT NOW, from the turn that is open on it.
 *
 * A finished block has its output; a live one has only what the model has said
 * so far, and that is the thing a person watching wants on screen. Reading it
 * from the trace rather than from a second stream is what keeps Work and Trace
 * from disagreeing about a run they are both watching.
 */
export function liveOutput(trace, blockId) {
  for (let t = (trace?.turns?.length ?? 0) - 1; t >= 0; t--) {
    const turn = trace.turns[t];
    for (let s = turn.steps.length - 1; s >= 0; s--) {
      const step = turn.steps[s];
      if (step.blockId !== blockId) continue;
      if (step.request?.content) return step.request.content;
    }
  }
  return null;
}

/** The run's own stage, from the log rather than from a caller's memory. */
export function runStage(trace) {
  let stage = null;
  let error = null;
  for (const event of trace?.others ?? []) {
    if (event?.type === 'run.stage' && typeof event.data?.stage === 'string') stage = event.data.stage;
    if (event?.type === 'run.error' && event.data?.error) error = String(event.data.error);
  }
  return { stage, error };
}

/**
 * The whole of what Work draws over the stack.
 *
 * @param trace — the folded trace.
 * @returns per-block state with the live text folded in, plus the run's stage.
 */
export function runView(trace) {
  const states = blockStates(trace);
  const { stage, error } = runStage(trace);
  const blocks = {};
  for (const [blockId, at] of Object.entries(states)) {
    blocks[blockId] = {
      ...at,
      // An active block shows what it is saying; a finished one shows what it
      // produced. Never both, and never the streaming text after the
      // deliverable exists — that would replace an answer with a draft of it.
      showing: at.status === 'active' ? (liveOutput(trace, blockId) ?? '') : (at.output ?? ''),
    };
  }
  const active = Object.entries(blocks).filter(([, b]) => b.status === 'active').map(([id]) => id);
  return {
    blocks,
    // Plural on purpose: a parallel has several, and rendering "the" active
    // block would make lanes running together look like one running alone.
    active,
    stage,
    error,
    running: stage === 'execution' || stage === 'resumed' || active.length > 0,
  };
}
