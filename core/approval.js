// What an approval mode decides — one table, and five named questions (D—/§5).
//
// `approvalMode: 'always'` was read in five places in core/stackRunner.js and
// settled five unrelated things: whether the run edits the project's context
// file, whether tool calls are gated at all, whether the gate screens them
// first, whether a node's pre-gate parks, and whether an interrogation asks or
// assumes. That overloading is not a tidiness complaint — it is the direct
// cause of t-0083. Three readers of one flag, two honouring the documented
// contract and one not, and nothing noticed the third for months because there
// was nothing to notice it WITH: no name for the concept, no single place it
// was decided, and no test that all the readers agreed.
//
// t-0084 then walked into it from the other side, where the obvious
// implementation silently undoes t-0083.
//
// So the decisions get names. "Nobody is here to approve a gate", "nobody is
// here to answer a question" and "do not touch the project outside the
// worktree" are three different facts that happen to be true together for the
// loop and are not true together for a person at a terminal — which is exactly
// what `flyt run --approval always` is.
//
// The table is the point, and reading down the `always` column is the argument
// for having written it: one word, four departures from every other mode.

export const APPROVAL_MODES = ['ask', 'smart', 'always', 'node'];

/** Unknown is 'ask', absent is 'node' — the shipped default before this existed. */
export const normalizeApprovalMode = m =>
  (m == null ? 'node' : APPROVAL_MODES.includes(m) ? m : 'ask');

/**
 * How tool calls are gated. Three answers, not two: `node` defers to each
 * node's own `approveToolCalls`, which is neither "all" nor "none" and is why
 * this axis cannot be a boolean.
 */
export const TOOL_GATING = ['none', 'every', 'per-node'];

/**
 * The whole of it. Every cell is the behaviour that shipped before this file
 * existed; this is a refactor, and the test for it is that nothing moved.
 */
export const APPROVAL_POLICY = {
  ask: {
    editsProject: true, toolGating: 'every', screensToolCalls: false,
    skipsNodePreGate: false, assumesItsOwnAnswers: false
  },
  smart: {
    editsProject: true, toolGating: 'every', screensToolCalls: true,
    skipsNodePreGate: false, assumesItsOwnAnswers: false
  },
  node: {
    editsProject: true, toolGating: 'per-node', screensToolCalls: false,
    skipsNodePreGate: false, assumesItsOwnAnswers: false
  },
  always: {
    editsProject: false, toolGating: 'none', screensToolCalls: false,
    skipsNodePreGate: true, assumesItsOwnAnswers: true
  }
};

/**
 * The closed list of decisions this flag drives.
 *
 * Closed on purpose: a sixth reader cannot silently disagree with the other
 * five, because there is nothing for it to read that is not named here, and the
 * test enumerates this list against every mode. Adding a decision means adding
 * a name and a column, which is a change somebody makes deliberately.
 */
export const APPROVAL_DECISIONS = [
  'editsProject', 'toolGating', 'screensToolCalls', 'skipsNodePreGate', 'assumesItsOwnAnswers'
];

const decide = name => mode => APPROVAL_POLICY[normalizeApprovalMode(mode)][name];

/** May this run write to the project outside its worktree (the context file)? */
export const editsProject = decide('editsProject');

/** How tool calls are gated: 'none' | 'every' | 'per-node'. */
export const toolGating = decide('toolGating');

/** Does the gate screen a call before pausing, and let safe ones through? */
export const screensToolCalls = decide('screensToolCalls');

/** Does a node's `requiresApproval` pre-gate pass without a person (t-0083)? */
export const skipsNodePreGate = decide('skipsNodePreGate');

/**
 * Is there nobody to answer a question, so the run states an assumption?
 *
 * The FALLBACK only. Whether somebody is there to answer is a property of how
 * the run was STARTED — `flyt run` parks on waitForRun and replies through
 * `run:answerInput` — and a run that said so explicitly overrides this (t-0084).
 * Reading the mode is what to do when nobody said.
 */
export const assumesItsOwnAnswers = decide('assumesItsOwnAnswers');
