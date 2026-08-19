// Bounded, validated planning (WR-06).
//
// Three related production failures, all in the planner:
//
//   Plan size    a focused UI change was expanded into seven to nine tasks,
//                several of which existed only to hand prose to the next one.
//   Contract     upstream tasks claimed to produce documentation in model prose
//                only; downstream tasks logged `context_input_missing` and ran
//                anyway, on inputs that were never produced.
//   Liveness     a planner streamed thousands of near-identical "I'll inspect…"
//                sentences without calling a tool. The general heartbeat did
//                catch it — after about six minutes of byte-identical work,
//                which is far too slow and too coarse for this failure.
//
// So: a declared contract per generated task, validated BEFORE anything is
// materialized, and a planning-specific liveness detector that watches for a
// lack of novel visible work rather than for elapsed time.
//
// Pure and dependency-free. The runner supplies limits and evidence; nothing
// here reads a file, a clock it was not given, or the network.

import { normalizeEffect } from '../src/flowTypes.js';

// --- Limits ------------------------------------------------------------------

export const PLANNER_LIMITS = {
  // The default cap on generated tasks. A focused request that plans into more
  // than this is usually fragmenting below the smallest independently
  // verifiable unit — which costs a model call per fragment and produces tasks
  // whose only output is a paragraph for the next one.
  maxPlanTasks: 5,
  // The explicit ceiling a broad request may be allowed up to, when the plan
  // says why. Never unbounded.
  maxPlanTasksHard: 12,
  // How deep generated nodes may nest (orchestrators inside orchestrators).
  maxDepth: 3,
  // One corrective re-ask. A second invalid plan is a failure, not a third try:
  // re-asking forever is how a misunderstanding becomes a bill.
  maxReasks: 1,
  // A cap on the contract text itself, so a planner cannot answer with a novel.
  maxContractBytes: 64 * 1024
};

export function plannerLimits(config = {}) {
  const raw = config?.planner ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  const limits = {
    maxPlanTasks: num(raw.maxPlanTasks, PLANNER_LIMITS.maxPlanTasks),
    maxPlanTasksHard: num(raw.maxPlanTasksHard, PLANNER_LIMITS.maxPlanTasksHard),
    maxDepth: num(raw.maxDepth, PLANNER_LIMITS.maxDepth),
    maxReasks: Number.isFinite(Number(raw.maxReasks)) && Number(raw.maxReasks) >= 0
      ? Math.floor(Number(raw.maxReasks)) : PLANNER_LIMITS.maxReasks,
    maxContractBytes: num(raw.maxContractBytes, PLANNER_LIMITS.maxContractBytes)
  };
  // A soft cap above the hard one is a configuration mistake, not a licence.
  limits.maxPlanTasks = Math.min(limits.maxPlanTasks, limits.maxPlanTasksHard);
  return limits;
}

// --- Task contracts ----------------------------------------------------------

/**
 * Normalize one generated task's declared contract.
 *
 * `requiredInputs` must have a producer; `optionalInputs` may be absent without
 * anyone treating it as an error — which is the distinction the runs were
 * missing, since every missing input looked equally like a problem and none of
 * them stopped anything.
 */
export function normalizeTaskContract(spec = {}) {
  const list = v => (Array.isArray(v) ? v : v == null ? [] : [v])
    .map(x => String(x ?? '').trim()).filter(Boolean);
  const required = list(spec.requiredInputs ?? spec.inputs);
  const optional = list(spec.optionalInputs);
  return {
    id: String(spec.id ?? '').trim(),
    effect: normalizeEffect(spec.effect) ?? null,
    effectScope: list(spec.effectScope),
    outputs: list(spec.outputs),
    // An input declared both ways is REQUIRED: the stricter reading is the safe
    // one, and a planner that says both has not decided.
    requiredInputs: required,
    optionalInputs: optional.filter(i => !required.includes(i)),
    dependsOn: list(spec.dependsOn),
    gates: list(spec.gates)
  };
}

// --- Plan validation ---------------------------------------------------------

/**
 * Validate a whole plan before ANY of it is materialized.
 *
 * Returns errors (the plan must not run), warnings (it may, but somebody should
 * know), and metrics for the run log. Pure: `available` is the set of inputs
 * that already exist — prompt.md, upstream node ids, files the run was given.
 *
 * @returns {{ok, errors, warnings, metrics, contracts}}
 */
export function validatePlan(specs, {
  limits = PLANNER_LIMITS, available = [], allowExceed = false, contractBytes = 0
} = {}) {
  const errors = [];
  const warnings = [];
  const contracts = (Array.isArray(specs) ? specs : []).map(normalizeTaskContract);

  if (!contracts.length) errors.push('plan declares no tasks');

  if (contractBytes > limits.maxContractBytes) {
    errors.push(`plan contract is ${contractBytes} bytes, over the ${limits.maxContractBytes}-byte limit`);
  }

  // --- size ---------------------------------------------------------------
  const cap = allowExceed ? limits.maxPlanTasksHard : limits.maxPlanTasks;
  if (contracts.length > cap) {
    errors.push(
      `plan has ${contracts.length} tasks, over the limit of ${cap}. `
      + 'Merge steps that one executor can safely do together; a task that exists only to '
      + 'hand prose to the next task is not an independently verifiable unit.');
  }

  // --- identity -----------------------------------------------------------
  const seen = new Set();
  for (const c of contracts) {
    if (!c.id) { errors.push('a task has no id'); continue; }
    if (seen.has(c.id)) errors.push(`duplicate task id "${c.id}"`);
    seen.add(c.id);
  }

  // --- outputs: exactly one producer each ---------------------------------
  const producerOf = new Map();
  for (const c of contracts) {
    for (const out of c.outputs) {
      if (producerOf.has(out)) {
        errors.push(`two tasks both claim to produce "${out}" ("${producerOf.get(out)}" and "${c.id}")`);
      } else {
        producerOf.set(out, c.id);
      }
    }
  }

  // --- required inputs: every one has a source ----------------------------
  const existing = new Set(available.map(a => String(a).trim()).filter(Boolean));
  for (const c of contracts) {
    for (const input of c.requiredInputs) {
      if (existing.has(input) || producerOf.has(input) || seen.has(input)) continue;
      errors.push(
        `task "${c.id}" requires "${input}", which no task produces and the run does not have. `
        + 'Declare a producer, mark it optional, or drop it.');
    }
    for (const input of c.optionalInputs) {
      if (existing.has(input) || producerOf.has(input) || seen.has(input)) continue;
      warnings.push(`task "${c.id}" may use "${input}", which nothing produces — it will run without it`);
    }
  }

  // --- dependencies: known, acyclic ---------------------------------------
  for (const c of contracts) {
    for (const dep of c.dependsOn) {
      if (!seen.has(dep)) errors.push(`task "${c.id}" depends on "${dep}", which is not in this plan`);
    }
  }
  const cycle = findCycle(contracts);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  // --- verifiability ------------------------------------------------------
  for (const c of contracts) {
    if (!c.outputs.length && !c.effect) {
      warnings.push(`task "${c.id}" declares neither an output nor an effect — nothing about it can be checked`);
    }
    if (c.effect === 'none') {
      warnings.push(`task "${c.id}" claims no deliverable; it cannot be verified and probably should not exist`);
    }
  }

  const metrics = {
    taskCount: contracts.length,
    cap,
    withEffect: contracts.filter(c => c.effect).length,
    withOutputs: contracts.filter(c => c.outputs.length).length,
    requiredInputs: contracts.reduce((n, c) => n + c.requiredInputs.length, 0),
    optionalInputs: contracts.reduce((n, c) => n + c.optionalInputs.length, 0),
    errors: errors.length,
    warnings: warnings.length
  };
  return { ok: errors.length === 0, errors, warnings, metrics, contracts };
}

function findCycle(contracts) {
  const adj = new Map(contracts.map(c => [c.id, c.dependsOn.filter(d => contracts.some(x => x.id === d))]));
  const state = new Map(); // 0 = visiting, 1 = done
  const stack = [];
  const walk = id => {
    if (state.get(id) === 1) return null;
    if (state.get(id) === 0) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 0);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 1);
    return null;
  };
  for (const c of contracts) {
    const found = walk(c.id);
    if (found) return found;
  }
  return null;
}

/** The correction handed back to the planner on its one re-ask. */
export function reaskPrompt(result, { limits = PLANNER_LIMITS } = {}) {
  return [
    'Your plan was rejected. Fix exactly these problems and return the same JSON contract again:',
    ...result.errors.map(e => `- ${e}`),
    '',
    `Hard rules: at most ${limits.maxPlanTasks} tasks; every task declares its effect`,
    '("artifact" or "workspace-change") and its outputs; every required input is either produced',
    'by another task in this plan or already present in the run. Prefer fewer, larger,',
    'independently verifiable tasks over a chain that passes prose along.'
  ].join('\n');
}

// --- Planner liveness --------------------------------------------------------

export const SPIN_DEFAULTS = {
  // Below this many lines there is not enough evidence to call anything.
  minLines: 12,
  // Fraction of lines in the rolling window that must be NEW. A planner
  // restating itself scores near zero; one making progress stays well above.
  minNovelty: 0.25,
  // The floor in wall time, so a fast burst of boilerplate is not cut off
  // before it has had a chance to become real work. Deliberately far below the
  // six-minute general heartbeat this exists to pre-empt.
  minMs: 60_000,
  // How many recent normalized lines to remember.
  window: 200
};

// Markdown noise is stripped; DIGITS ARE NOT. Folding numbers away would make
// "module alpha1" and "module alpha2" the same line, and a planner working
// through a numbered list of real things would read as a spin — a false
// positive here kills legitimate work, which is far worse than this detector
// being slow. The general six-minute heartbeat is still behind it either way.
const normalizeLine = line => String(line ?? '')
  .toLowerCase()
  .replace(/[`*_#>]+/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Watch a planner's streamed output for expensive activity without progress.
 *
 * The rule is deliberately NOT "it has been N minutes". A quiet reasoning call
 * emits nothing and must never be killed here — that is the silent-stall
 * detector's job. What this catches is the opposite: a stream that is busy and
 * saying the same thing, with no tool call and no contract progress to show
 * for it.
 *
 * Any of these resets suspicion outright, because each is real progress:
 * a tool call, a parsed contract, or genuinely novel text.
 */
export function createSpinDetector({ thresholds = {}, now = () => Date.now() } = {}) {
  const t = { ...SPIN_DEFAULTS, ...thresholds };
  const startedAt = now();
  const recent = [];
  const counts = new Map();
  let total = 0;
  let repeats = 0;
  let toolCalls = 0;
  let contractProgress = 0;
  let carry = '';

  const remember = line => {
    const key = normalizeLine(line);
    if (!key || key.length < 8) return;   // "ok", "---", bare punctuation
    total++;
    const seenBefore = (counts.get(key) ?? 0) > 0;
    if (seenBefore) repeats++;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    recent.push(key);
    while (recent.length > t.window) {
      const dropped = recent.shift();
      const n = (counts.get(dropped) ?? 1) - 1;
      if (n <= 0) counts.delete(dropped); else counts.set(dropped, n);
    }
  };

  return {
    /** Feed streamed text. Partial chunks are fine; lines are reassembled. */
    push(text) {
      carry += String(text ?? '');
      let idx;
      while ((idx = carry.indexOf('\n')) >= 0) {
        remember(carry.slice(0, idx));
        carry = carry.slice(idx + 1);
      }
      // A stream with no newlines at all would never be measured otherwise.
      if (carry.length > 400) { remember(carry); carry = ''; }
      return this.state();
    },
    /** Real progress: the planner did something instead of describing it. */
    noteToolCall() { toolCalls++; },
    noteContractProgress() { contractProgress++; },
    state() {
      const elapsedMs = now() - startedAt;
      const unique = counts.size;
      // Both halves come from the ROLLING WINDOW. Dividing the windowed
      // distinct count by the cumulative line count would make novelty decay
      // purely with length, so a long healthy stream would eventually look
      // like a spin for no reason other than having gone on a while — which is
      // exactly the "elapsed time" reasoning this detector must not use.
      const novelty = recent.length ? unique / recent.length : 1;
      const tripped = total >= t.minLines
        && elapsedMs >= t.minMs
        && novelty < t.minNovelty
        && toolCalls === 0
        && contractProgress === 0;
      return {
        tripped,
        reason: tripped
          ? `the planner produced ${total} lines with only ${unique} distinct ones `
            + `(${Math.round(novelty * 100)}% novel), called no tool and produced no contract`
          : null,
        metrics: {
          lines: total, distinct: unique, repeats,
          novelty: Math.round(novelty * 100) / 100,
          toolCalls, contractProgress, elapsedMs
        }
      };
    }
  };
}
