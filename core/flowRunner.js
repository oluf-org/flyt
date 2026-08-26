// Graph runner: executes an editable flow definition (core/flowstore.js) the
// same way pipeline.js executes the hardcoded linear sequence — through the
// RunStore, one file per artifact, a retrospective per node, everything in
// log.jsonl. This is the "graph walker over an editable workflow definition"
// extension point.
//
// Semantics per node type:
//   input     -> its text becomes prompt.md / the run brief
//   agentTask -> contributes a task to tasks.json and runs it (plus anything
//                it spawns via create_task) through the EXISTING executor
//   aiStep    -> one callModel() with context assembled from upstream outputs
//   output    -> collects upstream outputs into result.md
//
// Scheduling is a dynamic topological walk: after every wave the runner
// re-derives "which nodes are ready" from the current flow. That is what
// lets a plan-eval node materialize new nodes mid-run (they join the walk),
// and lets step-eval verdicts requeue an upstream node before continuing.
// Independent aiSteps AND agentTasks run concurrently (bounded by
// config.maxParallel, default 4); gates, plan-eval, and tool-gated tasks
// stay sequential. Queued agent tasks are claimed atomically out of
// tasks.json and drained with the same bound (see runPendingTasks).
//
// Reflective-pattern support (see FLOW_NODES.md for the contracts):
//   plan-eval -> strict JSON contract parsed by core/planEval.js; valid nodes
//                are materialized into the run's flow.json with provenance
//   step-eval -> structured verdict: pass | retry (bounded, with enriched
//                retry-for-<node>.md guidance) | escalate (human gate)
//   stitch    -> fixTasks[] routed through the existing create_task tool
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { callModel, abortError, isAbortError } from './adapters/index.js';
import { runAgent, callForAnswer, describeEmptyTurn, toolProtocol, supportsToolsFor } from './agent.js';
import { recordAttempt, settleAttempt } from '../src/attempts.js';
import { plannerLimits, validatePlan, createSpinDetector } from './planContract.js';
import { classifyAdapterError, unparsedToolDialect } from './adapters/failures.js';
import { makeRetrospective } from './retrospective.js';
import { recordToolUsage } from './feedback.js';
import { resolveCallTarget } from './modelSource.js';
import { runExecutorTask } from './nodes/executor.js';
import {
  runContainer, ensureChildStatuses, commitChildren, placeInContainer, placeByLayout
} from './nodes/expand.js';
import {
  resolveLanes, laneBrief, laneInventory, DEFAULT_LANE_TEMPLATE,
  normalizeLane, normalizeLaneWorker, uniqueLaneIds, sharedPreamble, applyPreamble, assignWorkers,
  addressingBlock, renderBrief, LANE_PRESETS, LANE_PRESET_IDS
} from './nodes/fanout.js';
import { spliceAllSubflows, SubflowError } from './nodes/subflow.js';
import { parseBacklogPlan, validateBacklogEvidence, BACKLOG_PLAN_ROLE } from './nodes/backlogPlan.js';
import {
  INPUTS_NODE_ID, validateInputValues, renderInputValue
} from './nodes/runInputs.js';
import {
  WAIT_POLICIES, DEFAULT_POLL_MS, enqueuePlan, tallyTasks, isSettled,
  readLoopState, writeLoopState, renderLoopReport, spendFor
} from './nodes/loopNode.js';
import { Workspace } from './workspace.js';
import { loadSkills, withSkillsSection, listSkills, availableSkillsSection } from './skills.js';
import { createWriteLedger } from './writeLedger.js';
import { executeTool, grantContext, resolveTools, toolLibraryForLint } from './tools/index.js';
import { narrowCeiling } from '../src/toolGrants.js';
import { checkToolCall } from './safetyCheck.js';
import { parsePlanEval, parseStepEvalVerdict, parseStitchDirectives, parseTriage, parseFeedbackReview, parseRefineQuestions, parseLanePlan, parseOrientation, parseInterrogation, stripRefineQuestions, stripJsonBlock, extractJson } from './planEval.js';
import { JUDGE_SYSTEM, buildJudgePrompt, parseJudgeVerdict } from './judge.js';
import { deriveRunName } from './state.js';
import {
  createNodeFromTemplate, getTemplate, resolveFlow, resolveInstance, primaryPort,
  effectiveRole, isFeedbackEdge, forwardEdges, EFFORT_MAX_TOKENS, effortBudget, REASONING_HEADROOM, LEGACY_TEMPLATE_MAP,
  validateOverrideMap, mergeOverrideMaps, questionRoundsFor
} from '../src/flowTypes.js';

// The roles that may park the whole run to ask the person a question, and the
// counter that decides when one has asked enough. `answeredInputs` records one
// entry per completed round (it always appended, never deduplicated), so the
// rounds a node has already had are just how many times its id appears.
export const ASKING_ROLES = ['refine', 'orient', 'interrogate'];
export function countAnsweredRounds(meta, nodeId) {
  return (meta?.answeredInputs ?? []).filter(id => id === nodeId).length;
}
import { pickDefaultWorker, planDefaultRoute, providerModelsFor, taskKindOf, PROVIDER_ORDER } from './modelPriority.js';
import { homeSeed, projectGates } from './homeSeed.js';
import { taskNodeStatus } from '../src/runGraph.js';
import { layoutPositions, containerLayout } from '../src/flowLayout.js';
import { lintFlow, RUNTIME_RULES } from './flowlang/lint.js';

const DEFAULT_SYSTEM = {
  plan: [
    'ROLE: planner',
    'You are the planning step of an AI workflow.',
    'Produce a Markdown plan for the brief. Structure it as:',
    '# Plan\n\nGoal: <one line>\n\n## Steps\n1. <step>\n2. <step> ...',
    'Each step must be small, self-contained, and independently verifiable.',
    'Prefer 3-7 steps. Do not include anything except the plan.'
  ].join('\n'),
  execute: [
    'ROLE: executor',
    'You are an execution step in an AI workflow.',
    'Complete exactly the work described by the brief and upstream context.',
    'Produce the deliverable as Markdown.'
  ].join('\n'),
  verify: [
    'ROLE: verifier',
    'You are the verification step of an AI workflow.',
    'Check the upstream outputs against the brief. Produce a short Markdown',
    'report: a PASS/FAIL verdict line, then bullet points per check.'
  ].join('\n'),
  custom: [
    'ROLE: workflow step',
    'You are one step in an AI workflow. Follow your instructions and the',
    'upstream context. Produce the deliverable as Markdown.'
  ].join('\n'),

  // === Polished prompts for the documented standard example nodes (see FLOW_NODES.md) ===
  'plan-start': [
    'ROLE: plan-start',
    'You are the Start node of an advanced planning flowchart.',
    'Given the user prompt, produce ONLY a structured tasks.md.',
    'Every task must be well-defined and independently verifiable.',
    'CRITICAL: for every task include a "Context files:" section.',
    'Each listed file must include a short description of *exactly* what part is needed.',
    'The goal is to give later steps the smallest possible context.',
    'Also assign a Category from: Code general, Code design, documentation, Test-creation.',
    'Suggest the "work" template for every work task (the category picks its task type).',
    'Format strictly as shown in the example in your instructions.'
  ].join('\n'),
  'plan-eval': [
    'ROLE: plan-eval',
    'You are the Plan Evaluation node. Read the tasks.md from the previous step.',
    'Respond with ONE ```json block satisfying this STRICT contract — invalid output is',
    'rejected and NO nodes are created:',
    '{',
    '  "nodes": [{',
    '    "id": "<unique; letters/digits/_/- only>",',
    '    "template": "work",',
    '    "taskRef": "task-N",',
    '    "category": "<Code general | Code design | documentation | Test-creation>",',
    '    "effort": "<low | medium | high — optional; match the task\'s difficulty>",',
    '    "title": "<short>", "goal": "<fully self-describing>",',
    '    "dependsOn": ["<id or taskRef of a prerequisite generated node>"],',
    '    "contextSpec": { "files": [{ "path": "<file>", "description": "<exactly which part is needed>" }] }',
    '  }],',
    '  "parallelGroups": [["task-1","task-2"],["task-3"]],',
    '  "categories": { "task-1": "Code design" },',
    '  "summary": "<one line>"',
    '}',
    'Every node MUST have id + template. The "work" template covers every task type;',
    'its category selects implementation / design / docs / tests. parallelGroups are',
    'sequential waves used for ordering when dependsOn is omitted. Keep every',
    'contextSpec minimal — that is the point.'
  ].join('\n'),
  'step-eval': [
    'ROLE: step-eval',
    'You evaluate the output of the immediately preceding work node.',
    'Note any changes that would affect downstream work.',
    'End your report with ONE ```json block:',
    '{ "verdict": "pass" | "retry" | "escalate", "reason": "<one line>", "guidance": "<required for retry: what to do differently>" }',
    'Use "retry" when a re-attempt with better guidance would likely fix the problem;',
    'use "escalate" when a human must decide. Anything without a valid block counts as pass.'
  ].join('\n'),
  stitch: [
    'ROLE: stitch',
    'You are the Stitch node. Review all upstream work outputs.',
    'Decide if they fit together coherently.',
    'Make small fixes yourself (describe them).',
    'Produce a stitch-report.',
    'If larger fixes are required, end with ONE ```json block:',
    '{ "fixTasks": [{ "title": "<short>", "goal": "<fully self-describing>", "constraints": [], "dependsOn": [] }] }',
    'Each entry becomes a real executor task run before the flow continues.',
    'Omit the block (or emit "fixTasks": []) when nothing is needed.'
  ].join('\n'),
  combine: [
    'ROLE: combine',
    'You are the Combine node. Merge the upstream outputs (often produced in',
    'parallel) into ONE coherent deliverable.',
    'The inputs are either COMPLEMENTARY PARTS of a larger whole, or ALTERNATIVE',
    'ATTEMPTS at the same task (e.g. the same brief given to different models).',
    'For complementary parts: resolve overlaps, contradictions, and seams; keep',
    'every genuine contribution.',
    'For alternatives: do NOT concatenate or average them. Take the strongest',
    'version of each element so the result keeps the best of every attempt, and',
    'follow the recommendations of any upstream comparison report. Briefly note',
    'which alternative each major element came from.',
    'Make small fixes yourself and describe them.',
    'If larger fixes are required, end with ONE ```json block:',
    '{ "fixTasks": [{ "title": "<short>", "goal": "<fully self-describing>", "constraints": [], "dependsOn": [] }] }',
    'Each entry becomes a real executor task run before the flow continues.',
    'Omit the block (or emit "fixTasks": []) when nothing is needed.'
  ].join('\n'),
  split: [
    'ROLE: split',
    'You are the Split node. Divide the upstream work into independent parts',
    'that can be handled in parallel by downstream nodes.',
    'Produce Markdown with one "## part-N — <short name>" section per part.',
    'Each part must be fully self-describing: state its goal, its inputs, and its',
    'boundaries so no two parts overlap and nothing is left unassigned.',
    'Prefer 2-5 parts. Do not do the work itself — only divide it.'
  ].join('\n'),
  compare: [
    'ROLE: compare',
    'You are the Compare node. The upstream outputs are ALTERNATIVES: the same',
    'task completed independently (e.g. by different models), or competing',
    'drafts/plans/solutions. Do NOT redo the work and do NOT merge — compare.',
    'Produce a structured Markdown report:',
    '# Comparison\n\n## Alternatives\n<one line each: which upstream node, in one sentence what it did>',
    '\n\n## Agreements\n<where they align — likely safe to trust>',
    '\n\n## Differences\n<each substantive difference: what diverges, and which alternative handles it better, with reasoning>',
    '\n\n## Strengths & weaknesses\n<per alternative>',
    '\n\n## Recommendation\n<exactly what to keep from which alternative to build the single best deliverable>',
    'Ground every judgment in the actual outputs (quote or reference). Judge',
    'correctness and fitness for the brief, not style or length. If the',
    'alternatives are equivalent on a point, say so instead of inventing a winner.',
    'A downstream node (or a human at an approval gate) merges based on your',
    'recommendation — make it specific enough to act on without re-reading everything.'
  ].join('\n'),
  analyze: [
    'ROLE: analyze',
    'You are a general text-analysis node. Analyze the brief and upstream context',
    'and produce a structured Markdown report:',
    '# Analysis\n\n## Summary\n<3-5 sentences>\n\n## Structure & key points\n\n## Claims & evidence',
    '\n\n## Gaps, risks & inconsistencies\n\n## Recommendations',
    'Ground every observation in the text (quote or reference the location).',
    'Match the depth to your effort level; never pad. State uncertainty honestly.'
  ].join('\n'),
  'plan-backlog': [
    'ROLE: plan-backlog',
    'You turn analysis into QUEUED WORK. Read the brief and upstream context and',
    'decide what should actually be done about it, as a backlog a supervisor can',
    'pick from without asking you anything.',
    'Write your reasoning in prose first — what you are proposing and why, what',
    'you deliberately left out — then emit exactly ONE fenced ```json block:',
    '[{ "title": "short imperative title", "goal": "what must be true when this',
    'is done", "doneWhen": ["a checkable criterion"], "value": 1-5, "effort": 1-5,',
    '"level": "low|medium|high|xhigh|max", "gates": ["npm test"], "blastRadius":',
    '["src/thing.js"], "skills": ["a skill this project has"],',
    '"dependsOn": ["title of another task in this list"] }]',
    'Rules that matter more than coverage:',
    '- Every task must be claimable ALONE. No "see above", no shared context.',
    '- Every task needs at least one "done when" someone else could check.',
    '- Prefer few real tasks to many plausible ones. A task nobody can verify is',
    '  not a task, and a backlog full of those is worse than an empty one.',
    '- dependsOn names another task by its exact title in this same list.',
    // The task is claimed weeks later by a worker with none of this context.
    // What it may TOUCH is blastRadius; what it must KNOW is skills, and
    // without it every worker rediscovers the same convention by trial and
    // error — expensively, because unattended is exactly where nobody is
    // watching to say "we do it this way here".
    '- skills names expertise the worker will need, from the list below. Attach',
    '  one when the job cannot be done right without it. Never invent a name: a',
    '  skill this project does not have resolves to nothing and says nothing.',
    // D38 P6. These fields describe THIS project, and this node used to hold no
    // tools at all — so every path and every gate command was invented, and the
    // loop was what found out. With a read grant they are checkable claims.
    '- blastRadius names paths in THIS project that you have CONFIRMED exist —',
    '  glob or read them first. A path you did not check does not go in the list.',
    '  For work that creates new files, name the files it will create and say so.',
    '- gates name commands this project actually has (its package.json scripts, or',
    '  the equivalent). Do not write "npm test" into a repository that has no test',
    '  script; leave gates empty rather than naming one that cannot run.',
    '- The tasks are for THIS project, not for whatever was read. A finding about',
    '  another repository only becomes a task once you can say what changes here.',
    // The failure this closes: a task that names the READ repository's files as
    // if they were ours. Whoever claims it later stands in this workspace, and
    // those paths are not here — so it is reported impossible, correctly, and a
    // sound task is thrown away. Nine were, in one sitting.
    '- When a task refers to something in the repository you READ, say so in the',
    '  goal and name it as `reference:<name>/<path>` — never as a bare path, which',
    '  reads as a file in THIS project. Whoever picks the task up will be standing',
    '  here, not there: "port the retry logic from `reference:their-repo/core/run.py`"',
    '  is claimable, "extract the logic from core/run.py" is a task about a file we',
    '  do not have.',
    '- For every referenced file, add an evidence entry to the task JSON:',
    '  { "claim": "the behavior being transferred", "ref": "reference:<name>/<full/path>",',
    '    "line": 42, "excerpt": "short exact text from that line" }.',
    '  The Loop node verifies the repository, path, line, and excerpt before it',
    '  queues anything. A search hit you did not open is not evidence.'
  ].join('\n'),
  translate: [
    'ROLE: translate',
    'You are a translation node. Translate the upstream content into the TARGET',
    'LANGUAGE given in your instructions (default: English).',
    'Preserve meaning, tone, register, names, numbers, code blocks, and Markdown',
    'formatting exactly; translate prose, not identifiers or code.',
    'Output ONLY the translation — no commentary. If a passage is ambiguous, pick',
    'the most faithful reading and add a translator\'s note at the very end.'
  ].join('\n'),
  refine: [
    'ROLE: refine',
    'You are the Prompt Refiner: the first step of a workflow. Rewrite the user\'s',
    'request into a precise, self-contained brief the rest of the flow can execute',
    'without seeing the original. Structure it as Markdown:',
    '# Brief\n\n## Goal\n<one or two sentences>\n\n## Constraints\n<bullets>\n\n'
      + '## Deliverable\n<what to produce>\n\n## Acceptance\n<how we know it is done>',
    'Resolve ordinary ambiguity yourself by stating a reasonable assumption inline',
    '(an "## Assumptions" section) and proceeding — do NOT ask about it.',
    'ONLY when an ambiguity would MATERIALLY change the deliverable (a fork you',
    'cannot responsibly pick for the user) may you ask. If so, end the brief with',
    'exactly ONE ```json block and nothing after it:',
    '{ "questions": [{ "id": "<short-slug>", "text": "<the question>", "why": "<what changes depending on the answer>" }] }',
    'At most 3 questions; fewer is better; usually none. Every question you ask',
    'stalls the run and costs the user a round-trip — ask only when you truly must.'
  ].join('\n'),
  // D46. Everything the refiner's prompt says about restraint is inverted here,
  // deliberately. The refiner is right for a request that is already a request;
  // this node is for an IDEA, where the missing half is the whole job and an
  // assumption quietly taken is the failure. Watched with the refiner on this
  // very feature: it asked nothing, assumed the deliverable was a written
  // interview template, and produced a confident brief for work nobody wanted.
  interrogate: [
    'ROLE: interrogate',
    'You are the Interrogation node. Someone has given you an IDEA, not a',
    'specification. Your job is to interrogate them until it becomes one, over a',
    'small number of rounds, and only then to write it down.',
    'ASK. Do not resolve a real ambiguity by assuming it — that is the failure',
    'this node exists to prevent. A confident specification for work nobody',
    'asked for is worse than an honest question.',
    'But interrogate like a good colleague, not a form:',
    '- Ask what you cannot get any other way. Never ask what the request, the',
    '  context you were given, or an obvious convention already answers.',
    '- READ FIRST. You are standing in a project and you hold read-only tools.',
    '  Anything on disk is not a question: file names, commands, existing',
    '  conventions, what already exists. Check before you ask, and check again',
    '  before you assert — a specification that invents a path or a command name',
    '  reads as authoritative and sends whoever implements it somewhere that does',
    '  not exist. Cite what you actually opened.',
    '- Take the load-bearing forks first: what this is FOR, who or what consumes',
    '  it, what would make it wrong, what is deliberately out of scope. Detail',
    '  follows a settled shape; asked before it, detail is noise.',
    '- Name the candidate answers whenever the question is a choice. A question',
    '  with options is answered in a click; an open one costs a paragraph.',
    '- Say what you would do by default, so silence is still an answer.',
    '- Each round, go deeper on what the last answers opened up. Re-asking one',
    '  question in different words is how an interrogation loses the person.',
    'STOP EARLY when the answers have settled the shape. Rounds are a ceiling,',
    'not a quota, and an unnecessary round is a person deciding this tool is not',
    'worth using.',
    'EVERY TURN, write the specification as it stands right now, in Markdown —',
    'never a bare list of questions, because a person can only judge a question',
    'against what you currently believe. Mark anything unsettled inline as TBD:',
    '# Specification',
    '## Goal — ## Non-goals — ## Constraints — ## Deliverable — ## Acceptance',
    '## Assumptions — what you settled yourself, and on what basis.',
    'Then end with EXACTLY ONE ```json block and nothing after it:',
    '{',
    '  "status": "asking" | "settled",',
    '  "confidence": "low" | "medium" | "high",',
    '  "questions": [{ "id": "<slug>", "text": "<the question>", "why": "<what changes with the answer>", "options": ["<candidate>", "..."] }],',
    '  "assumptions": ["<what you settled without asking, and why that was safe>"],',
    '  "unknowns": ["<what is still unsettled and could not be asked>"]',
    '}',
    '"asking" parks the run and puts your questions in front of the person; at',
    'most 6 per round, and 6 is a lot. "settled" ends the interrogation and hands',
    'the specification downstream — say it as soon as it is true.',
    'On your LAST round you will be told so. Then stop asking, take the remaining',
    'forks yourself, record each one under "assumptions" AND in the spec, and',
    'settle. An interrogation that ends still asking has produced nothing.'
  ].join('\n'),
  // DECISIONS.md D38. The cheapest node in the flow, and the one that aims
  // every expensive node after it: what is THIS project, and what relationship
  // does it have to the thing we are about to read? "What should we learn from
  // this repo" has no answer until you know whether we are empty, building the
  // same thing, or building something unrelated — the same repository read
  // against those three situations should produce three different backlogs.
  orient: [
    'ROLE: orient',
    'You are the first step of a workflow that is about to read SOMETHING ELSE —',
    'usually another repository — on behalf of THIS project. Your job is to say what',
    'this project is, and what relationship it has to that subject. Everything after',
    'you is aimed by your answer; nothing after you can recover from getting it wrong.',
    'You have a seed (assembled facts about this workspace) and read-only tools. The',
    'seed is a starting point, not the answer: go deeper wherever it looks thin or',
    'contradicts itself. Read enough of the SUBJECT to place the two side by side —',
    'you cannot judge a relationship having seen only one end of it.',
    'THE FOUR STANCES, and what each one makes the rest of the flow do:',
    '- empty: this workspace is empty or barely started. The reading is for what is',
    '  worth adopting wholesale, and in what order to build it.',
    '- similar: we are building the same kind of thing. The reading is for where they',
    '  solved what we solved worse, and where they diverge from us.',
    '- adjacent: different product, overlapping problems. The reading is for the',
    '  transferable mechanism, not the feature.',
    '- unrelated: no meaningful overlap. Say so, early, and read narrowly.',
    '"unrelated" is a FIRST-CLASS, non-embarrassing answer. A flow that cannot',
    'conclude "this repository has nothing for us" invents work to avoid saying it,',
    'and that work reaches a queue and spends real money. If that is the honest',
    'reading, give it and say why.',
    'Write the CONTEXT FILE first, as prose a person would want to read:',
    '# Context',
    '## This project — <what it is, what it is for, how it is built>',
    '## Where it stands — <what exists, what is half-built, what has been decided>',
    '## The subject — <what we are about to read, in a sentence or two>',
    '## The relationship — <the stance, argued from evidence on BOTH sides>',
    '## What to look for — <what a reading of that subject should come back with>',
    'Ground it: name files you actually opened. Do not describe intent you inferred',
    'from a directory name.',
    'Then end with EXACTLY ONE ```json block and nothing after it:',
    '{',
    '  "relation": "empty|similar|adjacent|unrelated",',
    '  "confidence": "high|medium|low",',
    '  "mission": "<ONE sentence completing \'your shared goal is to …\', for the readers who come after you>",',
    '  "focus": ["<what this reading is actually for, HERE>"],',
    '  "ignore": ["<what this workspace does not need from that subject>"],',
    '  "assumptions": ["<anything you resolved yourself where the evidence was thin>"],',
    '  "questions": [{ "id": "<slug>", "text": "<the question>", "why": "<what changes with the answer>" }]',
    '}',
    'Resolve ordinary ambiguity yourself by recording an assumption. ONLY when an',
    'ambiguity would MATERIALLY change what the whole flow is for — a fork you cannot',
    'responsibly pick — may you ask, and then at most 3 questions, fewer is better,',
    'usually none. Never ask what either repository already tells you: an orientation',
    'that asks "what does this project do?" when README.md says so has failed at its',
    'actual job. The case that genuinely warrants asking is an EMPTY workspace whose',
    'prompt does not say what is being built — there is no evidence anywhere, and',
    'everything downstream depends on the answer.',
    '`ignore` is advice for the readers, not a ban: it means "do not spend effort',
    'here", never "do not report it if it turns out to matter".'
  ].join('\n'),
  orchestrate: [
    'ROLE: orchestrate',
    'You are an Orchestrator node. From the brief and the upstream task list,',
    'decide the complete set of work nodes needed and respond with ONE ```json',
    'block satisfying the STRICT plan contract — invalid output is rejected and',
    'the orchestrator fails:',
    '{',
    '  "nodes": [{',
    '    "id": "<unique; letters/digits/_/- only>",',
    '    "template": "work",',
    '    "taskRef": "task-N",',
    '    "category": "<Code general | Code design | documentation | Test-creation>",',
    '    "effort": "<low | medium | high — optional; match the task\'s difficulty>",',
    '    "title": "<short>", "goal": "<fully self-describing>",',
    '    "dependsOn": ["<id of a prerequisite node>"],',
    '    "contextSpec": { "files": [{ "path": "<file>", "description": "<exactly which part is needed>" }] }',
    '  }],',
    '  "parallelGroups": [["task-1","task-2"],["task-3"]],',
    '  "summary": "<one line>"',
    '}',
    'The "work" template covers every task type; its category selects',
    'implementation / design / docs / tests. The nodes you declare are created',
    'inside you and run AUTOMATICALLY, without any human review — every goal must',
    'be fully self-describing, and every contextSpec minimal. Independent nodes',
    'run in parallel; use dependsOn (or parallelGroups as sequential waves) only',
    'where order truly matters.'
  ].join('\n'),
  'feedback-review': [
    'ROLE: feedback-review',
    'You close a follow-up turn: the user replied to a finished run, new nodes ran to',
    'address that feedback, and you now judge whether the feedback is actually solved.',
    'Compare the FEEDBACK (from the follow-up input node) against the turn\'s outputs',
    'and any workspace changes. Write a short review, then end with ONE ```json block:',
    '{',
    '  "verdict": "solved" | "more-work",',
    '  "reason": "<one line>",',
    '  "nodes": [{ "id", "template", "title", "goal", "dependsOn": [], "contextSpec": {...} }]',
    '}',
    'Use "solved" when the feedback is addressed; the turn then completes.',
    'Use "more-work" ONLY when concrete further work would fix it, and declare that work',
    'as node specs (same contract as plan-eval; template "work" + a category of',
    'Code general | Code design | documentation | Test-creation). They run before you',
    'review again. Extensions are bounded; when in doubt, prefer "solved" with an',
    'honest reason over an endless loop.'
  ].join('\n'),
  'final-eval': [
    'ROLE: final-eval',
    'You are the final evaluation node.',
    'Compare the completed work against the original prompt and the tasks.md / plan-eval.',
    'In your output (final-eval.md style) explicitly list:',
    '- Completeness',
    '- Differences from the original plan (with locations and reasoning)',
    'Be honest and specific.'
  ].join('\n')
};

// The follow-up triage prompt (DECISIONS.md D21): not a node role — a direct
// call made by followUp() before any node exists. It sees a digest of the run
// (FU9) and classifies the user's reply into question / fix / feature.
const TRIAGE_SYSTEM = [
  'ROLE: followup-triage',
  'A run of an AI workflow has finished, and the user replied to its result.',
  'Classify that reply and respond with ONE ```json block — nothing else is used:',
  '{',
  '  "class": "question" | "fix" | "feature",',
  '  "reason": "<one line>",',
  '  "contextNodes": ["<id of a finished node whose output the new work needs>"],',
  '  "answer": "<question-class only: answer the question directly, as Markdown>",',
  '  "nodes": [{ "id": "<short unique id>", "template": "work",',
  '              "category": "<Code general | Code design | documentation | Test-creation>",',
  '              "title": "<short>", "goal": "<fully self-describing>", "dependsOn": ["<id>"],',
  '              "contextSpec": { "files": [{ "path": "<file>", "description": "<exactly which part is needed>" }] } }],',
  '  "goal": "<feature-class only: one paragraph stating what to plan and build>"',
  '}',
  'Classes:',
  '- "question": the user asks about the result; nothing should run. Provide "answer".',
  '- "fix": a small correction to what was produced. Provide 1-2 "nodes" that do the fix.',
  '- "feature": new work that deserves planning. Provide "goal"; a plan segment is created.',
  'contextNodes: pick ONLY the finished nodes whose outputs the new work genuinely needs',
  '(their outputs are wired in as context via edges). Keep it minimal.',
  'If the run FAILED, the digest names the failed node and error: route the continuation',
  'around or past it — the user\'s reply (e.g. "skip that step", "use approach B")',
  'guides how. A rejected run\'s reply usually explains what was wrong with the plan.'
].join('\n');

// One turn may extend itself at most this many times before the run escalates
// to the human gate (FU6).
const MAX_TURN_EXTENSIONS = 2;

// The investigateNode prompt (RUN-CONTROL): not a node role — a direct call
// that explains one node's status/output/retro/log tail to the flow's owner
// in plain language, the way triageFollowUp explains a whole run.
const INVESTIGATE_SYSTEM = [
  'ROLE: node-investigator',
  'You are explaining one node of an AI workflow pipeline to the flow\'s owner.',
  'From the node\'s status, its (possibly partial) output, its retrospective,',
  'and the recent log lines, write a plain-language summary of 3-6 sentences:',
  'what this node did or is doing, whether it is healthy, and anything notable.',
  'Mention the model that ran it and the token usage when known. If there is',
  'no output yet, say so plainly instead of guessing. No headers, no jargon.'
].join('\n');

// The summarizeOutputs prompt (DESIGN-SPEC.md §7): not a node role — a
// direct call that condenses one or more node outputs into the summary node's
// fixed shape: one bold TL;DR line, then 3-6 bullets, grounded only in the
// sources it's given (D8 offers it on anything with output; multi-source
// summaries name each source section).
const SUMMARIZE_SYSTEM = [
  'ROLE: summarizer',
  'You summarize outputs of AI workflow nodes for the flow\'s owner.',
  'Produce exactly this shape, nothing else:',
  '**TL;DR** — <one sentence>',
  'then 3-6 Markdown bullet points with the key facts, decisions and numbers.',
  'Ground every claim ONLY in the provided source output(s) — no outside',
  'knowledge, no speculation. When several sources are given, each is named;',
  'cover all of them. If a source has no output yet, say so in one bullet.',
  'Long sources are truncated to a character budget and the prompt says so;',
  'note genuinely missing information rather than guessing.'
].join('\n');

// The fan-out peek (DECISIONS.md D37): not a node role — a direct read-only agent
// call made before the lane planner, over a hard cap of PEEK_MAX_CALLS tool
// calls. It answers ONE question: what am I actually looking at? A Rust
// workspace or a monorepo of notebooks; four services or one script. It is
// deliberately not a pre-read of the subject — that is what the lanes are for,
// and a peek that reads the repo has spent the budget it was meant to save.
const PEEK_SYSTEM = [
  'ROLE: subject-peek',
  'You are taking ONE quick look at a subject so that another model can decide',
  'how a team of readers should divide it up. You are NOT reading it yourself.',
  'Spend your few tool calls establishing shape, not content: what kind of thing',
  'this is, what the top-level parts are, which languages/frameworks are in play,',
  'roughly how big it is, and where the entry points look like they are.',
  'Answer in at most 200 words of plain prose or bullets. Say "could not tell"',
  'rather than guessing — a wrong map is worse than a blank one.'
].join('\n');

// The peek's ceiling: enough calls to list a tree and open a manifest, not
// enough to start reading source. §4 costs the whole feature at 10-15% overhead
// on the strength of this number.
const PEEK_MAX_CALLS = 3;
// 200 words is the ANSWER the peek is asked for; 700 tokens is roughly that,
// and was being sent as the whole completion budget. On a reasoning model that
// buys a peek cut off mid-thought having written nothing — `flyt why` caught
// exactly that on a live run, finish_reason "length" at max_tokens 700. The
// answer stays 200 words; the model gets room to arrive at it (D40).
const PEEK_MAX_TOKENS = 700 + REASONING_HEADROOM;

// The tools a peek may hold, intersected with (never added to) whatever the
// fan-out itself was granted. `glob` is listed for the day it exists; today the
// read-only library is read_file + search_references, and the intersection is
// what actually runs.
const PEEK_TOOLS = ['glob', 'read_file', 'search_references'];

// The lane planner (DECISIONS.md D37): not a node role — a direct call that
// chooses a fan-out's roster from the brief, the way TRIAGE_SYSTEM classifies a
// follow-up before any node exists.
//
// This is the part of D36 that DECISIONS.md D37 reverses: a fan-out DOES now make a
// planning call. What makes that safe is the enum below. The planner SELECTS
// and DUPLICATES presets; it never authors one. A model that can pick lanes but
// cannot define them cannot turn the adversarial read into a flattering one —
// which is the property "no planning call" was protecting in the first place.
const LANE_PLAN_SYSTEM = [
  'ROLE: lane-planner',
  'A fan-out node is about to run N independent readers over one subject, in',
  'parallel. Each reader is a FIXED role you pick from a closed list. You decide',
  'the shared mission every reader opens with, and which readers exist.',
  'You are NOT writing what a reader does — that text is fixed and you cannot',
  'change it. You choose from the list, and you may choose the same role more',
  'than once: three architecture lanes is the correct answer to "focus entirely',
  'on how this is put together".',
  'THE ROLES:',
  ...LANE_PRESET_IDS.map(id => `- ${id}: ${LANE_PRESETS[id].intent}`),
  'Read the brief for what the person actually wants, not for keywords. If they',
  'said to focus somewhere, weight the roster there. If they said to ignore',
  'something, put it in "ignore" — that is ADVISORY wording in every lane\'s',
  'prompt, not a filter, and you must NOT drop a lane because it might touch an',
  'ignored area.',
  'Respond with ONE ```json block — nothing else is used:',
  '{',
  '  "mission": "<one sentence completing \'your shared goal is to …\'>",',
  '  "subject": "<what they are reading: the repository | these three repositories | the codebase>",',
  '  "focus":  ["<what this reading is actually for>"],',
  '  "ignore": ["<what the person asking did not ask about>"],',
  '  "lanes": [{',
  `    "preset": "${LANE_PRESET_IDS.join('|')}",`,
  '    "id": "<kebab-case, unique>",',
  '    "label": "<e.g. Architecture — the data path>",',
  '    "intent": "<one line, shown to the other lanes>",',
  '    "emphasis": "<at most ONE sentence narrowing this lane inside its preset>",',
  '    "reason": "<why this lane exists — for the log, never sent to the lane>"',
  '  }]',
  '}',
  'When you repeat a preset, the lanes MUST differ in label, intent and emphasis',
  '— otherwise you have ordered the same read twice and called it coverage.',
  'mission is exactly one sentence. focus and ignore may be empty arrays; most',
  'briefs have neither, and inventing them is worse than leaving them out.'
].join('\n');

// --- the workspace context file (D38) ----------------------------------
//
// One HTML comment carries everything staleness needs: when it was written,
// against which commit, about which subject, and a hash of the body as written.
// A comment rather than front matter because the file is markdown a person
// reads and may commit, and front matter renders as a table on most viewers.
const CONTEXT_STAMP = /^<!--\s*flyt-context:\s*(\{[\s\S]*?\})\s*-->/;
export const stampLine = stamp => `<!-- flyt-context: ${JSON.stringify(stamp)} -->`;
export const bodyOf = text => String(text ?? '').replace(CONTEXT_STAMP, '').trim();
export function readContextStamp(text) {
  const m = String(text ?? '').match(CONTEXT_STAMP);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
const hashText = text => createHash('sha256').update(String(text ?? '').trim()).digest('hex').slice(0, 16);

// Re-survey when the code has moved on, when the file has simply aged out, or
// when it was written about a DIFFERENT subject — that last one matters most:
// a context file written while reading repository A says almost nothing
// trustworthy about a run reading repository B, and trusting it silently is
// how a flow ends up confidently oriented against the wrong thing.
export function contextIsStale(stamp, { subject = null, head = null, days = 30, now = Date.now() } = {}) {
  if (!stamp) return true;
  if (subject && stamp.subject && stamp.subject !== subject) return true;
  if (head && stamp.head && stamp.head !== head) return true;
  const written = Date.parse(stamp.written ?? '');
  if (!Number.isFinite(written)) return true;
  return now - written > days * 24 * 60 * 60 * 1000;
}

// The questions a parked node is asking, as the Markdown a person reads in the
// run feed and on the CLI. One renderer for all three asking roles, so a
// question written with candidate answers looks the same wherever it surfaces
// — options included, because "pick one of these" is the difference between a
// reply that takes ten seconds and one that takes a paragraph.
export function renderQuestions(questions) {
  return (questions ?? []).map((q, i) => [
    `${i + 1}. ${q.text}`,
    q.why ? `   (why: ${q.why})` : '',
    q.options?.length ? `   options: ${q.options.join(' · ')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');
}

// What a specification did NOT settle. Written as its own port because it is
// the part a reader must not have to infer: an assumption taken because nobody
// was there to ask reads exactly like a decision, unless something says so.
export function renderOpenItems({ assumptions = [], unknowns = [], confidence = 'low' } = {}) {
  const lines = [`Confidence: ${confidence}`];
  lines.push('', '## Assumptions taken');
  lines.push(assumptions.length ? assumptions.map(a => `- ${a}`).join('\n') : '- (none)');
  lines.push('', '## Still unknown');
  lines.push(unknowns.length ? unknowns.map(u => `- ${u}`).join('\n') : '- (none)');
  return lines.join('\n');
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim() || null;
  } catch { return null; }
}

// The orientation in ≤ORIENT_SUMMARY_WORDS words (D38), for the port that
// reaches EVERY lane of a fan-out.
//
// Capped in code rather than by instruction, deliberately. This is the field
// most likely to grow until every lane opens with a detailed shared prior, and
// a shared prior is exactly what collapses the divergence a fan-out exists to
// produce (D36 point 4). Lanes need to know who is asking and why; they do not
// need our architecture.
export const ORIENT_SUMMARY_WORDS = 120;
export function orientSummary(orientation, prose) {
  const head = [
    `Relation to the subject: ${orientation.relation}`
      + (orientation.confidence ? ` (confidence: ${orientation.confidence})` : '') + '.',
    orientation.mission ? `What this reading is for: ${orientation.mission}` : ''
  ].filter(Boolean).join(' ');
  // The "This project" section if the agent wrote one, else the opening prose:
  // enough to say who is asking, and no more.
  const section = String(prose ?? '').match(/^##\s*This project[^\n]*\n([\s\S]*?)(?=\n##\s|\n*$)/mi)?.[1]
    ?? String(prose ?? '').replace(/^#[^\n]*\n/, '');
  const words = `${head} ${section.replace(/\s+/g, ' ').trim()}`.trim().split(' ').filter(Boolean);
  return words.length <= ORIENT_SUMMARY_WORDS
    ? words.join(' ')
    : `${words.slice(0, ORIENT_SUMMARY_WORDS).join(' ')}…`;
}

// The subject repository a node was pointed at, stamped by materializeInputs
// when a `repo` input feeds it (DECISIONS.md D38). `strict: false` marks a node
// that reads the workspace by design — `orient` — so its home reads are not
// reported as mis-addressed.
export function subjectOf(node) {
  const repo = node?.data?.subjectRepo;
  if (!repo) return null;
  return { repo: String(repo), strict: node.data.subjectStrict !== false };
}

// Fan-out lane budget (P3.4). Each lane is a full read of the subject on a
// metered API, so an unbounded roster is the same class of liability as an
// unbounded loop.
const DEFAULT_MIN_LANES = 2;
const DEFAULT_MAX_LANES = 6;

// How often a token stream may reach the disk and the renderer. Every flush is
// a file write plus an IPC push, and adapters call onText per chunk — at real
// token rates that is hundreds of calls a second. 250ms still reads as live.
const STREAM_FLUSH_MS = 250;

// Per-source character budget inside a summarize prompt (D-risk: concatenated
// outputs may be huge; investigate truncates its log/output the same way).
const SUMMARY_SOURCE_BUDGET = 3000;

// The node types that resolve a worker (i.e. actually call a model). Anything
// else has no model to re-pin — see restartNode's worker override.
export const WORKER_NODE_TYPES = new Set(['aiStep', 'agentTask', 'orchestrator', 'fanout']);

// Unified worker resolution for aiStep AND agentTask nodes:
//   1. an explicit worker set on the node wins,
//   2. otherwise the node's category picks from config.categoryWorkers
//      (the plan-eval pattern: category drives model selection),
//   3. otherwise the model-priority defaults (core/modelPriority.js): the
//      node's task kind + effort level walk the general provider preference,
//      restricted to providers with a saved key,
//   4. otherwise the configured executor default.
/**
 * The one worker-precedence rule, as a pure function (WR-03).
 *
 * The defect this closes: the retry UI sent a chosen worker to `restartNode`,
 * which wrote it into the run's `flow.json` — but an `agentTask` executes from
 * the already-materialized entry in `tasks.json`, and resetting a task's status
 * did not touch its persisted worker. So the UI said "retried on B" while the
 * executor called A again, and the retry reproduced the original failure.
 *
 * Precedence, highest first:
 *   1. a manual retry override recorded for this run;
 *   2. an explicit worker on the run's flow node;
 *   3. the worker persisted on the materialized task;
 *   4. category / level / provider-priority routing.
 *
 * The override sits ABOVE the persisted task worker precisely because that is
 * the one the old code silently kept using.
 */
export function effectiveWorkerFor({ override = null, flowNode = null, task = null, config = {} } = {}) {
  if (override?.provider && override?.model) {
    return { worker: { provider: override.provider, model: override.model }, via: 'retry-override' };
  }
  const authored = flowNode?.data?.worker;
  if (authored?.provider && authored?.model) {
    return { worker: { provider: authored.provider, model: authored.model }, via: 'node' };
  }
  if (task?.worker?.provider && task?.worker?.model) {
    return { worker: { provider: task.worker.provider, model: task.worker.model }, via: 'task' };
  }
  const route = resolveWorkerRoute(flowNode ?? {}, config);
  return { worker: route.worker, via: route.via };
}

/**
 * The same resolution as `resolveWorker`, but showing its work (WR-04).
 *
 * One record naming the requested route, the effective route, WHY that rung of
 * the precedence ladder won, and (for a default pick) which providers were
 * considered and why each was skipped. The renderer preview, the node-start
 * log, diagnostics and the actual adapter call all read this rather than each
 * re-deriving the answer and occasionally disagreeing.
 *
 * Never contains a key: this record is logged verbatim.
 */
export function resolveWorkerRoute(node, config) {
  const w = node?.data?.worker;
  if (w?.provider && w?.model) {
    return {
      worker: { provider: w.provider, model: w.model },
      via: 'node', reason: 'the node names this worker explicitly', candidates: null
    };
  }
  if (config.levelWorker?.provider && config.levelWorker?.model) {
    const { provider, model, routing } = config.levelWorker;
    return {
      worker: { provider, model, ...(routing ? { routing } : {}) },
      via: 'level', reason: 'the run was started at an effort band or pinned to a model', candidates: null
    };
  }
  const cat = node?.data?.category;
  const pref = cat ? config.categoryWorkers?.[cat] : null;
  if (pref?.provider && pref?.model) {
    return {
      worker: { provider: pref.provider, model: pref.model },
      via: 'category', reason: `configured worker for category "${cat}"`, candidates: null
    };
  }
  const plan = planDefaultRoute(node, config);
  if (plan.provider) {
    return {
      worker: { provider: plan.provider, model: plan.model },
      via: plan.order, reason: plan.reason, candidates: plan.candidates,
      kind: plan.kind, effort: plan.effort
    };
  }
  const d = config.workers.executor;
  return {
    worker: { provider: d.provider, model: d.model },
    via: 'executor-default', reason: plan.reason, candidates: plan.candidates
  };
}

export function resolveWorker(node, config) {
  const w = node?.data?.worker;
  if (w?.provider && w?.model) return { provider: w.provider, model: w.model };
  // A run started at an effort LEVEL (DESIGN-SPEC.md §8), or pinned to a model,
  // routes every unpinned node through it. Below an explicitly authored worker
  // on purpose: a flow that names its model meant it, and a band is a default,
  // not an override.
  //
  // provider/model/routing only, never a key: this object is logged verbatim in
  // `node_start`, and the key is looked up at call time from `providerKeys`.
  // Spreading it whole once wrote a live OpenRouter key into every run's
  // log.jsonl — a file agents read and the archive copies.
  if (config.levelWorker?.provider && config.levelWorker?.model) {
    const { provider, model, routing } = config.levelWorker;
    return { provider, model, ...(routing ? { routing } : {}) };
  }
  const cat = node?.data?.category;
  const pref = cat ? config.categoryWorkers?.[cat] : null;
  if (pref?.provider && pref?.model) return { provider: pref.provider, model: pref.model };
  const pick = pickDefaultWorker(node, config);
  if (pick) return pick;
  const d = config.workers.executor;
  return { provider: d.provider, model: d.model };
}

// Kahn topological sort over the flow; throws on cycles. Feedback edges
// (sourceHandle 'feedback') point backwards by design and are not part of the
// execution order.
export function topoSort(flow) {
  const indegree = new Map(flow.nodes.map(n => [n.id, 0]));
  const adj = new Map(flow.nodes.map(n => [n.id, []]));
  for (const e of forwardEdges(flow.edges)) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue; // dangling edge
    indegree.set(e.target, indegree.get(e.target) + 1);
    adj.get(e.source).push(e.target);
  }
  const queue = flow.nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== flow.nodes.length) {
    const stuck = flow.nodes.filter(n => !order.includes(n.id)).map(n => n.id);
    throw new Error(`Flow contains a cycle involving: ${stuck.join(', ')}`);
  }
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  return order.map(id => byId.get(id));
}

// Stages a run can't continue from: the walk is over, one way or another.
// 'cancelled' (RUN-CONTROL stop) is terminal like the others: not resumable,
// never interrupted — but restartNode/branch can still relaunch from one.
export const TERMINAL_STAGES = new Set(['done', 'failed', 'rejected', 'cancelled']);

// The liveness lease (D40). The beat is short so a lease goes stale quickly
// once its holder is gone; the window is many beats wide so a busy event loop —
// a walk sitting inside a 90-second reasoning call — is never mistaken for a
// dead one.
const LEASE_BEAT_MS = 5000;
const LEASE_STALE_MS = 60000;

// The node plus everything transitively DOWNSTREAM of it over forward edges
// (feedback edges point backwards by design and are excluded). restartNode's
// reset set; exported for tests.
export function downstreamSet(flow, nodeId) {
  const adj = new Map();
  for (const e of forwardEdges(flow.edges)) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    for (const next of adj.get(queue.shift()) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

// The node plus everything transitively UPSTREAM of it over forward edges —
// the set a branch preserves.
export function upstreamSet(flow, nodeId) {
  const pred = new Map();
  for (const e of forwardEdges(flow.edges)) {
    if (!pred.has(e.target)) pred.set(e.target, []);
    pred.get(e.target).push(e.source);
  }
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    for (const prev of pred.get(queue.shift()) ?? []) {
      if (!seen.has(prev)) { seen.add(prev); queue.push(prev); }
    }
  }
  return seen;
}

// How a run decides whether to pause before a destructive tool call.
//   'ask'    — every time (the default; nothing runs unwatched)
//   'smart'  — only when the safety screen flags the call
//   'always' — never (always approve; the agent runs unattended)
//   'node'   — legacy: obey each node's own approveToolCalls flag
// Absent (null/undefined) means "nobody configured one" — runs recorded before
// this setting existed, and every embedding of the runner that doesn't pass it
// — so it keeps the historical behavior, 'node'. Anything else unrecognized is
// a bug or a corrupted settings file and becomes 'ask': neither is a reason to
// start running shell commands unattended.
export const APPROVAL_MODES = ['ask', 'smart', 'always', 'node'];
export const normalizeApprovalMode = m =>
  (m == null ? 'node' : APPROVAL_MODES.includes(m) ? m : 'ask');

export class FlowRunner {
  constructor(store, config, onUpdate = () => {}, nodeStore = null, flowStore = null) {
    this.store = store;
    this.config = config;
    this.onUpdate = onUpdate;
    this.nodeStore = nodeStore; // Node Library (template defaults for instances)
    // Flow store (D36 P3): resolves `flow: <id>` call sites at run start. Null
    // in contexts that have no flow library — a sub-flow call then fails at
    // start with a clear error rather than silently running an empty box.
    this.flowStore = flowStore;
    this.gates = new Map(); // runId -> resolve(bool) for a pending approval
    // DECISIONS.md D27: runId -> resolve(answersText) for a refine node parked
    // at the awaiting_input gate. A separate map from `gates` because the
    // answer is free text, not an approve/reject boolean.
    this.inputGates = new Map();
    // RUN-CONTROL state (process-local, like the approval gates):
    //   pauseGates    — runId -> resolve() for a walk holding at a pause
    //   pauseRequests — runs asked to hold at the next wave boundary
    //   stopRequests  — runs being hard-stopped; set by stop(), cleared when
    //                   the walk has fully unwound (launch's finally)
    //   abortControllers — runId -> Set<AbortController> of in-flight model calls
    this.pauseGates = new Map();
    this.pauseRequests = new Set();
    this.stopRequests = new Set();
    this.abortControllers = new Map();
    // Runs this process is currently walking. Process state, not file state:
    // it's exactly what's lost in a crash, which is what makes an interrupted
    // run identifiable (see reconcileInterrupted).
    this.live = new Set();
    // ...and its file-state shadow, so OTHER processes can see it too (D40).
    // Held one-to-one with `live`: whatever drops a run from that set releases
    // its lease in the same breath, or a stopped run keeps beating "I'm alive"
    // until its walk finishes unwinding.
    this.leases = new Map();
  }

  // Stop claiming this run. Idempotent — stop() and the walk's own unwind both
  // reach it, in either order.
  releaseLease(runId) {
    this.leases.get(runId)?.release();
    this.leases.delete(runId);
  }

  notify(runId) { this.onUpdate(runId); }
  owns(runId) { try { return Boolean(this.store.readMeta(runId)?.flowId); } catch { return false; } }

  // Build an onText handler (the adapter contract in adapters/index.js) that
  // mirrors partial model output into the run's files as it arrives, so a live
  // run is watchable rather than silent until a node completes (D10, V1 task 8).
  // Throttled to STREAM_FLUSH_MS. Dropping chunks is safe precisely because
  // onText hands over the FULL text so far rather than a delta: every flush is
  // a complete prefix, the next supersedes it, and the caller's write once the
  // call returns is authoritative.
  streamInto(runId, write) {
    let lastFlush = 0;
    return (textSoFar, opts) => {
      const now = Date.now();
      // A call's LAST emit is never dropped. Throttling rests on "the caller's
      // write afterwards is authoritative", which holds for a single-shot call
      // but not inside an agent loop: an intermediate turn is superseded by the
      // next turn, not by any write. Dropping its final state meant a tool call
      // showed as "→ write_file()" — the name arrives first and takes the flush
      // window, and the arguments, the part that says what the agent is doing,
      // streamed in behind it and were thrown away (V1 task 12).
      if (!opts?.final && now - lastFlush < STREAM_FLUSH_MS) return;
      lastFlush = now;
      write(textSoFar);
      this.notify(runId);
    };
  }

  // Log each transient-error retry the adapter backs off through (V1 task 11).
  // Without this a retry leaves no trace: a call that recovers reports only a
  // `retries` count, and one that exhausts its budget just throws, so "did
  // backoff actually run under real latency?" was answerable only by timing the
  // wall clock. Real 429s are routine, so this belongs in the audit log.
  retryLogger(runId, nodeId) {
    return info => this.store.appendLog(runId, { event: 'model_retry', node: nodeId, ...info });
  }

  // --- RUN-CONTROL: abort tracking -----------------------------------------
  // Every model call a run makes registers an AbortController here; stop()
  // fires them all at once. Register at call start, unregister when it
  // settles — the registry only ever holds genuinely in-flight calls.
  trackAbort(runId) {
    const ctl = new AbortController();
    let set = this.abortControllers.get(runId);
    if (!set) this.abortControllers.set(runId, set = new Set());
    set.add(ctl);
    return ctl;
  }
  untrackAbort(runId, ctl) {
    const set = this.abortControllers.get(runId);
    if (!set) return;
    set.delete(ctl);
    if (!set.size) this.abortControllers.delete(runId);
  }
  // One model call whose lifetime is registered against the run, so stop()
  // can abort it. The signal itself stays optional all the way down — every
  // other caller of callModel is untouched.
  async trackedCallModel(runId, params, nodeId = null) {
    const ctl = this.trackAbort(runId);
    // An extra signal a caller may fire for its OWN reason — the planner-spin
    // detector is the one that does. Combined rather than replacing the run's,
    // so a user stop still reaches the call either way.
    const extra = params.abortSignal ?? null;
    const signal = extra ? AbortSignal.any([ctl.signal, extra]) : ctl.signal;
    try {
      // The deadline default is the runner's, so a per-call timeout in params
      // still wins (DESIGN-SPEC.md §8).
      //
      // callForAnswer, not callModel: a turn that comes back with nothing but
      // reasoning gets one nudged retry at a larger budget before anyone calls
      // it a failure (core/agent.js). Every path through this method wants
      // that — a planner, a judge and a lane all fail the same way without it.
      const { abortSignal, ...rest } = params;
      return await callForAnswer({
        timeout: this.config.timeout, ...rest, signal,
        onCall: this.callLogger(runId, nodeId)
      }, this.emptyTurnLogger(runId, nodeId));
    } finally {
      this.untrackAbort(runId, ctl);
    }
  }

  // The black box (D40). One line per settled model call, in the run's own log:
  // model, budget, request size, finish reason, the content/reasoning split and
  // what it cost. Runs used to fail on "returned an empty response" with
  // nothing on disk to say whether the answer had been truncated, spent on
  // reasoning, or never started — the only way to find out was to run it again.
  callLogger(runId, nodeId) {
    return record => {
      this.store.appendLog(runId, { event: 'model_call', ...(nodeId ? { node: nodeId } : {}), ...record });
      if (nodeId) this.store.writeCallTrace(runId, nodeId, record);
    };
  }

  // A turn that produced nothing and had to be nudged. Logged whether or not
  // the recovery worked, because "this model needs two calls to answer once" is
  // a fact about the configuration worth seeing on a run that succeeded.
  emptyTurnLogger(runId, nodeId) {
    return info => this.store.appendLog(runId, {
      event: 'model_empty_turn', ...(nodeId ? { node: nodeId } : {}), ...info
    });
  }

  // An aiStep with a grant runs through the agent loop instead of a bare model
  // call (DESIGN-SPEC.md §5): a planner that can check the time or read a page
  // plans better. Only read-effect tools may be granted here — the linter's
  // `readonly-tools` rule — and runAgent with an empty tool list IS
  // trackedCallModel, so every existing aiStep takes exactly its old path.
  async trackedRunAgent(runId, nodeId, params, tools, subject = null) {
    if (!tools.length) return this.trackedCallModel(runId, params, nodeId);
    const ctl = this.trackAbort(runId);
    // An extra signal a caller may fire for its OWN reason — the planner-spin
    // detector is the one that does. Combined rather than replacing the run's,
    // so a user stop still reaches the call either way.
    const extra = params.abortSignal ?? null;
    const signal = extra ? AbortSignal.any([ctl.signal, extra]) : ctl.signal;
    try {
      // runAgent takes the worker NESTED (`{ worker, apiKey, system, ... }`),
      // the way core/nodes/executor.js has always passed it. Spreading it flat
      // here left `worker` undefined inside the agent loop, so every model call
      // it made resolved to provider `undefined` — which meant a read-only tool
      // grant on an aiStep (DESIGN-SPEC.md §5) failed the node the moment it was
      // used. Nothing in the suite exercised it until fan-out lanes started
      // inheriting a grant (D36 P2), which is how it surfaced.
      const { apiKey, system, prompt, onText, onRetry, retry, maxIterations, abortSignal, ...worker } = params;
      return await runAgent({
        worker, apiKey, system, prompt, onText, onRetry, retry,
        onCall: this.callLogger(runId, nodeId),
        onEmptyTurn: this.emptyTurnLogger(runId, nodeId),
        timeout: this.config.timeout, tools, signal,
        // A node that searches a repository needs more rounds than one that
        // checks the time (core/agent.js MAX_ITERATIONS). A caller may cap
        // itself BELOW the configured ceiling — the fan-out peek does, because
        // a peek that keeps going is just a slow lane (DECISIONS.md D37).
        maxIterations: maxIterations ?? this.config.maxToolIterations ?? null,
        ctx: {
          store: this.store, runId, nodeId, workspace: this.workspaceFor(runId),
          backlog: this.backlog ?? null, feedback: this.feedback ?? null,
          references: this.references ?? null,
          // The runtime config, for the tools whose answer depends on how this
          // INSTALLATION is set up rather than on this run: web_search needs to
          // know whether a search key exists, why_blocked needs to know whether
          // a reviewer is configured. Read-only by convention; nothing in
          // core/tools/ writes it.
          config: this.config ?? null,
          // The worktree pool, so read_run can show what an earlier attempt
          // actually changed. Lazily borrowed the same way `backlog` is.
          pool: this.pool ?? null,
          // The repository this node was pointed at, when it was pointed at one
          // (DECISIONS.md D38). Scopes `search_references` and makes a
          // read of the wrong root visible.
          ...(subject?.repo ? { subject } : {})
        }
      });
    } finally {
      this.untrackAbort(runId, ctl);
    }
  }

  // The tools an aiStep node actually gets, resolved and logged like an
  // agentTask's (§5). Read-effect only: anything else is dropped here as well
  // as flagged by the linter, because a lint warning is not a safety boundary.
  aiStepTools(runId, node) {
    if (!Array.isArray(node.data?.tools) || !node.data.tools.length) return [];
    const grant = resolveTools({ grant: node.data.tools, ceiling: node.data.toolCeiling ?? null });
    const readOnly = grant.tools.filter(t => (t.effects ?? []).every(e => e === 'read'));
    const dropped = grant.tools.filter(t => !readOnly.includes(t));
    this.store.appendLog(runId, {
      event: 'tool_resolved', node: node.id, tools: readOnly.map(t => t.name),
      ceiling: grant.ceiling, source: 'static'
    });
    for (const r of grant.refused) {
      this.store.appendLog(runId, { event: 'tool_grant_refused', node: node.id, tool: r.tool, ceiling: grant.ceiling });
    }
    for (const m of grant.missing) {
      this.store.appendLog(runId, { event: 'tool_missing', node: node.id, tool: m.tool, reason: m.reason });
    }
    for (const t of dropped) {
      this.store.appendLog(runId, { event: 'tool_missing', node: node.id, tool: t.name, reason: 'not read-only on an aiStep' });
    }
    return readOnly;
  }

  // The workspace copy of an orientation (D38): `.flyt/context.md`,
  // per-project, version-controllable and hand-editable — exactly what `.flyt/`
  // is for (D15, D22, D29). It is what makes "the first run gives you that
  // context" true across runs: the next orientation seeds from it and becomes a
  // confirm-or-revise rather than a full survey.
  //
  // Three rules, and the third is the one that decides whether people keep this
  // feature turned on:
  //   1. attended runs only — an unattended loop does not edit your repository;
  //   2. absent or stale only — a fresh file is left alone;
  //   3. NEVER over a hand edit. The divergence is reported instead.
  // Never throws: an unwritable `.flyt/` leaves the run-folder copy, which is
  // the artifact everything downstream actually reads.
  writeContextFile(runId, node, prose, orientation) {
    try {
      const ws = this.workspaceFor(runId);
      if (!ws) return;
      if (this.approvalMode(runId) === 'always') {
        this.store.appendLog(runId, { event: 'context_file_skipped', node: node.id, reason: 'unattended run does not edit the project' });
        return;
      }
      const rel = `${ws.configDirName}/context.md`;
      const existing = ws.readFile(rel);
      const subject = node.data?.subjectRepo ?? null;
      const head = existing ? readContextStamp(existing) : null;
      if (existing) {
        if (!head) {
          this.store.appendLog(runId, { event: 'context_file_kept', node: node.id, reason: 'hand-written file with no stamp' });
          this.reportContextDivergence(runId, node, rel, prose);
          return;
        }
        if (head.bodyHash !== hashText(bodyOf(existing))) {
          this.store.appendLog(runId, { event: 'context_file_kept', node: node.id, reason: 'edited by hand since it was written' });
          this.reportContextDivergence(runId, node, rel, prose);
          return;
        }
        if (!contextIsStale(head, { subject, days: 30 })) {
          this.store.appendLog(runId, { event: 'context_file_kept', node: node.id, reason: 'still fresh' });
          return;
        }
      }
      const stamp = {
        written: new Date().toISOString(),
        head: gitHead(ws.root),
        subject,
        relation: orientation.relation,
        bodyHash: hashText(prose)
      };
      ws.ensure();
      fs.writeFileSync(ws.resolve(rel), `${stampLine(stamp)}\n\n${prose}\n`, 'utf8');
      this.store.appendLog(runId, { event: 'context_file_written', node: node.id, path: rel, relation: orientation.relation });
    } catch (err) {
      this.store.appendLog(runId, { event: 'context_file_skipped', node: node.id, reason: String(err?.message ?? err) });
    }
  }

  // We would now say something different from what your file says. Reported,
  // never applied: silently rewriting a file the user edited is the one way
  // this feature becomes something people turn off.
  reportContextDivergence(runId, node, rel, prose) {
    this.store.writeNodeOutput(runId, `${node.id}.divergence`, [
      `# Your ${rel} was left alone`,
      '',
      'It has been edited since a run last wrote it (or was written by hand), so this run did',
      'not touch it. This run would now say the following instead — adopt any of it by editing',
      'that file yourself.',
      '',
      '---',
      '',
      prose
    ].join('\n'));
  }

  // The run's bound project, or null when it has none / the folder is gone.
  // Never throws: a missing workspace degrades the run, it doesn't kill it.
  workspaceFor(runId) {
    const p = this.store.readMeta(runId)?.workspace;
    if (!p) return null;
    try { return new Workspace(p); }
    catch { return null; }
  }

  // Attach a node's template-declared skills to its system prompt, resolved
  // from the bound project (V1 task 10, core/skills.js). Logged either way:
  // skills silently doing nothing was the original bug, so an attached skill
  // that couldn't be found has to be visible in the audit log rather than
  // being indistinguishable from one that worked.
  applySkills(runId, nodeId, system, names) {
    if (!names?.length) return system;
    const { found, missing } = loadSkills(this.workspaceFor(runId), names);
    if (found.length) {
      this.store.appendLog(runId, { event: 'skills_injected', node: nodeId, skills: found.map(s => s.name) });
    }
    for (const m of missing) {
      this.store.appendLog(runId, { event: 'skill_missing', node: nodeId, skill: m.name, reason: m.reason });
    }
    return withSkillsSection(system, found);
  }

  // Start walking a flow, tracking liveness for its whole lifetime — including
  // while it sits paused at a gate (execute() is still awaiting, so the run is
  // live and must not be resumable from underneath itself).
  launch(runId, flow, resume = false) {
    this.live.add(runId);
    this.leases.set(runId, this.holdLease(runId));
    this.execute(runId, flow, resume)
      .catch(err => this.fail(runId, err))
      .finally(() => {
        this.releaseLease(runId);
        this.live.delete(runId);
        // RUN-CONTROL: the walk has fully unwound — a stop request has done its
        // work and must not leak into a later relaunch of the same run.
        this.stopRequests.delete(runId);
        this.pauseRequests.delete(runId);
        this.abortControllers.delete(runId);
        this.inputGates.delete(runId);
      });
  }

  // Claim this run for this process, and keep saying so while it walks.
  //
  // The beat has to be short relative to the staleness window, and the timer
  // must never be a reason for a process to stay alive — a CLI that has
  // finished its command should exit, not linger holding a lease it no longer
  // needs.
  holdLease(runId) {
    const beat = () => this.store.writeLease(runId, {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      beatAt: Date.now()
    });
    beat();
    const timer = setInterval(beat, LEASE_BEAT_MS);
    timer.unref?.();
    return {
      release: () => { clearInterval(timer); this.store.clearLease(runId); }
    };
  }

  // Is some process — this one or another — actually walking this run?
  //
  // The pid check is the precise half: on this host, a process either exists or
  // it does not, and `kill(pid, 0)` says which without touching it. The
  // timestamp is the fallback for a lease written on another machine, and for a
  // pid that has since been recycled onto something unrelated.
  isRunLive(runId) {
    if (this.live.has(runId)) return true;
    const lease = this.store.readLease(runId);
    if (!lease) return false;
    const fresh = Date.now() - Number(lease.beatAt ?? 0) < LEASE_STALE_MS;
    if (lease.host && lease.host !== os.hostname()) return fresh;
    if (!fresh) return false;
    try { process.kill(lease.pid, 0); return true; }
    // ESRCH: no such process — the holder died without releasing. EPERM means
    // it exists but belongs to someone else, which still counts as alive.
    catch (err) { return err?.code === 'EPERM'; }
  }

  // At startup nothing is live yet, so any run left in a non-terminal stage was
  // cut off by the app dying — mark it so the UI can offer Resume (D17, V1
  // task 7). awaiting_approval is deliberately excluded: those runs already
  // have a way back (approve/reject → resumeFromGate), and a tool gate must
  // stay abandonable rather than look resumable.
  //
  // "Nothing is live yet" is true of a fresh process and false of a fresh
  // PROCESS BESIDE A RUNNING ONE, which is the normal case the moment anything
  // headless exists — hence the lease (D40) rather than the in-memory set.
  reconcileInterrupted() {
    const marked = [];
    for (const runId of this.store.listRuns()) {
      let meta;
      try { meta = this.store.readMeta(runId); } catch { continue; }
      if (!meta?.flowId || meta.interrupted) continue;
      if (TERMINAL_STAGES.has(meta.stage) || meta.stage === 'awaiting_approval' || meta.stage === 'awaiting_input') continue;
      if (this.isRunLive(runId)) continue;
      this.store.writeMeta(runId, { ...meta, interrupted: true });
      this.store.appendLog(runId, { event: 'run_interrupted', stage: meta.stage });
      this.rewindInFlight(runId);
      marked.push(runId);
    }
    return marked;
  }

  // Rewind whatever was mid-flight when the process died — its call stack is
  // gone, so it has to run again. Done here (the moment we know the run is
  // dead) rather than at resume, so an interrupted run reads honestly the
  // instant it's reopened: nothing spins, because nothing is running.
  //   - node statuses that aren't 'done' go back to 'pending'
  //   - tasks stuck at 'running' return to the queue for re-claiming, including
  //     agent-spawned tasks that have no node of their own
  // Returns how many completed nodes were preserved. Idempotent.
  rewindInFlight(runId) {
    const doc = this.store.readTasks(runId);
    if (doc) {
      const requeued = doc.tasks.filter(t => t.status === 'running');
      if (requeued.length) {
        for (const t of requeued) t.status = 'pending';
        this.store.writeTasks(runId, doc);
        this.store.appendLog(runId, { event: 'tasks_requeued', tasks: requeued.map(t => t.id) });
      }
    }
    const meta = this.store.readMeta(runId);
    // 'skipped' survives the rewind: those nodes belong to a superseded pass of
    // a failed/rejected run that a follow-up turn routed around (FU7) — they
    // were retired deliberately and must not come back as runnable.
    const nodeStatus = Object.fromEntries(Object.entries(meta.nodeStatus ?? {})
      .map(([id, s]) => [id, s === 'done' || s === 'skipped' ? s : 'pending']));
    this.store.writeMeta(runId, { ...meta, nodeStatus, currentTaskId: null, currentNodeId: null });
    this.notify(runId);
    return Object.values(nodeStatus).filter(s => s === 'done').length;
  }

  // Why this run can't be resumed, or null when it can.
  resumeBlocker(runId) {
    let meta;
    try { meta = this.store.readMeta(runId); } catch { return 'Run not found.'; }
    if (!meta?.flowId) return 'Only flow runs can be resumed.';
    // A stop that is still unwinding counts as live — the old walk must be
    // fully gone before anything relaunches this run.
    if (this.live.has(runId) || this.stopRequests.has(runId)) return 'That run is already running.';
    if (meta.stage === 'awaiting_approval') return 'This run is paused at an approval gate — approve or reject it instead.';
    if (meta.stage === 'awaiting_input') return 'This run is waiting for your input — answer its question instead.';
    if (TERMINAL_STAGES.has(meta.stage)) return `This run already finished (${meta.stage}).`;
    if (!this.store.readFlow(runId)) return 'This run has no flow.json; it cannot be resumed.';
    return null;
  }

  // Resume a run the app died in the middle of (V1 task 7). Completed nodes are
  // NOT re-executed: execute(resume) rebuilds `completed` from meta.nodeStatus,
  // so the walk picks up exactly where it stopped. The rewind is normally
  // already done by reconcileInterrupted at startup; repeating it here is a
  // no-op that keeps resume correct on its own.
  //
  // RUN-CONTROL: on a soft-paused run this SAME entry point releases the pause
  // gate — the walk is still live (parked on the gate promise), so there is
  // nothing to relaunch; it clears meta.paused itself when it wakes.
  resume(runId) {
    let pausedMeta = null;
    try { pausedMeta = this.store.readMeta(runId); } catch { /* falls through to the blocker */ }
    if (pausedMeta?.paused && this.pauseGates.has(runId)) {
      this.store.appendLog(runId, { event: 'run_resume_requested', from: 'pause' });
      this.pauseGates.get(runId)();
      return runId;
    }
    const blocker = this.resumeBlocker(runId);
    if (blocker) throw new Error(blocker);
    const flow = this.store.readFlow(runId);
    const kept = this.rewindInFlight(runId);
    // `paused: false`: a run the app killed mid-pause carries a stale flag no
    // live gate will ever clear.
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), interrupted: false, error: null, paused: false });
    this.store.appendLog(runId, { event: 'flow_run_resume_requested', keptCompleted: kept });
    this.notify(runId);
    this.launch(runId, flow, true);
    return runId;
  }

  // --- Run control (RUN-CONTROL): stop / pause / restart / branch / investigate.

  // Soft pause: hold the walk at the NEXT wave boundary — the wave in flight
  // (including any approval gate it is parked on) always settles first.
  // meta.paused flips true only once the hold has actually landed (execute()),
  // so the UI never claims a pause that hasn't happened. Idempotent: a second
  // request while pausing or paused is a no-op. Not live -> not-live.
  pause(runId) {
    if (!this.live.has(runId)) {
      // Deliberately NOT the stop() fallback: pausing a walk that exists
      // only in some other process's memory means nothing - the pause
      // request is consulted between waves by the walking loop itself, so
      // there is no durable thing to hold. Say exactly that rather than a
      // bare not-live that reads like a bug.
      return { ok: false, error: "not-live", message: `Run ${runId} is not running in this process; there is nothing to pause.` };
    }
    if (!this.pauseRequests.has(runId) && !this.pauseGates.has(runId)) {
      this.pauseRequests.add(runId);
      this.store.appendLog(runId, { event: 'run_pause_requested' });
      this.notify(runId);
    }
    return { ok: true };
  }

  // Hard stop: abort every in-flight model call, wake whatever the walk is
  // parked on (approval gate or pause hold), and record the honest end state —
  // stage 'cancelled', every unfinished node back to 'pending' so the run
  // stays inspectable and its done work preserved, tasks stuck 'running'
  // requeued. The asynchronous unwind (aborted calls, gate rejection paths)
  // reads stopRequests and skips its own 'failed'/'rejected' writes, so
  // nothing clobbers the cancelled state written here. Removing the run from
  // `live` is what unblocks run:delete. Not live -> not-live.
  stop(runId) {
    if (!this.live.has(runId)) {
      // Not walking it HERE hides two very different situations, and answering
      // `not-live` for both is what let the CLI report success while touching
      // nothing. Ask isRunLive — the cross-process lease check — and split:
      if (this.isRunLive(runId)) {
        // A live process somewhere else owns this run. Writing a terminal
        // stage under it is two writers corrupting one run — the lease exists
        // precisely to prevent that — so refuse, and name the owner.
        const lease = this.store.readLease(runId);
        const who = lease ? ` (pid ${lease.pid ?? '?'}${lease.host ? `, host ${lease.host}` : ''})` : '';
        return {
          ok: false,
          error: 'owned-by-live-process',
          message: `Run ${runId} belongs to a live process${who} — not stopping it from underneath.`
        };
      }
      // Nobody anywhere is walking it: the starting CLI process died and left
      // a stale (or missing) lease. Stop it from the files, the same way
      // resolveGate falls back to resumeFromGate for approvals.
      // readMeta THROWS for a run that is not there (readJson does a bare
      // readFileSync), so the guard below could never fire — an unknown run
      // came out as an ENOENT stack rather than the sentence this branch was
      // written to produce.
      let meta = null;
      try { meta = this.store.readMeta(runId); } catch { meta = null; }
      if (!meta) {
        return { ok: false, error: 'unknown-run', message: `No such run: ${runId}` };
      }
      if (['done', 'failed', 'cancelled', 'rejected', 'retired'].includes(meta.stage)) {
        return { ok: false, error: 'already-ended', message: `Run ${runId} already ended (${meta.stage}) — nothing left to stop.` };
      }
      this.stopFromFiles(runId, meta);
      return { ok: true, fromFiles: true };
    }
    this.stopRequests.add(runId);
    this.pauseRequests.delete(runId);
    // Wake a pause hold: the walk re-checks stopRequests right after the gate
    // and returns instead of continuing.
    const pauseWake = this.pauseGates.get(runId);
    if (pauseWake) { this.pauseGates.delete(runId); pauseWake(); }
    // Abort every in-flight model call registered for this run.
    for (const ctl of this.abortControllers.get(runId) ?? []) ctl.abort();
    // Settle a pending approval gate so no awaiting promise hangs. The
    // rejection path runs but is muted by stopRequests (see gate(), toolGate(),
    // handleStepEval, handleFeedbackReview), so it never lands a 'rejected'.
    const gateResolve = this.gates.get(runId);
    if (gateResolve) { this.gates.delete(runId); gateResolve(false); }
    // Settle a pending input gate (T6, and D38's orient) the same way — resolve
    // null so the awaiting_input walk unwinds; handleNodeQuestions skips its
    // bookkeeping under stopRequests, leaving the cancelled state intact.
    const inputResolve = this.inputGates.get(runId);
    if (inputResolve) { this.inputGates.delete(runId); inputResolve(null); }
    // Requeue tasks that were claimed when the stop landed; the executor's own
    // unwind settles in-flight ones the same way, so this covers the gaps
    // (a stop between waves) and converges with it otherwise.
    const doc = this.store.readTasks(runId);
    if (doc) {
      const requeued = doc.tasks.filter(t => t.status === 'running');
      if (requeued.length) {
        for (const t of requeued) t.status = 'pending';
        this.store.writeTasks(runId, doc);
      }
    }
    const meta = this.store.readMeta(runId);
    // 'done'/'skipped' survive, everything else goes back to 'pending' — the
    // same honesty rule as the crash rewind: nothing is running, so nothing
    // may keep looking active.
    const nodeStatus = Object.fromEntries(Object.entries(meta.nodeStatus ?? {})
      .map(([id, s]) => [id, s === 'done' || s === 'skipped' ? s : 'pending']));
    this.store.writeMeta(runId, {
      ...meta, nodeStatus,
      currentTaskId: null, currentNodeId: null, paused: false,
      pendingNodeId: null, pendingGateKind: null, pendingToolCall: null
    });
    this.store.setStage(runId, 'cancelled', { cancelledAt: new Date().toISOString() });
    this.store.appendLog(runId, { event: 'run_stopped' });
    this.releaseLease(runId);
    this.live.delete(runId);
    this.notify(runId);
    return { ok: true };
  }

  // The durable half of stop(): the same terminal state the in-process path
  // writes (stage 'cancelled', unfinished nodes back to 'pending', stuck tasks
  // requeued), driven from meta.json alone so a run whose starting process is
  // long gone can still be stopped. Mirrors resumeFromGate() in shape: read
  // meta, act on the recorded stage, write the result.
  stopFromFiles(runId, meta = this.store.readMeta(runId)) {
    const flow = this.store.readFlow(runId);
    if (flow) {
      const nodeStatus = { ...(meta.nodeStatus ?? {}) };
      for (const n of flow.nodes) {
        const s = nodeStatus[n.id];
        if (s !== 'done' && s !== 'skipped') nodeStatus[n.id] = 'pending';
      }
      // A gate parked mid-executor belongs to a call stack that died with the
      // process; nothing is left to approve and it must not look pending.
      if (meta.pendingGateKind === 'tool' && meta.pendingNodeId) {
        nodeStatus[meta.pendingNodeId] = 'failed';
      }
      this.store.writeMeta(runId, {
        ...meta, nodeStatus,
        currentTaskId: null, currentNodeId: null, paused: false,
        pendingNodeId: null, pendingGateKind: null, pendingToolCall: null
      });
    } else {
      this.store.writeMeta(runId, { ...meta, paused: false });
    }
    const doc = this.store.readTasks(runId);
    if (doc) {
      const requeued = doc.tasks.filter(t => t.status === 'running');
      if (requeued.length) {
        for (const t of requeued) t.status = 'pending';
        this.store.writeTasks(runId, doc);
      }
    }
    this.store.setStage(runId, 'cancelled', { cancelledAt: new Date().toISOString() });
    this.store.appendLog(runId, { event: 'run_stopped', fromFiles: true });
    // Both, and they are not the same thing. releaseLease drops a lease THIS
    // process holds, which for a run stopped from files is nothing at all —
    // the holder is a dead process elsewhere. The lease FILE is what makes
    // isRunLive keep answering, so it has to go or the next reader still sees
    // an owner for a run that has been cancelled.
    this.releaseLease(runId);
    this.store.clearLease(runId);
    this.notify(runId);
  }

  // Restart one node and everything downstream of it, on a non-live run.
  // Completed ancestors keep their status and outputs; the reset set goes back
  // to 'pending' with its stale outputs deleted, then the run relaunches with
  // resume semantics so exactly those nodes re-run. Optional guidance lands in
  // retry-for-<nodeId>.md, which runNode already injects into the prompt.
  //
  // `worker` re-pins the node's model for the retry (D39): the commonest reason
  // a step fails is the model it was pointed at — a missing key, a broken CLI,
  // a provider that can't serve the id — so "run it again" is useless unless
  // "run it again somewhere else" comes with it. The pin is written into the
  // RUN's flow.json, not the authored flow: this attempt changes, the workflow
  // on disk does not. `{ provider: null }` clears the pin back to the default.
  restartNode(runId, nodeId, guidance = '', worker = null) {
    if (this.live.has(runId) || this.stopRequests.has(runId)) {
      throw new Error('run is live — stop or pause it first');
    }
    // A run that is not there reads as ENOENT on meta.json unless it is
    // caught here, and 'no such file or directory' naming an internal path is
    // not an answer to "retry this node". Same shape as stop() and why().
    let meta = null;
    try { meta = this.store.readMeta(runId); } catch { /* says so below */ }
    if (!meta) throw new Error(`No run "${runId}".`);
    if (!meta.flowId) throw new Error('Only flow runs can restart a node.');
    const flow = this.store.readFlow(runId);
    if (!flow) throw new Error(`Run ${runId} has no flow.json; cannot restart a node.`);
    const target = flow.nodes.find(n => n.id === nodeId);
    if (!target) throw new Error(`No node "${nodeId}" in this run's flow.`);

    // Re-pin before the walk reads the flow again. Only aiStep/agentTask nodes
    // resolve a worker at all; pinning one on an input node would be a silent
    // no-op, so say so instead.
    let repinned = null;
    // The manual retry override (WR-03). Recorded in the run's meta as well as
    // on the flow node, because an `agentTask` does not execute from the flow
    // node — it executes from its materialized entry in tasks.json, and writing
    // only the node is exactly why "retry on B" used to call A again. The map
    // is the authoritative, inspectable, clearable statement of retry intent.
    const workerOverrides = { ...(meta.workerOverrides ?? {}) };
    if (worker) {
      if (!WORKER_NODE_TYPES.has(target.type)) {
        throw new Error(`Node "${nodeId}" (${target.type}) does not call a model — it has no worker to change.`);
      }
      target.data = { ...(target.data ?? {}) };
      if (worker.provider && worker.model) {
        repinned = { provider: String(worker.provider), model: String(worker.model) };
        target.data.worker = repinned;
        workerOverrides[nodeId] = repinned;
      } else {
        delete target.data.worker; // back to category / priority / default resolution
        delete workerOverrides[nodeId]; // clearing a pin restores normal routing
      }
      this.store.writeFlow(runId, flow);
    }

    // Forward edges only: a feedback edge points backwards by design and is no
    // reason to reset its target.
    const reset = downstreamSet(flow, nodeId);
    const nodeStatus = { ...(meta.nodeStatus ?? {}) };
    for (const id of reset) nodeStatus[id] = 'pending';
    // A gated node being re-run must ask again — its old approval described
    // the attempt the user just sent back.
    const approvedGates = (meta.approvedGates ?? []).filter(id => !reset.has(id));
    // The retry SUPERSEDES the attempt it replaces (WR-05). Without this the
    // old terminal error stays in the foreground while the new attempt runs,
    // which is exactly what happened when a failed Codex planning attempt kept
    // showing next to a live OpenRouter retry. The failure is not erased — it
    // is demoted to history and remains inspectable.
    // The tasks are reset FIRST, because resetting is what applies the override
    // (or restores the planned worker when a pin is cleared) to the task this
    // node already materialized. Reading the effective worker before that would
    // report the worker being replaced rather than the one about to run.
    this.resetTasksForNodes(runId, flow, reset, { overrides: workerOverrides, targetNodeId: nodeId });
    //
    // What the retry will ACTUALLY run on, resolved through the same precedence
    // the executor uses. Computed once because both the attempt record and the
    // echo returned to the UI need it, and they must not disagree (WR-03).
    const targetTask = target.type === 'agentTask'
      ? (this.store.readTasks(runId)?.tasks ?? []).find(t => t.id === target.data?.taskId) ?? null
      : null;
    const effective = effectiveWorkerFor({
      override: workerOverrides[nodeId] ?? null, flowNode: target, task: targetTask, config: this.config
    });
    const attempts = recordAttempt(meta.attempts ?? {}, nodeId, {
      status: 'active', worker: effective.worker
    });
    this.store.writeMeta(runId, {
      ...meta, nodeStatus, approvedGates, workerOverrides, attempts,
      stage: 'execution', error: null, interrupted: false, paused: false,
      currentNodeId: null, currentTaskId: null
    });
    // Stale outputs of reset nodes must never reach a downstream prompt
    // (upstreamContext tolerates missing files, so deleting is the safe side).
    // Stale retry guidance goes too — the restart IS the fresh attempt.
    for (const id of reset) {
      this.store.deleteNodeOutputs(runId, id);
      this.store.deleteNodeOutputs(runId, `retry-for-${id}`);
    }
    const text = String(guidance ?? '').trim();
    if (text) {
      this.store.writeNodeOutput(runId, `retry-for-${nodeId}`,
        `# Retry guidance (manual restart)\n\n${text}`);
    }
    this.store.appendLog(runId, {
      event: 'node_restart', node: nodeId, reset: [...reset], guidance: Boolean(text),
      ...(worker ? { worker: repinned } : {}),
      // Requested vs effective, in one record and with no key (WR-03/WR-04).
      ...(repinned ? { requestedWorker: repinned } : {}),
      effectiveWorker: effective.worker, via: effective.via
    });
    this.notify(runId);
    this.launch(runId, flow, true);
    // The re-pin echoes back only when there was one — plain restarts keep the
    // { ok: true } every existing caller matches on.
    //
    // `effectiveWorker` rides along whenever the caller ASKED about the model
    // (a re-pin, or an explicit clear), because that is exactly when the UI
    // must confirm against what the backend resolved rather than against what
    // it requested. A plain "run it again" asked nothing and gets the same
    // answer it always did.
    if (!worker) return { ok: true };
    return repinned
      ? { ok: true, worker: repinned, effectiveWorker: effective.worker }
      : { ok: true, effectiveWorker: effective.worker };
  }

  // Fork a run at a node: copy the run directory wholesale, prune the copy's
  // nodeStatus so the chosen node and its transitive ancestors keep their
  // status (their outputs survive as context) and everything else goes back
  // to 'pending', then launch the copy with resume semantics so the downstream
  // re-runs against the preserved upstream. The new run lists with a
  // ' (branch)' name suffix and a branchedFrom pointer.
  branch(runId, nodeId) {
    if (this.live.has(runId) || this.stopRequests.has(runId)) {
      throw new Error('run is live — stop or pause it first');
    }
    const srcMeta = this.store.readMeta(runId);
    if (!srcMeta?.flowId) throw new Error('Only flow runs can be branched.');
    const flow = this.store.readFlow(runId);
    if (!flow) throw new Error(`Run ${runId} has no flow.json; cannot branch it.`);
    if (!flow.nodes.some(n => n.id === nodeId)) throw new Error(`No node "${nodeId}" in this run's flow.`);

    // Mint the id + directories, then overwrite with the full copy.
    const newRunId = this.store.createRun(this.store.readPrompt(runId));
    this.store.copyRunDir(runId, newRunId);

    const keep = upstreamSet(flow, nodeId);
    const reset = new Set(flow.nodes.map(n => n.id).filter(id => !keep.has(id)));
    const meta = this.store.readMeta(newRunId);
    const nodeStatus = Object.fromEntries(flow.nodes.map(n =>
      [n.id, keep.has(n.id) ? (meta.nodeStatus?.[n.id] ?? 'pending') : 'pending']));
    const baseName = String(meta.name ?? '').trim() || deriveRunName(this.store.readPrompt(newRunId));
    const cleaned = {
      ...meta,
      runId: newRunId,
      nodeStatus,
      name: `${baseName} (branch)`,
      branchedFrom: { runId, nodeId, at: new Date().toISOString() },
      stage: 'execution',
      error: null, interrupted: false, paused: false,
      currentNodeId: null, currentTaskId: null,
      pendingNodeId: null, pendingGateKind: null, pendingToolCall: null,
      approvedGates: [] // the fork makes its own gate decisions
    };
    delete cleaned.cancelledAt; // a branch of a stopped run is a fresh run
    this.store.writeMeta(newRunId, cleaned);
    // Re-running agentTasks requeue their tasks (same rule as restartNode);
    // re-running nodes lose their stale outputs.
    this.resetTasksForNodes(newRunId, flow, reset);
    for (const id of reset) {
      this.store.deleteNodeOutputs(newRunId, id);
      this.store.deleteNodeOutputs(newRunId, `retry-for-${id}`);
    }
    this.store.appendLog(newRunId, { event: 'run_branched', from: runId, nodeId });
    this.notify(newRunId);
    this.launch(newRunId, flow, true);
    return { ok: true, runId: newRunId };
  }

  // A plain-language read on one node: status, (possibly partial) output,
  // retrospective, the last log lines mentioning it, and — when a model is
  // configured — a 3-6 sentence summary of what the node did/is doing and
  // whether it's healthy. The raw data always comes back; without a model the
  // summary degrades to null + summaryError 'no-model'.
  async investigateNode(runId, nodeId) {
    let meta;
    try { meta = this.store.readMeta(runId); } catch { throw new Error(`Run ${runId} not found.`); }
    const flow = this.store.readFlow(runId);
    const node = flow?.nodes.find(n => n.id === nodeId) ?? null;
    const status = meta?.nodeStatus?.[nodeId] ?? 'pending';
    // aiSteps write nodes/<id>.md; an agentTask's deliverable is its task output.
    let output = this.store.readNodeOutput(runId, nodeId);
    if (output == null && node?.type === 'agentTask') {
      output = this.store.readTaskOutput(runId, node.data?.taskId ?? '');
    }
    // Retros and log lines are matched on the node id AND its task id, because
    // an agentTask's records live under `executor-<taskId>`.
    const needles = [nodeId, ...(node?.data?.taskId ? [node.data.taskId] : [])];
    const retro = Object.entries(this.store.readRetrospectives(runId))
      .find(([name]) => needles.some(n => name.includes(n)))?.[1] ?? null;
    const logTail = this.store.readLog(runId)
      .filter(e => needles.some(n => JSON.stringify(e).includes(n)))
      .slice(-20);
    const model = retro?.model ?? logTail.map(e => e?.worker).filter(Boolean).pop() ?? null;

    let summary = null, summaryError = null;
    try {
      // Same model choice as follow-up triage: the configured default worker.
      const worker = resolveCallTarget(resolveWorker({}, this.config), this.config);
      const result = await callModel({
        ...worker, apiKey: worker.apiKey,
        system: INVESTIGATE_SYSTEM,
        prompt: [
          `RUN: ${meta?.flowName ?? meta?.flowId ?? runId} (${runId}) — stage: ${meta?.stage ?? 'unknown'}`,
          `NODE: ${nodeId}${node?.data?.title ? ` — ${node.data.title}` : ''} (${node?.type ?? 'unknown'}) — status: ${status}`,
          `MODEL THAT RAN IT: ${model ? `${model.provider}/${model.model}` : 'unknown'}`,
          retro ? `RETROSPECTIVE:\n${JSON.stringify(retro, null, 2).slice(0, 2000)}` : 'RETROSPECTIVE: none recorded',
          `OUTPUT (possibly partial):\n${output?.trim() ? output.slice(0, 4000) : '(no output recorded yet)'}`,
          logTail.length
            ? `RECENT LOG LINES:\n${logTail.map(e => JSON.stringify(e)).join('\n').slice(0, 2000)}`
            : 'RECENT LOG LINES: none'
        ].join('\n\n'),
        retry: this.config.retry,
        onRetry: this.retryLogger(runId, `investigate:${nodeId}`)
      });
      summary = String(result.text ?? '').trim() || null;
      if (!summary) summaryError = 'no-model';
    } catch (err) {
      summaryError = 'no-model';
      this.store.appendLog(runId, { event: 'investigate_summary_failed', node: nodeId, error: String(err?.message ?? err).slice(0, 300) });
    }
    return { ok: true, status, output, retro, logTail, summary, model, ...(summaryError ? { summaryError } : {}) };
  }

  // A source's output text, every shape a summarizeable thing comes in (B4/D8):
  // a flow node (aiStep / orchestrator plan sidecar / agentTask / the input's
  // prompt), a run-time-spawned task with no flow node, or a legacy stage id.
  // Mirrors the renderer's nodeOutputText (src/runGraph.js) against the store.
  readSourceOutput(runId, sourceId) {
    const flow = this.store.readFlow(runId);
    const flowNode = flow?.nodes.find(n => n.id === sourceId) ?? null;
    if (flowNode) {
      if (flowNode.type === 'input') { try { return this.store.readPrompt(runId); } catch { return null; } }
      if (flowNode.type === 'agentTask') {
        return this.store.readTaskOutput(runId, flowNode.data?.taskId ?? '')
          ?? this.store.readNodeOutput(runId, sourceId);
      }
      if (flowNode.type === 'orchestrator') {
        return this.store.readNodeOutput(runId, `${sourceId}.plan`)
          ?? this.store.readNodeOutput(runId, sourceId);
      }
      return this.store.readNodeOutput(runId, sourceId);
    }
    const task = this.store.readTasks(runId)?.tasks?.find(t => t.id === sourceId);
    if (task) return this.store.readTaskOutput(runId, task.id);
    if (sourceId === 'prompt') { try { return this.store.readPrompt(runId); } catch { return null; } }
    if (sourceId === 'planner') return this.store.readPlan(runId);
    return null;
  }

  // A source's canvas status at creation time (D6): the summary badges itself
  // "summarized before completion" forever when any source wasn't terminal.
  sourceStatusAt(runId, sourceId) {
    const meta = this.store.readMeta(runId);
    if (meta?.nodeStatus?.[sourceId]) return meta.nodeStatus[sourceId];
    const task = this.store.readTasks(runId)?.tasks?.find(t => t.id === sourceId);
    if (task) return taskNodeStatus(task.status);
    if (sourceId === 'prompt') return 'done';
    if (sourceId === 'planner') return this.store.readPlan(runId) ? 'done' : 'pending';
    return 'unknown';
  }

  // Summarize one or more node outputs into a summary node (B4/D5). The model
  // resolves exactly like investigateNode (the configured default worker);
  // without one the call degrades to { ok:false, error:'no-model' } and nothing
  // is persisted — the renderer keeps a retryable placeholder. The artifact is
  // summaries/<key>.md + an index.json entry; flow.json is never touched.
  async summarizeOutputs(runId, sourceIds, { position = null } = {}) {
    try { this.store.readMeta(runId); } catch { throw new Error(`Run ${runId} not found.`); }
    const ids = [...new Set((sourceIds ?? []).map(String).filter(Boolean))];
    if (!ids.length) throw new Error('Summarize needs at least one source node.');
    const sources = ids.map(id => ({
      id,
      statusAtCreation: this.sourceStatusAt(runId, id),
      text: this.readSourceOutput(runId, id)
    }));
    if (!sources.some(s => s.text?.trim())) {
      throw new Error(ids.length === 1
        ? `Node ${ids[0]} has no output to summarize yet.`
        : 'None of the selected nodes has output to summarize yet.');
    }

    // Same model choice as follow-up triage / investigate: the configured
    // default worker. A model that can't even be dialed (unknown provider, no
    // saved key) is the no-model state; any other call failure is a retryable
    // error — the renderer shows them differently (B4).
    let worker;
    try {
      worker = resolveCallTarget(resolveWorker({}, this.config), this.config);
    } catch {
      return { ok: false, error: 'no-model' };
    }
    const key = ids.map(id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')).join('+');
    const id = `sum-${key}`;
    const prompt = [
      `RUN: ${this.store.readMeta(runId)?.flowName ?? runId} (${runId}) — stage: ${this.store.readMeta(runId)?.stage ?? 'unknown'}`,
      `Summarize the following ${sources.length} source output(s). Each source is truncated to ${SUMMARY_SOURCE_BUDGET} characters.`,
      ...sources.map(s =>
        `## SOURCE: ${s.id} (status: ${s.statusAtCreation})\n${s.text?.trim() ? s.text.slice(0, SUMMARY_SOURCE_BUDGET) : '(no output recorded yet)'}`)
    ].join('\n\n');
    let text;
    try {
      const result = await callModel({
        ...worker, apiKey: worker.apiKey,
        system: SUMMARIZE_SYSTEM,
        prompt,
        retry: this.config.retry,
        onRetry: this.retryLogger(runId, `summarize:${id}`)
      });
      text = String(result.text ?? '').trim();
      if (!text) throw new Error('empty response');
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 300);
      // Resolution-style failures (unknown provider, no saved key) surface as
      // the no-model state — same degradation investigateNode applies.
      const noModel = /unknown provider|api key is not set/i.test(msg);
      this.store.appendLog(runId, { event: 'summarize_failed', sources: ids, error: msg });
      return { ok: false, error: noModel ? 'no-model' : msg };
    }
    const model = { provider: worker.provider, model: worker.model };
    const entry = this.store.saveSummary(runId, {
      id,
      sources: sources.map(({ id, statusAtCreation }) => ({ id, statusAtCreation })),
      at: new Date().toISOString(),
      model,
      file: `${key}.md`,
      ...(position ? { position: { x: Math.round(position.x), y: Math.round(position.y) } } : {})
    }, text);
    this.store.appendLog(runId, { event: 'summary_created', id, sources: ids, model });
    this.notify(runId);
    return { ok: true, summary: { ...entry, text } };
  }

  // Delete a summary node: file + index entry (B4). Summaries never rerun, so
  // there's nothing else to unwind.
  deleteSummary(runId, summaryId) {
    const removed = this.store.deleteSummary(runId, String(summaryId ?? ''));
    if (!removed) return { ok: false, error: 'not-found' };
    this.store.appendLog(runId, { event: 'summary_deleted', id: summaryId });
    this.notify(runId);
    return { ok: true };
  }

  // The user dragged a summary card: persist its canvas position so it
  // survives reload (B4 placement rule).
  moveSummary(runId, summaryId, position) {
    const entry = this.store.updateSummaryPosition(runId, String(summaryId ?? ''), position);
    if (!entry) return { ok: false, error: 'not-found' };
    return { ok: true };
  }

  // DECISIONS.md D27 (T13's end state): judge two finished runs against
  // each other. One direct compare-role call over both runs' final outputs —
  // A is runIdA, B is runIdB, and the judge is blind to which config produced
  // which (provenance goes to the logs/record, not the prompt). Returns the
  // verdict payload for the comparison record; PERSISTING it is the IPC
  // handler's job — the runner doesn't know which record the pair belongs to.
  async judgeComparison(runIdA, runIdB, { judgeModel = null } = {}) {
    const settled = (runId, label) => {
      let meta;
      try { meta = this.store.readMeta(runId); } catch { throw new Error(`Run ${label} (${runId}) not found.`); }
      if (!TERMINAL_STAGES.has(meta?.stage)) {
        throw new Error(`Run ${label} hasn't settled yet (stage: ${meta?.stage ?? 'unknown'}) — judge once both sides are done.`);
      }
      // The final answer, same definition as the sidebar's: the output node's
      // primary output. Classic (flow-less) runs have nothing to compare.
      const flow = this.store.readFlow(runId);
      const out = flow?.nodes.find(n => n.type === 'output');
      const text = (out ? this.store.readNodeOutput(runId, out.id) : null)?.trim();
      if (!text) throw new Error(`Run ${label} produced no final output to judge.`);
      return { meta, text };
    };
    const a = settled(runIdA, 'A');
    const b = settled(runIdB, 'B');
    // Manual pairings may couple runs from different prompts; A's is the
    // reference, with B's as the fallback when A's file is gone.
    let prompt = '';
    try { prompt = this.store.readPrompt(runIdA); } catch { /* fall through */ }
    if (!prompt) { try { prompt = this.store.readPrompt(runIdB); } catch { /* unknown */ } }
    // What was actually compared — recorded in both runs' logs (the record
    // knows the runs; the runs know their configs).
    const configs = { A: a.meta.modeId ?? 'default', B: b.meta.modeId ?? 'default' };

    // Judge model (P3): the configured pick, resolved like an active-model
    // node worker; unset falls back to the default worker, like triage.
    const worker = judgeModel
      ? resolveCallTarget({ provider: 'auto', model: judgeModel }, this.config)
      : resolveCallTarget(resolveWorker({}, this.config), this.config);
    const judge = { provider: worker.provider, model: worker.model };
    for (const runId of [runIdA, runIdB]) {
      this.store.appendLog(runId, { event: 'compare_judge_start', with: runId === runIdA ? runIdB : runIdA, judge, configs });
    }
    const result = await callModel({
      ...worker, apiKey: worker.apiKey,
      system: JUDGE_SYSTEM,
      prompt: buildJudgePrompt({ prompt, alternatives: [{ label: 'A', text: a.text }, { label: 'B', text: b.text }] }),
      retry: this.config.retry,
      onRetry: this.retryLogger(runIdA, 'compare-judge')
    });
    const outText = String(result.text ?? '').trim();
    if (!outText) throw new Error('The judge returned an empty report.');
    // A missing/malformed JSON half degrades to summary-only (null fields) —
    // the report still renders, the record just stays un-scored.
    const parsed = parseJudgeVerdict(outText);
    const verdict = {
      summary: parsed.summary,
      winner: parsed.winner,
      axes: parsed.axes,
      notes: parsed.notes,
      judgeModel: worker.model,
      at: new Date().toISOString()
    };
    for (const runId of [runIdA, runIdB]) {
      this.store.appendLog(runId, { event: 'compare_judged', with: runId === runIdA ? runIdB : runIdA, judge, configs, winner: verdict.winner });
    }
    return verdict;
  }

  // Tasks belonging to (or spawned under) a set of reset nodes go back to
  // 'pending' so the relaunched walk re-claims them, and their stale outputs
  // are deleted. createdBy names either a task id (executor-spawned) or a node
  // id (stitch/fix-task created), so both are matched.
  // `overrides` is the run's manual retry map (WR-03). Resetting a task's
  // status was never enough: an `agentTask` executes from its persisted
  // tasks.json worker, so a retry re-pointed at another model kept calling the
  // one that had just failed. `targetNodeId` scopes the override to the node
  // the user actually re-pointed — descendants a task spawned keep their own
  // routing unless somebody asks otherwise, which is the conservative default.
  resetTasksForNodes(runId, flow, resetNodes, { overrides = null, targetNodeId = null } = {}) {
    const doc = this.store.readTasks(runId);
    if (!doc?.tasks?.length) return;
    const taskIds = new Set(flow.nodes
      .filter(n => resetNodes.has(n.id) && n.type === 'agentTask')
      .map(n => n.data?.taskId).filter(Boolean));
    // The task belonging to the re-pointed node, before descendants are folded
    // in below — only this one takes the override.
    const targetTaskId = targetNodeId
      ? flow.nodes.find(n => n.id === targetNodeId && n.type === 'agentTask')?.data?.taskId ?? null
      : null;
    for (let grew = true; grew;) {
      grew = false;
      for (const t of doc.tasks) {
        if (taskIds.has(t.id) || !t.createdBy) continue;
        if (taskIds.has(t.createdBy) || resetNodes.has(t.createdBy)) {
          taskIds.add(t.id); grew = true;
        }
      }
    }
    let changed = false;
    const override = targetTaskId ? overrides?.[targetNodeId] ?? null : null;
    for (const t of doc.tasks) {
      if (taskIds.has(t.id) && t.status !== 'pending') { t.status = 'pending'; changed = true; }
      if (t.id !== targetTaskId) continue;
      if (override?.provider && override?.model) {
        // The original planned worker is preserved for audit rather than
        // overwritten: "what did the plan choose, and what did I re-point it
        // to" must both survive the retry.
        if (!t.originalWorker && t.worker) t.originalWorker = { ...t.worker };
        t.worker = { provider: override.provider, model: override.model };
        changed = true;
      } else if (t.originalWorker) {
        // The pin was cleared: restore the planned worker so normal
        // category/provider-priority resolution applies again.
        t.worker = { ...t.originalWorker };
        delete t.originalWorker;
        changed = true;
      }
    }
    if (changed) this.store.writeTasks(runId, doc);
    for (const id of taskIds) this.store.deleteTaskOutput(runId, id);
  }

  // --- Follow-up turns (DECISIONS.md D21): reply to a finished run and the flow
  // GROWS — a triage step classifies the feedback, a continuation subgraph is
  // appended after the finished output, and the normal walk executes it.
  // Completed nodes are never re-run (FU1); prior outputs reach the new nodes
  // via edges, which is the only context mechanism there is.

  // Why this run can't take a follow-up right now, or null when it can (FU2,
  // FU10): legal only from a terminal stage, never while the run is live.
  followUpBlocker(runId) {
    let meta;
    try { meta = this.store.readMeta(runId); } catch { return 'Run not found.'; }
    if (!meta?.flowId) return 'Only flow runs can take follow-ups.';
    if (this.live.has(runId)) return 'This run is still working — wait for the current turn to finish.';
    if (meta.stage === 'awaiting_approval') return 'This run is paused at an approval gate — approve or reject it instead.';
    if (meta.stage === 'awaiting_input') return 'This run is waiting for your input — answer its question instead.';
    if (!TERMINAL_STAGES.has(meta.stage)) return `Follow-ups are only possible once a run has finished (stage: ${meta.stage}).`;
    if (!this.store.readFlow(runId)) return 'This run has no flow.json; it cannot be extended.';
    return null;
  }

  // Accept one follow-up turn. Synchronous guards + snapshot, then the async
  // triage/extend/walk runs under the same liveness tracking as launch().
  followUp(runId, text) {
    const feedback = String(text ?? '').trim();
    if (!feedback) throw new Error('Follow-up text is empty.');
    const blocker = this.followUpBlocker(runId);
    if (blocker) throw new Error(blocker);
    const flow = this.store.readFlow(runId);
    const turn = this.store.nextTurn(runId);
    this.store.snapshotBeforeTurn(runId, turn); // FU8: every turn boundary reconstructable
    this.store.writeFollowupPrompt(runId, turn, feedback);
    // The digest reads statuses, so build it BEFORE retiring the old walk.
    const digest = this.followupDigest(runId, flow);
    const meta = this.store.readMeta(runId);
    const priorStage = meta.stage;
    // Retire whatever the old walk never finished (a failed/rejected run's
    // failure path): the turn routes around it, and it must never re-run —
    // not even via crash-resume, which preserves 'skipped' (FU7).
    const nodeStatus = Object.fromEntries(Object.entries(meta.nodeStatus ?? {})
      .map(([id, s]) => [id, s === 'done' ? 'done' : 'skipped']));
    this.store.writeMeta(runId, { ...meta, turn, nodeStatus });
    this.store.appendLog(runId, {
      event: 'followup_received', turn,
      prompt: feedback.length > 200 ? feedback.slice(0, 200) + '…' : feedback
    });
    this.live.add(runId);
    this.runFollowUp(runId, flow, turn, feedback, digest, priorStage)
      .catch(err => this.fail(runId, err))
      .finally(() => this.live.delete(runId));
    return { runId, turn };
  }

  async runFollowUp(runId, flow, turn, feedback, digest, priorStage) {
    // The run reads as working while the turn is triaged/executed. meta.error
    // is deliberately kept until the graph actually extends, so a question
    // turn on a failed run leaves the failure report intact.
    this.store.setStage(runId, 'execution');
    this.notify(runId);
    const triage = await this.triageFollowUp(runId, turn, feedback, digest);

    if (!triage) {
      // Triage never produced a valid classification. The run's work is fine —
      // restore its stage and surface the miss in the thread, not as a failure.
      // (A stop mid-triage already wrote the cancelled state — keep it.)
      if (this.stopRequests.has(runId)) return;
      this.store.writeFollowupAnswer(runId, turn,
        'This follow-up could not be triaged (the model produced no valid classification), so nothing was run. Try rephrasing.');
      this.store.setStage(runId, priorStage);
      this.notify(runId);
      return;
    }

    if (triage.class === 'question') {
      // No graph change: the answer lands in the thread, the run stays as it was.
      if (this.stopRequests.has(runId)) return;
      this.store.writeFollowupAnswer(runId, turn, triage.answer);
      this.store.appendLog(runId, { event: 'turn_done', turn, class: 'question' });
      this.store.setStage(runId, priorStage);
      this.notify(runId);
      return;
    }

    this.materializeTurn(runId, flow, turn, feedback, triage);
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), error: null, interrupted: false });
    this.store.appendLog(runId, { event: 'turn_started', turn, class: triage.class });
    this.notify(runId);
    // resume=true: completed is rebuilt from meta.nodeStatus, so exactly the
    // new nodes are ready (FU2).
    await this.execute(runId, flow, true);
  }

  // The triage digest (FU9): flow topology, per-done-node output heads, files
  // the run wrote (from the tool records), and failure info — never the full
  // outputs, which won't fit a long run into one prompt.
  followupDigest(runId, flow) {
    const meta = this.store.readMeta(runId);
    const head = (s, n = 40) => {
      const all = String(s).split('\n');
      return all.length > n ? all.slice(0, n).join('\n') + '\n…' : all.join('\n');
    };
    const lines = ['FLOW TOPOLOGY (id · title · kind · status):'];
    for (const n of flow.nodes) {
      const kind = n.type === 'aiStep' ? `aiStep/${n.data?.role ?? 'custom'}` : n.type;
      lines.push(`- ${n.id} · ${n.data?.title ?? ''} · ${kind} · ${meta.nodeStatus?.[n.id] ?? 'pending'}`);
    }
    lines.push('', 'EDGES:', ...flow.edges.map(e => `- ${e.source} -> ${e.target}`));
    lines.push('', 'FINISHED NODE OUTPUTS (first 40 lines each):');
    for (const n of flow.nodes) {
      if (meta.nodeStatus?.[n.id] !== 'done' || n.type === 'input') continue;
      const out = n.type === 'agentTask'
        ? this.store.readTaskOutput(runId, n.data?.taskId ?? '')
        : this.store.readNodeOutput(runId, n.id);
      if (out) lines.push('', `--- ${n.id} (${n.data?.title ?? n.type}) ---`, head(out));
    }
    const files = new Set();
    for (const r of Object.values(this.store.readRetrospectives(runId))) {
      for (const c of r?.toolCalls ?? []) {
        if ((c.tool === 'write_file' || c.tool === 'create_file') && c.ok && c.args?.path) {
          files.add(String(c.args.path));
        }
      }
    }
    if (files.size) lines.push('', 'FILES WRITTEN DURING THE RUN:', ...[...files].map(f => `- ${f}`));
    lines.push('', `RUN OUTCOME: ${meta.stage}${meta.error ? ` — ${meta.error}` : ''}`);
    const failed = Object.entries(meta.nodeStatus ?? {}).filter(([, s]) => s === 'failed').map(([id]) => id);
    if (failed.length) lines.push(`FAILED NODES: ${failed.join(', ')}`);
    return lines.join('\n');
  }

  // One triage call (strict contract in core/planEval.js, one bounded re-ask).
  // Returns the validated triage, or null — never throws for contract misses.
  async triageFollowUp(runId, turn, feedback, digest) {
    const worker = resolveCallTarget(resolveWorker({}, this.config), this.config);
    const apiKey = worker.apiKey;
    const label = `fu${turn}-triage`;
    const templateIds = this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : [];
    this.store.appendLog(runId, { event: 'followup_triage_start', turn, worker: { provider: worker.provider, model: worker.model } });
    const userMsg = [
      `RUN DIGEST:\n${digest}`,
      `ORIGINAL PROMPT (turn 0):\n${this.store.readPrompt(runId)}`,
      `USER FEEDBACK (follow-up turn ${turn}):\n${feedback}`
    ].join('\n\n');
    let outText;
    try {
      const result = await this.trackedCallModel(runId, {
        ...worker, apiKey,
        system: TRIAGE_SYSTEM, prompt: userMsg,
        onRetry: this.retryLogger(runId, label), retry: this.config.retry
      }, label);
      outText = String(result.text ?? '').trim();
    } catch (err) {
      this.store.appendLog(runId, { event: 'followup_triage_failed', turn, error: String(err?.message ?? err) });
      return null;
    }
    let parsed = parseTriage(outText, templateIds);
    if (!parsed.ok) {
      const fixed = await this.reAsk(runId, { id: label }, worker, apiKey, TRIAGE_SYSTEM, userMsg, outText, parsed.errors);
      if (fixed != null) {
        const reparsed = parseTriage(fixed, templateIds);
        if (reparsed.ok) { parsed = reparsed; outText = fixed; }
      }
    }
    this.store.writeFollowupTriage(runId, turn, parsed.ok
      ? { ...parsed.triage, raw: outText }
      : { class: null, errors: parsed.errors, raw: outText });
    this.store.appendLog(runId, parsed.ok
      ? { event: 'followup_triaged', turn, class: parsed.triage.class, contextNodes: parsed.triage.contextNodes, reason: parsed.triage.reason }
      : { event: 'followup_triage_invalid', turn, errors: parsed.errors });
    return parsed.ok ? parsed.triage : null;
  }

  // Namespace generated-node specs into a turn (FU5): ids get the fu<n>-
  // prefix (collision-proof against plan-eval ids), and dependsOn references
  // between the specs are rewritten to match.
  prefixSpecs(specs, prefix) {
    const ids = new Set(specs.map(s => s.id));
    const ref = id => (ids.has(id) ? prefix + id : id);
    return specs.map(s => ({
      ...s,
      id: prefix + s.id,
      ...(s.dependsOn ? { dependsOn: s.dependsOn.map(ref) } : {})
    }));
  }

  // Append the turn's continuation subgraph to the run's flow (FU3/FU4/FU5):
  //   fix     -> fu<n>-input -> [triage's executor nodes] -> fu<n>-review
  //   feature -> fu<n>-input -> plan -> plan-eval (approval gate) -> stitch
  //              -> fu<n>-review, with plan-eval materializing executors
  //              between itself and stitch mid-run, exactly as in a fresh run.
  // The feedback itself is a visible input node on the canvas, and the done
  // nodes triage selected are wired in as edge context.
  materializeTurn(runId, flow, turn, feedback, triage) {
    const provenance = { origin: 'followup', turn };
    const inputId = `fu${turn}-input`;
    const reviewId = `fu${turn}-review`;
    const input = {
      id: inputId, type: 'input', kind: 'user', position: { x: 0, y: 0 },
      data: { title: `Follow-up ${turn}`, text: feedback, ...provenance }
    };
    const review = {
      id: reviewId, type: 'aiStep', kind: 'ai', position: { x: 0, y: 0 },
      data: { title: `Feedback review ${turn}`, role: 'feedback-review', icon: '⚖', ...provenance }
    };
    flow.nodes.push(input);
    const added = [input, review];
    const edges = [];
    // Which new nodes the selected context (and the review's leaf edges) attach to.
    let contextTargets = [];

    if (triage.class === 'fix') {
      const specs = this.prefixSpecs(triage.nodes, `fu${turn}-`);
      // Materialize BEFORE the input->review edge exists, so the input node has
      // no downstream targets and the leaves stay unwired until we point them
      // at the review below. Roots hang off the input node (the feedback).
      const mat = this.materializeParsedNodes(runId, flow, input, { nodes: specs });
      for (const n of mat.created) n.data = { ...n.data, ...provenance };
      const createdIds = new Set(mat.created.map(n => n.id));
      contextTargets = mat.created.filter(n =>
        flow.edges.some(e => e.source === inputId && e.target === n.id));
      const leaves = mat.created.filter(n =>
        !flow.edges.some(e => e.source === n.id && createdIds.has(e.target)));
      for (const l of leaves) {
        edges.push({ id: `fu${turn}-e-${l.id}-${reviewId}`, source: l.id, target: reviewId, generatedBy: inputId });
      }
    } else {
      // feature: the standard reflective segment. The plan-eval node carries
      // the human approval gate, and its materialized executors wire between
      // it and the stitch node via the normal plan-eval path.
      const plan = this.templateNode('plan-start', `fu${turn}-plan`,
        { title: `Plan (follow-up ${turn})`, goal: triage.goal ?? feedback });
      const planEval = this.templateNode('evaluation', `fu${turn}-plan-eval`,
        { title: `Plan evaluation (follow-up ${turn})`, evalType: 'plan', requiresApproval: true });
      const stitch = this.templateNode('combine', `fu${turn}-stitch`,
        { title: `Combine (follow-up ${turn})` });
      for (const n of [plan, planEval, stitch]) {
        n.data = { ...n.data, ...provenance, generatedBy: inputId };
        flow.nodes.push(n);
        added.push(n);
      }
      edges.push(
        { id: `fu${turn}-e-${inputId}-${plan.id}`, source: inputId, target: plan.id, generatedBy: inputId },
        { id: `fu${turn}-e-${plan.id}-${planEval.id}`, source: plan.id, target: planEval.id, generatedBy: inputId },
        { id: `fu${turn}-e-${planEval.id}-${stitch.id}`, source: planEval.id, target: stitch.id, generatedBy: inputId },
        { id: `fu${turn}-e-${stitch.id}-${reviewId}`, source: stitch.id, target: reviewId, generatedBy: inputId }
      );
      contextTargets = [plan];
    }

    // The review always sees the feedback it judges against.
    edges.push({ id: `fu${turn}-e-${inputId}-${reviewId}`, source: inputId, target: reviewId, generatedBy: inputId });

    // Context selection is edge selection (FU1): each done node triage picked
    // feeds the turn's entry nodes.
    const meta = this.store.readMeta(runId);
    const nodeIds = new Set(flow.nodes.map(n => n.id));
    const ctx = (triage.contextNodes ?? []).filter(id =>
      nodeIds.has(id) && meta.nodeStatus?.[id] === 'done');
    for (const src of ctx) {
      for (const t of contextTargets) {
        edges.push({ id: `fu${turn}-e-${src}-${t.id}`, source: src, target: t.id, generatedBy: inputId });
      }
    }

    flow.nodes.push(review);
    flow.edges.push(...edges);
    const pos = layoutPositions(flow);
    for (const n of flow.nodes) if (!n.parentId) n.position = pos.get(n.id) ?? n.position;
    this.store.writeFlow(runId, flow);
    this.store.writeMeta(runId, {
      ...this.store.readMeta(runId),
      nodeStatus: {
        ...this.store.readMeta(runId).nodeStatus,
        ...Object.fromEntries(added.map(n => [n.id, 'pending']))
      }
    });
    this.store.appendLog(runId, {
      event: 'turn_materialized', turn, class: triage.class,
      nodes: added.map(n => n.id), contextNodes: ctx
    });
    this.notify(runId);
  }

  // Act on a feedback-review verdict (FU6): 'solved' completes the turn;
  // 'more-work' materializes the declared nodes upstream of the review and
  // re-runs it, bounded to MAX_TURN_EXTENSIONS per turn. The bound (or a
  // more-work verdict with nothing materializable) escalates to the existing
  // human gate. This is also the fix-class misclassification safety net.
  async handleFeedbackReview(runId, flow, node, review) {
    const turn = Number(node.data?.turn ?? 0);
    if (review.verdict === 'solved') {
      this.store.appendLog(runId, { event: 'turn_done', turn, node: node.id, reason: review.reason });
      return { ok: true };
    }

    const used = Number(node.data?.extensionsUsed ?? 0);
    if (review.nodes?.length && used < MAX_TURN_EXTENSIONS) {
      const specs = this.prefixSpecs(review.nodes, `fu${turn}x${used + 1}-`);
      const existing = new Set(flow.nodes.map(n => n.id));
      const usable = specs.filter(s => !existing.has(s.id));
      const specIds = new Set(usable.map(s => s.id));
      // Reject dependency cycles among the declared nodes before touching the
      // flow — a cycle would leave them permanently unready.
      const deps = new Map(usable.map(s => [s.id, (s.dependsOn ?? []).filter(d => specIds.has(d) && d !== s.id)]));
      const state = new Map();
      const cyclic = function visit(id) {
        if (state.get(id) === 1) return true;
        if (state.get(id) === 2) return false;
        state.set(id, 1);
        for (const d of deps.get(id)) if (visit(d)) return true;
        state.set(id, 2);
        return false;
      };
      if (usable.length && !usable.some(s => cyclic(s.id))) {
        const inputId = `fu${turn}-input`;
        const feedbackSrc = flow.nodes.some(n => n.id === inputId) ? inputId : null;
        const created = usable.map(s => {
          const nd = this.specNode(s);
          nd.data = { ...nd.data, generatedBy: node.id, origin: 'followup', turn };
          return nd;
        });
        const dependedOn = new Set([].concat(...deps.values()));
        const edges = [];
        for (const nd of created) {
          for (const d of deps.get(nd.id)) {
            edges.push({ id: `gen-e-${d}-${nd.id}`, source: d, target: nd.id, generatedBy: node.id });
          }
          if (!deps.get(nd.id).length && feedbackSrc) {
            edges.push({ id: `gen-e-${feedbackSrc}-${nd.id}`, source: feedbackSrc, target: nd.id, generatedBy: node.id });
          }
          // Leaves feed the review itself: it re-runs after them.
          if (!dependedOn.has(nd.id)) {
            edges.push({ id: `gen-e-${nd.id}-${node.id}`, source: nd.id, target: node.id, generatedBy: node.id });
          }
        }
        flow.nodes.push(...created);
        flow.edges.push(...edges);
        node.data = { ...node.data, extensionsUsed: used + 1 };
        const pos = layoutPositions(flow);
        for (const n of flow.nodes) if (!n.parentId) n.position = pos.get(n.id) ?? n.position;
        this.store.writeFlow(runId, flow);
        const meta = this.store.readMeta(runId);
        this.store.writeMeta(runId, {
          ...meta,
          nodeStatus: { ...meta.nodeStatus, ...Object.fromEntries(created.map(n => [n.id, 'pending'])) }
        });
        this.store.appendLog(runId, {
          event: 'feedback_review_extension', turn, node: node.id,
          extension: used + 1, nodes: created.map(n => n.id), reason: review.reason
        });
        this.notify(runId);
        // Un-complete the review: the walk runs the new nodes, then it again.
        return { ok: true, requeue: [node.id] };
      }
    }

    // Bound exhausted, or more-work with nothing materializable: a human decides.
    this.store.appendLog(runId, {
      event: 'feedback_review_escalate', turn, node: node.id,
      reason: review.reason, extensionsUsed: used
    });
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id, pendingGateKind: 'escalation' });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      // A stop() settling the gate is a cancel, not a rejection — its
      // cancelled state stands.
      if (!this.stopRequests.has(runId)) {
        this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
        this.setNodeStatus(runId, node.id, 'failed');
        this.notify(runId);
      }
      return { ok: false };
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id, context: 'feedback-review escalation' });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null });
    this.setNodeStatus(runId, node.id, 'done');
    return { ok: true };
  }

  // Start a run of a flow definition. Template instances are resolved
  // against the Node Library HERE, so the run's flow.json is a fully
  // self-contained snapshot (template edits never mutate past runs).
  // userInput becomes the content of the flow's User Input node for this run.
  // workspace (an absolute path to a bound project folder, already validated +
  // .flyt/-provisioned by the caller) is recorded in meta.json so the run,
  // its tools, and the UI all know which real repo it operates on (D15).
  // approvalMode (DESIGN-SPEC.md §5) is captured PER RUN, at start, and stored
  // in meta.json. It is not read live from settings, because a run that began
  // under "ask permission" must not silently become unattended halfway through
  // when the user flips the global default for the next one.
  //   'ask'    — pause before every destructive tool call.
  //   'smart'  — screen each call (core/safetyCheck.js); pause only on risk.
  //   'always' — never pause. The dangerous one.
  start(flow, { userInput = '', workspace = null, approvalMode = null, attended = null, modeId = null, overrides = null, compareGroup = null, inputs = null, loopTaskId = null, skills = null } = {}) {
    // Pre-run gate (FLOW_LANG.md): refuse to start a structurally invalid
    // flow. Only RUNTIME_RULES — shape rules (no-input etc.) stay author-time
    // lint concerns; the runner has always tolerated partial flows.
    const gate = lintFlow(flow, {
      templates: this.nodeStore?.listFull() ?? null,
      rules: RUNTIME_RULES,
      library: toolLibraryForLint(),
      // A fan-out's lanes may come entirely from a model set, so the gate has
      // to be able to resolve one — otherwise a perfectly good flow reads as
      // laneless (D36 P2.4/P2.5).
      modelSets: this.config.modelSets ?? null,
      activeModels: this.config.activeModels ?? null
    });
    if (!gate.ok) {
      throw new Error(`Flow "${flow.name ?? flow.id}" failed validation:\n`
        + gate.errors.map(e => `- [${e.rule}] ${e.message}`).join('\n'));
    }
    const templates = this.nodeStore?.listFull() ?? [];
    // Launch overrides (DECISIONS.md D27): a chosen mode's saved override
    // bundle, then ad-hoc run inputs on top (run input > mode). Validate the
    // effective map against the resolved-without-overrides flow BEFORE applying
    // it, so an unknown node or an illegal field rejects the start cleanly.
    let mode = null;
    if (modeId) {
      mode = flow.modes?.[modeId];
      if (!mode) throw new Error(`Flow "${flow.name ?? flow.id}" has no mode "${modeId}".`);
    }
    const launchOverrides = mergeOverrideMaps(mode?.overrides, overrides);
    const hasLaunch = Object.keys(launchOverrides).length > 0;
    if (hasLaunch) {
      const base = resolveFlow(flow, templates);
      const errs = validateOverrideMap(base, launchOverrides, { label: 'launch override' });
      if (errs.length) {
        throw new Error(`Flow "${flow.name ?? flow.id}" launch overrides are invalid:\n`
          + errs.map(e => `- ${e}`).join('\n'));
      }
    }
    const resolved = resolveFlow(flow, templates, hasLaunch ? launchOverrides : null);
    const flowCopy = JSON.parse(JSON.stringify({ ...resolved, builtin: undefined }));
    // Sub-flows are spliced HERE (D36/P3.7): the run's flow.json is the
    // spliced graph, so the snapshot always shows what actually ran, and every
    // downstream part of the engine — scheduler, canvas, resume, gates — sees
    // an ordinary graph and needs to know nothing about sub-flows.
    if (flowCopy.nodes.some(n => n.type === 'subflow')) {
      if (!this.flowStore) {
        throw new Error(`Flow "${flow.name ?? flow.id}" calls a sub-flow, but this runner has no flow library to resolve it.`);
      }
      try {
        spliceAllSubflows(flowCopy, {
          loadFlow: id => { try { return this.flowStore.load(id); } catch { return null; } },
          templates
        });
      } catch (err) {
        if (err instanceof SubflowError) {
          throw new Error(`Flow "${flow.name ?? flow.id}" could not be assembled:
- ${err.message}`);
        }
        throw err;
      }
    }
    // Typed run inputs (D36 P1). Checked BEFORE a run folder exists, so a
    // missing required value is a refused start rather than a failed run.
    const inputsNode = flowCopy.nodes.find(n => n.type === 'inputs');
    let inputValues = null;
    if (inputsNode) {
      const { values, errors } = validateInputValues(inputsNode.data?.declared ?? [], inputs ?? {});
      if (errors.length) {
        throw new Error(`Flow "${flow.name ?? flow.id}" is missing run inputs:\n`
          + errors.map(e => `- ${e}`).join('\n'));
      }
      inputValues = values;
    }
    // Run-level skills (core/backlog.js `skills`). A task can say what
    // expertise its worker needs, and the only place that can be honoured is
    // here: the caller does not know which nodes the flow has, and the nodes do
    // not know which task they were started for. Merged into the RESOLVED copy
    // rather than applied at prompt time, so runs/<id>/flow.json records what
    // was actually attached and a comparison of two runs can see the
    // difference. Union, never replacement — a template's own skills are its
    // author's decision and a task may add to them, not overrule them.
    if (skills?.length) {
      const extra = skills.map(s => String(s ?? '').trim()).filter(Boolean);
      for (const node of flowCopy.nodes) {
        if (!node.data) continue;
        node.data.skills = [...new Set([...(node.data.skills ?? []), ...extra])];
      }
    }

    const input = flowCopy.nodes.find(n => n.type === 'input');
    if (input && userInput.trim()) input.data = { ...input.data, text: userInput.trim() };
    const brief = input?.data?.text?.trim() || `Flow: ${flow.name}`;
    const runId = this.store.createRun(brief);
    this.store.writeFlow(runId, flowCopy);
    this.store.writeMeta(runId, {
      ...this.store.readMeta(runId),
      flowId: flow.id,
      flowName: flow.name,
      ...(workspace ? { workspace } : {}),
      approvalMode: normalizeApprovalMode(approvalMode ?? this.config.approvalMode),
      // "A caller is blocked on this run and can ANSWER a question" is how the
      // run was STARTED, not what approvalMode means (t-0084). `flyt run`
      // passes attended: true — it parks on waitForRun and replies through
      // `run:answerInput`; the loop and every other caller pass nothing and
      // stay unattended. Recorded in the meta so the interrogation's decision
      // is inspectable from the snapshot, not just from this closure.
      attended: attended === true ? true : (attended === false ? false : null),
      // Provenance for reproducibility/replay: which mode ran, and the exact
      // effective override map. The flow.json snapshot already bakes them in;
      // this records the intent behind that snapshot.
      ...(modeId ? { modeId, modeName: mode?.name ?? modeId } : {}),
      ...(hasLaunch ? { launchOverrides } : {}),
      // Compare provenance (DECISIONS.md D27): both runs of a launch-compare
      // or rematch carry the shared group id + their A/B label, so the pairing
      // is discoverable from either side even before the record is read.
      ...(compareGroup?.id
        ? { compareGroup: { id: String(compareGroup.id), label: compareGroup.label === 'B' ? 'B' : 'A' } }
        : {}),
      // From the SPLICED graph: sub-flow children are real nodes in this run.
      ...(inputValues ? { runInputs: inputValues } : {}),
      // Whose run this is. The supervisor records its own runs against the task
      // when the task ends; without this marker the runner would record them
      // too, and every loop call would be counted twice.
      ...(loopTaskId ? { loopTaskId: String(loopTaskId) } : {}),
      nodeStatus: Object.fromEntries(flowCopy.nodes.map(n => [n.id, 'pending']))
    });
    this.store.appendLog(runId, {
      event: 'flow_run_created', flowId: flow.id, workspace: workspace ?? null,
      approvalMode: normalizeApprovalMode(approvalMode ?? this.config.approvalMode),
      attended: attended === true ? true : (attended === false ? false : null),
      ...(modeId ? { modeId } : {}),
      ...(hasLaunch ? { overrideNodes: Object.keys(launchOverrides) } : {}),
      ...(compareGroup?.id ? { compareGroup: String(compareGroup.id) } : {}),
      nodes: flowCopy.nodes.length, edges: flowCopy.edges.length
    });
    this.notify(runId);
    // A `repo` input clones before the walk starts, so the launch is async from
    // here; everything else is already on disk.
    if (inputsNode) {
      this.materializeInputs(runId, flowCopy, inputsNode, inputValues)
        .then(() => this.launch(runId, flowCopy))
        .catch(err => this.fail(runId, err));
    } else {
      this.launch(runId, flowCopy);
    }
    return runId;
  }

  // Write each declared input to its own port artifact (nodes/inputs.<name>.md),
  // which is what makes `inputs.repo -> x` an ordinary ported edge: context
  // assembly reads it the same way it reads any other node's named output.
  //
  // A `repo` input is the one with a side effect: the URL is adopted into the
  // read-only reference library first, and what downstream nodes receive is the
  // REFERENCE, because a name they can search beats a URL they cannot fetch.
  async materializeInputs(runId, flow, node, values) {
    const specs = node.data?.declared ?? [];
    this.setNodeStatus(runId, node.id, 'active');
    const repoTargets = new Set();
    for (const spec of specs) {
      const value = values?.[spec.name];
      if (value === undefined) continue;
      let reference = null;
      if (spec.type === 'repo') {
        if (!this.references) throw new Error(`Run input "${spec.label}": this runner has no reference library to clone into.`);
        this.store.appendLog(runId, { event: 'run_input_adopt', input: spec.name, url: value });
        reference = await this.references.adopt(value, {
          about: `Adopted for run ${runId} (input "${spec.name}").`,
          onLog: msg => this.store.appendLog(runId, { event: 'run_input_clone', input: spec.name, message: msg })
        });
        this.store.appendLog(runId, {
          event: 'run_input_adopted', input: spec.name, reference: reference.name, commit: reference.commit
        });
        // On the RUN, not just in the log: everything this run produces was
        // learned from here, and the things it produces outlive the run. A
        // backlog task written from reading someone else's repository is the
        // case that matters — it names that repository's files, and without
        // this the task is claimed later by an agent standing in a workspace
        // where none of those paths exist. Observed: nine tasks describing
        // `code_quality_manager.py` and `agent.py`, correctly reported as
        // impossible by every agent that looked, while a read-only clone
        // containing both sat in the reference library the whole time.
        const meta = this.store.readMeta(runId);
        const seen = Array.isArray(meta.references) ? meta.references : [];
        if (!seen.some(r => r.name === reference.name)) {
          this.store.writeMeta(runId, {
            ...meta,
            references: [...seen, { name: reference.name, url: reference.url ?? null, commit: reference.commit ?? null }]
          });
        }
        for (const e of forwardEdges(flow.edges)) {
          if (e.source === node.id && e.sourceHandle === spec.name) repoTargets.add([e.target, reference.name]);
        }
      }
      this.store.writeNodeOutput(runId, `${node.id}.${spec.name}`, renderInputValue(spec, value, { reference }));
    }
    // P1.5: a node handed a repository needs to be able to read it. Both tools
    // are read-effect, which is all an aiStep may hold anyway (§6.4) — without
    // this the node receives a reference name and no way to open it.
    for (const [id, repo] of repoTargets) {
      const target = flow.nodes.find(n => n.id === id);
      if (!target) continue;
      const have = Array.isArray(target.data?.tools) ? target.data.tools : [];
      const granted = [...new Set([...have, 'search_references', 'read_file'])];
      // Which repository this node was POINTED AT (DECISIONS.md D38). Everything
      // downstream of the addressing problem reads it from here: the fan-out
      // preamble's addressing block, the default scope of `search_references`,
      // and the `tool_target_unexpected` log line. A node that reads the
      // workspace on purpose (`orient`) records it non-strictly, so surveying
      // home is not reported as a mis-addressed read.
      target.data = {
        ...target.data,
        ...(granted.length !== have.length ? { tools: granted } : {}),
        subjectRepo: repo,
        ...(target.data?.role === 'orient' ? { subjectStrict: false } : {})
      };
      if (granted.length !== have.length) {
        this.store.appendLog(runId, {
          event: 'run_input_granted', node: id, tools: ['search_references', 'read_file'], reason: 'fed by a repo input'
        });
      }
      this.store.appendLog(runId, { event: 'run_input_subject', node: id, reference: repo });
    }
    // The node's MAIN output is its PRIMARY port's value, because that is what a
    // primary port means everywhere else in the DSL — upstreamContext only
    // reads a `<id>.<port>` sidecar for a NON-primary port. Writing a summary
    // here instead silently hands `inputs.repo -> x` a bullet list.
    const primary = specs[0];
    const primaryText = primary && values?.[primary.name] !== undefined
      ? this.store.readNodeOutput(runId, `${node.id}.${primary.name}`)
      : null;
    this.store.writeNodeOutput(runId, node.id, primaryText ?? (specs
      .map(sp => `- **${sp.label}** (${sp.type}): ${values?.[sp.name] ?? '(not given)'}`)
      .join('\n') || '(no inputs)'));
    this.store.writeFlow(runId, flow);
    this.setNodeStatus(runId, node.id, 'done');
    this.notify(runId);
  }

  // The run's captured approval mode. Falls back to the host default, then to
  // 'ask' — the safe end. A run recorded before the setting existed has no
  // approvalMode in meta and lands on the host default, preserving the old
  // node-flag behavior only when that default is 'node'.
  approvalMode(runId) {
    const meta = this.store.readMeta(runId);
    return normalizeApprovalMode(meta?.approvalMode ?? this.config.approvalMode);
  }

  // Ask the configured cheap model whether this call is risky. The host injects
  // config.safety = { model, resolveModelSource } — the runner never sees keys
  // or settings. Missing config means no screening is possible, which is
  // 'caution': ask the human.
  async screenToolCall(runId, nodeId, call) {
    const safety = this.config.safety;
    const verdict = await checkToolCall(call, {
      resolve: safety?.resolveModelSource ?? null,
      model: safety?.model ?? null,
      retry: this.config.retry
    });
    this.store.appendLog(runId, {
      event: 'tool_safety_check', node: nodeId, tool: call.tool,
      risk: verdict.risk, reason: verdict.reason, source: verdict.source,
      ...(verdict.model ? { model: verdict.model } : {}),
      ...(verdict.durationMs != null ? { durationMs: verdict.durationMs } : {})
    });
    return verdict;
  }

  approvePlan(runId) { this.resolveGate(runId, true); }
  rejectPlan(runId, reason = '') {
    this.store.appendLog(runId, { event: 'human_decision', decision: 'rejected', reason });
    this.resolveGate(runId, false);
  }
  resolveGate(runId, approved) {
    const resolve = this.gates.get(runId);
    if (resolve) {
      this.gates.delete(runId);
      resolve(approved);
      return;
    }
    // No live gate (the app restarted while the run was paused): the gate
    // state lives in meta.json (stage awaiting_approval + pendingNodeId +
    // pendingGateKind), so resume the run from its persisted file state.
    this.resumeFromGate(runId, approved);
  }

  // Resume a flow run that was paused at an approval gate when the app died.
  // completed/taskIdByNode are rebuilt from meta.nodeStatus and flow.json in
  // execute(); retry budgets reset (they are bounded either way).
  resumeFromGate(runId, approved) {
    const meta = this.store.readMeta(runId);
    if (!meta?.flowId || meta.stage !== 'awaiting_approval') {
      throw new Error('No pending approval for this run.');
    }
    const flow = this.store.readFlow(runId);
    if (!flow) throw new Error(`Run ${runId} has no flow.json; cannot resume.`);
    const nodeId = meta.pendingNodeId;
    const kind = meta.pendingGateKind ?? 'pre';

    // A tool gate paused mid-executor; that call stack died with the app and
    // can't be resumed. Abort the task honestly rather than pretending to
    // approve/reject an in-flight tool call.
    if (kind === 'tool') {
      this.store.appendLog(runId, { event: 'tool_gate_abandoned', node: nodeId, reason: 'app restarted during tool approval' });
      this.store.setStage(runId, 'failed', {
        pendingNodeId: null, pendingGateKind: null, pendingToolCall: null,
        error: 'The app restarted while a tool call was awaiting approval; the task was aborted. Re-run the flow.'
      });
      if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      this.notify(runId);
      return;
    }

    if (!approved) {
      this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
      if (nodeId) this.setNodeStatus(runId, nodeId, kind === 'escalation' ? 'failed' : 'pending');
      this.notify(runId);
      return;
    }

    this.store.appendLog(runId, {
      event: 'human_decision', decision: 'approved', node: nodeId,
      context: kind === 'escalation' ? 'step-eval escalation (resumed after restart)' : 'checkpoint (resumed after restart)'
    });
    const extra = { pendingNodeId: null, pendingGateKind: null };
    if (kind === 'pre' && nodeId) {
      // Remember the decision so the pre-node gate() doesn't pause again on
      // the resumed walk.
      extra.approvedGates = [...(meta.approvedGates ?? []), nodeId];
    }
    this.store.writeMeta(runId, { ...this.store.readMeta(runId), ...extra, interrupted: false });
    if (kind === 'escalation' && nodeId) this.setNodeStatus(runId, nodeId, 'done');
    this.launch(runId, flow, true);
  }

  setNodeStatus(runId, nodeId, status, extra = {}) {
    const meta = this.store.readMeta(runId);
    this.store.writeMeta(runId, {
      ...meta, ...extra,
      nodeStatus: { ...meta.nodeStatus, [nodeId]: status },
      updatedAt: new Date().toISOString()
    });
    this.notify(runId);
  }

  async execute(runId, flow, resume = false) {
    this.store.setStage(runId, 'execution');
    this.notify(runId);

    // Next free task-N id, derived from tasks.json so ids never collide with
    // tasks spawned by create_task (tool calls or stitch fix tasks).
    const nextTaskId = () => {
      const doc = this.store.readTasks(runId) ?? { tasks: [] };
      const maxN = doc.tasks.reduce((m, t) =>
        Math.max(m, Number((String(t.id).match(/^task-(\d+)$/) ?? [])[1] ?? 0)), 0);
      return `task-${maxN + 1}`;
    };
    const opts = { taskIdByNode: new Map(), nextTaskId, retryBudget: new Map() };
    const completed = new Set();

    // Resuming from persisted state (after an app restart): completed nodes
    // come from meta.nodeStatus, and agentTask -> task mappings from the
    // taskIds recorded in the run's flow.json.
    if (resume) {
      const meta = this.store.readMeta(runId);
      for (const n of flow.nodes) {
        // 'skipped' counts as walked-past: a follow-up turn on a failed run
        // retires the old failure path rather than re-running it (FU7).
        const s = meta.nodeStatus?.[n.id];
        if (s === 'done' || s === 'skipped') completed.add(n.id);
        if (n.type === 'agentTask' && n.data?.taskId) opts.taskIdByNode.set(n.id, n.data.taskId);
      }
      this.store.appendLog(runId, { event: 'flow_run_resumed', completed: completed.size, total: flow.nodes.length });
    }

    // Dynamic topological walk: readiness is recomputed after every wave so
    // nodes materialized by plan-eval mid-run join the schedule, and nodes a
    // step-eval sends back for retry (postProcess requeue) re-enter it.
    const maxParallel = Math.max(1, Number(this.config.maxParallel ?? 4));
    for (;;) {
      // RUN-CONTROL hard stop: stop() already recorded the cancelled end
      // state; the walk just leaves without touching the stage again.
      if (this.stopRequests.has(runId)) return;
      // RUN-CONTROL soft pause: requested at any moment, taken here — between
      // waves, so the wave in flight always settles first. meta.paused flips
      // true only once the hold actually lands, then the walk parks on the
      // pause gate until resume() (or stop()) resolves it.
      if (this.pauseRequests.has(runId)) {
        this.pauseRequests.delete(runId);
        this.store.writeMeta(runId, { ...this.store.readMeta(runId), paused: true });
        this.store.appendLog(runId, { event: 'run_paused' });
        this.notify(runId);
        await new Promise(resolve => this.pauseGates.set(runId, resolve));
        this.pauseGates.delete(runId);
        if (this.stopRequests.has(runId)) return; // stopped out of the hold
        this.store.writeMeta(runId, { ...this.store.readMeta(runId), paused: false });
        this.store.appendLog(runId, { event: 'run_resumed', from: 'pause' });
        this.notify(runId);
      }
      const nodesById = new Map(flow.nodes.map(n => [n.id, n]));
      const order = topoSort(flow); // also validates: throws on cycles
      // Orchestrator children live inside their container's box (parentId):
      // materialized ones (managedBy) and authored ones alike are run by the
      // container's inline sub-walk — the outer scheduler never picks them up.
      const ready = order.filter(n => !completed.has(n.id) && !n.data?.managedBy && !n.parentId &&
        forwardEdges(flow.edges).every(e =>
          e.target !== n.id || completed.has(e.source) || !nodesById.has(e.source)));
      if (!ready.length) break;

      // Wave selection: independent nodes that neither rewrite the flow
      // (plan-eval) nor pause at a gate run concurrently; everything else runs
      // alone. agentTask belongs here too (D7, V1 task 6): its runNode only
      // queues a task into tasks.json — a synchronous, therefore atomic,
      // append — and the queued tasks then execute in parallel below.
      const parallelSafe = n => !n.data?.requiresApproval && (
        (n.type === 'aiStep'
          // plan-eval and feedback-review rewrite the flow; both run alone.
          // effectiveRole: an Evaluation node set to evalType 'plan' IS plan-eval.
          && !['plan-eval', 'feedback-review'].includes(effectiveRole(n.data?.role ?? 'custom', n.data?.evalType)))
        || n.type === 'agentTask');
      const safe = ready.filter(parallelSafe);
      const batch = safe.length > 1 ? safe.slice(0, maxParallel) : [ready[0]];

      if (batch.length > 1) {
        this.store.appendLog(runId, { event: 'wave_start', nodes: batch.map(n => n.id) });
        const results = await Promise.allSettled(batch.map(n => this.runNode(runId, flow, n, opts)));
        batch.forEach((n, i) => { if (results[i].status === 'fulfilled') completed.add(n.id); });
        const rejected = results.find(r => r.status === 'rejected');
        if (rejected) throw rejected.reason;
        // agentTasks in the wave only queued their work; run the queue (itself
        // bounded-parallel) before anything downstream sees their outputs.
        if (batch.some(n => n.type === 'agentTask')
          && !await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return;
        for (let i = 0; i < batch.length; i++) {
          if (!await this.applyPost(runId, flow, batch[i], results[i].value, opts, completed)) return;
        }
        continue;
      }

      const node = batch[0];
      if (!await this.gate(runId, node)) return; // rejected at a checkpoint
      const outcome = await this.runNode(runId, flow, node, opts);
      if (node.type === 'agentTask') {
        // Run the contributed task (and anything it spawns via create_task)
        // through the existing executor before anything downstream.
        if (!await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return;
      }
      completed.add(node.id);
      if (!await this.applyPost(runId, flow, node, outcome, opts, completed)) return;
    }

    if (this.stopRequests.has(runId)) return; // stopped during the final wave
    this.store.setStage(runId, 'done', { currentTaskId: null });
    this.#recordSpend(runId);
    this.notify(runId);
  }

  // Atomically claim the next runnable pending task, or null when there is
  // none. The read-modify-write of tasks.json is fully SYNCHRONOUS, so Node
  // runs it to completion before any other continuation can interleave: two
  // concurrent schedulers can never claim the same task. Claiming flips the
  // task to 'running', which is also what drives multi-active task status in
  // the UI (V1 task 6).
  //
  // A task is runnable when every dependsOn is 'done' (an unknown id is
  // ignored rather than deadlocking) and `canClaim` accepts it.
  claimNextTask(runId, canClaim = () => true) {
    const doc = this.store.readTasks(runId);
    if (!doc) return null;
    const byId = new Map(doc.tasks.map(t => [t.id, t]));
    const task = doc.tasks.find(t => t.status === 'pending'
      && (t.dependsOn ?? []).every(d => !byId.has(d) || byId.get(d).status === 'done')
      && canClaim(t));
    if (!task) return null;
    task.status = 'running';
    this.store.writeTasks(runId, doc);
    this.store.appendLog(runId, { event: 'task_claimed', task: task.id, node: `executor:${task.id}` });
    return task;
  }

  // Run one already-claimed task to completion. Never rejects: the outcome
  // comes back as a record so the scheduler can keep draining the other
  // in-flight tasks instead of losing them to an exception.
  // `gate` is { node } when this task's tool calls must be approved (node is
  // only the pause's attribution target and may be null), or null when they
  // run unattended. The caller decides — see gateFor in runPendingTasks.
  async runClaimedTask(runId, task, taskIdByNode, flow, ledger, gate = null) {
    const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
    if (nodeId) this.setNodeStatus(runId, nodeId, 'active', { currentTaskId: task.id });
    // RUN-CONTROL: the task's model calls are abortable via stop().
    const abortCtl = this.trackAbort(runId);
    const opts = {
      ledger,
      // Mirror the agent's reply into the task's output file as it streams, so
      // a long tool-using task is watchable instead of silent (V1 task 8). Each
      // agent turn restarts the text (see runAgent), so what shows is the turn
      // in progress — including the tool block it is about to ask approval for.
      // Parallel tasks each stream into their own tasks/<id>.md, so they can't
      // scribble over one another.
      onText: this.streamInto(runId, t => this.store.writeTaskOutput(runId, task.id, t)),
      onRetry: this.retryLogger(runId, `executor:${task.id}`),
      retry: this.config.retry,
      timeout: this.config.timeout,
      backlog: this.backlog ?? null,
      feedback: this.feedback ?? null,
      references: this.references ?? null,
      // read_run's diff: what an earlier attempt on this task actually changed.
      pool: this.pool ?? null,
      signal: abortCtl.signal,
      ...(gate ? { approveToolCall: call => this.toolGate(runId, gate.node, call) } : {})
    };
    ledger.begin(task.id);
    try {
      const retro = await runExecutorTask(this.store, runId, task.id, this.config, opts);
      // A stopped task requeues (retro.stopped): its node goes back to
      // 'pending', not 'failed' — the run was cancelled, the task didn't lose.
      if (nodeId) this.setNodeStatus(runId, nodeId,
        retro.stopped ? 'pending' : retro.status === 'failed' ? 'failed' : 'done');
      return { taskId: task.id, ok: !retro.stopped && retro.status !== 'failed', retro };
    } catch (err) {
      // runExecutorTask folds model/tool errors into a failed retrospective, so
      // reaching here means something unexpected threw. Mark the task failed so
      // it is never re-claimed and its dependents stay blocked. (A stop lands
      // inside runExecutorTask's own catch, never here.)
      const doc = this.store.readTasks(runId);
      const t = doc?.tasks.find(t => t.id === task.id);
      if (t) { t.status = 'failed'; this.store.writeTasks(runId, doc); }
      this.store.appendLog(runId, { event: 'task_error', task: task.id, error: String(err?.message ?? err) });
      if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      return { taskId: task.id, ok: false, error: String(err?.message ?? err) };
    } finally {
      ledger.end(task.id);
      this.untrackAbort(runId, abortCtl);
    }
  }

  // Drain tasks.json through the executor with bounded parallelism (D7, V1
  // task 6): independent tasks run concurrently up to config.maxParallel.
  // Returns false (and fails the run) when a task fails.
  //
  // Two things stay serialized on purpose:
  //   - a gated task runs ALONE, because the gate promise (this.gates) is
  //     per-run — two tasks pausing at once would collide over it. Same reason
  //     the outer walk keeps gated nodes solo.
  //   - once a task fails we stop claiming, but still await the in-flight ones
  //     so no task keeps writing after the run is marked failed.
  async runPendingTasks(runId, taskIdByNode, flow = null) {
    const maxParallel = Math.max(1, Number(this.config.maxParallel ?? 4));
    const ledger = createWriteLedger();
    const nodeFor = task => {
      const nodeId = [...taskIdByNode.entries()].find(([, tid]) => tid === task.id)?.[0];
      return nodeId && flow ? flow.nodes.find(n => n.id === nodeId) : null;
    };

    // Does this task's tool calls need approval? The flag lives on the TASK
    // (persisted when an agentTask node queues it, and inherited by anything
    // create_task spawns) rather than being re-derived from the node graph: a
    // spawned task has no node of its own, so reading the gate off the graph let
    // an agent delegate its destructive work to a child and have it run against
    // the real workspace unapproved. Tasks recorded before the flag existed fall
    // back to their node.
    //
    // The run's approvalMode (DESIGN-SPEC.md §5) overrides the node flag in both
    // directions, because it is the more recent and more explicit statement of
    // intent — the user chose it for THIS run, in the chatbox, seconds ago:
    //   'always' — nothing is gated, whatever the node says.
    //   'ask'    — everything is gated, whatever the node says.
    //   'smart'  — everything is gated too; the gate then screens the call and
    //              lets safe ones through without bothering the human. The task
    //              still runs solo, since it may pause.
    const mode = this.approvalMode(runId);
    const isGated = task => {
      if (mode === 'always') return false;
      if (mode === 'ask' || mode === 'smart') return true;
      return Boolean(task.approveToolCalls ?? nodeFor(task)?.data?.approveToolCalls);
    };

    // The gate to run a claimed task under, or null when it is unattended. The
    // node is the pause's attribution target only: walk createdBy up to the
    // nearest ancestor that has one, so a spawned task pauses under the node
    // whose gate it inherited. Gating never depends on finding one — toolGate
    // takes a null node and simply skips the canvas highlight.
    const gateFor = task => {
      if (!isGated(task)) return null;
      const own = nodeFor(task);
      if (own) return { node: own };
      const byId = new Map((this.store.readTasks(runId)?.tasks ?? []).map(t => [t.id, t]));
      let t = byId.get(task.createdBy);
      for (let hops = 0; t && hops < 100; hops++) {
        const n = nodeFor(t);
        if (n) return { node: n };
        t = byId.get(t.createdBy);
      }
      return { node: null };
    };

    const running = new Map(); // taskId -> Promise<outcome>
    let failure = null;

    for (;;) {
      // RUN-CONTROL: after a stop, no new task is claimed — in-flight ones
      // unwind via their abort signals and the loop drains.
      while (!failure && !this.stopRequests.has(runId) && running.size < maxParallel) {
        // A gated task may only start when nothing else is in flight.
        const task = this.claimNextTask(runId, t => !isGated(t) || running.size === 0);
        if (!task) break;
        running.set(task.id, this.runClaimedTask(runId, task, taskIdByNode, flow, ledger, gateFor(task)));
        if (isGated(task)) break; // keep it alone until it settles
      }
      if (!running.size) break;
      if (running.size > 1) {
        this.store.appendLog(runId, { event: 'task_wave', tasks: [...running.keys()] });
      }
      const outcome = await Promise.race(running.values());
      running.delete(outcome.taskId);
      if (!outcome.ok && !failure) failure = outcome;
    }

    // The batch has drained; no task is current any more.
    const meta = this.store.readMeta(runId);
    if (meta?.currentTaskId) this.store.writeMeta(runId, { ...meta, currentTaskId: null });

    if (failure) {
      // A human tool-gate rejection already set stage 'rejected'; don't
      // clobber it with a generic failure. A stop already set 'cancelled'
      // (a stopped task carries the aborted flag too) — same rule.
      if (!failure.retro?.aborted && !this.stopRequests.has(runId)) {
        const why = failure.retro ? failure.retro.problems.join('; ') : failure.error;
        this.store.setStage(runId, 'failed', { error: `Task ${failure.taskId} failed: ${why}` });
      }
      this.notify(runId);
      return false;
    }
    this.notify(runId);
    return true;
  }

  // Per-tool-call approval gate: pause the run before a gated task's
  // destructive tool call and wait for a human decision, reusing the same gate
  // promise + IPC as the pre-node gate. Approve -> the tool runs; reject ->
  // false (the agent loop throws an abort). The pending call is surfaced in
  // meta for the UI. `node` is the pause's attribution target and may be null
  // (a task that inherited its gate but maps to no node) — the pause itself
  // still happens; only the canvas highlight is skipped.
  async toolGate(runId, node, call) {
    const summary = call.tool === 'bash' ? call.args?.command : call.args?.path;
    const nodeId = node?.id ?? null;

    // 'smart' mode: screen the call first and let a clean verdict through
    // without waking the human. Only 'safe' passes — 'caution' and 'danger'
    // both fall through to the pause below, carrying the verdict with them so
    // the approval bar can say WHY it stopped. checkToolCall never throws and
    // fails closed, so a broken or unreachable classifier degrades this mode
    // into plain "ask permission" rather than into "approve everything".
    let verdict = null;
    if (this.approvalMode(runId) === 'smart') {
      verdict = await this.screenToolCall(runId, nodeId, call);
      if (verdict.risk === 'safe') return true;
    }

    if (nodeId) this.setNodeStatus(runId, nodeId, 'waiting');
    this.store.appendLog(runId, {
      event: 'tool_gate_pause', node: nodeId, tool: call.tool, summary: summary ?? null,
      ...(verdict ? { risk: verdict.risk, reason: verdict.reason } : {})
    });
    this.store.setStage(runId, 'awaiting_approval', {
      pendingNodeId: nodeId, pendingGateKind: 'tool',
      pendingToolCall: {
        tool: call.tool,
        summary: summary ?? null,
        ...(verdict ? { risk: verdict.risk, reason: verdict.reason, checkedBy: verdict.model ?? verdict.source } : {})
      }
    });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      this.store.appendLog(runId, { event: 'tool_gate_decision', node: nodeId, tool: call.tool, decision: 'rejected' });
      // stop() settles the gate with false too — but a stop is a cancel, not a
      // rejection: the cancelled state stop() wrote must stand.
      if (!this.stopRequests.has(runId)) {
        this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null, pendingToolCall: null });
        if (nodeId) this.setNodeStatus(runId, nodeId, 'failed');
      }
      return false;
    }
    this.store.appendLog(runId, { event: 'tool_gate_decision', node: nodeId, tool: call.tool, decision: 'approved' });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null, pendingToolCall: null });
    if (nodeId) this.setNodeStatus(runId, nodeId, 'active');
    return true;
  }

  // React to a node's structured outcome (stitch fix tasks, step-eval
  // verdicts) and fold the result back into the scheduler's bookkeeping:
  // a step-eval retry un-completes the target + eval nodes so the main walk
  // re-runs them with normal status handling. Returns false to stop the run.
  async applyPost(runId, flow, node, outcome, opts, completed) {
    const post = await this.postProcess(runId, flow, node, outcome, opts);
    if (!post.ok) return false;
    for (const id of post.requeue ?? []) {
      completed.delete(id);
      this.setNodeStatus(runId, id, 'pending');
    }
    return true;
  }

  // Returns { ok, requeue?: nodeIds[] }.
  async postProcess(runId, flow, node, outcome, opts) {
    if (outcome?.fixTasks?.length) {
      for (const ft of outcome.fixTasks) {
        const rec = await executeTool('create_task', ft, {
          store: this.store, runId, taskId: node.id,
          defaultWorker: this.config.workers.executor
        });
        this.store.appendLog(runId, {
          event: 'stitch_fix_task', node: node.id,
          ok: rec.ok, created: rec.result?.created, error: rec.error
        });
      }
      if (!await this.runPendingTasks(runId, opts.taskIdByNode, flow)) return { ok: false };
    }
    // A refine node that asked clarifying questions parks the whole run at the
    // awaiting_input gate until the user answers (DECISIONS.md D27).
    if (outcome?.questions?.length) return this.handleNodeQuestions(runId, flow, node, outcome.questions);
    if (outcome?.stepEval) return this.handleStepEval(runId, flow, node, outcome.stepEval, opts);
    // A feedback-edge verdict is handled exactly like a step-eval verdict — the
    // explicit feedback targets take precedence inside handleStepEval.
    if (outcome?.feedback) return this.handleStepEval(runId, flow, node, outcome.feedback, opts);
    if (outcome?.feedbackReview) return this.handleFeedbackReview(runId, flow, node, outcome.feedbackReview);
    return { ok: true };
  }

  // Act on a structured step-eval verdict:
  //   pass     -> continue
  //   retry    -> bounded re-run of the evaluated upstream node with the
  //               guidance persisted as retry-for-<node>.md, then re-evaluate.
  //               Implemented as a requeue: the target and this eval node are
  //               un-completed so the main walk re-runs both in order (no
  //               recursion, normal scheduler status bookkeeping).
  //   escalate -> pause at the human approval gate (approve = continue)
  // Returns { ok, requeue? }.
  async handleStepEval(runId, flow, node, evalResult, opts) {
    const { verdict, reason, guidance } = evalResult;
    if (verdict === 'pass') return { ok: true };

    // The evaluated node(s). Explicit feedback edges win (the node rework's
    // feedback point names its target); otherwise fall back to the classic
    // heuristic — the last upstream work node feeding this step-eval.
    const fbTargets = flow.edges.filter(e => isFeedbackEdge(e) && e.source === node.id)
      .map(e => flow.nodes.find(n => n.id === e.target))
      .filter(n => n && n.type !== 'input' && n.type !== 'output');
    const evalRoles = new Set(['plan-start', 'plan-eval', 'step-eval', 'stitch', 'combine', 'compare', 'final-eval', 'feedback-review', 'plan', 'verify']);
    const upstream = forwardEdges(flow.edges).filter(e => e.target === node.id)
      .map(e => flow.nodes.find(n => n.id === e.source))
      .filter(Boolean);
    const heuristic = upstream.filter(n =>
        n.type === 'agentTask' || (n.type === 'aiStep' && !evalRoles.has(n.data?.role ?? 'custom'))).pop()
      ?? upstream.filter(n => n.type === 'aiStep' || n.type === 'agentTask').pop();
    const targets = fbTargets.length ? fbTargets : (heuristic ? [heuristic] : []);

    const maxRetries = Math.max(0, Number(node.data?.maxRetries ?? 1));
    const used = opts.retryBudget.get(node.id) ?? 0;

    if (verdict === 'retry' && targets.length && used < maxRetries) {
      opts.retryBudget.set(node.id, used + 1);
      for (const target of targets) {
        const guidanceText = [
          `# Retry guidance from ${node.data?.title || node.id} (attempt ${used + 1} of ${maxRetries})`,
          '',
          `Reason the previous attempt was rejected: ${reason || '(none given)'}`,
          '',
          guidance || '(no specific guidance — address the stated reason)'
        ].join('\n');
        this.store.writeNodeOutput(runId, `retry-for-${target.id}`, guidanceText);
        this.store.appendLog(runId, { event: 'step_eval_retry', node: node.id, target: target.id, attempt: used + 1, reason });

        if (target.type === 'agentTask') {
          // Reset the node's task to pending with the guidance as an extra
          // input; the requeued walk runs it through the executor again.
          const doc = this.store.readTasks(runId);
          const t = doc?.tasks.find(t => t.id === opts.taskIdByNode.get(target.id));
          if (t) {
            t.status = 'pending';
            if (!t.inputs.includes(`retry-for-${target.id}`)) t.inputs.push(`retry-for-${target.id}`);
            this.store.writeTasks(runId, doc);
          }
        }
      }
      // Un-complete the work node(s) and this eval node: the scheduler re-runs
      // the target (which picks up retry-for-<id>.md), then re-evaluates.
      return { ok: true, requeue: [...targets.map(t => t.id), node.id] };
    }

    // escalate — explicitly requested, retry budget exhausted, or no target.
    this.store.appendLog(runId, {
      event: 'step_eval_escalate', node: node.id, reason,
      retriesUsed: used, cause: verdict === 'retry' ? 'retry budget exhausted' : 'verdict'
    });
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id, pendingGateKind: 'escalation' });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      // A stop() settling the gate is a cancel, not a rejection.
      if (!this.stopRequests.has(runId)) {
        this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
        this.setNodeStatus(runId, node.id, 'failed');
        this.notify(runId);
      }
      return { ok: false };
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id, context: 'step-eval escalation' });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null });
    this.setNodeStatus(runId, node.id, 'done');
    return { ok: true };
  }

  // A node emitted clarifying questions: park the run at the awaiting_input
  // gate (sibling of awaiting_approval) until the user answers from the
  // composer, then re-run the node with the answers as context.
  //
  // "Is somebody there to ANSWER a question" (t-0084) is a property of how the
  // run was STARTED — `flyt run` parks on waitForRun and replies through
  // `run:answerInput` — not of approvalMode, whose 'always' also means four
  // other things (context-file edits, the question gate, the t-0083 pre-gate,
  // and scripted runs). Only a run started attended may park on its questions;
  // everything else proceeds on stated assumptions.
  isAttended(runId) {
    const said = this.store.readMeta(runId)?.attended;
    if (said === true || said === false) return said;
    // A caller that did not say gets exactly what it got before this existed.
    //
    // Defaulting an unset value to `false` reads as the careful choice and is
    // the opposite: the desktop app does not pass this, so every interrogation
    // in the UI would have silently stopped asking and started assuming — with
    // a person sitting in front of it, which is the most attended context there
    // is. Seven interrogation tests caught it by timing out; the app has no
    // test that would have.
    //
    // So an unset value falls back to the rule this replaces, and the flag only
    // ever OVERRIDES it. Nothing changes for a caller that has not been taught
    // to say.
    return this.approvalMode(runId) !== 'always';
  }

  // Role-agnostic since D38: `refine` asks about the request, `orient` asks
  // about the workspace, and both park identically. Since D46 the number of
  // rounds is the node's, not the gate's: `refine`/`orient` still get exactly
  // one, `interrogate` gets several, and `answeredInputs` is COUNTED rather
  // than tested for membership — it already appended one entry per round, so
  // the record needed no new shape. Returns { ok, requeue? }.
  async handleNodeQuestions(runId, flow, node, questions) {
    // Nobody is there to answer unless the run was STARTED attended (t-0084):
    // `flyt run` parks on waitForRun and replies through `run:answerInput`, so
    // it parks here. The loop and every scripted caller did not promise a
    // reader — approvalMode: always still passes the t-0083 pre-gate below and
    // never reaches this branch differently than before. Questions are
    // recorded and the run proceeds on the node's stated assumptions. They
    // stay visible in the node's output and in the log, so a human reading the
    // run afterwards sees exactly which forks were taken blind.
    if (!this.isAttended(runId)) {
      this.store.writeNodeOutput(runId, `${node.id}.answers`,
        '(nobody was available to answer — this run is unattended. Proceed on your stated assumptions.)');
      this.store.appendLog(runId, {
        event: 'input_gate_skipped', node: node.id, questions: questions.length,
        reason: 'unattended run (not started attended; approvalMode: ' + this.approvalMode(runId) + ')'
      });
      return { ok: true };
    }
    this.store.writeNodeQuestions(runId, node.id, questions);
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_input', {
      pendingNodeId: node.id, pendingGateKind: 'input', pendingQuestions: questions
    });
    this.store.appendLog(runId, { event: 'input_gate', node: node.id, questions: questions.length });
    this.notify(runId);
    const answers = await new Promise(resolve => this.inputGates.set(runId, resolve));
    // stop() settles the gate with null — a cancel, not an answer. The
    // cancelled end state is already written; just unwind.
    if (answers == null && this.stopRequests.has(runId)) return { ok: false };
    const text = String(answers ?? '').trim() || '(the user provided no answer — proceed on your stated assumptions)';
    // Multi-round (D46): the transcript is the node's second deliverable, so a
    // later round must not overwrite what an earlier one established. One round
    // per section, in order, headed by the questions that produced it — a spec
    // whose interrogation reads back as a conversation can be argued with.
    const prior = this.store.readNodeOutput(runId, `${node.id}.answers`) ?? '';
    const round = countAnsweredRounds(this.store.readMeta(runId), node.id) + 1;
    const section = [
      `### Round ${round}`,
      questions.map((q, i) => `**Q${i + 1}.** ${q.text}`).join('\n'),
      '',
      text
    ].join('\n');
    this.store.writeNodeOutput(runId, `${node.id}.answers`,
      prior.trim() ? `${prior.trimEnd()}\n\n${section}` : section);
    // One write, not two. Clearing the pending question and leaving the stage
    // at awaiting_input — even for the microseconds between two writes — is a
    // readable state in which the run says it is asking something and has no
    // question to show. A snapshot taken there renders an empty gate.
    const meta = this.store.readMeta(runId);
    this.store.setStage(runId, 'execution', {
      answeredInputs: [...(meta.answeredInputs ?? []), node.id],
      pendingNodeId: null, pendingGateKind: null, pendingQuestions: null
    });
    this.store.appendLog(runId, { event: 'input_answered', node: node.id, chars: text.length });
    this.notify(runId);
    // Requeue the refine node: the walk re-runs it, now with the answers in
    // context, and it produces the settled brief without asking again.
    return { ok: true, requeue: [node.id] };
  }

  // Answer a run parked at the awaiting_input gate (DECISIONS.md D27). Distinct
  // from run:followUp — this closes an in-flight question, it does not open a
  // new turn. Works whether the walk is still parked on the live promise or the
  // app restarted (persisted-state path, mirroring resumeFromGate).
  answerInput(runId, answersText) {
    let meta;
    try { meta = this.store.readMeta(runId); } catch { throw new Error(`Run ${runId} not found.`); }
    if (!meta?.flowId || meta.stage !== 'awaiting_input') {
      throw new Error('This run is not waiting for input.');
    }
    const nodeId = meta.pendingNodeId;
    const text = String(answersText ?? '').trim();
    const live = this.inputGates.get(runId);
    if (live) {
      // The walk is parked on the promise: it handles the bookkeeping + re-run.
      this.inputGates.delete(runId);
      live(text);
      return { ok: true };
    }
    // App restarted while gated: no live promise. Record the answers, mark the
    // node answered (one-round cap), requeue it, and relaunch with resume.
    const flow = this.store.readFlow(runId);
    if (!flow) throw new Error(`Run ${runId} has no flow.json; cannot resume.`);
    if (nodeId) this.store.writeNodeOutput(runId, `${nodeId}.answers`, text || '(the user provided no answer — proceed on your stated assumptions)');
    this.store.writeMeta(runId, {
      ...meta,
      answeredInputs: [...(meta.answeredInputs ?? []), nodeId].filter(Boolean),
      nodeStatus: { ...meta.nodeStatus, ...(nodeId ? { [nodeId]: 'pending' } : {}) },
      stage: 'execution', pendingNodeId: null, pendingGateKind: null, pendingQuestions: null,
      interrupted: false
    });
    this.store.appendLog(runId, { event: 'input_answered', node: nodeId, resumed: true });
    this.notify(runId);
    this.launch(runId, flow, true);
    return { ok: true };
  }

  // Optional human checkpoint before a node. Returns false when rejected.
  async gate(runId, node) {
    if (!node.data?.requiresApproval) return true;
    // Unattended (DESIGN-SPEC.md §5: 'always' IS "the agent runs unattended"):
    // pass the checkpoint rather than park a run nobody can release. This is
    // the same contract isGated() honours above — 'always' means nothing is
    // gated, whatever the node says — applied by the last reader that ignored
    // it: a run here had already concluded three times that no human was
    // answering its questions, then parked at this gate waiting for one. The
    // pass is logged so an unattended run says which gates it went through
    // rather than passing them silently. 'ask' and 'smart' fall through and
    // pause exactly as before; no mode's meaning changes, and no gate becomes
    // skippable under any other mode.
    if (this.approvalMode(runId) === 'always') {
      this.store.appendLog(runId, {
        event: 'approval_gate_skipped', node: node.id,
        reason: 'unattended run (approvalMode: always)'
      });
      return true;
    }
    // Already approved before a restart (see resumeFromGate): don't re-pause.
    if (this.store.readMeta(runId).approvedGates?.includes(node.id)) return true;
    this.setNodeStatus(runId, node.id, 'waiting');
    this.store.setStage(runId, 'awaiting_approval', { pendingNodeId: node.id, pendingGateKind: 'pre' });
    this.notify(runId);
    const approved = await new Promise(resolve => this.gates.set(runId, resolve));
    if (!approved) {
      // A stop() settling the gate is a cancel, not a rejection.
      if (!this.stopRequests.has(runId)) {
        this.store.setStage(runId, 'rejected', { pendingNodeId: null, pendingGateKind: null });
        this.setNodeStatus(runId, node.id, 'pending');
      }
      return false;
    }
    this.store.appendLog(runId, { event: 'human_decision', decision: 'approved', node: node.id });
    this.store.setStage(runId, 'execution', { pendingNodeId: null, pendingGateKind: null });
    this.notify(runId);
    return true;
  }

  // Upstream context: every incoming node's output, labeled by its title.
  // When the target node has a contextSpec, we build a *minimal* context using only
  // the explicitly listed files + the per-file descriptions the planner provided.
  // This directly implements "do not use any more context than necessary".
  upstreamContext(runId, flow, node, taskIdByNode) {
    // Feedback edges are a reverse channel (verdict + guidance, delivered as
    // retry-for-<id>.md), never forward context.
    const incoming = forwardEdges(flow.edges).filter(e => e.target === node.id);
    const spec = node.data?.contextSpec;
    if (spec && Array.isArray(spec.files) && spec.files.length) {
      // A minimal-context node pulls only its declared files and ignores its
      // upstream outputs — so record its incoming edges as carrying nothing.
      // That is exactly what makes them draw thin on the canvas (flare 3).
      this.recordEdgeContext(runId, Object.fromEntries(incoming.map(e => [e.id, 0])));
      return this.buildMinimalContext(runId, node);
    }

    const parts = [];
    const sizes = {};
    for (const e of incoming) {
      const src = flow.nodes.find(n => n.id === e.source);
      if (!src) continue;
      const label = src.data?.title?.trim() || src.type;
      let content, aux = null;
      const port = e.sourceHandle;
      if (src.type === 'agentTask') {
        content = this.store.readTaskOutput(runId, taskIdByNode.get(src.id) ?? '');
      } else if (src.type === 'input') {
        content = src.data?.text;
      } else {
        // The edge may pick a declared output port of the source. Auxiliary
        // ports live in nodes/<id>.<port>.md; the primary port (or an absent
        // sourceHandle) is the node's main output. A missing port artifact
        // falls back to the main output rather than dropping the edge.
        aux = port && port !== primaryPort(src)
          ? this.store.readNodeOutput(runId, `${src.id}.${port}`)
          : null;
        content = aux ?? this.store.readNodeOutput(runId, src.id);
      }
      sizes[e.id] = content ? content.length : 0;
      if (port && aux) {
        parts.push(`--- ${label} (${src.id} · output: ${port}) ---\n${content}`);
        continue;
      }
      if (content) parts.push(`--- ${label} (${src.id}) ---\n${content}`);
    }
    this.recordEdgeContext(runId, sizes);
    return parts;
  }

  // Persist, per edge id, how many characters of context flowed along it, for
  // the canvas to weight the line (flare 3). Merge (never clobber) — a run
  // assembles context for many nodes, each contributing its own incoming edges.
  // Synchronous read-modify-write is atomic under the single-threaded loop, the
  // same assumption every other meta write here already relies on.
  recordEdgeContext(runId, sizes) {
    if (!sizes || !Object.keys(sizes).length) return;
    const meta = this.store.readMeta(runId);
    this.store.writeMeta(runId, {
      ...meta,
      edgeContext: { ...(meta.edgeContext ?? {}), ...sizes }
    });
  }

  // Resolve one contextSpec path against the run's artifacts, in order:
  // agent workspace file, well-known artifacts (prompt/plan/tasks.md), a node
  // output (nodes/<id>.md), a task output (tasks/<id>.md). Null = not found.
  resolveContextFile(runId, rawPath) {
    const p = String(rawPath).trim();
    // The BOUND PROJECT first. When a run is pointed at a real repo, a planner
    // declaring "Context files: src/types.ts" means that repo's file. This
    // resolved only against the run's own sandbox, so every contextSpec naming a
    // real project file came back [NOT FOUND] — the minimal-context mechanism
    // couldn't see the project it was aimed at (V1 task 12).
    const ws = this.workspaceFor(runId);
    if (ws) {
      try {
        const c = ws.readFile(p);
        if (c != null) return { content: c, source: `${p} (project)` };
      } catch { /* escapes the project root — fall through to the other roots */ }
    }
    try {
      const c = this.store.readWorkspaceFile(runId, p);
      if (c != null) return { content: c, source: `workspace/${p}` };
    } catch { /* path escapes the workspace — fall through to the other roots */ }
    const bare = p.replace(/^\.\//, '').replace(/\.md$/i, '');
    if (bare === 'prompt') return { content: this.store.readPrompt(runId), source: 'prompt.md' };
    if (bare === 'plan') {
      const c = this.store.readPlan(runId);
      if (c != null) return { content: c, source: 'plan.md' };
    }
    if (bare === 'tasks' || bare === 'tasks-md') {
      const c = this.store.readNodeOutput(runId, 'tasks-md');
      if (c != null) return { content: c, source: 'nodes/tasks-md.md' };
    }
    const n = this.store.readNodeOutput(runId, bare);
    if (n != null) return { content: n, source: `nodes/${bare}.md` };
    const t = this.store.readTaskOutput(runId, bare);
    if (t != null) return { content: t, source: `tasks/${bare}.md` };
    return null;
  }

  // Build minimal context from an explicit contextSpec on the node. Files
  // that cannot be resolved are surfaced explicitly (to the model AND the
  // audit log) instead of silently dropped.
  buildMinimalContext(runId, node) {
    const spec = node.data.contextSpec;
    const parts = [];
    for (const f of (spec.files || [])) {
      if (!f?.path) continue;
      const hit = this.resolveContextFile(runId, f.path);
      const desc = f.description ? ` (${f.description})` : '';
      if (hit) {
        parts.push(`--- ${f.path}${desc} [from ${hit.source}] ---\n${hit.content}`);
      } else {
        parts.push(`--- ${f.path}${desc} ---\n[NOT FOUND: no matching file in workspace/, nodes/, tasks/, or run artifacts. Proceed using the description above and state any assumptions you make.]`);
        this.store.appendLog(runId, { event: 'context_file_missing', node: node.id, path: f.path });
      }
    }
    if (parts.length === 0) return [];
    return [`MINIMAL CONTEXT (only explicitly declared files):\n\n${parts.join('\n\n')}`];
  }

  async runNode(runId, flow, node, opts) {
    const { taskIdByNode, nextTaskId } = opts;
    // RUN-CONTROL: a stop can land while the walk is suspended at an await
    // before this node starts (the gate, a wave boundary). Never begin new
    // node work for a stopped run — stop() aborts what is IN flight; this
    // guard covers what has not started yet.
    if (this.stopRequests.has(runId)) throw abortError(`Node ${node.id} not started: run stopped`);
    this.setNodeStatus(runId, node.id, 'active', { currentNodeId: node.id });

    if (node.type === 'input') {
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'input' });
      this.store.writeNodeOutput(runId, node.id, node.data?.text ?? '');
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    if (node.type === 'agentTask') {
      // Resuming after a restart: the node already contributed a task on a
      // previous pass — reuse it instead of queueing a duplicate.
      const priorId = node.data?.taskId;
      const priorDoc = priorId ? this.store.readTasks(runId) : null;
      const prior = priorDoc?.tasks.find(t => t.id === priorId);
      if (prior) {
        taskIdByNode.set(node.id, prior.id);
        this.store.appendLog(runId, {
          event: 'node_resume', node: node.id, type: 'agentTask',
          taskId: prior.id, taskStatus: prior.status
        });
        // The task already finished on the previous pass (the app died between
        // the task's last write and this node being marked done): the node's
        // work IS the task, so honor it as done instead of re-running it.
        if (prior.status === 'done') {
          this.setNodeStatus(runId, node.id, 'done');
          return;
        }
        prior.status = 'pending';
        this.store.writeTasks(runId, priorDoc);
        this.setNodeStatus(runId, node.id, 'queued');
        return;
      }
      const taskId = nextTaskId();
      taskIdByNode.set(node.id, taskId);
      const upstream = forwardEdges(flow.edges).filter(e => e.source && e.target === node.id).map(e => e.source);
      const specFiles = (node.data?.contextSpec?.files ?? []).map(f => f?.path).filter(Boolean);
      const inputs = ['prompt.md', ...upstream
        .map(srcId => {
          const src = flow.nodes.find(n => n.id === srcId);
          if (!src || src.type === 'input') return null;
          return src.type === 'agentTask' ? `${taskIdByNode.get(srcId)} output` : srcId;
        })
        .filter(Boolean), ...specFiles];
      const route = resolveWorkerRoute(node, this.config);
      const worker = route.worker;
      const task = {
        id: taskId,
        title: node.data?.title || 'Task',
        goal: node.data?.goal || node.data?.title || '',
        inputs,
        constraints: node.data?.constraints ?? [],
        // Template/override instructions ride along as constraints so the
        // executor honors them without a schema change.
        ...(node.data?.instructions?.trim()
          ? { constraints: [...(node.data?.constraints ?? []), node.data.instructions.trim()] }
          : {}),
        // Tool availability comes from the node template (overridable per
        // workflow); undefined = the full registry.
        ...(Array.isArray(node.data?.tools) ? { tools: node.data.tools } : {}),
        // The effect contract (WR-01). The AUTHORED intent travels with the
        // task when there is one; role/category travel regardless, because the
        // executor runs from tasks.json alone and never sees the node, and
        // without them it could only infer from the tool grant. The mode itself
        // is resolved in the executor, where the resolved tool records are.
        ...(node.data?.effect ? { effect: node.data.effect } : {}),
        ...(node.data?.effectScope ? { effectScope: node.data.effectScope } : {}),
        // Inputs the plan declared REQUIRED (WR-06). Opt-in and explicit: the
        // `inputs` list above stays best-effort, so only what a planner
        // actually promised is enforced before the model is called.
        ...(node.data?.requiredInputs?.length ? { requiredInputs: node.data.requiredInputs } : {}),
        ...(node.data?.outputs?.length ? { outputs: node.data.outputs } : {}),
        ...(node.data?.role ? { role: node.data.role } : {}),
        ...(node.data?.category ? { category: node.data.category } : {}),
        // The ceiling rides along for the same reason the grant does: the
        // executor runs from tasks.json alone and never sees the node. Absent
        // ⇒ the ceiling is the grant (DESIGN-SPEC.md §5), so a task written
        // before ceilings existed keeps exactly its envelope.
        ...(node.data?.toolCeiling ? { toolCeiling: node.data.toolCeiling } : {}),
        // Skills ride on the task for the same reason tools do: the executor
        // runs from tasks.json alone and never sees the node. Resolved against
        // the bound project at execution time, not here (V1 task 10).
        ...(node.data?.skills?.length ? { skills: node.data.skills } : {}),
        // The gate travels with the task, not the node: create_task copies it
        // onto anything this task spawns, so delegated work can't slip past the
        // approval the node asked for (see gateFor in runPendingTasks).
        ...(node.data?.approveToolCalls ? { approveToolCalls: true } : {}),
        dependsOn: upstream.map(srcId => taskIdByNode.get(srcId)).filter(Boolean),
        worker,
        status: 'pending'
      };
      const tasksDoc = this.store.readTasks(runId) ?? { tasks: [] };
      tasksDoc.tasks.push(task);
      this.store.writeTasks(runId, tasksDoc);
      // Record the node -> task mapping in the run's flow copy for the UI.
      node.data = { ...node.data, taskId };
      this.store.writeFlow(runId, flow);
      this.store.appendLog(runId, {
        event: 'node_start', node: node.id, type: 'agentTask', taskId, worker,
        // How this worker was chosen (WR-04). Without it, "the run used a model
        // I did not pick" has no answer in the artifacts — and the log, the
        // renderer's preview and the actual call could disagree silently.
        route: { via: route.via, reason: route.reason, ...(route.candidates ? { candidates: route.candidates } : {}) }
      });
      this.setNodeStatus(runId, node.id, 'queued');
      return;
    }

    if (node.type === 'aiStep') {
      // The 'evaluation' meta-role resolves through the node's evalType.
      const role = effectiveRole(node.data?.role ?? 'custom', node.data?.evalType);
      const route = resolveWorkerRoute(node, this.config);
      const worker = resolveCallTarget(route.worker, this.config);
      const apiKey = worker.apiKey;
      // Read-only tools on a planning node (§6.4). Resolved before node_start
      // so the log records HOW this node will call them, the same way an
      // agentTask's does — the gap the `protocol` field exists to close.
      const stepTools = this.aiStepTools(runId, node);
      if (stepTools.length && worker.provider !== 'mock' && worker.provider !== 'anthropic') {
        worker.supportsTools = supportsToolsFor(worker, this.config);
      }
      this.store.appendLog(runId, {
        event: 'node_start', node: node.id, type: 'aiStep', role,
        // The EFFECTIVE provider/model — after an 'auto' source has walked the
        // priority list — beside how it was chosen (WR-04). The requested route
        // rides along whenever it differs, so a run that resolved somewhere
        // other than where you expected says so in one line.
        worker: { provider: worker.provider, model: worker.model },
        ...(route.worker.provider !== worker.provider || route.worker.model !== worker.model
          ? { requested: { provider: route.worker.provider, model: route.worker.model } } : {}),
        route: { via: route.via, reason: route.reason, ...(route.candidates ? { candidates: route.candidates } : {}) },
        ...(stepTools.length ? { protocol: toolProtocol(worker), tools: stepTools.map(t => t.name) } : {}),
        ...(node.data?.effort ? { effort: node.data.effort } : {})
      });
      let system = this.applySkills(runId, node.id,
        node.data?.system?.trim() || DEFAULT_SYSTEM[role] || DEFAULT_SYSTEM.custom,
        node.data?.skills);
      if (role === 'translate') {
        system += `\n\nTARGET LANGUAGE: ${node.data?.language?.trim() || 'English'}`;
      }
      // A planner deciding what a future worker needs has to be shown what
      // this project HAS. Told to name skills without the menu, it either
      // names none (which is what happened) or invents one that resolves to
      // nothing at run time — and both failures are silent.
      if (role === BACKLOG_PLAN_ROLE) {
        const menu = availableSkillsSection(listSkills(this.workspaceFor(runId)));
        if (menu) system += `

${menu}`;
      }
      // Feedback channel (node rework): a node wired back to an upstream node
      // via a feedback edge judges that node's work with a structured verdict.
      // Roles with their own verdict/materialization contracts keep them.
      const feedbackTargets = flow.edges
        .filter(e => isFeedbackEdge(e) && e.source === node.id)
        .map(e => flow.nodes.find(n => n.id === e.target))
        .filter(Boolean);
      const ownContract = ['step-eval', 'feedback-review', 'plan-eval'].includes(role);
      if (feedbackTargets.length && !ownContract) {
        system += [
          '',
          '',
          'FEEDBACK LINK: you are wired back to '
            + feedbackTargets.map(t => `"${t.data?.title || t.id}" (${t.id})`).join(', ')
            + ' — the node(s) whose output you received.',
          'After your deliverable, end with ONE ```json block:',
          '{ "verdict": "pass" | "retry", "reason": "<one line>", "guidance": "<retry only: what to do differently>" }',
          'Use "retry" when that upstream work needs revision — it re-runs with your',
          'guidance, then you review again (bounded). Otherwise use "pass".'
        ].join('\n');
      }
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const retryGuidance = this.store.readNodeOutput(runId, `retry-for-${node.id}`);
      // A refine node re-running after the awaiting_input gate gets the user's
      // answers to the questions it asked (DECISIONS.md D27).
      // Both roles that may park at the input gate re-run with the user's
      // answers in context (DECISIONS.md D27, D38).
      const gateAnswers = ASKING_ROLES.includes(role)
        ? this.store.readNodeOutput(runId, `${node.id}.answers`) : null;
      // D46. An interrogation has to know where it stands in its own budget:
      // "you have one round left" is what turns a node that would keep asking
      // into one that settles. Told plainly rather than implied, because a
      // model cannot count rounds it cannot see.
      const roundsUsed = role === 'interrogate'
        ? countAnsweredRounds(this.store.readMeta(runId), node.id) : 0;
      const roundsAllowed = role === 'interrogate' ? questionRoundsFor(node) : 0;
      const roundNotice = role !== 'interrogate' ? '' : (roundsUsed + 1 >= roundsAllowed
        ? `INTERROGATION BUDGET: this is your LAST round (${roundsUsed + 1} of ${roundsAllowed}). Do not ask again — settle the remaining forks yourself, record them as assumptions, and emit "status": "settled".`
        : `INTERROGATION BUDGET: round ${roundsUsed + 1} of at most ${roundsAllowed}. Settle earlier than that if the answers already carry the shape.`);
      // Planning roles learn from prior runs' retrospectives (historyDigest),
      // matching the classic pipeline's planner behavior.
      const history = (role === 'plan' || role === 'plan-start') ? this.store.historyDigest() : '';
      // The orientation seed (D38): assembled facts about this workspace,
      // so the cheapest node in the flow does not spend its first four tool
      // calls rediscovering that package.json exists. A starting point, not the
      // answer — the node holds tools precisely so it can go past it.
      // D38's seed, D46's second reader. Both nodes exist to aim what comes
      // after them, and both are worthless if they have to spend their first
      // tool calls rediscovering that package.json exists.
      const seed = (role === 'orient' || role === 'interrogate')
        ? homeSeed(this.workspaceFor(runId)) : '';
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        node.data?.goal?.trim() ? `GOAL:\n${node.data.goal.trim()}` : '',
        node.data?.instructions?.trim() ? `EXTRA INSTRUCTIONS (from the node template / workflow):\n${node.data.instructions.trim()}` : '',
        seed ? `WHAT IS ALREADY KNOWN ABOUT THIS WORKSPACE (assembled, not judged — verify anything load-bearing):\n${seed}` : '',
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : '',
        gateAnswers ? (role === 'interrogate'
          ? `THE INTERROGATION SO FAR (your questions and the answers given — build on these; never ask any of it again):\n${gateAnswers}`
          : `USER ANSWERS TO YOUR CLARIFYING QUESTIONS (incorporate these and do NOT ask again):\n${gateAnswers}`) : '',
        roundNotice,
        history ? `LESSONS FROM PREVIOUS RUNS (retrospective recommendations):\n${history}` : '',
        retryGuidance ? `RETRY GUIDANCE (a previous attempt was rejected — fix this):\n${retryGuidance}` : ''
      ].filter(Boolean).join('\n\n');

      // Incremental output: stream the partial text into the node's output file
      // so the inspector and the live panel show work as it happens.
      const writeStream = this.streamInto(runId, t => this.store.writeNodeOutput(runId, node.id, t));

      // Planner liveness (WR-06). A planning node that streams the same
      // sentence forever without calling a tool is spending money to stand
      // still — and the general heartbeat only caught it after ~6 minutes of
      // byte-identical work. This watches for a lack of NOVEL visible work, not
      // for elapsed time, so a quiet reasoning call is never its business.
      const planning = ['plan', 'plan-start', 'plan-eval', 'split'].includes(role);
      const spin = planning ? createSpinDetector({ thresholds: this.config.planner?.spin ?? {} }) : null;
      const spinCtl = spin ? new AbortController() : null;
      let spinTripped = null;
      // `onText` carries the whole turn so far (http.js renderTurn), and the
      // detector takes an incremental chunk. Feeding it the cumulative buffer
      // re-counted every line on every emission, so a healthy long plan looked
      // like a spin purely for being long: novelty is distinct-over-recent, and
      // recent filled with duplicates of lines the model wrote exactly once.
      // Watched it kill a real planning call at 77 seconds, reporting "560,242
      // lines with only 49 distinct ones" for an answer that was never
      // anywhere near that size — the detector written to avoid judging by
      // elapsed time was, in effect, judging by elapsed time.
      let seenText = '';
      const newlyStreamed = text => {
        const s = String(text ?? '');
        // A re-render that is not an extension (reasoning interleaving) is
        // pushed whole rather than guessed at.
        const next = s.startsWith(seenText) ? s.slice(seenText.length) : s;
        seenText = s;
        return next;
      };
      const onText = spin
        ? (text, opts) => {
            const state = spin.push(newlyStreamed(text));
            if (state.tripped && !spinTripped) {
              spinTripped = state;
              this.store.appendLog(runId, {
                event: 'planner_spin', node: node.id, reason: state.reason, ...state.metrics
              });
              // Stop paying for it. The partial stream stays on disk as the
              // evidence, and the node fails with the reason rather than
              // hanging until the six-minute heartbeat notices.
              spinCtl.abort();
            }
            return writeStream(text, opts);
          }
        : writeStream;

      let result;
      try {
        result = await this.trackedRunAgent(runId, node.id, {
          ...worker, apiKey, system, prompt: userMsg, onText,
          ...(spinCtl ? { abortSignal: spinCtl.signal } : {}),
          // Read-only aiSteps normally inherit the host-wide tool ceiling. A
          // flow may narrow one node below it: orientation should inspect just
          // enough of both projects to aim the expensive readers, not become a
          // full repository audit before fan-out even starts.
          ...(Number(node.data?.maxToolIterations) > 0
            ? { maxIterations: Math.floor(Number(node.data.maxToolIterations)) }
            : {}),
          // Effort level sets the response budget; medium keeps the default.
          maxTokens: effortBudget(node.data?.effort),
          onRetry: this.retryLogger(runId, node.id), retry: this.config.retry
        }, stepTools, subjectOf(node));
        // A call that comes back with nothing is not a success. Recording one as
        // success wrote a 0-byte artifact, marked the node done, and handed
        // emptiness to every downstream node — the run read as healthy the whole
        // way while producing nothing. Only ever seen against a real provider;
        // the mock always answers, which is why this survived to V1 task 11.
        if (!String(result.text ?? '').trim()) {
          throw new Error(describeEmptyTurn(worker, result));
        }
        // A truncated deliverable must never be handed downstream as though it
        // were whole. A live synthesis ended after 406 characters, mid-heading,
        // and was still marked done; its planner then spent against an invalid
        // premise. Keep the partial artifact for diagnosis, but fail the node
        // visibly so a larger budget/model can be chosen before work is queued.
        if (result.finishReason === 'length') {
          const partial = String(result.text ?? '').trim();
          if (partial) this.store.writeNodeOutput(runId, node.id, partial);
          this.store.appendLog(runId, {
            event: 'output_truncated', node: node.id, role,
            model: `${worker.provider}/${worker.model}`,
            maxTokens: EFFORT_MAX_TOKENS[node.data?.effort] ?? null,
            chars: partial.length
          });
          throw new Error(`The model response was cut off at the token budget (finish_reason "length") after ${partial.length} characters; the partial artifact was preserved and downstream nodes were not run.`);
        }
      } catch (err) {
        // RUN-CONTROL stop: an aborted call is not a node failure — no failed
        // retrospective, no 'failed' status. The node goes back to 'pending'
        // so a later restart re-runs it; the partial streamed text on disk is
        // an honest partial. The abort error unwinds the walk (fail() mutes
        // itself under stopRequests).
        // A planner interrupted for spinning is NOT a user stop: it must fail
        // with its reason and keep its partial stream as evidence, not requeue
        // as though somebody had pressed pause (WR-06).
        if (spinTripped && isAbortError(err) && !this.stopRequests.has(runId)) {
          err = new Error(`Planning was interrupted: ${spinTripped.reason}.`);
        } else if (isAbortError(err) || this.stopRequests.has(runId)) {
          this.store.appendLog(runId, { event: 'node_aborted', node: node.id, role });
          this.setNodeStatus(runId, node.id, 'pending');
          throw isAbortError(err) ? err : abortError(`Node ${node.id} stopped`);
        }
        const msg = String(err?.message ?? err);
        this.store.appendLog(runId, { event: 'node_error', node: node.id, role, error: msg });
        this.store.writeRetrospective(runId, node.id, makeRetrospective({
          node: node.id,
          status: 'failed',
          problems: [msg],
          resolution: 'Node failed; run stopped and escalated to human.',
          confidence: 0,
          recommendation: `AI step "${node.data?.title || role}" failed calling ${worker.provider}/${worker.model} — check provider key/config, then retry the run.`,
          model: { provider: worker.provider, model: worker.model }
        }));
        this.setNodeStatus(runId, node.id, 'failed');
        throw new Error(`Node ${node.id} (${role}) failed: ${msg}`);
      }

      const outText = String(result.text ?? '').trim();
      this.store.writeNodeOutput(runId, node.id, outText);

      const outcome = {};
      const problems = [];

      // A turn that parsed ZERO tool calls but whose text carries a model's
      // native tool-call markup means the model tried to act and this harness
      // did not understand it: nothing ran, and the raw markup would otherwise
      // sit in the deliverable looking like content. Recorded as a problem so
      // it reaches the retrospective (and `flyt why`) without anyone reading
      // the call trace. Detection only — never executed, because parsing a
      // dialect we do not speak well enough to run is how a wrong tool call
      // gets made confidently. A model that narrates alongside a real call
      // (result.toolCalls non-empty) or merely DISCUSSES these dialects
      // (quoted in a code fence while explaining them) must stay silent.
      // Asked here rather than relied on being carried: the value reaches this
      // point through four different return shapes — two agent loops, a
      // tool-less early return, and  short-circuiting
      // straight to  when a node holds no tools, which is
      // the path the node that produced the original failure takes. Three of
      // the four had to be found one at a time. One place asking one question
      // cannot drift the way four places passing a field can.
      const dialect = result.toolCalls?.length ? null
        : (result.unparsedToolCall ?? unparsedToolDialect(result.text));
      if (dialect) {
        problems.push(`model emitted a ${dialect} tool call as message content, which this harness cannot parse — no tool ran and no result was returned; the raw markup is in the output below`);
      }

      // Special handling for the documented example nodes (FLOW_NODES.md)
      if (role === 'plan' || role === 'plan-start') {
        // Write the primary planning artifact as tasks.md (plus classic plan for compat)
        this.store.writePlan(runId, outText); // keep compat
        if (outText.includes('## task-') || outText.toLowerCase().includes('context files')) {
          this.store.writeNodeOutput(runId, 'tasks-md', outText);
        }
      }
      if (role === 'plan-eval') {
        // Persist a clean sidecar for downstream consumption / inspection
        this.store.writeNodeOutput(runId, 'plan-eval', outText);
        let mat = this.materializeGeneratedNodes(runId, flow, node, outText);
        if (!mat.ok) {
          // Real models sometimes emit malformed contract JSON: one bounded
          // re-ask that feeds the validation errors back before giving up.
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, mat.errors);
          if (fixed != null) {
            this.store.writeNodeOutput(runId, node.id, fixed);
            this.store.writeNodeOutput(runId, 'plan-eval', fixed);
            mat = this.materializeGeneratedNodes(runId, flow, node, fixed);
            if (mat.ok) {
              this.store.writeNodeOutput(runId, 'plan-eval-errors', [
                '# Plan-eval contract violations (resolved)',
                '',
                'The first attempt violated the contract; a re-ask with the validation errors produced a valid plan.'
              ].join('\n'));
            }
          }
        }
        if (!mat.ok) problems.push(...mat.errors);
        outcome.materialized = mat.ok && mat.created.length > 0;
        outcome.materializedCount = mat.created.length;
        // Auxiliary "summary" output port (see flowTypes ROLE_PORTS).
        const summary = extractJson(this.store.readNodeOutput(runId, node.id))?.summary;
        if (typeof summary === 'string' && summary.trim()) {
          this.store.writeNodeOutput(runId, `${node.id}.summary`, summary.trim());
        }
      }
      if (role === 'step-eval') {
        let verdictObj = parseStepEvalVerdict(outText);
        if (!verdictObj) {
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText,
            ['no ```json block with { "verdict": "pass" | "retry" | "escalate", "reason", "guidance" } found']);
          if (fixed != null) {
            verdictObj = parseStepEvalVerdict(fixed);
            if (verdictObj) this.store.writeNodeOutput(runId, node.id, fixed);
          }
        }
        if (verdictObj) {
          outcome.stepEval = verdictObj;
          // Auxiliary "verdict" output port: just the structured decision.
          this.store.writeNodeOutput(runId, `${node.id}.verdict`, JSON.stringify(verdictObj, null, 2));
          this.store.appendLog(runId, { event: 'step_eval_verdict', node: node.id, ...verdictObj });
        } else {
          problems.push('step-eval emitted no structured verdict JSON block; treated as pass');
          this.store.appendLog(runId, { event: 'step_eval_no_verdict', node: node.id });
        }
      }
      if (role === 'compare') {
        // Inspectability sidecar, matching combine-report / stitch-report.
        this.store.writeNodeOutput(runId, 'compare-report', outText);
      }
      if (role === 'stitch' || role === 'combine') {
        this.store.writeNodeOutput(runId, role === 'combine' ? 'combine-report' : 'stitch-report', outText);
        const st = parseStitchDirectives(outText);
        if (st) {
          problems.push(...(st.errors ?? []));
          if (st.fixTasks.length) outcome.fixTasks = st.fixTasks;
        }
      }
      if (role === 'final-eval') {
        this.store.writeNodeOutput(runId, 'final-eval', outText);
      }
      if (role === 'refine') {
        // The primary "prompt" port is the clean brief — downstream nodes
        // consume it as the run request, so strip the trailing questions fence.
        const brief = stripRefineQuestions(outText);
        if (brief && brief !== outText) this.store.writeNodeOutput(runId, node.id, brief);
        // On an answer re-run the node already asked once (T6's one-round cap,
        // which D46 expresses as questionRoundsFor(node) === 1 for this role):
        // parse questions, but a re-run must never park again.
        const answered = countAnsweredRounds(this.store.readMeta(runId), node.id)
          >= questionRoundsFor(node);
        const parsed = answered ? null : parseRefineQuestions(outText);
        if (parsed?.questions?.length) {
          this.store.writeNodeOutput(runId, `${node.id}.questions`, renderQuestions(parsed.questions));
          outcome.questions = parsed.questions;
          this.store.appendLog(runId, { event: 'refine_questions', node: node.id, count: parsed.questions.length });
        } else {
          if (answered && parseRefineQuestions(outText)) {
            this.store.appendLog(runId, { event: 'refine_questions_capped', node: node.id, reason: 'one-round cap: second-round questions ignored' });
          }
          this.store.appendLog(runId, { event: 'refine_done', node: node.id });
        }
      }
      if (role === 'interrogate') {
        // The spec is the deliverable, so the contract block is stripped from
        // the primary port the way the refiner's questions are.
        const spec = stripJsonBlock(outText);
        if (spec && spec !== outText) this.store.writeNodeOutput(runId, node.id, spec);

        let parsed = parseInterrogation(outText);
        if (!parsed.ok) {
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, parsed.errors);
          if (fixed != null) {
            const reparsed = parseInterrogation(fixed);
            if (reparsed.ok) {
              parsed = reparsed;
              this.store.writeNodeOutput(runId, node.id, stripJsonBlock(fixed) || fixed);
            }
          }
        }
        // Degrade, never fail (§6). An interrogation whose contract will not
        // parse twice has still WRITTEN a specification — the prose is the
        // deliverable and it stands. What it loses is the right to ask again,
        // which is the safe direction to fail in: the run proceeds on what is
        // on the page instead of parking on a question nobody can read.
        const interrogation = parsed.ok ? parsed.interrogation : {
          status: 'settled', confidence: 'low', questions: [], assumptions: [],
          unknowns: ['The interrogation contract could not be parsed, so this specification was settled without a further round.']
        };
        if (!parsed.ok) {
          problems.push('interrogation emitted no parseable status JSON; settled on the specification as written');
          this.store.appendLog(runId, { event: 'interrogation_failed', node: node.id, errors: parsed.errors });
        }

        const used = countAnsweredRounds(this.store.readMeta(runId), node.id);
        const allowed = questionRoundsFor(node);
        // t-0084: "nobody is there" means nobody was promised when the run
        // STARTED, not approvalMode === 'always' — that flag also governs the
        // t-0083 pre-gate and the context file, and an attended `flyt run` at
        // 'always' has a caller parked on waitForRun who can answer.
        const unattended = !this.isAttended(runId);
        const asking = interrogation.status === 'asking' && interrogation.questions.length > 0;
        // Out of rounds, or nobody there to answer. Either way the fork is
        // taken by the run rather than by a person, so it is recorded as an
        // assumption and stays visible in the artifact and the log (§4) —
        // never silently folded into the spec as though it had been settled.
        const spent = used >= allowed;
        if (asking && (unattended || spent)) {
          for (const q of interrogation.questions) {
            interrogation.assumptions.push(`ASSUMED: ${q.text} — answered by the run's own judgement, nobody was asked.`);
          }
          this.store.appendLog(runId, {
            event: 'interrogation_assumed', node: node.id,
            questions: interrogation.questions.map(q => q.text), rounds: used, allowed,
            reason: unattended ? 'unattended run' : `round budget spent (${used} of ${allowed})`
          });
          interrogation.questions = [];
        } else if (asking) {
          this.store.writeNodeOutput(runId, `${node.id}.questions`, renderQuestions(interrogation.questions));
          outcome.questions = interrogation.questions;
        }

        this.store.writeNodeOutput(runId, `${node.id}.transcript`,
          this.store.readNodeOutput(runId, `${node.id}.answers`)
            || '(no round of questions was answered — this specification was written from the request alone)');
        this.store.writeNodeOutput(runId, `${node.id}.open`,
          renderOpenItems(interrogation));
        this.store.appendLog(runId, {
          event: 'interrogation', node: node.id, status: interrogation.status,
          confidence: interrogation.confidence, rounds: used, allowed,
          asking: outcome.questions?.length ?? 0, assumptions: interrogation.assumptions.length
        });
      }
      if (role === 'orient') {
        // The prose IS the deliverable — it is the context file every
        // downstream node holds — so the fenced stance is stripped from the
        // primary port the way the refiner's questions are.
        const prose = stripJsonBlock(outText);
        if (prose && prose !== outText) this.store.writeNodeOutput(runId, node.id, prose);

        let parsed = parseOrientation(outText);
        if (!parsed.ok) {
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, parsed.errors);
          if (fixed != null) {
            const reparsed = parseOrientation(fixed);
            if (reparsed.ok) {
              parsed = reparsed;
              this.store.writeNodeOutput(runId, node.id, stripJsonBlock(fixed) || fixed);
            }
          }
        }
        // Degrade, never fail (§6): unparseable twice means the prose stands as
        // the context file and the stance defaults to `adjacent` — the reading
        // that assumes least. An orientation that cannot be parsed is still an
        // orientation someone can read.
        const orientation = parsed.ok ? parsed.orientation : {
          relation: 'adjacent', confidence: 'low', mission: '', focus: [], ignore: [],
          assumptions: ['The orientation contract could not be parsed; the stance defaults to "adjacent", which assumes least.'],
          questions: []
        };
        if (!parsed.ok) {
          problems.push('orientation emitted no parseable stance JSON; defaulted to relation "adjacent"');
          this.store.appendLog(runId, { event: 'orientation_failed', node: node.id, errors: parsed.errors });
        }

        const answered = countAnsweredRounds(this.store.readMeta(runId), node.id)
          >= questionRoundsFor(node);
        // t-0084: same signal as the interrogation — started attended means
        // somebody is parked on the run and can answer.
        const unattended = !this.isAttended(runId);
        // Unattended, a question is a fork taken blind, not a question — it is
        // recorded as an explicit assumption so the run afterwards shows which
        // ones were taken and on what basis (§4).
        if (orientation.questions.length && (unattended || answered)) {
          for (const q of orientation.questions) orientation.assumptions.push(`ASSUMED: ${q.text} — answered by the run's own judgement, nobody was asked.`);
          this.store.appendLog(runId, {
            event: 'orientation_assumed', node: node.id, questions: orientation.questions.map(q => q.text),
            reason: unattended ? 'unattended run' : 'one-round cap: already asked once'
          });
        } else if (orientation.questions.length) {
          this.store.writeNodeOutput(runId, `${node.id}.questions`, renderQuestions(orientation.questions));
          outcome.questions = orientation.questions;
        }

        this.store.writeNodeOutput(runId, `${node.id}.stance`, JSON.stringify(orientation, null, 2));
        this.store.writeNodeOutput(runId, `${node.id}.summary`,
          orientSummary(orientation, prose || outText));
        this.store.appendLog(runId, {
          event: 'orientation', node: node.id, relation: orientation.relation,
          confidence: orientation.confidence, assumptions: orientation.assumptions.length
        });
        // The workspace copy (§3.3): what makes the next run cheap. Attended
        // runs only, never over a hand edit.
        this.writeContextFile(runId, node, prose || outText, orientation);
      }
      if (role === 'feedback-review') {
        const templateIds = this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : [];
        let review = parseFeedbackReview(outText, templateIds);
        if (!review) {
          const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText,
            ['no ```json block with { "verdict": "solved" | "more-work", "reason", "nodes"? } found']);
          if (fixed != null) {
            review = parseFeedbackReview(fixed, templateIds);
            if (review) this.store.writeNodeOutput(runId, node.id, fixed);
          }
        }
        if (review) {
          outcome.feedbackReview = review;
          problems.push(...(review.errors ?? []));
          // Auxiliary "verdict" output port: just the structured decision.
          this.store.writeNodeOutput(runId, `${node.id}.verdict`,
            JSON.stringify({ verdict: review.verdict, reason: review.reason }, null, 2));
          this.store.appendLog(runId, { event: 'feedback_review_verdict', node: node.id, verdict: review.verdict, reason: review.reason });
        } else {
          problems.push('feedback-review emitted no structured verdict JSON block; treated as solved');
          this.store.appendLog(runId, { event: 'feedback_review_no_verdict', node: node.id });
        }
      }

      // Feedback channel: a node wired back to upstream work judges it with the
      // step-eval verdict shape. Missing verdict counts as pass — feedback must
      // never wedge a run.
      if (feedbackTargets.length && !ownContract) {
        const verdictObj = parseStepEvalVerdict(outText);
        if (verdictObj) {
          outcome.feedback = verdictObj;
          this.store.writeNodeOutput(runId, `${node.id}.verdict`, JSON.stringify(verdictObj, null, 2));
          this.store.appendLog(runId, { event: 'feedback_verdict', node: node.id, targets: feedbackTargets.map(t => t.id), ...verdictObj });
        } else {
          this.store.appendLog(runId, { event: 'feedback_no_verdict', node: node.id });
        }
      }

      const retro = makeRetrospective({
        node: node.id,
        status: problems.length ? 'partial' : 'success',
        problems,
        confidence: problems.length ? 0.4 : 0.75,
        recommendation: `AI step "${node.data?.title || role}" completed by ${worker.provider}/${worker.model}.`
          + (outcome.materializedCount ? ` Materialized ${outcome.materializedCount} generated node(s).` : '')
          + (outcome.stepEval ? ` Verdict: ${outcome.stepEval.verdict}.` : '')
          + (outcome.fixTasks ? ` Created ${outcome.fixTasks.length} fix task(s).` : ''),
        // The Auto Router answers as a different model than the one asked for
        // (`openrouter/auto`), and result.resolvedModel is the only place that
        // says which. Recording the request id here would make every ledger
        // entry and every retrospective say "auto".
        model: { provider: worker.provider, model: result.resolvedModel ?? worker.model,
          ...(result.resolvedModel && result.resolvedModel !== worker.model ? { requested: worker.model } : {}) },
        usage: result.usage,
        durationMs: result.durationMs,
        // A granted aiStep runs through the agent loop and can call tools
        // (DESIGN-SPEC.md §5), so its retrospective carries them like any other.
        toolCalls: result.toolCalls ?? []
      });
      this.store.writeRetrospective(runId, node.id, retro);
      recordToolUsage(this.feedback, {
        runId, nodeId: node.id, model: { provider: worker.provider, model: worker.model }, retro
      });
      this.setNodeStatus(runId, node.id, 'done');
      return outcome;
    }

    if (node.type === 'orchestrator') {
      return this.runOrchestrator(runId, flow, node, opts);
    }

    if (node.type === 'fanout') {
      return this.runFanout(runId, flow, node, opts);
    }

    if (node.type === 'subflow') {
      return this.runSubflow(runId, flow, node, opts);
    }

    if (node.type === 'loop') {
      return this.runLoop(runId, flow, node, opts);
    }

    if (node.type === 'inputs') {
      // Materialized before the walk began (materializeInputs), because a repo
      // input has to finish cloning before anything downstream can read it.
      // By the time the scheduler reaches this node its port artifacts are
      // already on disk, so there is nothing left to do.
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    if (node.type === 'output') {
      this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'output' });
      const parts = this.upstreamContext(runId, flow, node, taskIdByNode);
      const result = parts.length
        ? `# Result — ${flow.name}\n\n${parts.join('\n\n')}`
        : `# Result — ${flow.name}\n\n(no upstream outputs)`;
      this.store.writeNodeOutput(runId, node.id, result);
      this.store.writeResult(runId, result);
      this.setNodeStatus(runId, node.id, 'done');
      return;
    }

    throw new Error(`Unknown node type "${node.type}" (node ${node.id})`);
  }

  // The Orchestrator container: one autonomous planning call decides the set
  // of work nodes (same strict contract as plan-eval, one bounded re-ask),
  // the nodes are materialized INSIDE the box (parentId + managedBy, never
  // gated), executed by an inline sub-walk (parallel waves for aiSteps,
  // sequential agent tasks), and every child's output is aggregated into the
  // orchestrator's primary "results" output — downstream nodes only ever see
  // the orchestrator itself. No human intervention anywhere in the loop.
  //
  // Exception: nodes the user placed inside the box on the canvas (parentId,
  // no managedBy) ARE the plan — with authored children present the planning
  // call is skipped and exactly they run in the same sub-walk.
  async runOrchestrator(runId, flow, node, opts) {
    const worker = resolveCallTarget(resolveWorker(node, this.config), this.config);
    const apiKey = worker.apiKey;
    this.store.appendLog(runId, {
      event: 'node_start', node: node.id, type: 'orchestrator',
      worker: { provider: worker.provider, model: worker.model }
    });

    const failNode = (msg, problems = [msg]) => {
      this.store.writeRetrospective(runId, node.id, makeRetrospective({
        node: node.id,
        status: 'failed',
        problems,
        resolution: 'Orchestrator failed; run stopped and escalated to human.',
        confidence: 0,
        recommendation: `Orchestrator "${node.data?.title || node.id}" failed (${worker.provider}/${worker.model}). ${msg}`,
        model: { provider: worker.provider, model: worker.model }
      }));
      this.setNodeStatus(runId, node.id, 'failed');
      return new Error(`Orchestrator ${node.id} failed: ${msg}`);
    };

    // Resume support: children already materialized on a previous pass are
    // reused — the planning call is skipped and unfinished children re-run.
    let children = flow.nodes.filter(n => n.data?.managedBy === node.id);
    // Authored children (canvas rework): nodes the user placed inside this
    // orchestrator's box by hand. They ARE the plan — the planning call is
    // skipped and exactly they run in the inline sub-walk, their outputs
    // aggregated like materialized children's.
    const authored = !children.length
      ? flow.nodes.filter(n => n.parentId === node.id && !n.data?.managedBy)
      : [];
    if (authored.length) {
      children = authored;
      ensureChildStatuses(this.store, runId, authored);
      // The auxiliary "summary" port: the node inventory (no plan exists —
      // the canvas placement was the plan).
      this.store.writeNodeOutput(runId, `${node.id}.summary`, [
        `${children.length} authored node(s) orchestrated.`,
        '',
        ...children.map(c => `- ${c.data?.title ?? c.id} (${c.id})`)
      ].join('\n'));
      this.store.appendLog(runId, { event: 'orchestrator_authored_children', node: node.id, children: children.map(c => c.id) });
    }
    if (!children.length) {
      // Node budget (rework): the min/max dropdowns on the node bound how many
      // work nodes the planning call may declare. Defaults 1-5.
      const minNodes = Math.max(1, Math.floor(Number(node.data?.minNodes ?? 1) || 1));
      const maxNodes = Math.max(minNodes, Math.floor(Number(node.data?.maxNodes ?? 5) || 5));
      const system = this.applySkills(runId, node.id,
        node.data?.system?.trim() || DEFAULT_SYSTEM.orchestrate,
        node.data?.skills)
        + `\n\nNODE BUDGET: declare between ${minNodes} and ${maxNodes} nodes (inclusive). `
        + 'Prefer the fewest nodes that genuinely cover the work.';
      const parts = this.upstreamContext(runId, flow, node, opts.taskIdByNode);
      const userMsg = [
        `USER PROMPT:\n${this.store.readPrompt(runId)}`,
        node.data?.goal?.trim() ? `GOAL:\n${node.data.goal.trim()}` : '',
        node.data?.instructions?.trim() ? `EXTRA INSTRUCTIONS (from the workflow):\n${node.data.instructions.trim()}` : '',
        parts.length ? `CONTEXT:\n${parts.join('\n\n')}` : ''
      ].filter(Boolean).join('\n\n');

      // Stream the planning output into the "plan" sidecar as it arrives.
      const onText = this.streamInto(runId, t => this.store.writeNodeOutput(runId, `${node.id}.plan`, t));
      let result;
      try {
        result = await this.trackedCallModel(runId, {
          ...worker, apiKey, system, prompt: userMsg, onText,
          maxTokens: effortBudget(node.data?.effort),
          onRetry: this.retryLogger(runId, node.id), retry: this.config.retry
        }, node.id);
      } catch (err) {
        // RUN-CONTROL stop: not a failure — back to pending, no failed retro.
        if (isAbortError(err) || this.stopRequests.has(runId)) {
          this.store.appendLog(runId, { event: 'node_aborted', node: node.id, role: 'orchestrate' });
          this.setNodeStatus(runId, node.id, 'pending');
          throw isAbortError(err) ? err : abortError(`Orchestrator ${node.id} stopped`);
        }
        const msg = String(err?.message ?? err);
        this.store.appendLog(runId, { event: 'node_error', node: node.id, role: 'orchestrate', error: msg });
        throw failNode(msg);
      }
      let outText = String(result.text ?? '').trim();
      this.store.writeNodeOutput(runId, `${node.id}.plan`, outText);

      const templateIds = this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : [];
      // Contract violations AND budget violations both earn the one bounded
      // re-ask; a plan that stays outside the budget after that is accepted
      // with a logged warning rather than wasted (the work is still valid).
      const boundsErrors = plan => {
        const n = plan.nodes.length;
        return n < minNodes || n > maxNodes
          ? [`nodes: declared ${n} node(s); this orchestrator's node budget is ${minNodes}-${maxNodes} (inclusive)`]
          : [];
      };
      let parsed = parsePlanEval(outText, templateIds);
      const firstErrors = parsed.ok ? boundsErrors(parsed.plan) : parsed.errors;
      if (firstErrors.length) {
        const fixed = await this.reAsk(runId, node, worker, apiKey, system, userMsg, outText, firstErrors);
        if (fixed != null) {
          const reparsed = parsePlanEval(fixed, templateIds);
          if (reparsed.ok) {
            parsed = reparsed;
            outText = fixed;
            this.store.writeNodeOutput(runId, `${node.id}.plan`, fixed);
          }
        }
      }
      // Unlike plan-eval (which degrades gracefully), creating nodes IS the
      // orchestrator's job — an invalid plan fails the node honestly.
      if (!parsed.ok) throw failNode('planning output violated the node contract', parsed.errors);
      const stillOut = boundsErrors(parsed.plan);
      if (stillOut.length) {
        this.store.appendLog(runId, { event: 'orchestrator_bounds_violated', node: node.id, min: minNodes, max: maxNodes, declared: parsed.plan.nodes.length });
      }

      const mat = this.materializeParsedNodes(runId, flow, node, parsed.plan, { parentId: node.id });
      if (!mat.ok || !mat.created.length) {
        throw failNode('no nodes could be materialized from the plan', mat.errors.length ? mat.errors : ['plan declared no new nodes']);
      }
      children = mat.created;

      // Auxiliary "summary" output port: the plan summary + node inventory.
      this.store.writeNodeOutput(runId, `${node.id}.summary`, [
        parsed.plan.summary ?? `${children.length} node(s) orchestrated.`,
        '',
        ...children.map(c => `- ${c.data?.title ?? c.id} (${c.id})`)
      ].join('\n'));
      this.store.appendLog(runId, { event: 'orchestrator_spawned', node: node.id, children: children.map(c => c.id) });
    } else if (!authored.length) {
      this.store.appendLog(runId, { event: 'node_resume', node: node.id, type: 'orchestrator', children: children.length });
    }

    // The scoped sub-walk + aggregation live in core/nodes/expand.js (DECISIONS.md D36
    // P2.0): same wave semantics as the outer scheduler, bounded to the box.
    // Deciding WHICH children exist — everything above — is the part that is
    // actually the orchestrator's; running them is not.
    const title = node.data?.title?.trim() || 'Orchestrator';
    await runContainer(this, runId, flow, node, children, { ...opts, kind: 'Orchestrator', title });

    this.store.writeRetrospective(runId, node.id, makeRetrospective({
      node: node.id,
      status: 'success',
      problems: [],
      confidence: 0.75,
      recommendation: `Orchestrator "${title}" created and ran ${children.length} node(s) autonomously (${worker.provider}/${worker.model}).`,
      model: { provider: worker.provider, model: worker.model }
    }));
    this.setNodeStatus(runId, node.id, 'done');
    return {};
  }

  // The ordered model pool a PLANNED roster is staffed from (DECISIONS.md D37).
  // Explicit lane workers are pinned before this list is consulted; what is
  // left is: the node's own worker, then the model-priority ranking for this
  // kind of reading, then whatever else is active, then the configured default
  // so a run always has something to fall back on.
  //
  // Deduplicated by model id, because a pool listing one model twice would let
  // two same-preset lanes "differ" while landing on the same model.
  lanePool(node, authored = []) {
    const pool = [];
    const seen = new Set();
    const push = w => {
      const n = normalizeLaneWorker(w);
      if (!n || seen.has(n.model)) return;
      seen.add(n.model);
      pool.push(n);
    };
    push(node?.data?.worker);
    // The models the author picked for THIS fan-out. A planned roster replaces
    // their lanes, but not their judgement about which models read well here —
    // and without them, a flow whose lanes name four models by hand would have
    // nothing but the executor default to staff a planned roster from.
    for (const lane of authored) push(lane.worker);

    const active = (this.config.activeModels ?? []).filter(m => m && m.enabled !== false).map(m => m.id);
    const known = new Set(active);
    // Lanes read and report, whatever template they instantiate — so the pool
    // is ranked as analysis work unless the node says otherwise.
    const kind = taskKindOf({ type: 'aiStep', data: { role: 'analyze', category: node?.data?.category } });
    const effort = node?.data?.effort ?? 'medium';
    const order = PROVIDER_ORDER[kind]?.[effort] ?? PROVIDER_ORDER.general.medium;
    for (const provider of order) {
      if (!this.config.providerKeys?.[provider]) continue;
      for (const model of providerModelsFor(provider, kind, effort, { kimiKeyKind: this.config.kimiKeyKind })) {
        // A ranked model the user has switched off is not available to staff a
        // lane with; the lint rule that warns about it says the same thing.
        if (known.size && !known.has(model)) continue;
        push({ provider, model });
      }
    }
    for (const id of active) push(id);
    push(this.config.workers?.executor);
    return pool;
  }

  // The peek (DECISIONS.md D37): one bounded read-only look at the subject, so the
  // lane planner knows whether it is dividing up a Rust workspace or a folder
  // of notebooks. Capped at PEEK_MAX_CALLS tool calls and a small token budget.
  //
  // Its grant is the INTERSECTION of the fan-out's own read-only tools with
  // PEEK_TOOLS — never a union. A node that decides what other nodes may do
  // must not be able to do more than they may (§6.3), and that goes double for
  // the call that decides who they are.
  //
  // Total, except for a stop: no grant, or a failed call, degrades to a blind
  // planner (which is simply P3-without-P3.1, and still better than no planner).
  async fanoutPeek(runId, node, worker, apiKey, brief, subjectRepo = '') {
    const grant = this.aiStepTools(runId, node).filter(t => PEEK_TOOLS.includes(t.name));
    if (!grant.length) {
      this.store.appendLog(runId, { event: 'fanout_peek_skipped', node: node.id, reason: 'no read-only tool grant to look with' });
      return null;
    }
    const target = { ...worker };
    if (target.provider !== 'mock' && target.provider !== 'anthropic') {
      target.supportsTools = supportsToolsFor(target, this.config);
    }
    try {
      const res = await this.trackedRunAgent(runId, node.id, {
        ...target, apiKey,
        system: subjectRepo ? `${PEEK_SYSTEM}\n\n${addressingBlock(subjectRepo)}` : PEEK_SYSTEM,
        prompt: brief,
        maxTokens: PEEK_MAX_TOKENS, maxIterations: PEEK_MAX_CALLS,
        onRetry: this.retryLogger(runId, node.id), retry: this.config.retry
      }, grant, subjectRepo ? { repo: subjectRepo, strict: true } : subjectOf(node));
      const text = String(res.text ?? '').trim();
      this.store.appendLog(runId, {
        event: 'fanout_peek', node: node.id,
        tools: grant.map(t => t.name), calls: res.toolCalls?.length ?? 0
      });
      if (text) this.store.writeNodeOutput(runId, `${node.id}.peek`, text);
      return text || null;
    } catch (err) {
      if (isAbortError(err) || this.stopRequests.has(runId)) {
        throw isAbortError(err) ? err : abortError(`Fan-out ${node.id} stopped`);
      }
      this.store.appendLog(runId, { event: 'fanout_peek_skipped', node: node.id, reason: String(err?.message ?? err) });
      return null;
    }
  }

  // The orientation an upstream `orient` node settled, or null (D38 P6).
  //
  // The fan-out's own planner used to invent a mission, a focus and an ignore
  // list from the prompt alone. When a node that has actually read BOTH
  // repositories has already decided them, re-deriving them is a duplicated
  // inference with worse evidence — so the planner inherits them and its job
  // narrows to choosing a roster, which is the part it is uniquely placed to do.
  orientationFor(runId, flow, node) {
    for (const e of forwardEdges(flow.edges)) {
      if (e.target !== node.id) continue;
      const src = flow.nodes.find(n => n.id === e.source);
      if (src?.data?.role !== 'orient') continue;
      const raw = this.store.readNodeOutput(runId, `${src.id}.stance`);
      if (!raw) continue;
      try {
        const stance = JSON.parse(raw);
        if (!stance?.relation) continue;
        return { ...stance, node: src.id, summary: this.store.readNodeOutput(runId, `${src.id}.summary`) ?? '' };
      } catch { /* an unparseable sidecar is no orientation at all */ }
    }
    return null;
  }

  // The planning call (DECISIONS.md D37). Returns { plan, pool, reason } —
  // `plan` null when the roster could not be planned, with `reason` saying why
  // so `.brief.md` can be honest about running the authored fallback.
  /**
   * The one repository this run was pointed at, if there is exactly one.
   *
   * Read off the graph rather than the meta: `materializeInputs` stamps
   * `subjectRepo` on whichever nodes a repo input feeds, so the flow itself
   * already records the answer. Exactly one, or nothing — a run given two
   * repositories has no single subject, and guessing which one a reader meant
   * is worse than leaving it unscoped.
   */
  #runSubject(flow) {
    const names = new Set();
    for (const n of flow?.nodes ?? []) {
      if (n?.data?.subjectRepo) names.add(String(n.data.subjectRepo));
    }
    return names.size === 1 ? [...names][0] : null;
  }

  async planLanes(runId, flow, node, opts, authored) {
    const minLanes = Math.max(1, Math.floor(Number(node.data?.minLanes ?? DEFAULT_MIN_LANES) || DEFAULT_MIN_LANES));
    const maxLanes = Math.max(minLanes, Math.floor(Number(node.data?.maxLanes ?? DEFAULT_MAX_LANES) || DEFAULT_MAX_LANES));
    const pool = this.lanePool(node, authored);
    // Who plans the roster, when the fan-out itself names nobody.
    //
    // `resolveWorker` falls through to the global default, which is a provider
    // chosen for the whole app and has nothing to do with this flow. Watched it
    // cost a whole reading: a fan-out whose four lanes each named a working
    // OpenRouter model planned on a subscription CLI that could not start
    // (`Error loading config.toml`), so the planning call failed, the authored
    // roster ran as the fallback, and the "read it four ways" the flow exists
    // for was never shaped to the brief at all — a degradation visible only in
    // one line at the bottom of the brief file.
    //
    // The models the author staffed the lanes with are right there, already
    // ranked, and a flow that can read on them can plan on them.
    const authoredWorker = node?.data?.worker?.provider && node?.data?.worker?.model;
    const planner = !authoredWorker && pool.length ? pool[0] : resolveWorker(node, this.config);
    const worker = resolveCallTarget(planner, this.config);
    const apiKey = worker.apiKey;

    const goal = node.data?.goal?.trim() ?? '';
    const parts = this.upstreamContext(runId, flow, node, opts.taskIdByNode);
    const orientation = this.orientationFor(runId, flow, node);
    const brief = [
      `USER PROMPT:\n${this.store.readPrompt(runId)}`,
      goal ? `THIS FAN-OUT'S GOAL:\n${goal}` : '',
      orientation ? [
        `THE ORIENTATION (settled by an upstream node that read BOTH this project and the subject):`,
        `- relation to the subject: ${orientation.relation} (confidence: ${orientation.confidence})`,
        orientation.mission ? `- mission: ${orientation.mission}` : '',
        orientation.focus?.length ? `- focus: ${orientation.focus.join('; ')}` : '',
        orientation.ignore?.length ? `- low priority: ${orientation.ignore.join('; ')}` : '',
        orientation.summary ? `\n${orientation.summary}` : ''
      ].filter(Boolean).join('\n') : '',
      parts.length ? `WHAT FEEDS THIS NODE:\n${parts.join('\n\n')}` : ''
    ].filter(Boolean).join('\n\n');

    // The repo input normally feeds orientation, not the fan-out. Inherit the
    // one run subject before the peek: waiting until lane materialization made
    // the map-building call search every reference and read this workspace.
    const subjectRepo = String(node.data?.subjectRepo ?? this.#runSubject(flow) ?? '');
    const peek = await this.fanoutPeek(runId, node, worker, apiKey, brief, subjectRepo);

    const userMsg = [
      brief,
      peek ? `A QUICK LOOK AT THE SUBJECT (one bounded read-only pass — shape only, not a reading):\n${peek}` : '',
      `THE ROSTER THE AUTHOR WROTE (${authored.length}) — the fallback if you fail, and a hint at what they had in mind:\n`
        + authored.map(l => `- ${l.id} · ${l.preset ?? 'no preset'}${l.intent ? ` — ${l.intent}` : ''}`).join('\n'),
      pool.length
        ? `MODELS AVAILABLE TO STAFF LANES (${pool.length}), in preference order:\n${pool.map(p => `- ${p.model}`).join('\n')}`
        : '',
      orientation
        ? 'THE MISSION IS ALREADY SETTLED. Reuse the orientation\'s mission, focus and low-priority list '
          + 'verbatim — a node that read both repositories decided them and you have not. Your job is the '
          + 'ROSTER: which readers this relation calls for, and how many.'
        : '',
      `LANE BUDGET: declare between ${minLanes} and ${maxLanes} lanes (inclusive). `
        + `Two lanes sharing a preset are staffed on DIFFERENT models, and ${pool.length} model(s) are available — `
        + 'a roster that asks for more copies of one preset than there are models is truncated, not doubled up.'
    ].filter(Boolean).join('\n\n');

    const onText = this.streamInto(runId, t => this.store.writeNodeOutput(runId, `${node.id}.brief`, t));
    let outText;
    try {
      const result = await this.trackedCallModel(runId, {
        ...worker, apiKey, system: LANE_PLAN_SYSTEM, prompt: userMsg, onText,
        maxTokens: effortBudget(node.data?.effort),
        onRetry: this.retryLogger(runId, node.id), retry: this.config.retry
      }, `${node.id}:lane-planner`);
      outText = String(result.text ?? '').trim();
    } catch (err) {
      // A stop unwinds the walk; anything else degrades to the authored roster
      // (P3.7). A fan-out that cannot reach its planner should still read the
      // repo — same posture as workspaceFor().
      if (isAbortError(err) || this.stopRequests.has(runId)) {
        throw isAbortError(err) ? err : abortError(`Fan-out ${node.id} stopped`);
      }
      return { plan: null, pool, reason: `the planning call failed (${String(err?.message ?? err)})` };
    }

    const bounds = { presetIds: LANE_PRESET_IDS, minLanes, maxLanes };
    let parsed = parseLanePlan(outText, bounds);
    if (!parsed.ok) {
      const fixed = await this.reAsk(runId, node, worker, apiKey, LANE_PLAN_SYSTEM, userMsg, outText, parsed.errors);
      if (fixed != null) {
        const reparsed = parseLanePlan(fixed, bounds);
        if (reparsed.ok) parsed = reparsed;
      }
    }
    if (!parsed.ok) {
      this.store.appendLog(runId, { event: 'fanout_plan_failed', node: node.id, errors: parsed.errors });
      return { plan: null, pool, reason: 'the planner\'s roster violated the lane contract twice' };
    }
    // The orientation WINS on mission/focus/ignore (D38 P6). The planner is
    // told to reuse them, but told is not the same as bound: an inherited
    // mission that drifts through a re-ask is the duplicated inference coming
    // back, and the node that read both repositories is the better authority.
    const plan = orientation
      ? {
        ...parsed.plan,
        mission: orientation.mission || parsed.plan.mission,
        focus: orientation.focus?.length ? orientation.focus : parsed.plan.focus,
        ignore: orientation.ignore?.length ? orientation.ignore : parsed.plan.ignore,
        relation: orientation.relation
      }
      : parsed.plan;
    this.store.appendLog(runId, {
      event: 'fanout_planned', node: node.id, mission: plan.mission,
      ...(orientation ? { inheritedFrom: orientation.node, relation: orientation.relation } : {}),
      lanes: plan.lanes.map(l => ({ id: l.id, preset: l.preset }))
    });
    return { plan, pool, reason: '' };
  }

  // The Fan-out container (DECISIONS.md D36, planning added by D37): N
  // deliberately diverged takes on ONE brief.
  //
  // The author writes a lane list, or points at a model set, and by default
  // exactly that runs — no planning call, nothing to re-ask. Under `plan: auto`
  // the node first peeks at the subject and asks a model which of the FIXED
  // presets should be on this particular brief, and how many (D37). What keeps
  // that safe is the enum: the planner selects and duplicates presets, it never
  // writes what a lane is, so nothing it can say turns the adversarial read
  // into a flattering one.
  //
  // Every lane is told who its siblings are and asked for at least one finding
  // none of them can reach. No lane ever sees another's OUTPUT — that would
  // collapse the divergence the whole node exists to produce (B6), and it is
  // the one part of D36 that planning does not touch.
  async runFanout(runId, flow, node, opts) {
    this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'fanout' });

    const failNode = (msg, problems = [msg]) => {
      this.store.writeRetrospective(runId, node.id, makeRetrospective({
        node: node.id,
        status: 'failed',
        problems,
        resolution: 'Fan-out failed; run stopped and escalated to human.',
        confidence: 0,
        recommendation: `Fan-out "${node.data?.title || node.id}" failed. ${msg}`
      }));
      this.setNodeStatus(runId, node.id, 'failed');
      return new Error(`Fan-out ${node.id} failed: ${msg}`);
    };

    // The authored roster: what runs by default, and the fallback a planning
    // failure lands on (P3.7). Never discarded, only possibly replaced.
    const authored = resolveLanes(node, {
      modelSets: this.config.modelSets ?? {},
      activeModels: this.config.activeModels ?? null
    });
    if (!authored.length) {
      throw failNode('no lanes — declare "lanes:", or point "modelSet:" at a set with active members');
    }
    let lanes = authored;

    // Resume: children materialized on a previous pass are reused, matched
    // back to their lanes by the laneId stamped on them.
    let children = flow.nodes.filter(n => n.data?.managedBy === node.id);
    const laneOf = new Map();

    if (children.length) {
      // A resumed run re-plans zero times and re-peeks zero times: the roster
      // that ran is reconstructed from the children themselves, because under
      // `plan: auto` the authored list is not the list that ran and matching
      // against it would mislabel every lane in the aggregate.
      lanes = children.map(c => {
        const laneId = c.data?.laneId ?? c.id;
        // The child's own stamps first, the authored lane only as backfill —
        // for a run materialized before those stamps existed, and for the
        // fields a child does not carry.
        const known = authored.find(l => l.id === laneId) ?? null;
        const preset = c.data?.lanePreset ?? known?.preset ?? null;
        const lane = {
          id: laneId,
          label: c.data?.title?.trim() || known?.label || laneId,
          intent: c.data?.laneIntent ?? known?.intent ?? '',
          instructions: known?.instructions ?? '',
          worker: normalizeLaneWorker(c.data?.worker) ?? known?.worker ?? null,
          template: known?.template ?? null,
          tools: known?.tools ?? null,
          ...(preset ? { preset } : {})
        };
        laneOf.set(c.id, lane);
        return lane;
      });
      ensureChildStatuses(this.store, runId, children);
      this.store.appendLog(runId, { event: 'node_resume', node: node.id, type: 'fanout', children: children.length });
    } else {
      const goal = node.data?.goal?.trim() ?? '';
      // The repository the lanes are pointed at, when a repo input feeds this
      // node: it buys every lane the addressing block (DECISIONS.md D38).
      //
      // Inherited when this node has none of its own, because a repo input
      // feeds ONE node and it is rarely the fan-out. In `learn-from-repo` the
      // edge is `inputs.repo -> orient`, so orient was stamped and the readers
      // were not — and a lane with no subject has no default search scope, no
      // addressing block, and nothing that reports a read of the wrong
      // repository. Watched the whole reading go wrong that way: five lanes
      // read THIS project and a different reference, and the merge then
      // discarded the actual subject as irrelevant. A run has one subject; a
      // node that does the reading should not have to be the node that was
      // handed the URL.
      const subjectRepo = String(node.data?.subjectRepo ?? this.#runSubject(flow) ?? '');

      // A `system:` on the fan-out node itself is the author writing the shared
      // preamble by hand: it wins outright and skips both the peek and the
      // planning call (P3.8). Until now this key was legal on a fanout and read
      // by nothing — it lint-cleaned and did nothing at all.
      const authorSystem = typeof node.data?.system === 'string' && node.data.system.trim()
        ? node.data.system.trim() : '';
      const planMode = String(node.data?.plan ?? 'off').trim().toLowerCase();

      if (planMode === 'auto' && authorSystem) {
        this.store.appendLog(runId, {
          event: 'fanout_plan_inert', node: node.id,
          reason: 'a system prompt written on the node wins over the planner'
        });
      }

      if (planMode === 'auto' && !authorSystem) {
        const { plan, pool, reason } = await this.planLanes(runId, flow, node, opts, authored);
        let staffed = null;
        if (plan) {
          const roster = uniqueLaneIds(plan.lanes.map((l, i) => ({ ...normalizeLane(l, i), reason: l.reason ?? '' })));
          const assigned = assignWorkers(roster, pool);
          for (const d of assigned.dropped) {
            // Truncating and saying so beats three correlated reads sold as
            // coverage — the failure this node exists to prevent (P2).
            this.store.appendLog(runId, { event: 'fanout_lane_unstaffed', node: node.id, lane: d.id, preset: d.preset, reason: d.reason });
          }
          if (assigned.lanes.length) staffed = assigned.lanes;
          else this.store.appendLog(runId, { event: 'fanout_plan_failed', node: node.id, errors: ['every planned lane went unstaffed'] });
        }
        if (staffed) {
          lanes = applyPreamble(staffed, sharedPreamble({
            mission: plan.mission, subject: plan.subject, count: staffed.length,
            focus: plan.focus, ignore: plan.ignore, subjectRepo
          }));
          this.store.writeNodeOutput(runId, `${node.id}.brief`,
            renderBrief({ ...plan, lanes }));
        } else {
          // P3.7: degrade, never fail. The authored lanes run on a mission
          // derived mechanically from the goal — or, better, on the one an
          // upstream orientation already settled, which survives a planner
          // failure because it was decided before the planner ran (D38 P6).
          const settled = this.orientationFor(runId, flow, node);
          const mission = settled?.mission || `answer: ${goal || this.store.readPrompt(runId) || 'the brief above'}`;
          const fallbackReason = plan ? 'no planned lane could be staffed with a model of its own' : reason;
          const subject = subjectRepo ? `the repository \`reference:${subjectRepo}\`` : 'the subject of this brief';
          lanes = applyPreamble(authored, sharedPreamble({
            mission, subject, count: authored.length, subjectRepo,
            focus: settled?.focus ?? [], ignore: settled?.ignore ?? []
          }));
          this.store.writeNodeOutput(runId, `${node.id}.brief`, renderBrief(
            {
              mission, subject, focus: settled?.focus ?? [], ignore: settled?.ignore ?? [],
              ...(settled?.relation ? { relation: settled.relation } : {}), lanes
            },
            { fallback: true, reason: fallbackReason }));
        }
      } else if (authorSystem) {
        lanes = applyPreamble(authored, authorSystem);
      }

      const created = [];
      const errors = [];
      for (const lane of lanes) {
        const templateId = lane.template ?? node.data?.template ?? DEFAULT_LANE_TEMPLATE;
        const childId = `${node.id}-${lane.id}`;
        if (flow.nodes.some(n => n.id === childId)) {
          errors.push(`lane "${lane.id}": node id "${childId}" already exists in the flow`);
          continue;
        }
        // The lane's brief IS its instructions: the shared goal, its own
        // slant, and the roster of everyone else on the same question.
        const child = this.templateNode(templateId, childId, {
          title: lane.label,
          goal,
          instructions: laneBrief(lane, lanes, { goal }),
          // The lane's ROLE prompt (DECISIONS.md D37): the shared preamble plus the
          // preset's fixed text. It replaces DEFAULT_SYSTEM[role], which is the
          // point — one report format imposed on every lane is why four lanes
          // used to come back reading alike. A lane with neither a preset nor a
          // system of its own carries none, and falls through as it always did.
          ...(lane.system ? { system: lane.system } : {}),
          ...(lane.worker ? { worker: lane.worker } : node.data?.worker ? { worker: node.data.worker } : {}),
          // A lane with no grant of its own inherits the fan-out's, the same
          // way it inherits its template. Without this an aiStep lane gets NO
          // tools at all (aiStepTools returns [] without an explicit array),
          // so five lanes pointed at a repository would produce five confident
          // analyses of nothing.
          ...(lane.tools ? { tools: lane.tools } : Array.isArray(node.data?.tools) && node.data.tools.length ? { tools: node.data.tools } : {})
        });
        // A lane inherits the fan-out's ceiling exactly as a generated child
        // inherits an orchestrator's (§6.3) — a node that decides what other
        // nodes may do must not be able to decide they may do more than it may.
        const ceiling = node.data?.toolCeiling
          ? narrowCeiling(node.data.toolCeiling, child.data?.toolCeiling ?? null, grantContext())
          : child.data?.toolCeiling ?? null;
        child.data = {
          ...child.data,
          laneId: lane.id,
          // A fan-out authors its lane nodes. Its per-agent round budget must
          // therefore follow them; otherwise a bounded container silently
          // expands back to the host-wide default when its children start.
          ...(Number(node.data?.maxToolIterations) > 0
            ? { maxToolIterations: Math.floor(Number(node.data.maxToolIterations)) }
            : {}),
          // A lane inherits the subject the fan-out was pointed at, so its own
          // tool calls are scoped and audited the same way (DECISIONS.md D38).
          ...(subjectRepo ? { subjectRepo } : {}),
          // Stamped so a resumed run can rebuild the roster from its children
          // without re-planning: under `plan: auto` the authored lane list is
          // not the list that ran.
          ...(lane.preset ? { lanePreset: lane.preset } : {}),
          ...(lane.intent ? { laneIntent: lane.intent } : {}),
          generatedBy: node.id,
          managedBy: node.id,
          requiresApproval: false,
          ...(ceiling ? { toolCeiling: ceiling } : {})
        };
        child.parentId = node.id;
        child.extent = 'parent';
        created.push(child);
        laneOf.set(child.id, lane);
      }
      if (!created.length) throw failNode('no lane could be materialized', errors.length ? errors : ['every lane collided with an existing node id']);

      // Lanes are independent by construction — that is the entire point — so
      // there are no edges BETWEEN them. Each gets the container's wire (which
      // marks ownership) plus a wire from whatever feeds the fan-out.
      //
      // That second set is load-bearing: a lane's context would otherwise come
      // from `nodes/<fan>.md`, which does not exist until every lane has
      // finished. Without it a fan-out only works when the whole brief fits in
      // `goal` — which is exactly not the case when the upstream node is the
      // one that says which repo to read. The orchestrator escapes this by
      // writing a `.plan` sidecar its children read; a fan-out has no plan, so
      // it forwards its own inputs instead (the same thing a sub-flow splice
      // does for the inner input node).
      const inbound = forwardEdges(flow.edges).filter(e => e.target === node.id);
      const edges = created.flatMap(c => [
        { id: `gen-e-${node.id}-${c.id}`, source: node.id, target: c.id, generatedBy: node.id },
        ...inbound.map(e => ({
          id: `gen-e-${e.source}-${c.id}` + (e.sourceHandle ? `-${e.sourceHandle}` : ''),
          source: e.source, target: c.id,
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          generatedBy: node.id
        }))
      ]);
      commitChildren(this, runId, flow, node, created, edges, {
        parentId: node.id,
        place: placeInContainer(node, created, containerLayout)
      });
      children = created;
      this.store.appendLog(runId, {
        event: 'fanout_lanes', node: node.id,
        lanes: lanes.map(l => ({ id: l.id, model: l.worker?.model ?? null, preset: l.preset ?? null }))
      });
    }

    // The auxiliary "lanes" port: who ran, on what, and why they were separate.
    this.store.writeNodeOutput(runId, `${node.id}.lanes`, laneInventory(lanes));

    const title = node.data?.title?.trim() || 'Fan-out';
    await runContainer(this, runId, flow, node, children, {
      ...opts,
      kind: 'Fan-out',
      title,
      aggregateLabel: `${children.length} lane(s)`,
      label: c => laneOf.get(c.id)?.label ?? c.data?.title?.trim() ?? c.id
    });

    this.store.writeRetrospective(runId, node.id, makeRetrospective({
      node: node.id,
      status: 'success',
      problems: [],
      confidence: 0.75,
      recommendation: `Fan-out "${title}" ran ${children.length} lane(s) on one brief: `
        + lanes.map(l => `${l.label}${l.worker ? ` (${l.worker.model})` : ''}`).join(', ') + '.'
    }));
    this.setNodeStatus(runId, node.id, 'done');
    return {};
  }

  // The Sub-flow call site (DECISIONS.md D36): a flow used as a node.
  //
  // By the time this runs there is nothing to resolve — start() spliced the
  // referenced flow's nodes into the run graph as this node's children, so
  // this is the third consumer of the same container walk, and the thinnest.
  // What it adds over runContainer: the call site reports the inner flow's
  // RESULT (whatever fed its output node), not every inner node, and writes
  // one sidecar per declared port so `<call>.<port>` edges resolve (P3.3).
  async runSubflow(runId, flow, node, opts) {
    const flowId = node.data?.flowId ?? '(unknown)';
    this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'subflow', flowId });

    const children = flow.nodes.filter(n => n.data?.managedBy === node.id);
    if (!children.length) {
      // Only reachable if the splice produced nothing — an inner flow that is
      // entirely input + output. Honest failure beats an empty box.
      this.store.writeRetrospective(runId, node.id, makeRetrospective({
        node: node.id, status: 'failed',
        problems: [`flow "${flowId}" contributed no runnable nodes`],
        resolution: 'Sub-flow failed; run stopped and escalated to human.',
        confidence: 0,
        recommendation: `Sub-flow "${node.data?.title || node.id}" referenced "${flowId}", which has nothing to run between its input and output.`
      }));
      this.setNodeStatus(runId, node.id, 'failed');
      throw new Error(`Sub-flow ${node.id} failed: flow "${flowId}" contributed no runnable nodes`);
    }
    ensureChildStatuses(this.store, runId, children);

    // The declared ports, stamped onto the node at splice time. Each names an
    // inner node whose output backs it.
    const ports = (node.data?.outputs ?? []).map(p => ({
      ...p, childId: `${node.id}__${p.id}`
    }));
    const resultIds = new Set(ports.map(p => p.childId));

    const title = node.data?.title?.trim() || flowId;
    await runContainer(this, runId, flow, node, children, {
      ...opts,
      kind: 'Sub-flow',
      title,
      aggregateLabel: `result of ${flowId}`,
      // A caller means "what the sub-flow produced", not "everything that
      // happened inside it" — the inner nodes are all on the canvas anyway.
      aggregateOver: cs => {
        const results = cs.filter(c => resultIds.has(c.id));
        return results.length ? results : cs;
      },
      label: c => c.data?.title?.trim() || c.data?.subflowNodeId || c.id
    });

    // Port sidecars: nodes/<call>.<port>.md, so an edge `call.x -> next` picks
    // one inner result the same way it picks any other node's named output.
    for (const p of ports) {
      const text = this.store.readNodeOutput(runId, p.childId);
      if (text != null) this.store.writeNodeOutput(runId, `${node.id}.${p.id}`, text);
    }

    this.store.writeRetrospective(runId, node.id, makeRetrospective({
      node: node.id,
      status: 'success',
      problems: [],
      confidence: 0.75,
      recommendation: `Sub-flow "${title}" ran flow "${flowId}" (${children.length} node(s))`
        + (node.data?.flowMode ? ` in mode "${node.data.flowMode}"` : '') + '.'
    }));
    this.setNodeStatus(runId, node.id, 'done');
    return {};
  }

  // The Loop node (DECISIONS.md D36): enqueue, then wait for terminal.
  //
  // This adds no autonomy. Everything that actually decides, edits and merges
  // is the loop D35 already built — budget ceilings, gates, heartbeats, the
  // canary. What this node contributes is a doorway: the tasks a `backlog-plan`
  // node produced go into the same queue the Loop page shows, the same
  // supervisor picks them, and the flow run stays open until they settle.
  //
  // The state is FILES (B12). A run that waits three days is legal and
  // expected, so nothing lives in memory: the truth is the backlog's own
  // status, re-derived on every poll and on reattach after a restart.
  async runLoop(runId, flow, node, opts) {
    const host = this.loopHost;
    const title = node.data?.title?.trim() || 'Loop';
    const waitFor = WAIT_POLICIES.includes(node.data?.waitFor) ? node.data.waitFor : 'all';
    this.store.appendLog(runId, { event: 'node_start', node: node.id, type: 'loop', waitFor });

    const failNode = (msg, problems = [msg]) => {
      this.store.writeRetrospective(runId, node.id, makeRetrospective({
        node: node.id, status: 'failed', problems,
        resolution: 'Loop hand-off failed; run stopped and escalated to human.',
        confidence: 0,
        recommendation: `Loop node "${title}" could not hand work over. ${msg}`
      }));
      this.setNodeStatus(runId, node.id, 'failed');
      return new Error(`Loop ${node.id} failed: ${msg}`);
    };

    if (!host?.backlog) throw failNode('this runner has no backlog to enqueue into');

    const runDir = this.store.runDir(runId);
    // Reattach (P4.3): a restart finds the ids we queued last time and picks
    // the wait back up. Nothing is re-enqueued and nothing is re-run — the
    // supervisor owns the work, this node only watches for it to settle.
    let state = readLoopState(runDir, node.id);
    if (state?.taskIds?.length) {
      this.store.appendLog(runId, {
        event: 'loop_node_reattach', node: node.id, tasks: state.taskIds.length
      });
    } else {
      const parts = this.upstreamContext(runId, flow, node, opts.taskIdByNode);
      const parsed = parseBacklogPlan(parts.join('\n\n'));
      if (!parsed.ok) {
        this.store.writeNodeOutput(runId, `${node.id}.errors`, [
          '# Backlog contract violations', '',
          'The upstream plan did not satisfy the backlog task contract; nothing was enqueued.', '',
          ...parsed.errors.map(e => `- ${e}`)
        ].join('\n'));
        throw failNode('the upstream plan violated the backlog task contract', parsed.errors);
      }
      const runReferences = this.store.readMeta(runId)?.references ?? [];
      const evidence = validateBacklogEvidence(parsed.tasks, {
        references: this.references,
        allowedReferences: runReferences,
        requireEvidence: node.data?.requireEvidence === true
      });
      if (!evidence.ok) {
        this.store.writeNodeOutput(runId, `${node.id}.errors`, [
          '# Backlog evidence violations', '',
          'External claims could not be verified against the repositories pinned by this run; nothing was enqueued.', '',
          ...evidence.errors.map(e => `- ${e}`)
        ].join('\n'));
        throw failNode('the upstream plan contained unverifiable reference evidence', evidence.errors);
      }
      this.store.appendLog(runId, {
        event: 'backlog_evidence_verified', node: node.id,
        tasks: evidence.tasks.length,
        citations: evidence.tasks.reduce((n, task) => n + (task.evidence?.length ?? 0), 0)
      });
      const maxTasks = Number(node.data?.maxTasks) > 0 ? Math.floor(Number(node.data.maxTasks)) : null;
      const tasks = maxTasks ? evidence.tasks.slice(0, maxTasks) : evidence.tasks;
      const taskIds = enqueuePlan(host.backlog, tasks, {
        runId, nodeId: node.id,
        budgetUsd: Number.isFinite(Number(node.data?.budgetUsd)) ? Number(node.data.budgetUsd) : null,
        // What this run read to arrive at these tasks. Without it a task
        // learned from another repository names files the claiming agent
        // cannot find, and the loop parks a backlog it could have worked.
        references: runReferences
      });
      state = writeLoopState(runDir, node.id, {
        nodeId: node.id, runId, taskIds, waitFor,
        startedAt: new Date().toISOString(),
        ...(maxTasks && evidence.tasks.length > maxTasks ? { dropped: evidence.tasks.length - maxTasks } : {})
      });
      this.store.appendLog(runId, { event: 'loop_node_enqueued', node: node.id, tasks: taskIds });
    }

    // Start the supervisor, or join the one already running. One queue, one
    // picker: two over the same backlog would race for the same tasks.
    if (waitFor !== 'none' && host.start) {
      try {
        const r = await host.start({
          parallelism: Number(node.data?.parallelism) > 0 ? Math.floor(Number(node.data.parallelism)) : 1,
          maxTasks: null
        });
        this.store.appendLog(runId, { event: 'loop_node_supervisor', node: node.id, ...r });
      } catch (err) {
        // A supervisor that will not start is a real failure — the tasks are
        // queued and nothing will pick them up.
        throw failNode(`the supervisor could not be started: ${String(err?.message ?? err)}`);
      }
    }

    this.setNodeStatus(runId, node.id, 'active');
    const snapshot = () => state.taskIds.map(id => ({ id, task: host.backlog.get(id) }));
    // The report is written on every change, not just at the end: a run that
    // waits three days should say what it is waiting for the whole time, and
    // the canvas card is the reader (D11).
    const publish = t => this.store.writeNodeOutput(runId, node.id, renderLoopReport({
      nodeTitle: title, taskIds: state.taskIds, tasks: snapshot(), tally: t, waitFor,
      spend: spendFor(host.ledger, state.taskIds)
    }));

    let tally = tallyTasks(snapshot());
    let seen = '';
    publish(tally);
    while (!isSettled(tally, waitFor)) {
      if (this.stopRequests.has(runId)) {
        // A stop leaves the tasks queued: they are the supervisor's now, and
        // this node picks the wait back up on resume.
        this.setNodeStatus(runId, node.id, 'pending');
        throw abortError(`Loop ${node.id} stopped`);
      }
      const key = JSON.stringify(tally);
      if (key !== seen) {
        seen = key;
        publish(tally);
        // A parked task surfaces ON THIS NODE (P4.4) and does NOT end the
        // wait: D35 rule 7 says a gate parks a task and never blocks the
        // loop, so the flow-level equivalent is to keep waiting and say so
        // out loud. `awaiting_approval` is the node status the canvas already
        // draws as a gate — the answering itself happens on the Loop page,
        // which is where the task's own context lives.
        if (tally.parked.length) {
          this.store.appendLog(runId, { event: 'loop_node_parked', node: node.id, tasks: tally.parked });
          this.setNodeStatus(runId, node.id, 'awaiting_approval');
        } else {
          this.setNodeStatus(runId, node.id, 'active');
        }
        this.notify(runId);
      }
      await new Promise(r => setTimeout(r, this.config.loop?.pollMs ?? DEFAULT_POLL_MS));
      tally = tallyTasks(snapshot());
    }

    const tasks = snapshot();
    const spend = spendFor(host.ledger, state.taskIds);
    const report = renderLoopReport({ nodeTitle: title, taskIds: state.taskIds, tasks, tally, waitFor, spend });
    this.store.writeNodeOutput(runId, node.id, report);
    this.store.appendLog(runId, {
      event: 'loop_node_settled', node: node.id,
      landed: tally.landed.length, failed: tally.failed.length, parked: tally.parked.length
    });

    // Failed tasks do not fail the node: "three landed, one failed" is a
    // result, and the report says which. A node that failed here would throw
    // away the three that worked.
    this.store.writeRetrospective(runId, node.id, makeRetrospective({
      node: node.id,
      status: tally.failed.length ? 'partial' : 'success',
      problems: tally.failed.map(id => `task ${id} failed`),
      confidence: tally.failed.length ? 0.5 : 0.8,
      recommendation: `Loop node "${title}" queued ${state.taskIds.length} task(s): `
        + `${tally.landed.length} landed, ${tally.failed.length} failed, ${tally.parked.length} waiting on a human.`
    }));
    this.setNodeStatus(runId, node.id, 'done');
    return {};
  }

  // One bounded retry for structured-output roles: re-ask the SAME worker with
  // its rejected output and the concrete validation errors. Returns the new
  // output text, or null when the retry call itself failed (the caller then
  // falls back to its graceful-degradation path).
  async reAsk(runId, node, worker, apiKey, system, userMsg, badOutput, errors) {
    this.store.appendLog(runId, { event: 'structured_output_reask', node: node.id, errors });
    const prompt = [
      userMsg,
      `YOUR PREVIOUS ATTEMPT (rejected):\n${badOutput}`,
      `VALIDATION ERRORS — the previous output violated the required JSON contract:\n- ${errors.join('\n- ')}`,
      'Respond again in full, fixing every error above. Emit exactly ONE valid ```json block satisfying the contract.'
    ].join('\n\n');
    try {
      const result = await this.trackedCallModel(runId, { ...worker, apiKey, system, prompt,
        onRetry: this.retryLogger(runId, node.id), retry: this.config.retry }, `${node.id}:reask`);
      return String(result.text ?? '').trim();
    } catch (err) {
      // A stop must unwind the walk, not degrade into a graceful contract miss.
      if (isAbortError(err) || this.stopRequests.has(runId)) {
        throw isAbortError(err) ? err : abortError(`Node ${node.id} stopped`);
      }
      this.store.appendLog(runId, { event: 'structured_output_reask_failed', node: node.id, error: String(err?.message ?? err) });
      return null;
    }
  }

  /**
   * What this run cost, into the ledger.
   *
   * Only the SUPERVISOR recorded spend, and only for the runs it started. So
   * every run a person or a flow launched — including the fan-out that reads
   * another repository with four lanes, the most expensive single thing this
   * app does — spent real money and left no ledger line. `flyt spend` answered
   * $3.62 for a day that had emptied an OpenRouter key's total limit; the
   * burn-down on the Loop view drew a bar against a ceiling it could not see
   * past; and the caps, which are rolling totals of real money, were counting
   * a fraction of it.
   *
   * A run the supervisor owns is left alone: it records the same calls against
   * the TASK when the task ends (§9), and that attribution is what the Loop
   * view's per-task spend reads. `loopTaskId` in the meta is how a run says
   * which it is.
   */
  #recordSpend(runId) {
    try {
      if (!this.ledger?.recordRun) return;
      if (this.store.readMeta(runId)?.loopTaskId) return;
      this.ledger.recordRun(this.store, { runId });
    } catch { /* accounting must never take a run down */ }
  }

  fail(runId, err) {
    // Never throws: a run stopped and then deleted mid-unwind pulls the files
    // out from under these writes, and an unhandled rejection here would take
    // down the main process for a race the user caused legitimately.
    try {
      // A stop() unwinds through here as an abort-marked error: the cancelled
      // end state stop() already recorded must stand — no 'failed' clobbering.
      if (this.stopRequests.has(runId) || isAbortError(err)) {
        this.store.appendLog(runId, { event: 'flow_unwound_after_stop', error: String(err?.message ?? err).slice(0, 300) });
        // A stopped run spent everything it spent before you stopped it. This
        // path returned before the ledger was written, so pressing Stop was a
        // way to make a run's cost disappear — and stopping a run that is going
        // badly is exactly when a person presses it.
        this.#recordSpend(runId);
        this.notify(runId);
        return;
      }
      this.store.appendLog(runId, { event: 'flow_error', error: String(err?.stack ?? err) });
      const meta = this.store.readMeta(runId);
      const current = meta.currentNodeId;
      this.store.setStage(runId, 'failed', { error: String(err?.message ?? err) });
      // A run that failed still spent. The expensive kind — four lanes over a
      // large repository, dying at the merge — is exactly the one whose cost a
      // ledger that only records tidy endings would omit.
      this.#recordSpend(runId);
      // In a parallel wave currentNodeId is just the last node that went
      // active — it may have finished fine. Only flag it if it's still active.
      if (current && this.store.readMeta(runId).nodeStatus?.[current] === 'active') {
        this.setNodeStatus(runId, current, 'failed');
      }
      // Close this node's open attempt with a classified reason (WR-05), so the
      // failure sits in attempt history rather than as a free-floating run
      // error that a later retry has to compete with.
      if (current) {
        const failure = classifyAdapterError(err, { provider: 'the provider' });
        const after = this.store.readMeta(runId);
        this.store.writeMeta(runId, {
          ...after,
          attempts: settleAttempt(after.attempts ?? {}, current, {
            status: 'failed', error: failure.detail, code: failure.code
          })
        });
      }
      this.notify(runId);
    } catch { /* the run is gone — there is nothing left to report to */ }
  }

  // Instantiate one Node Library template (user-editable worker/instructions/
  // tools apply) as a runtime node, falling back to the built-in catalog. The
  // caller re-layouts, so the position is a placeholder.
  templateNode(templateId, id, overrides = {}) {
    let lib = this.nodeStore?.get(templateId);
    let effOverrides = overrides;
    // A retired template id (a model quoting the pre-rework catalog, or an old
    // run being resumed) resolves through the combined replacement.
    if (!lib && LEGACY_TEMPLATE_MAP[templateId]) {
      const legacy = LEGACY_TEMPLATE_MAP[templateId];
      const mapped = this.nodeStore?.get(legacy.templateId);
      if (mapped) {
        lib = mapped;
        templateId = legacy.templateId;
        effOverrides = { ...legacy.overrides, ...overrides };
      }
    }
    if (lib) return resolveInstance({ id, templateId, position: { x: 0, y: 0 }, overrides: effOverrides }, lib);
    const {
      title, goal, category, contextSpec, requiresApproval, effort, evalType, language,
      // The library path passes the whole override map through resolveInstance;
      // this fallback used to forward a fixed subset, which quietly dropped
      // exactly the three fields a fan-out lane is made of (D36 P2.1). Both
      // paths now carry the same set — `system` joined them for the same
      // reason (DECISIONS.md D37): a lane's role prompt IS the lane.
      instructions, worker, tools, system
    } = overrides;
    return createNodeFromTemplate(templateId, {
      id,
      position: { x: 0, y: 0 },
      data: {
        ...(title ? { title } : {}),
        ...(goal ? { goal } : {}),
        ...(category ? { category } : {}),
        ...(contextSpec ? { contextSpec } : {}),
        ...(effort ? { effort } : {}),
        ...(evalType ? { evalType } : {}),
        ...(language ? { language } : {}),
        ...(instructions ? { instructions } : {}),
        ...(worker ? { worker } : {}),
        ...(tools ? { tools } : {}),
        ...(typeof system === 'string' && system.trim() ? { system } : {}),
        ...(requiresApproval != null ? { requiresApproval } : {})
      }
    });
  }

  // Turn one validated generated-node spec (plan-eval / triage / feedback-
  // review contract shape) into a runtime node. A spec without an explicit
  // contextSpec at least gets the task list, keeping "minimal declared
  // context" the default.
  specNode(s) {
    const contextSpec = s.contextSpec ?? (s.taskRef
      ? { files: [{ path: 'tasks-md', description: `The full task list from plan-start; only ${s.taskRef} is this node's assignment.` }] }
      : undefined);
    const goal = s.goal || (s.taskRef ? `Complete ${s.taskRef} exactly as defined in tasks.md.` : '');
    const label = this.nodeStore?.get(s.template)?.name ?? getTemplate(s.template)?.label ?? s.template;
    return this.templateNode(s.template, s.id, {
      title: s.title || (s.taskRef ? `${label} (${s.taskRef})` : label),
      goal,
      ...(s.category ? { category: s.category } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(contextSpec ? { contextSpec } : {})
    });
  }

  // Materialize the nodes a plan-eval step declared (strict contract in
  // core/planEval.js): create real node objects from NODE_TEMPLATES, wire
  // them between the plan-eval node and its downstream targets, and persist
  // the updated flow.json so they appear live on the canvas with provenance.
  // Contract violations reject the whole document: they are written to
  // nodes/plan-eval-errors.md + log.jsonl and the run continues without
  // generated nodes (graceful failure).
  materializeGeneratedNodes(runId, flow, planEvalNode, evalOutputText) {
    const parsed = parsePlanEval(evalOutputText,
      this.nodeStore ? this.nodeStore.listFull().map(t => t.id) : []);
    if (!parsed.ok) {
      this.store.writeNodeOutput(runId, 'plan-eval-errors', [
        '# Plan-eval contract violations',
        '',
        'The plan-eval output did not satisfy the strict JSON contract; no nodes were materialized.',
        '',
        ...parsed.errors.map(e => `- ${e}`)
      ].join('\n'));
      this.store.appendLog(runId, { event: 'materialize_failed', fromNode: planEvalNode.id, errors: parsed.errors });
      return { ok: false, errors: parsed.errors, created: [] };
    }

    // The plan parses — but is it a plan worth running? (WR-06)
    //
    // Shape validity was the only bar, so a focused change could be split into
    // nine tasks, two of them claiming to produce the same file and one
    // requiring an input nothing wrote. Every one of those is cheaper to catch
    // here than three model calls later, and the errors feed the SAME bounded
    // re-ask the malformed-JSON path already uses.
    const limits = plannerLimits(this.config);
    const available = [
      'prompt.md', 'plan.md',
      ...flow.nodes.map(n => n.id),
      ...(this.store.readTasks(runId)?.tasks ?? []).map(t => t.id)
    ];
    const verdict = validatePlan(parsed.plan.nodes, {
      limits, available,
      allowExceed: planEvalNode.data?.allowLargePlan === true,
      contractBytes: Buffer.byteLength(String(evalOutputText ?? ''), 'utf8')
    });
    this.store.appendLog(runId, {
      event: 'plan_validated', fromNode: planEvalNode.id,
      ok: verdict.ok, ...verdict.metrics,
      ...(verdict.warnings.length ? { warnings: verdict.warnings.slice(0, 10) } : {})
    });
    if (!verdict.ok) {
      this.store.writeNodeOutput(runId, 'plan-eval-errors', [
        '# Plan rejected',
        '',
        'The plan parsed but did not satisfy the planning contract; no nodes were materialized.',
        '',
        ...verdict.errors.map(e => `- ${e}`)
      ].join('\n'));
      this.store.appendLog(runId, {
        event: 'plan_rejected', fromNode: planEvalNode.id, errors: verdict.errors.slice(0, 10)
      });
      return { ok: false, errors: verdict.errors, created: [] };
    }
    return this.materializeParsedNodes(runId, flow, planEvalNode, parsed.plan);
  }

  // Turn a validated plan into real nodes in the run's flow. Two modes:
  //   default   — plan-eval style: roots hang off the owner, leaves feed the
  //               owner's downstream targets, global re-layout.
  //   parentId  — orchestrator style: children live INSIDE the owner's box
  //               (parentId + relative grid positions), are flagged managedBy
  //               so the outer scheduler leaves them alone, never gate, and
  //               are NOT wired to anything outside the container.
  materializeParsedNodes(runId, flow, ownerNode, plan, { parentId = null } = {}) {
    const existing = new Set(flow.nodes.map(n => n.id));
    const specs = plan.nodes.filter(s => {
      if (existing.has(s.id)) {
        this.store.appendLog(runId, { event: 'materialize_skip', fromNode: ownerNode.id, node: s.id, reason: 'id already exists in flow' });
        return false;
      }
      return true;
    });
    if (!specs.length) return { ok: true, errors: [], created: [] };

    // Both a spec's id and its taskRef name the generated node in dependsOn /
    // parallelGroups references.
    const idMap = new Map();
    for (const s of specs) {
      idMap.set(s.id, s.id);
      if (s.taskRef) idMap.set(s.taskRef, s.id);
    }

    // Ordering between generated nodes: explicit dependsOn wins; otherwise
    // consecutive parallelGroups form sequential waves.
    const depsFor = new Map(specs.map(s => [s.id, new Set()]));
    let usedExplicit = false;
    for (const s of specs) {
      for (const d of s.dependsOn ?? []) {
        const dep = idMap.get(d);
        if (dep && dep !== s.id) { depsFor.get(s.id).add(dep); usedExplicit = true; }
      }
    }
    if (!usedExplicit && Array.isArray(plan.parallelGroups)) {
      const waves = plan.parallelGroups
        .map(g => g.map(ref => idMap.get(ref)).filter(id => id && depsFor.has(id)));
      for (let i = 1; i < waves.length; i++) {
        for (const id of waves[i]) for (const prev of waves[i - 1]) depsFor.get(id).add(prev);
      }
    }

    // Reject dependency cycles among generated nodes before touching the flow.
    {
      const state = new Map(); // 1 = visiting, 2 = done
      const cyclic = function visit(id) {
        if (state.get(id) === 1) return true;
        if (state.get(id) === 2) return false;
        state.set(id, 1);
        for (const d of depsFor.get(id)) if (visit(d)) return true;
        state.set(id, 2);
        return false;
      };
      if (specs.some(s => cyclic(s.id))) {
        const errors = ['dependsOn: generated nodes form a dependency cycle; nothing was materialized'];
        this.store.writeNodeOutput(runId, 'plan-eval-errors', `# Plan-eval contract violations\n\n- ${errors[0]}`);
        this.store.appendLog(runId, { event: 'materialize_failed', fromNode: ownerNode.id, errors });
        return { ok: false, errors, created: [] };
      }
    }

    // A generated node inherits its owner's ceiling, narrowed by its own
    // (DESIGN-SPEC.md §5). This is the hole that would otherwise open the moment
    // planning became tool-aware: a node that decides what other nodes may do
    // must not be able to decide they may do more than IT may.
    const ownerCeiling = ownerNode.data?.toolCeiling ?? null;
    const ctx = ownerCeiling ? grantContext() : null;

    const created = [];
    for (const s of specs) {
      const node = this.specNode(s);
      const ceiling = ownerCeiling
        ? narrowCeiling(ownerCeiling, node.data?.toolCeiling ?? null, ctx)
        : node.data?.toolCeiling ?? null;
      node.data = {
        ...node.data,
        ...(s.taskRef ? { taskRef: s.taskRef } : {}),
        generatedBy: ownerNode.id,
        ...(ceiling ? { toolCeiling: ceiling } : {}),
        // Container children run autonomously: managed by the orchestrator's
        // inline sub-walk, never pausing at an approval gate.
        ...(parentId ? { managedBy: parentId, requiresApproval: false } : {})
      };
      if (ownerCeiling) {
        this.store.appendLog(runId, {
          event: 'tool_ceiling_inherited', node: node.id, from: ownerNode.id,
          ceiling, ...(node.data.toolCeiling !== (s.toolCeiling ?? null) && s.toolCeiling ? { declared: s.toolCeiling } : {})
        });
      }
      if (parentId) {
        node.parentId = parentId;
        node.extent = 'parent';
      }
      created.push(node);
    }

    // Wiring. Default (plan-eval): roots hang off the owner, internal
    // dependsOn edges, leaves feed the owner's original downstream targets.
    // Container (orchestrator): roots hang off the owner, internal edges
    // only — downstream stays connected to the owner, which completes after
    // its children and hands over the aggregated result.
    const downstreamTargets = parentId ? []
      : flow.edges.filter(e => e.source === ownerNode.id).map(e => e.target);
    const dependedOn = new Set();
    depsFor.forEach(set => set.forEach(id => dependedOn.add(id)));
    const edges = [];
    for (const n of created) {
      const deps = [...depsFor.get(n.id)];
      if (deps.length) {
        for (const d of deps) edges.push({ id: `gen-e-${d}-${n.id}`, source: d, target: n.id, generatedBy: ownerNode.id });
      } else {
        edges.push({ id: `gen-e-${ownerNode.id}-${n.id}`, source: ownerNode.id, target: n.id, generatedBy: ownerNode.id });
      }
      if (!dependedOn.has(n.id)) {
        for (const t of downstreamTargets) edges.push({ id: `gen-e-${n.id}-${t}`, source: n.id, target: t, generatedBy: ownerNode.id });
      }
    }

    // Placement + persistence are shared with every other container (DECISIONS.md D36
    // P2.0): inside a box the children are gridded and the box sized to fit;
    // outside one the run's display copy is re-laid-out so generated nodes
    // slot into clean dependency layers instead of overlapping the authored
    // ones. Either way only flow.json inside the run dir moves — never the
    // saved flow definition.
    commitChildren(this, runId, flow, ownerNode, created, edges, {
      parentId,
      place: parentId
        ? placeInContainer(ownerNode, created, containerLayout)
        : placeByLayout(layoutPositions)
    });
    return { ok: true, errors: [], created };
  }
}
