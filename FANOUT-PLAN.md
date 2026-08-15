# FANOUT-PLAN.md — the fan-out reads the brief before it picks its lanes

Status: **not started.** Lands as **D37** in `DECISIONS.md` when P3 is merged.
Retire this file to git history once P6 is done (standing rule in `CLAUDE.md`).

---

## 0. What this is

Today a fan-out's roster is fixed at authoring time. `flows/learn-from-repo.flow.yaml`
declares four lanes — architecture, wildcard, adversarial, contrarian — and runs
exactly those four whatever the user asked for. If the user says *"focus entirely
on how it handles retries, ignore style"*, four lanes still read four different
ways, three of which were told to look somewhere the user explicitly did not care
about.

This plan gives the fan-out one planning call before it materializes children.
That call:

- **peeks at the subject** with read-only tools (a few globs and a file or two),
- **writes the shared preamble** every lane opens with — the "you are one of N
  agents, your shared goal is …" paragraph,
- **picks the roster** from the fixed preset list, and may repeat a preset to put
  three architecture readers on a repo when architecture is what was asked for,
- **extracts focus and ignore** from the intent of the prompt rather than from
  dedicated input fields.

Two things it may **not** do: author lane instructions (presets are fixed text,
and stay fixed), or run two lanes of the same preset on the same model.

### 0.1 What it reverses

`FLOW_NODES.md` §7b currently states the fan-out's defining property:

> An orchestrator asks a model *which children to create*; a fan-out already
> knows, because the author wrote a lane list […] So there is **no planning
> call**, no strict contract and no re-ask.

That is exactly what P3 adds, so §7b is rewritten, not appended to. The property
worth preserving from D36 is *why* there was no planning call: lanes were author-
written, so nothing a model said could change what ran. The mitigation is the
enum. The planner **selects and duplicates** from `LANE_PRESETS`; it never writes
what a lane is. A model that can pick lanes but not define them cannot turn an
adversarial read into a flattering one.

D36 point 4 survives untouched: lane outputs still never cross.

### 0.2 Non-goals

- No new node type. This is `type: fanout` gaining keys.
- No change to `runContainer` or the sub-walk.
- No DSL dependencies (D24).
- Not on by default. `plan: auto` is opt-in; every existing flow behaves
  identically until its author asks for this.

---

## 1. The two prompt layers

A lane's system prompt becomes two concatenated parts:

1. **Shared preamble** — generated per run, identical in every lane.
2. **Role prompt** — `LANE_PRESETS[preset].system`, fixed text, plus the
   planner's optional one-sentence `emphasis`.

`laneBrief()` stays exactly where it is, in the **user** message, carrying the
shared goal and the sibling roster. Nothing about D36's sibling-awareness moves.

Lanes have no `system` field today (`src/flowTypes.js:736` — templates don't
carry one, it is an instance-level override), so P1 adds the passthrough.

### 1.1 The preamble template

```js
// core/nodes/fanout.js
export function sharedPreamble({ mission, subject, count, focus = [], ignore = [] }) {
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
  if (focus.length) parts.push(`TREAT AS CENTRAL:\n${focus.map(f => `- ${f}`).join('\n')}`);
  if (ignore.length) parts.push(
    `LOW PRIORITY — the person asking did not ask for this, so do not spend `
    + `effort here unless it is load-bearing for something they did ask for:\n`
    + ignore.map(i => `- ${i}`).join('\n'));
  return parts.join('\n\n');
}
```

Both trailing blocks are omitted entirely when empty. A `FOCUS: none in
particular` line is worse than silence.

### 1.2 Ignore is advisory, by decision

`ignore` is a preamble line and nothing more. The planner is **not** permitted to
drop a lane because its preset collides with an ignore item, and the runner does
not filter findings against it.

The reason: "don't focus on X" is a statement about attention, not a statement
about relevance. A user who says *"ignore syntax errors"* still wants to hear it
if a syntax error is why the build is broken. Hard enforcement turns a hint into
a blindfold, and the failure is silent — nobody sees the finding that was
suppressed. The wording above ("unless it is load-bearing for something they did
ask for") is the load-bearing part of this decision and should not be softened
into a flat prohibition during implementation.

The planner may still *shape* the roster around a focus — that is what `focus`
and lane selection are for. It just may not do it as a punishment for an ignore
item.

---

## 2. Phases

### P1 — `architecture` preset, lane `system`, `sharedPreamble()`

Pure functions, no model call, fully unit-testable. Nothing downstream can be
built without these.

**P1.1 — Fifth preset.** `LANE_PRESETS` (`core/nodes/fanout.js:17`) gains
`architecture`. `learn-from-repo` hand-writes this today as `standard` plus an
`intent` string, which means the planner could never select it — it can only
choose from the enum, so anything absent from `LANE_PRESETS` is unreachable.

**P1.2 — Presets gain a `system` field.** Today a preset is `{ label, intent,
instructions }` and the instructions land in the user message. Add `system:` per
preset — the role prompt from §1 — leaving `instructions` in place for the
lanes that still want a user-message nudge. Both compose; neither replaces the
other.

Draft text for all five is in §6. It is deliberately shape-owning (each preset
names its own output structure) because `DEFAULT_SYSTEM.analyze`
(`core/flowRunner.js:196`) otherwise imposes one report format on all of them,
which is the single biggest source of four-lanes-that-read-alike today.

**P1.3 — The `system` passthrough.** Four touch points:

| File | Change |
|---|---|
| `core/flowlang/schema.json` `$defs/lane` | add `system` and `emphasis` (`additionalProperties: false` currently rejects them) |
| `core/nodes/fanout.js` `normalizeLane` | carry `system` and `emphasis` through, preset `system` first, lane's own after |
| `core/flowRunner.js:3230` (`templateNode(...)` in `runFanout`) | forward `...(lane.system ? { system: lane.system } : {})` |
| `src/flowTypes.js:736` | already honours `ov.system` on the library path — verify, don't change |

Note the fallback branch of `templateNode` (flowRunner.js, the `if (lib)` miss)
destructures a fixed override subset. It already lost `instructions`/`worker`/
`tools` once — see the D36 P2.1 comment there. Add `system` to **both** paths.

**P1.4 — `sharedPreamble()`** exactly as §1.1.

**Tests** (`tests/fanout.test.js`):

- a preset's `system` and a lane's own `system` compose, preset first
- a lane with no `system` produces no `data.system`, so it still falls through
  to `DEFAULT_SYSTEM[role]` — the no-regression case
- `sharedPreamble` omits both optional blocks when the arrays are empty
- a lane's `system` reaches the child node's `data.system` through both
  `templateNode` paths

---

### P2 — `assignWorkers()`

New export in `core/nodes/fanout.js`. Runs after `resolveLanes`, before
materialization.

```js
export function assignWorkers(lanes, pool) // -> { lanes, dropped }
```

Pool order: explicit lane workers (already pinned, never reassigned) → the
node's `worker` → active models in priority order (`core/modelPriority.js`).

One hard rule: **two lanes sharing a `preset` never share a model.** If the pool
runs dry before the roster does, the roster is *truncated* and each drop is
logged as `fanout_lane_unstaffed` with the preset and the reason. Three
architecture lanes on one model is three correlated reads sold as coverage,
which is precisely the failure this node exists to prevent — shipping it silently
would be worse than running two lanes.

Lanes of *different* presets may share a model freely; the preset is doing the
diverging there.

**Tests:**

- two lanes of the same preset get different models
- a lane with an explicit `worker` keeps it even when that duplicates another
  preset's model (the author asked for it)
- an exhausted pool truncates and reports rather than doubling up
- deterministic: the same lanes + pool produce the same assignment twice

---

### P3 — the planning call

Behind `plan: auto`. This is the phase that reverses part of D36, so it merges
with the D37 entry and the §7b rewrite in the same commit.

**P3.1 — The peek.** Before planning, one bounded read-only agent call over the
fan-out's own tool grant, narrowed to `glob`, `read_file`, `search_references`.
It answers one question: *what am I actually looking at?* Budget: `maxTokens`
small, and a hard cap of **6 tool calls** — the peek exists to tell a Rust
workspace from a monorepo of notebooks, not to pre-read the repo. It writes to
`nodes/<id>.peek.md`.

Runs through `trackedRunAgent` (`core/flowRunner.js:590`) with the same read-only
filter `aiStepTools` applies (`:622`). Ceiling inheritance is the fan-out's, per
§6.3 — the peek must not be able to do more than the lanes it is planning.

If the peek fails, or the node has no tool grant, planning proceeds without it
and logs `fanout_peek_skipped`. A blind planner is the P3-without-P3.1 behaviour
and is still better than no planner.

**P3.2 — `LANE_PLAN_SYSTEM`.** A direct call, not a node role — the precedent is
`TRIAGE_SYSTEM` / `INVESTIGATE_SYSTEM` / `SUMMARIZE_SYSTEM` at
`core/flowRunner.js:304–370`, each with the comment explaining why it is not a
role. Follow that comment convention.

Its user message: the run prompt, the node's `goal`, the peek output, the
authored lane roster (as the fallback and as a hint at what the author wanted),
the available model pool, and the lane budget.

Strict contract, one fenced block:

```json
{
  "mission": "one sentence completing 'your shared goal is to …'",
  "subject": "the repository | these three repositories | the codebase",
  "focus": ["what this reading is actually for"],
  "ignore": ["what the person asking did not ask about"],
  "lanes": [
    {
      "preset": "standard|architecture|wildcard|adversarial|contrarian",
      "id": "kebab-case, unique",
      "label": "Architecture — the data path",
      "intent": "one line, shown to the other lanes",
      "emphasis": "at most one sentence narrowing this lane inside its preset",
      "reason": "why this lane exists — for the log, never sent to the lane"
    }
  ]
}
```

`preset` is an enum; anything else fails validation. Repeating a preset is legal
and is how "focus entirely on architecture" becomes three architecture lanes
differing only in `label` / `intent` / `emphasis`.

**P3.3 — Parsing.** `parseLanePlan(text, { presetIds, minLanes, maxLanes })` in
`core/planEval.js`, beside `parseTriage` (`:228`) and `parseRefineQuestions`
(`:277`). Same shape: returns `{ ok, plan, errors }`, never throws. One bounded
re-ask through the existing `reAsk` (`core/flowRunner.js:3539`), then fallback.

Validation: preset in enum, lane count within budget, ids unique and kebab,
`emphasis` ≤ 280 chars, `mission` non-empty and a single sentence. A missing
`focus`/`ignore` is an empty array, not an error — most briefs have neither.

**P3.4 — Bounds.** `minLanes` / `maxLanes` on the node, defaults **2** and **6**,
appended to the planner's system prompt the way the orchestrator's `NODE BUDGET`
is (`core/flowRunner.js:3069`). Each lane is a full read of the subject on a
metered API; an unbounded roster is the same class of liability as an unbounded
loop, and D36's loop rule exists for exactly that reason.

**P3.5 — Wiring into `runFanout`** (`core/flowRunner.js:3181`). The planner runs
in the `else` branch — the one that materializes children — and only when
`children.length === 0`. The resume path already short-circuits by matching
`laneId`; keep that ahead of everything so a resumed run never re-plans and
never re-peeks.

Order inside the branch:

1. `resolveLanes` (authored lanes / model set) — unchanged, this is the fallback
2. peek (P3.1) → `nodes/<id>.peek.md`
3. plan (P3.2–P3.3) → `nodes/<id>.brief.md`, streamed via `streamInto`
4. planned roster → `normalizeLane` per lane, preamble prepended to each
   `system`
5. `assignWorkers` (P2)
6. materialize, exactly as today

**P3.6 — Ports.** Two new sidecars beside `results` and `lanes`:
`brief` (the mission, focus, ignore and the roster with each lane's `reason`) and
`peek`. Both are `writeNodeOutput(runId, \`${node.id}.<port>\`)` — the pattern at
`:3082`. `<id>.brief.md` is the artifact a user reads to understand why these
lanes ran, so render it as prose, not raw JSON.

**P3.7 — Degrade, never fail.** Planner error, unparseable JSON after the
re-ask, or an empty roster → log `fanout_plan_failed`, then run the **authored**
lanes with a mission derived mechanically from `goal` ("…to answer: <goal>").
Same posture as `workspaceFor()` (`:643`): a missing capability degrades a run,
it does not kill it. A fan-out that cannot reach its planner should still read
the repo.

**P3.8 — Author override.** A `system:` written on the fan-out node itself wins
outright and skips both the peek and the planning call. Note that `system` is
*currently* a legal key on a `rawNode` in the schema that nothing reads on the
fanout path — writing it today lints clean and does nothing. P3.8 makes it mean
something, which also closes that silent no-op.

**Tests:**

- `plan: auto` off → byte-identical behaviour to today (guard the whole feature)
- a planned roster of three same-preset lanes gets three different models
- an invalid plan falls back to authored lanes and the run still completes
- a resumed run re-plans zero times and re-peeks zero times
- the peek's tool grant cannot exceed the fan-out's ceiling
- `ignore` reaches the preamble as advisory wording, and no lane is dropped for
  colliding with it (the §1.2 guarantee, asserted explicitly)

---

### P4 — schema, lint, DSL surface

New node keys: `plan` (`auto` | `off`, default `off`), `minLanes`, `maxLanes`.
New lane keys: `system`, `emphasis`.

Lint rules:

- `plan: auto` on a node with no `goal` and no upstream edge → warn (the planner
  has nothing to read)
- `minLanes > maxLanes` → error
- `plan: auto` together with a node-level `system` → warn that the planner is
  inert (P3.8)
- peek tools stay inside the read-only rule the existing `readonly-tools` rule
  enforces

`tests/flowlangLint.test.js` covers each.

---

### P5 — `learn-from-repo`

Switch `read` to `plan: auto`, `maxLanes: 6`. Keep all four authored lanes
verbatim — under P3.7 they are the fallback roster, so deleting them would make
a planner failure fatal. Add `laneModels` (or leave the pool to
`modelPriority`) so a planner minting a fifth and sixth lane has somewhere to
staff them from.

Run it against a real repo twice — once with a neutral goal, once with
*"focus entirely on architecture, ignore test coverage"* — and diff the two
`<id>.brief.md` files. If the rosters are the same, P3 is not working, and no
unit test will tell you that.

---

### P6 — docs

- `FLOW_NODES.md` §7b — rewrite the "no planning call" paragraph; document
  `plan`, `minLanes`, `maxLanes`, the `brief` and `peek` ports, and the five
  presets
- `FLOW_LANG.md` — the new node and lane keys
- `DECISIONS.md` — **D37**, covering: the enum constraint as the mitigation for
  reversing part of D36 §7b; ignore-is-advisory (§1.2) and why; same-preset
  models must differ (P2) and why truncating beats doubling up
- `DESIGN-SPEC.md` §11 — built-vs-planned ledger

---

## 3. Failure modes worth naming

| Risk | Mitigation |
|---|---|
| Planner converges on one preset for every brief | `minLanes: 2` plus the same-preset model rule; `reason` per lane in `.brief.md` makes drift readable |
| Peek burns the budget it was meant to save | Hard 6-call cap and a small `maxTokens`; the peek answers one question |
| Generated preamble drifts from the fixed presets and contradicts them | Preamble owns *mission and scope*; presets own *method and output shape*. Keep that split when editing either |
| A planner failure silently degrades quality | `fanout_plan_failed` is logged, and `.brief.md` says the roster was the authored fallback |
| Two lanes with different presets but identical `emphasis` | `emphasis` is planner-written and capped at one sentence; if this shows up in practice, dedupe in `parseLanePlan` rather than in the prompt |

---

## 4. Cost

Per fan-out run with `plan: auto`: one small agent call (peek, ≤6 tool calls) +
one planning call, against N full lane reads. At the current four lanes this is
roughly a 10–15% overhead, and it drops as the roster grows. The saving is real
when the planner drops a lane the brief did not want — the first time it runs
four lanes where the author would have run six, it has paid for itself.

---

## 5. Open

- **Q-F1.** Should the peek's output reach the *lanes*, not just the planner? It
  is already paid for, and a lane starting with a map of the repo wastes fewer
  tool calls rediscovering it. Argument against: it is one model's summary, and
  seeding all lanes with it is a shared prior — the thing this node exists to
  avoid. Leaning no; revisit after P5.
- **Q-F2.** Should `plan: auto` become the default for new fan-outs once P5 has
  run in anger? Opt-in is right for the first release; the answer depends on how
  often the planner beats a hand-written roster.
- **Q-F3.** A `plan: once` mode that plans, writes the roster back into the
  `.flow.yaml`, and never plans again — the planner as an authoring aid rather
  than a run-time step. Cheap, and it fits the "you own the file" principle.
  Deferred; needs a write path that does not surprise the author.

---

## 6. Preset drafts

Each preset owns its output shape. `emphasis`, when the planner supplies one, is
appended as a final line: `THIS LANE SPECIFICALLY: <emphasis>`.

### standard

```
ROLE: primary reader
You answer the shared brief directly and thoroughly. The other lanes are each
looking somewhere specific and strange; you are the one who reads it the way it
asks to be read.
Prefer what is well-supported over what is striking. Where you are confident,
say so plainly and move on — hedging every sentence makes the genuinely
uncertain claims impossible to find.
Output:
# Reading
## What this is
## How it works — <the main path, end to end>
## What matters most for the brief
Cite file:line for every claim. Say what you could not determine.
```

### architecture

```
ROLE: architecture reader
You explain how the subject is put together, and why.
Work outside-in: entry points, then the boundaries between parts, then what
crosses them. Name the load-bearing decisions and the constraint each one
answers to — a design is only explained once you can say what it costs.
Output:
# Architecture
## Shape — <the parts, and what talks to what>
## Load-bearing decisions — <decision · evidence · what it buys · what it costs>
## Where it would strain
Cite file:line you actually opened. Do not describe intent you inferred only
from names.
```

### wildcard

```
ROLE: wildcard reader
You hunt for what is odd, hidden, undocumented, or surprising. The obvious
reading is covered by others; producing it is a failed run.
Go where documentation is absent: dead code, commented-out blocks, oddly
specific constants, defensive branches, comments that apologise, tests that
assert something strange, commit-shaped scar tissue.
Output:
# Findings
For each: **<one-line claim>** · file:line · what it implies · confidence
(certain / likely / speculative).
Rank by surprise, not by certainty. Six sharp findings beat twenty. Label
speculation as speculation rather than softening it into a hedge — an
interesting maybe is the deliverable, a safe restatement is not.
```

### adversarial

```
ROLE: adversarial reader
You find what is fragile, wrong, or done badly. Assume something here fails in
production; your job is to say what, and under which conditions. Do not balance
criticism with praise and do not close with reassurance.
Look for: unhandled failure paths, silent catches, unbounded retries, state that
can be written twice, ordering assumptions, resource leaks, anything whose
correctness depends on a comment.
Output:
# Weaknesses
For each: **<what breaks>** · file:line · the trigger · blast radius · severity
(high / medium / low).
A weakness you cannot tie to a concrete trigger is not a finding — cut it.
```

### contrarian

```
ROLE: contrarian reader
You argue against the obvious reading of the brief. State the strongest version
of the case the other readers will not make.
This is not contradiction for its own sake: build the case from what is actually
there, then state plainly what would have to be true for it to hold, and what
would falsify it. If the obvious reading survives contact with the evidence, say
so explicitly and explain what specifically defeats your case — that is a real
result, not a failure.
Output:
# The case against
## Claim — <the counter-reading, one sentence>
## Evidence — <file:line, each doing actual work>
## What must be true for this to hold
## What would falsify it
Never manufacture evidence to keep the argument alive.
```
