# HOME-CONTEXT-PLAN.md — orient before you read

Status: **not started.** Lands as **D38**.
Companion to `FANOUT-PLAN.md` (D37, mostly built). Retire to git history when P7 is done.

---

## 0. The problem, precisely

`learn-from-repo` reads a foreign repository and produces backlog tasks for **the
workspace the user is standing in**. Nothing in the flow ever establishes what
that workspace is, or what relationship it has to the repo being read.

Follow the chain:

| Step | Knows the subject repo | Knows the home workspace |
|---|---|---|
| `read` peek | yes (`reference:<name>`) | no |
| `read` lane planner | yes | no |
| `read` lanes ×N | yes | **no — but can read it by accident** |
| `synthesise` | via lane output | no |
| `plan` (backlog-plan) | via synthesis | **no, and it must** |
| `work` (loop) | no | yes (agent tasks hold workspace tools) |

The `plan` node is the sharp end. `nodes/backlog-plan.json` has `"tools": null`,
so it holds nothing, and its contract (`DEFAULT_SYSTEM['plan-backlog']`,
`core/flowRunner.js:205`) demands `blastRadius: ["src/thing.js"]` and
`gates: ["npm test"]` — real paths and a real test command for a repository it
has never seen a single file of. Those fields are invented. The loop is what
finds out.

But the deeper gap is upstream of any of that: **"what should we learn from this
repo" has no answer until you know whether we are empty, building the same
thing, or building something unrelated.** The same repo read against those three
situations should produce three different sets of lanes, three different
readings, and three completely different backlogs. Today it produces one.

### 0.1 The silent failure

`read_file` (`core/tools/read_file.js`) resolves a bare path against **the
workspace** — the home repo — and only a `reference:` prefix reaches the subject.
The lane's brief says *"Read the repository you have been given"*. A lane that
calls `read_file("src/index.js")` gets **our** code, is told nothing unusual
happened, and reports on it as if it were the subject.

Every lane in `learn-from-repo` holds `read_file`. The mis-addressing is one
plausible tool call away, it produces confident output, and nothing in the run
log distinguishes it from a correct read.

### 0.2 The other silent failure

`search_references` searches **every** reference in the library unless given
`repo:`. The library is shared and pinned (LOOP-PLAN §16.1), so a lane reading
repo X can match a line in `opencode`, get back `reference:opencode/…`, read it,
and cite it as a finding about X.

---

## 1. The shape: an orientation node, first

Before anything reads the subject, one **agent** surveys the home workspace and
writes a context file. Everything downstream holds that file.

```
inputs.repo ─┐
inputs.goal ─┼─> orient ──> read (fan-out) ──> synthesise ──> plan ──> work
             │      │                              ↑            ↑
             └──────┴──────── orient.context ──────┴────────────┘
```

Not a code-generated digest. An agent, because the question it answers —
*what is this workspace, and what is its relationship to the repo we are about
to read* — is a judgement, not a file listing. It reads the manifest, the
instruction files, the tree, the decision log, then reads enough of the subject
to place the two side by side.

And because it is an agent, it can **ask the user** when the answer is not in
either repo. That machinery already exists (§4).

### 1.1 Why not a typed `project` input

An earlier draft of this plan proposed `type: project` — a typed run input
rendering a code-assembled digest, wired like `type: repo`. Dropped. The
workspace is already bound at `meta.workspace` and every agent tool resolves
against it, so a typed input would be declaring something the run already knows.
More importantly a digest cannot answer the relationship question, which is the
part the rest of the flow actually needs.

The deterministic digest survives as an **internal seed** (§3.1), not as the
deliverable.

---

## 2. The relationship stance

The orientation agent's central output. Four values, and each one changes what
the flow does:

| `relation` | Situation | What the lanes are for | What `plan` emits |
|---|---|---|---|
| `empty` | Workspace is empty or near-empty; we are starting something | find what is worth adopting wholesale, and the order to build it in | tasks that create files, scaffolding first |
| `similar` | We are building the same kind of thing | find where they solved what we solved worse, and where they diverge from us | tasks that change existing files; "we already have X" is a valid finding |
| `adjacent` | Different product, overlapping problems | find the transferable mechanism, not the feature | tasks framed as adaptations, not ports |
| `unrelated` | No meaningful overlap | say so early and read narrowly against the stated goal | few tasks, or an honest "nothing here transfers" |

`unrelated` must be a first-class, non-embarrassing outcome. A flow that cannot
conclude "this repo has nothing for us" will manufacture six tasks to avoid
saying it, and those tasks reach the loop and consume real budget. The
orientation node is the right place to say it because it is the cheapest step in
the flow — one agent, before N lane reads.

`empty` is the case with the least evidence available, and therefore the case
where asking the user is most likely to be correct (§4).

---

## 3. The orientation node

**Template:** `nodes/orient.json`, `baseType: agentTask`, `role: orient`.
**Tools:** `glob`, `read_file`, `search_references` (all read-effect), plus
`write_file` scoped to the config dir (§3.3).
**Effort:** medium. This step is cheap on purpose — it exists so the expensive
steps are aimed.

### 3.1 The seed

`core/homeSeed.js` assembles a deterministic starting digest so the agent does
not spend its first four tool calls rediscovering that `package.json` exists:

1. name + root, git remote and HEAD if present
2. `package.json` name/description/**scripts** (or the ecosystem equivalent) —
   `scripts` is where `gates: ["npm test"]` should come from instead of guesswork
3. tree at depth 2, directories with file counts (not a full listing — a real
   repo's full tree buries the shape it was meant to show)
4. `CLAUDE.md` / `AGENTS.md` / `README.md`, first ~1500 chars each
5. `.flyt/config.json` (D15, D22, D29)
6. `### D<n> — <title>` lines from `DECISIONS.md`, titles only — ~30 lines that
   answer "have we already decided this?", where the bodies are the whole file

Hard cap ~4k chars, per-section budgets, truncation marked inline (the pattern
`SUMMARY_SOURCE_BUDGET` uses, `core/flowRunner.js:373`). Every section optional.
Never throws. An empty workspace yields a seed that says "empty", which is a
real finding, not a failure.

The agent gets the seed **and** the tools, so it can go deeper wherever the seed
looks thin or contradictory.

### 3.2 The contract

Prose file, then exactly one fenced JSON block:

```json
{
  "relation": "empty|similar|adjacent|unrelated",
  "confidence": "high|medium|low",
  "mission": "one sentence completing 'your shared goal is to …'",
  "focus": ["what this reading is actually for, here"],
  "ignore": ["what this workspace does not need from that repo"],
  "assumptions": ["stated where the agent resolved ambiguity itself"],
  "questions": [
    { "id": "slug", "text": "the question", "why": "what changes with the answer" }
  ]
}
```

`mission`, `focus` and `ignore` are the fields `FANOUT-PLAN` §1.1 already
consumes — the fan-out's own planner currently invents them from the prompt
alone. After this it inherits them from a step that has actually read both
repositories, and its job narrows to choosing a roster. That is a strict
improvement and it removes a duplicated inference.

Parse with `parseOrientation(text)` in `core/planEval.js`, beside
`parseRefineQuestions` (`:280`) and `parseLanePlan`. Total function, never
throws, `{ ok, orientation, errors }`, one bounded `reAsk` then fallback (§6).

### 3.3 The written file

Two destinations, deliberately:

- **`nodes/orient.md`** in the run folder — always. The prose context file, the
  thing every downstream node holds.
- **`.flyt/context.md`** in the workspace — when the run is attended and the
  file is absent or stale. Per-project, version-controllable, hand-editable:
  exactly what `.flyt/` is for (D15, D22, D29).

The second is what makes "the first run gives that context" true across runs.
Subsequent runs read `.flyt/context.md` as part of the seed and the orientation
becomes a cheap confirm-or-revise rather than a full survey.

**Staleness:** stamp the file with the HEAD sha and date at write time. Re-survey
when HEAD has moved, when the file is older than 30 days, or when the subject
repo differs from the one recorded. Never silently trust a context file written
against a different repository.

**The user owns it.** A hand-edited `.flyt/context.md` is never overwritten
without saying so — the run reports "your context file says X; I would now say
Y" and leaves the file alone unless the user is there to accept. Silently
rewriting a file the user edited is the one way this feature becomes something
people turn off.

---

## 4. Asking the user

The machinery exists. `handleRefineQuestions` (`core/flowRunner.js:2474`) parks
the run at the `awaiting_input` gate, stores the questions, waits on
`inputGates`, writes answers to `<node>.answers`, and requeues the node. The
`refine` role's prompt (`:236`) already encodes the discipline this needs:

> Resolve ordinary ambiguity yourself by stating a reasonable assumption inline
> […] ONLY when an ambiguity would MATERIALLY change the deliverable (a fork you
> cannot responsibly pick for the user) may you ask.

`orient` reuses it verbatim — the same parked stage, the same one-round-only
rule via `answeredInputs`, the same 3-question cap in `parseRefineQuestions`.
Generalize the handler to any role emitting a `questions` block rather than
copying it; `handleRefineQuestions` is already role-agnostic apart from its name
and its `stripRefineQuestions` call.

**What is worth asking.** The bar is the `refine` bar, and for orientation it
lands almost entirely on the `empty` and `unrelated` cases:

- empty workspace and the prompt does not say what is being built — ask. There
  is no evidence anywhere else, and every downstream step depends on the answer.
- the workspace looks like a *different* product than the prompt implies — ask,
  once, with both readings offered.
- the goal is "learn from this repo" with no stated purpose and the relation is
  `adjacent` — ask what we are trying to build.

Not worth asking: anything readable from either repo. An orientation agent that
asks "what does this project do?" when `README.md` says so has failed at its
actual job.

**Unattended runs must not hang.** The headless supervisor (LOOP-PLAN) and
scheduled runs have nobody to answer. Rule: when `approvalMode` is `always`
(`core/flowRunner.js:559` — "the agent runs unattended"), `orient` **does not
park**. It records what it would have asked in `assumptions` with an explicit
`ASSUMED:` prefix and proceeds. The questions still appear in `orient.md` and in
the log as `orientation_assumed`, so a human reading the run afterwards sees
exactly which forks were taken blind. A flow that can park forever is not usable
from the loop, and the loop is where this flow is meant to end up (D36 point 9).

---

## 5. Wiring, step by step

**P1 — Addressing hygiene.** Independent of everything else, ships first, closes
the §0.1/§0.2 silent failures.

- **P1.1** `sharedPreamble()` (`core/nodes/fanout.js:280`) gains a subject-
  addressing block when the fan-out is fed by a repo input:

  ```
  THE SUBJECT IS NOT THIS PROJECT. You are reading `reference:<name>`, a
  read-only clone.
  - `search_references` with repo: "<name>" searches it. Without `repo:` you
    are searching every reference in a shared library, and hits from other
    repositories are not findings about this one.
  - `read_file` on "reference:<name>/<path>" reads it.
  - `read_file` on a bare path like "src/index.js" reads THIS PROJECT, not the
    subject. If you do that by accident, the file you get back is not evidence
    for anything you were asked.
  ```

  The last line matters more than the first three. A model that knows the
  failure mode catches its own slip.

- **P1.2** `read_file` already returns `target`; render it as a visible first
  line of the tool result (`core/tools/read_tool_result.js`) —
  `[workspace: this project]` or `[reference:<name> — read-only]`. The
  information exists and never reaches the model's eyes.
- **P1.3** `search_references` defaults `repo:` to the subject when the node is
  fed by a repo input (the binding is already at hand in `repoTargets`,
  `core/flowRunner.js:1867`). `repo: "*"` opts out, deliberately.
- **P1.4** Log `tool_target_unexpected` when a node carrying `laneId` and fed by
  a repo input reads a bare workspace path. Not a block — a lane comparing
  subject to home is legitimate — but it must be visible.

**P2 — `homeSeed`.** §3.1. Pure, deterministic, unit-testable, no model call.

**P3 — `parseOrientation` + the `orient` template.** §3.2, plus
`DEFAULT_SYSTEM.orient` and `nodes/orient.json`.

**P4 — Generalize the input gate.** Rename `handleRefineQuestions` →
`handleNodeQuestions`, drop the role assumption, keep behaviour identical for
`refine`. Add the unattended bypass (§4). Existing refine tests must pass
unchanged — that is the guard on this refactor.

**P5 — `.flyt/context.md`.** Write, stamp, staleness check, the
never-clobber-a-hand-edit rule (§3.3), and seeding from it on later runs.

**P6 — Consume it.**

- `orient.summary` → the fan-out. A capped ≤120-word orientation: what this
  project is, the relation, and what we are looking for. **Capped in code**, not
  by instruction — this is the field most likely to grow until every lane shares
  a detailed prior, and that collapses the divergence the fan-out exists to
  produce (D36 point 4). Lanes need to know who is asking and why, not our
  architecture.
- `orient` (full) → the lane planner, `synthesise`, `plan`. The roster decision
  is exactly where "we already have a scheduler, so read theirs adversarially
  rather than descriptively" is right, and that needs the whole picture.
- `nodes/backlog-plan.json` gains `"tools": ["glob", "read_file"]` — read-effect
  only, inside the `aiStepTools` rule (`:622`) — and its contract tightens:
  **`blastRadius` paths must be confirmed to exist**, or be a confirmed
  directory. Today the field is a plausible string; with a grant it is a checked
  claim. Under `relation: empty` it is instead the files the task will create,
  named as such.
- `synthesise`'s instructions currently say *"Make sure the tasks fit into this
  repo as well"* — an instruction to a node with no way to know what this repo
  is. With `orient` in context, sharpen it to name the job: what is relevant
  here, what is already solved here, what does not apply.

**P7 — Docs.** `FLOW_NODES.md` (the `orient` node, the questions contract),
`FLOW_LANG.md`, `DECISIONS.md` **D38**, `DESIGN-SPEC.md` §11, and
`flows/learn-from-repo.flow.yaml`.

---

## 6. Failure posture

Every step degrades rather than fails — the `workspaceFor()` posture
(`core/flowRunner.js:732`).

| Failure | Behaviour |
|---|---|
| No workspace bound | `relation: empty`, `confidence: low`, one recorded assumption; run continues |
| Orientation call fails | log `orientation_failed`, downstream gets the raw seed, fan-out planner falls back to inferring from the prompt as it does today |
| Contract unparseable | one `reAsk`, then treat the prose as the context file and default `relation` to `adjacent` — the stance that assumes least |
| `.flyt/` not writable | run-folder copy only, logged, no failure |
| Nobody answers the gate | existing behaviour: `(the user provided no answer — proceed on your stated assumptions)` (`:2486`) |

---

## 7. Tests

- seed: no manifest / no README / no `.flyt` → valid seed saying so, no throw
- seed: deterministic across two runs on identical bytes; budgets respected;
  truncation marked
- empty workspace → `relation: empty` and at least one question when the prompt
  does not say what is being built
- unattended (`approvalMode: 'always'`) → no park, questions recorded as
  `ASSUMED:` assumptions, run completes
- attended → parks at `awaiting_input`, answers reach `<node>.answers`, node
  re-runs once and cannot park again
- `orient.summary` is ≤120 words for a workspace with a 4000-word README
- a hand-edited `.flyt/context.md` is not overwritten; the divergence is reported
- stale context (HEAD moved / different subject repo) triggers re-survey
- `relation: unrelated` produces a small or empty backlog without inventing work
- lane preamble carries the addressing block only when a repo input feeds it
- `search_references` without `repo:` is scoped to the subject; `"*"` opts out
- bare-path `read_file` from a lane logs `tool_target_unexpected`
- `backlog-plan` with a grant emits `blastRadius` paths that exist in the
  fixture workspace — the one test proving P6 did anything
- every existing `refine` test passes unchanged after P4

---

## 8. Open

- **Q-H1.** Should one lane read the **home** repo on purpose — an adoption lane
  asking what would have to change here to take any of this on? It breaks the
  invariant that all lanes read the subject and needs an inverted addressing
  rule. It may also be the most useful lane in the flow. Defer until P6 has run:
  if `plan` with a grant already produces adoptable tasks, it is redundant.
- **Q-H2.** Should `orient` run as its own flow, callable as a sub-flow (D36
  point 1) so any flow can orient itself? Probably yes, eventually. Build it as
  a node first and extract once there is a second caller.
- **Q-H3.** Should `relation` gate the fan-out's lane budget? `unrelated` with
  six lanes is six expensive confirmations of a cheap conclusion. Tempting; risks
  a low-confidence orientation silently starving a reading that would have
  changed its mind.
- **Q-H4.** Digest freshness across a long run — built once at start, and a loop
  node running for days plans against a stale tree. Probably fine since `plan`
  runs early, but worth naming before it surprises someone.
