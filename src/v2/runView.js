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
export const BLOCK_STATES = ['pending', 'active', 'done', 'failed', 'waiting', 'approval', 'input', 'skipped'];
const TERMINAL_STAGES = new Set(['done', 'failed', 'stopped', 'interrupted', 'cancelled', 'rejected']);
const ACTIVE_STAGES = new Set(['execution', 'resumed', 'pausing', 'paused', 'stopping']);

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
      if (['done', 'failed', 'skipped'].includes(data.status) && at.warningTransient) {
        delete at.warning;
        delete at.warningTransient;
      }
    }
    if (event.type === 'block.warning') {
      at.warning = String(data.reason ?? data.content ?? 'This block degraded.');
      at.warningTransient = data.transient === true;
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
  let errorBlockId = null;
  let reason = null;
  for (const event of trace?.others ?? []) {
    if (event?.type === 'run.stage' && typeof event.data?.stage === 'string') {
      stage = event.data.stage;
      reason = event.data?.reason ? String(event.data.reason) : null;
      if (stage === 'execution' || stage === 'resumed' || stage === 'done') {
        error = null;
        errorBlockId = null;
      }
    }
    if (event?.type === 'run.error' && event.data?.error) {
      error = String(event.data.error);
      errorBlockId = typeof event.data.blockId === 'string' ? event.data.blockId : null;
    }
  }
  return { stage, error, errorBlockId, reason };
}

/**
 * The whole of what Work draws over the stack.
 *
 * @param trace — the folded trace.
 * @returns per-block state with the live text folded in, plus the run's stage.
 */
export function runView(trace) {
  const states = blockStates(trace);
  const { stage, error, errorBlockId, reason } = runStage(trace);
  // A terminal run cannot have live blocks, even if the process died or the
  // scheduler failed between the active and terminal block events. Preserve
  // the raw trace for inspection; make the operational view truthful.
  if (TERMINAL_STAGES.has(stage)) {
    for (const block of Object.values(states)) {
      if (block.status === 'active') block.status = stage === 'failed' ? 'failed' : 'pending';
    }
  }
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
    errorBlockId,
    reason,
    warnings: Object.entries(blocks).filter(([, block]) => block.warning).map(([blockId, block]) => ({ blockId, message: block.warning })),
    running: ACTIVE_STAGES.has(stage) && !['paused', 'interrupted'].includes(stage),
    pausing: stage === 'pausing',
    paused: stage === 'paused',
    stopping: stage === 'stopping',
    resumable: stage === 'paused' || stage === 'stopped' || stage === 'interrupted',
  };
}
