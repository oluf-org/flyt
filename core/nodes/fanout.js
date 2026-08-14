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

// Named lane shapes, so the common four are one click rather than a paragraph
// of prompt each (P2.2). These are `instructions` presets on a lane — not new
// node types, and not new roles. A lane may take a preset, its own text, or
// both (the preset first, the author's text after).
export const LANE_PRESETS = {
  standard: {
    label: 'Standard',
    intent: 'the brief as written, done well',
    instructions: 'Answer the shared brief directly and thoroughly. Prefer what is well-supported over what is striking.'
  },
  wildcard: {
    label: 'Wildcard',
    intent: 'the odd, hidden, undocumented, surprising',
    instructions: 'Look ONLY for what is odd, hidden, undocumented, or surprising. Ignore the obvious reading of the brief entirely — the other lanes have it covered. Something interesting and uncertain beats something safe and already known.'
  },
  adversarial: {
    label: 'Adversarial',
    intent: 'what is fragile, wrong, or badly done',
    instructions: 'Look ONLY for what is done badly, is fragile, or is outright wrong. Assume something here will fail and your job is to say what, and under which conditions. Do not balance criticism with praise.'
  },
  contrarian: {
    label: 'Contrarian',
    intent: 'the case against the obvious reading',
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

// One raw lane entry → the canonical lane. `index` only supplies a fallback id
// for a lane written without one.
export function normalizeLane(raw, index = 0) {
  const entry = typeof raw === 'string' ? { preset: raw } : (raw ?? {});
  const preset = LANE_PRESETS[entry.preset] ?? null;
  const id = slug(entry.id) || slug(entry.label) || (preset ? slug(entry.preset) : '') || `lane-${index + 1}`;
  const own = typeof entry.instructions === 'string' ? entry.instructions.trim() : '';
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
    ...(entry.preset ? { preset: String(entry.preset) } : {})
  };
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

  // Duplicate ids would collide as node ids inside the box; suffix rather than
  // drop, because a set and an authored lane naming the same model is a
  // reasonable thing to write.
  const seen = new Map();
  return lanes.map(lane => {
    const n = (seen.get(lane.id) ?? 0) + 1;
    seen.set(lane.id, n);
    return n === 1 ? lane : { ...lane, id: `${lane.id}-${n}` };
  });
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

// What the fan-out writes to its `lanes` port: the roster, so a reader can see
// which lane produced which section of the aggregate and on what model.
export function laneInventory(lanes) {
  return [
    `${lanes.length} lane(s):`,
    '',
    ...lanes.map(l => `- ${l.label} (${l.id})${l.worker ? ` · ${l.worker.model}` : ''}${l.intent ? ` — ${l.intent}` : ''}`)
  ].join('\n');
}
