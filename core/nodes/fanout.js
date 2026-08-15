// Fan-out lanes (BRICKS P2 / D36 B5–B6): N takes on ONE brief, deliberately
// diverged, run as a scoped subgraph inside the fan-out node's box.
//
// Lanes are data on one node, not N authored nodes. Wiring five `work` nodes
// by hand and overriding `worker` on each is already possible (FLOW_NODES §8)
// and already tedious — and, more importantly, no lane authored that way knows
// the others exist, which is what makes "find something the others will not"
// meaningless. A lane list makes the siblings addressable.
//
// Everything here is pure: the runner mints nodes from these lanes, the linter
// checks them, and the canvas draws them, from one normalization.

// Named lane shapes, so the common five are one click rather than a paragraph
// of prompt each (P2.2). These are `instructions` presets on a lane — not new
// node types, and not new roles. A lane may take a preset, its own text, or
// both (the preset first, the author's text after).
//
// Each preset carries TWO prompt layers (FANOUT §1):
//   `system`       — the ROLE prompt, and the lane's output SHAPE. It replaces
//                    DEFAULT_SYSTEM[role] wholesale, which is the point: one
//                    report format imposed on every lane is the single biggest
//                    reason four lanes come back reading alike.
//   `instructions` — the user-message nudge, composed into the lane brief
//                    beside the shared goal and the sibling roster.
// Both compose; neither replaces the other. The text of a preset is FIXED —
// the planner (P3) selects and duplicates presets, it never writes one.
export const LANE_PRESETS = {
  standard: {
    label: 'Standard',
    intent: 'the brief as written, done well',
    system: [
      'ROLE: primary reader',
      'You answer the shared brief directly and thoroughly. The other lanes are each',
      'looking somewhere specific and strange; you are the one who reads it the way it',
      'asks to be read.',
      'Prefer what is well-supported over what is striking. Where you are confident,',
      'say so plainly and move on — hedging every sentence makes the genuinely',
      'uncertain claims impossible to find.',
      'Output:',
      '# Reading',
      '## What this is',
      '## How it works — <the main path, end to end>',
      '## What matters most for the brief',
      'Cite file:line for every claim. Say what you could not determine.'
    ].join('\n'),
    instructions: 'Answer the shared brief directly and thoroughly. Prefer what is well-supported over what is striking.'
  },
  // The fifth preset (FANOUT P1.1). learn-from-repo hand-wrote this as
  // `standard` plus an intent string, which meant the planner could never
  // select it: it picks from this enum, so anything absent here is unreachable.
  architecture: {
    label: 'Architecture',
    intent: 'how the thing is put together, and why',
    system: [
      'ROLE: architecture reader',
      'You explain how the subject is put together, and why.',
      'Work outside-in: entry points, then the boundaries between parts, then what',
      'crosses them. Name the load-bearing decisions and the constraint each one',
      'answers to — a design is only explained once you can say what it costs.',
      'Output:',
      '# Architecture',
      '## Shape — <the parts, and what talks to what>',
      '## Load-bearing decisions — <decision · evidence · what it buys · what it costs>',
      '## Where it would strain',
      'Cite file:line you actually opened. Do not describe intent you inferred only',
      'from names.'
    ].join('\n'),
    instructions: 'Explain how the subject is put together, and why. Work outside-in: entry points, then the boundaries between the parts, then what crosses them. Name the load-bearing decisions and what each one costs.'
  },
  wildcard: {
    label: 'Wildcard',
    intent: 'the odd, hidden, undocumented, surprising',
    system: [
      'ROLE: wildcard reader',
      'You hunt for what is odd, hidden, undocumented, or surprising. The obvious',
      'reading is covered by others; producing it is a failed run.',
      'Go where documentation is absent: dead code, commented-out blocks, oddly',
      'specific constants, defensive branches, comments that apologise, tests that',
      'assert something strange, commit-shaped scar tissue.',
      'Output:',
      '# Findings',
      'For each: **<one-line claim>** · file:line · what it implies · confidence',
      '(certain / likely / speculative).',
      'Rank by surprise, not by certainty. Six sharp findings beat twenty. Label',
      'speculation as speculation rather than softening it into a hedge — an',
      'interesting maybe is the deliverable, a safe restatement is not.'
    ].join('\n'),
    instructions: 'Look ONLY for what is odd, hidden, undocumented, or surprising. Ignore the obvious reading of the brief entirely — the other lanes have it covered. Something interesting and uncertain beats something safe and already known.'
  },
  adversarial: {
    label: 'Adversarial',
    intent: 'what is fragile, wrong, or badly done',
    system: [
      'ROLE: adversarial reader',
      'You find what is fragile, wrong, or done badly. Assume something here fails in',
      'production; your job is to say what, and under which conditions. Do not balance',
      'criticism with praise and do not close with reassurance.',
      'Look for: unhandled failure paths, silent catches, unbounded retries, state that',
      'can be written twice, ordering assumptions, resource leaks, anything whose',
      'correctness depends on a comment.',
      'Output:',
      '# Weaknesses',
      'For each: **<what breaks>** · file:line · the trigger · blast radius · severity',
      '(high / medium / low).',
      'A weakness you cannot tie to a concrete trigger is not a finding — cut it.'
    ].join('\n'),
    instructions: 'Look ONLY for what is done badly, is fragile, or is outright wrong. Assume something here will fail and your job is to say what, and under which conditions. Do not balance criticism with praise.'
  },
  contrarian: {
    label: 'Contrarian',
    intent: 'the case against the obvious reading',
    system: [
      'ROLE: contrarian reader',
      'You argue against the obvious reading of the brief. State the strongest version',
      'of the case the other readers will not make.',
      'This is not contradiction for its own sake: build the case from what is actually',
      'there, then state plainly what would have to be true for it to hold, and what',
      'would falsify it. If the obvious reading survives contact with the evidence, say',
      'so explicitly and explain what specifically defeats your case — that is a real',
      'result, not a failure.',
      'Output:',
      '# The case against',
      '## Claim — <the counter-reading, one sentence>',
      '## Evidence — <file:line, each doing actual work>',
      '## What must be true for this to hold',
      '## What would falsify it',
      'Never manufacture evidence to keep the argument alive.'
    ].join('\n'),
    instructions: 'Argue the OPPOSITE of the obvious reading of this brief. State the strongest version of the case the other lanes will not make, and say plainly what would have to be true for it to hold.'
  }
};

export const LANE_PRESET_IDS = Object.keys(LANE_PRESETS);

// The template a lane instantiates when neither it nor the node names one.
export const DEFAULT_LANE_TEMPLATE = 'general-analysis';

// A lane's model, written the way people actually want to write it. A bare
// string is the ergonomic form (`worker: anthropic/claude-sonnet-5`); the
// {provider, model} object stays legal because that is what the rest of the
// DSL uses. 'auto' means "an active model, resolved by provider priority at
// call time" — the same meaning it has everywhere else.
export function normalizeLaneWorker(worker) {
  if (!worker) return null;
  if (typeof worker === 'string') {
    const model = worker.trim();
    if (!model) return null;
    return { provider: model.startsWith('mock-') ? 'mock' : 'auto', model };
  }
  if (typeof worker === 'object' && typeof worker.model === 'string' && worker.model.trim()) {
    return { provider: String(worker.provider || 'auto'), model: worker.model.trim() };
  }
  return null;
}

const slug = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The planner's one-sentence narrowing of a lane INSIDE its preset (P3.2).
// Capped, because a paragraph here is lane authoring by the back door.
export const MAX_EMPHASIS = 280;

// One raw lane entry → the canonical lane. `index` only supplies a fallback id
// for a lane written without one.
export function normalizeLane(raw, index = 0) {
  const entry = typeof raw === 'string' ? { preset: raw } : (raw ?? {});
  const preset = LANE_PRESETS[entry.preset] ?? null;
  const id = slug(entry.id) || slug(entry.label) || (preset ? slug(entry.preset) : '') || `lane-${index + 1}`;
  const own = typeof entry.instructions === 'string' ? entry.instructions.trim() : '';
  const ownSystem = typeof entry.system === 'string' ? entry.system.trim() : '';
  const emphasis = typeof entry.emphasis === 'string' ? entry.emphasis.trim().slice(0, MAX_EMPHASIS) : '';
  // The role prompt: the preset's fixed text, then anything the author wrote
  // themselves, then the planner's emphasis as a closing line. A lane with
  // none of the three carries no `system` at all, so it still falls through to
  // DEFAULT_SYSTEM[role] exactly as it did before this existed.
  const system = [
    preset?.system ?? '',
    ownSystem,
    emphasis ? `THIS LANE SPECIFICALLY: ${emphasis}` : ''
  ].filter(Boolean).join('\n\n');
  return {
    id,
    label: String(entry.label ?? preset?.label ?? id),
    // One line, shown to the OTHER lanes so they know who else is on the
    // brief. Never an output — see the brief assembly below.
    intent: String(entry.intent ?? preset?.intent ?? '').trim(),
    instructions: [preset?.instructions ?? '', own].filter(Boolean).join('\n\n'),
    worker: normalizeLaneWorker(entry.worker),
    template: entry.template ? String(entry.template) : null,
    tools: Array.isArray(entry.tools) ? entry.tools.map(String) : null,
    ...(system ? { system } : {}),
    ...(emphasis ? { emphasis } : {}),
    ...(entry.preset ? { preset: String(entry.preset) } : {})
  };
}

// Duplicate ids would collide as node ids inside the box; suffix rather than
// drop, because a set and an authored lane naming the same model is a
// reasonable thing to write — and so is a planner minting three architecture
// lanes (P3.2), which is exactly a legal repeat.
export function uniqueLaneIds(lanes) {
  const seen = new Map();
  return lanes.map(lane => {
    const n = (seen.get(lane.id) ?? 0) + 1;
    seen.set(lane.id, n);
    return n === 1 ? lane : { ...lane, id: `${lane.id}-${n}` };
  });
}

// Every lane this node will run, from either source, with ids made unique.
// `modelSet` mints one lane per member model (P2.4) — the ten-second path to
// "five models on one question". Explicit lanes win; a node may also do both,
// in which case the set's lanes come after the authored ones.
export function resolveLanes(node, { modelSets = {}, activeModels = null } = {}) {
  const d = node?.data ?? {};
  const lanes = (Array.isArray(d.lanes) ? d.lanes : []).map(normalizeLane);

  const setId = slug(d.modelSet);
  if (setId) {
    const set = modelSets?.[setId];
    let models = Array.isArray(set?.models) ? set.models : [];
    // A set naming a model that is no longer active shrinks rather than
    // minting a lane that cannot run. Skipped when the caller has no active
    // list to judge against (the linter, for one).
    if (Array.isArray(activeModels)) {
      const usable = new Set(activeModels.filter(m => m && m.enabled !== false).map(m => m.id));
      models = models.filter(id => usable.has(id));
    }
    const preset = LANE_PRESETS[d.modelSetPreset] ? d.modelSetPreset : undefined;
    for (const model of models) {
      lanes.push(normalizeLane({
        id: slug(model), label: model, worker: model,
        ...(preset ? { preset } : {}),
        // Without a preset, a per-model lane's whole point is the model, so
        // that is what its siblings are told about it.
        ...(preset ? {} : { intent: `the same brief, answered by ${model}` })
      }, lanes.length));
    }
  }

  return uniqueLaneIds(lanes);
}

// The prompt a single lane runs on (B6). It carries the shared goal, the
// lane's own instructions, and — the load-bearing part — the LABELS AND
// INTENTS of its siblings. "Find at least one thing the others will not" is
// only a meaningful instruction if a lane knows who the others are.
//
// Sibling OUTPUTS never cross. Sharing them would collapse the divergence the
// fan-out exists to produce: every lane would converge on whatever the first
// one said.
export function laneBrief(lane, lanes, { goal = '' } = {}) {
  const siblings = lanes.filter(l => l.id !== lane.id);
  const parts = [];
  if (goal.trim()) parts.push(`SHARED GOAL (every lane is answering this):\n${goal.trim()}`);
  parts.push(`YOUR LANE: ${lane.label}${lane.intent ? ` — ${lane.intent}` : ''}`);
  if (lane.instructions) parts.push(`YOUR LANE'S INSTRUCTIONS:\n${lane.instructions}`);
  if (siblings.length) {
    parts.push([
      `THE OTHER LANES WORKING THIS SAME BRIEF (${siblings.length}):`,
      ...siblings.map(l => `- ${l.label}${l.intent ? ` — ${l.intent}` : ''}`),
      '',
      'You will never see their output, and they will never see yours. Do not guess at what they',
      'found or hedge against it. Surface AT LEAST ONE finding that no other lane above is',
      'positioned to reach — that is why your lane exists separately from theirs.'
    ].join('\n'));
  }
  return parts.join('\n\n');
}

// --- the shared preamble (FANOUT §1.1) --------------------------------------
//
// The first half of a lane's SYSTEM prompt: generated once per run, identical
// in every lane, and prepended to the preset's fixed role prompt. The split is
// load-bearing — the preamble owns MISSION AND SCOPE, the preset owns METHOD
// AND OUTPUT SHAPE. Keep it when editing either, or the two start contradicting
// each other about what the lane is supposed to produce.
//
// `laneBrief()` is untouched by this: the shared goal and the sibling roster
// stay in the USER message where D36 put them.
export function sharedPreamble({ mission, subject, count, focus = [], ignore = [], subjectRepo = '' }) {
  const parts = [
    `You are one of ${count} agents reading ${subject} in parallel. `
    + `Your shared goal is to ${mission}`,

    `You will never see the other agents' output and they will never see yours. `
    + `Do not guess at what they found or hedge against it. Surface AT LEAST ONE `
    + `finding no other lane is positioned to reach — the point of running `
    + `${count} of you is coverage, not ${count} versions of the same answer.`,

    `Ground every claim in a file and a line you actually opened: search first, `
    + `then read the specific place. Say plainly what you could not determine `
    + `rather than filling the gap.`
  ];
  if (subjectRepo) parts.push(addressingBlock(subjectRepo));
  if (focus.length) parts.push(`TREAT AS CENTRAL:\n${focus.map(f => `- ${f}`).join('\n')}`);
  // `ignore` is ADVISORY and nothing more (§1.2). "Don't focus on X" is a
  // statement about attention, not about relevance: a user who says "ignore
  // syntax errors" still wants to hear it when a syntax error is why the build
  // is broken. The "unless it is load-bearing" clause is the decision, not
  // filler — hard enforcement turns a hint into a blindfold, and the failure
  // is silent, because nobody ever sees the finding that was suppressed.
  if (ignore.length) parts.push(
    `LOW PRIORITY — the person asking did not ask for this, so do not spend `
    + `effort here unless it is load-bearing for something they did ask for:\n`
    + ignore.map(i => `- ${i}`).join('\n'));
  return parts.join('\n\n');
}

// How to address the SUBJECT rather than the project this flow is running in
// (HOME-CONTEXT P1.1). Both roots are reachable from the same two tools and
// only the path prefix distinguishes them, so a lane that slips reads our code
// and reports on it as if it were the subject — confidently, and with nothing
// in the log to tell the two apart.
//
// The last line does more work than the first three: a model that has been told
// the failure mode catches its own slip, where one given only the correct usage
// has no reason to re-examine a call that returned a perfectly good file.
export function addressingBlock(repo) {
  return [
    `THE SUBJECT IS NOT THIS PROJECT. You are reading \`reference:${repo}\`, a read-only clone.`,
    `- \`search_references\` searches it. It defaults to repo: "${repo}" for you; passing`,
    `  repo: "*" searches every reference in a shared library, and hits from other`,
    '  repositories are not findings about this one.',
    `- \`read_file\` on "reference:${repo}/<path>" reads it.`,
    '- `read_file` on a bare path like "src/index.js" reads THIS PROJECT, not the subject.',
    '  Every tool result says which root it came from. If you do that by accident, the file',
    '  you get back is not evidence for anything you were asked.'
  ].join('\n');
}

// Prepend one preamble to every lane's role prompt. A lane with no role prompt
// of its own still gets one, so the mission reaches every lane in the roster.
export function applyPreamble(lanes, preamble) {
  if (!preamble) return lanes;
  return lanes.map(lane => ({
    ...lane,
    system: [preamble, lane.system ?? ''].filter(Boolean).join('\n\n')
  }));
}

// --- staffing the roster (FANOUT P2) ----------------------------------------
//
// One hard rule: TWO LANES SHARING A PRESET NEVER SHARE A MODEL. A planner may
// legally put three architecture readers on a repo when architecture is what
// was asked for (P3.2), and three identical role prompts on one model is three
// correlated reads sold as coverage — precisely the failure this node exists to
// prevent. When the pool runs dry before the roster does, the roster is
// TRUNCATED and each drop reported: shipping the correlated reads silently is
// worse than running two lanes and saying so.
//
// Lanes of DIFFERENT presets may share a model freely — the preset is doing the
// diverging there. A lane with no preset at all is unconstrained: it has no
// fixed role text to be correlated with.
//
// `pool` is the ordered fallback list ({provider, model} or plain model ids);
// a lane that already names a worker is pinned and never reassigned, even when
// that duplicates another same-preset lane's model. The author asked for it.
//
// Deterministic by construction: lanes in order, pool in order, no randomness.
export function assignWorkers(lanes, pool = []) {
  const candidates = (Array.isArray(pool) ? pool : []).map(normalizeLaneWorker).filter(Boolean);
  const usedByPreset = new Map();   // preset -> Set(model)
  const taken = preset => {
    if (!preset) return null;
    let s = usedByPreset.get(preset);
    if (!s) usedByPreset.set(preset, s = new Set());
    return s;
  };

  const out = [];
  const dropped = [];
  for (const lane of lanes) {
    const used = taken(lane.preset ?? null);
    if (lane.worker) {
      used?.add(lane.worker.model);
      out.push(lane);
      continue;
    }
    const pick = candidates.find(c => !used || !used.has(c.model));
    if (!pick) {
      dropped.push({
        id: lane.id,
        preset: lane.preset ?? null,
        reason: candidates.length
          ? `every available model is already running a "${lane.preset}" lane — two lanes of one preset on one model are not two reads`
          : 'no model pool to staff this lane from'
      });
      continue;
    }
    used?.add(pick.model);
    out.push({ ...lane, worker: pick });
  }
  return { lanes: out, dropped };
}

// What the fan-out writes to its `lanes` port: the roster, so a reader can see
// which lane produced which section of the aggregate and on what model.
export function laneInventory(lanes) {
  return [
    `${lanes.length} lane(s):`,
    '',
    ...lanes.map(l => `- ${l.label} (${l.id})${l.worker ? ` · ${l.worker.model}` : ''}${l.intent ? ` — ${l.intent}` : ''}`)
  ].join('\n');
}

// --- the brief artifact (FANOUT P3.6) ---------------------------------------
//
// `<id>.brief.md` is what a user opens to understand why THESE lanes ran, so
// it is prose, not the raw contract JSON. Each lane's `reason` appears here and
// nowhere else — it is written for the log and the reader, never sent to the
// lane it describes.
export function renderBrief(plan, { fallback = false, reason = '' } = {}) {
  const parts = [
    '# Why these lanes',
    '',
    `**Mission** — ${plan.mission}`,
    `**Subject** — ${plan.subject}`,
    // Present when an upstream orientation settled the stance (D38): the single
    // most useful line for understanding why THIS roster and not another.
    ...(plan.relation ? [`**Relation to this project** — ${plan.relation}`] : [])
  ];
  if (plan.focus?.length) parts.push('', '## Treated as central', ...plan.focus.map(f => `- ${f}`));
  if (plan.ignore?.length) {
    parts.push('', '## Low priority', '',
      'Advisory only: a lane still reports one of these when it turns out to be',
      'load-bearing for something that WAS asked for.',
      ...plan.ignore.map(i => `- ${i}`));
  }
  parts.push('', `## The roster (${plan.lanes.length})`, '');
  for (const l of plan.lanes) {
    parts.push(`### ${l.label} — \`${l.preset}\``);
    if (l.intent) parts.push(`*${l.intent}*`);
    if (l.emphasis) parts.push(`- **This lane specifically:** ${l.emphasis}`);
    if (l.worker) parts.push(`- **Model:** ${l.worker.model}`);
    if (l.reason) parts.push(`- **Why it exists:** ${l.reason}`);
    parts.push('');
  }
  if (fallback) {
    parts.push('---', '',
      '> This roster is the flow\'s AUTHORED fallback, not a planned one'
      + (reason ? ` — ${reason}` : '') + '.',
      '> The planning call did not produce a usable roster, so the lanes the author',
      '> wrote ran instead. The reading is still valid; it just was not shaped to',
      '> this particular brief.');
  }
  return parts.join('\n');
}
