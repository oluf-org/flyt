# BRICKS — composition, chaining, and the road to self-improvement

**Feature:** turn flows from *one-shot graphs you author by hand* into **bricks that stack** —
fan-out lanes, sub-flows, typed run inputs, and a flow that hands its output to the loop and
stays open until the supervisor says the work landed.
**Status:** planned, not started (2026-08-14).
**Acceptance:** paste a GitHub URL into the **Learn from a repo** flow, several models analyse
it in parallel, a combiner writes a backlog, the loop works it, and the *flow run* closes when
the supervisor marks the last task terminal. First subject: `self_improving_coding_agent`.

> Read `GOALS.md` and `DECISIONS.md` first. This plan reverses two entries on the `GOALS.md`
> non-goals list on purpose — see §0.2 — in the same way D35 reversed cost tracking. That
> reversal is the single most consequential thing in this document.

---

## 0. Why this plan exists

### 0.1 The gap, stated plainly

Everything the learn-flow needs is *nearly* here, and nothing is here:

| What the target flow needs | What exists today | Gap |
|---|---|---|
| A repo URL as an input | one free-text prompt → the `input` node | no typed inputs; a link is just prose |
| The repo readable by every lane | `ReferenceLibrary` + `search_references`, read-only clones | repos come from `config.json`; nothing adopts a URL at run time |
| N models on the same brief, told to diverge | wire N `work` nodes, override `worker` on each (`FLOW_NODES.md` §8) | authorable but tedious, and no lane knows the others exist |
| A combiner that writes a plan | `combine` / `compare` templates | present and good |
| That plan becoming queued work | `enqueue_task` tool → `.flyt/backlog/` | present, but only as an agent's side-effect mid-run |
| The run staying open until the loop lands it | `loop:start`, supervisor, gates, canary (D35) | **nothing chains a flow to the loop**; the run ends, the loop is a separate page |
| Reusing the whole thing inside another flow | — | **flows cannot contain flows** |
| Picking three different models in ten seconds | `WorkerPicker`: a bare `<select>` of active model ids | no metadata, no multi-pick, no reusable sets |

Five of eight rows are missing. They are not five unrelated features — four of them are the
same missing primitive wearing different hats.

### 0.2 Two non-goals are being reversed

`GOALS.md` lists under **Explicit Non-Goals**: *"Full general-purpose visual programming
(loops, conditionals, sub-flows)"*. This plan builds **sub-flows** and a **loop node**. The
reversal is narrow and deliberate, and it is worth being precise about what is *not* being
reversed:

- **Sub-flows: reversed.** A flow may contain another flow. This is composition, not
  programming — there are no variables, no conditionals, no iteration count. A sub-flow call
  is a static edge to a named artifact, resolved at lint time, with a depth cap.
- **Loops: reversed only as *handoff*.** The `loop` node does not iterate a subgraph N times.
  It hands a task list to the supervisor and waits for terminal status. The iteration happens
  in the loop engine that already exists (D35), which has budget ceilings, gates, heartbeats
  and a canary. A flow-level `while` remains a non-goal.
- **Conditionals: still a non-goal.** Nothing in this plan branches on a value. Routing stays
  where it is — inside `plan-eval` and the routing matrix (D12).

The reason to allow these two and refuse the third is the same reason D35 allowed cost
tracking: the loop makes the old answer wrong. An unattended system that cannot compose its
own workflows can only ever run the workflows a human wired by hand, which caps
self-improvement at the rate a human draws boxes.

### 0.3 The spine: one mechanism, three consumers

The insight that makes this plan small enough to build: **fan-out, sub-flows and the
orchestrator are the same thing** — a node that materializes children into its own box at run
start and runs them as a scoped subgraph.

That machinery already exists. `FLOW_LANG.md` "Containment" gives any node a `parent:` and a
`box:`, children render inside the box, layout is relative, deleting the parent deletes the
children, and `runOrchestrator` (`core/flowRunner.js:2832`) already walks a contained subgraph
with bounded parallelism and gates. The orchestrator materializes children *from a model's
plan*; a fan-out node materializes them *from a lane list*; a sub-flow node materializes them
*from another flow file*.

So the build order is: extract the expansion mechanism once (P2), then pay a small marginal
cost per consumer. Do this backwards — build sub-flows first as a bespoke feature — and the
orchestrator, the fan-out and the sub-flow end up as three subgraph walkers that drift.

---

## 1. Decisions (locked before implementation)

| # | Question | Decision |
|---|---|---|
| **B1** | Sub-flow execution: nested run or inline splice? | **Inline splice.** At run start the sub-flow's nodes are spliced into the run graph as children of the call-site node, ids namespaced `<callId>/<innerId>`. One run folder, one snapshot, one canvas, gates and resume unchanged. A nested `FlowRunner` would fragment run state across run folders and break the live canvas — which is the transparency window the whole product rests on (D1, D4). |
| **B2** | Canvas representation of a sub-flow | **A collapsed box**, reusing orchestrator containment. Collapsed by default showing `name · N nodes · status`; double-click expands in place using the `displace.js` routine from `OUTPUT-VIEW-PLAN.md` B3. |
| **B3** | Sub-flow nesting depth | **Cap 3, enforced at lint time and again at run start.** The D8 two-tier orchestrator rule stands on top: a sub-flow may contain orchestrators, and depth counts every container. Cycles (A uses B uses A) are a lint **error**, detected on the flow-reference graph, not the node graph. |
| **B4** | Sub-flow parameterisation | **Reuse the mode override map.** A call site may set `mode: <modeId>` to pick one of the sub-flow's saved configs, and `overrides: { <innerId>: {...} }` for ad-hoc tweaks. Precedence extends the existing chain: **run input > call-site override > call-site mode > inner node override > template.** No new concept — a mode is already "a per-node override map applied at a point in time" (D27), and a call site is just another such point. |
| **B5** | Fan-out lane definition | **Lanes are data on one node**, not N authored nodes: `lanes: [{ id, label, worker, instructions, tools? }]`. Expands into N siblings inside the node's box. |
| **B6** | Cross-lane awareness | **Each lane's prompt names the other lanes** (labels + one-line intents, never their outputs). "Find at least one thing the others will not" is only meaningful if a lane knows who the others are. Lane outputs stay isolated — sharing them would collapse the diversity the fan-out exists to produce. |
| **B7** | Typed run inputs | **Declared inputs become named input nodes**, wired with ordinary edges (`inputs.repo -> clone`). No templating syntax, no `{{ }}`, no hidden binding — an input is a node, visible on the canvas, per principle 1 and D24's spirit. |
| **B8** | Repo ingestion | **Extend `ReferenceLibrary` with run-time adoption.** A `repo`-typed input adopts the URL as a shallow, pinned, read-only clone under the existing reference root; every lane then reads it with `search_references` and `read_file` on `reference:<name>/<path>`. Read-only stays enforced by there being no write path — the property `core/references.js` was built around. |
| **B9** | Flow → backlog contract | **A dedicated `backlog-plan` template** whose output port `tasks` is a strict fenced JSON block of backlog task records. The `loop` node consumes that port. The alternative — the loop node parsing a combiner's prose — puts a parser where a contract belongs; `plan-eval` already sets the precedent for a strict JSON contract (`FLOW_NODES.md`). |
| **B10** | Loop node semantics | **Enqueue, then wait for terminal.** The node enqueues the tasks, starts (or joins) the supervisor for the project, and stays `running` until every enqueued task is `landed`/`failed`, or `parked` past the wait policy. Its output is a report: what landed, what failed, what is waiting on you. |
| **B11** | Wait policy | `waitFor: all | any | none`. `none` is fire-and-forget (the node completes on enqueue). Default `all`. A **parked** task does not fail the node — D35 rule 7 says a gate parks a task and never blocks the loop; the flow-level equivalent is that the loop node surfaces the park as a gate on itself and keeps waiting. |
| **B12** | A run that waits for days | **Legal, and the reason the state is files.** The loop node persists `runs/<id>/loop/<nodeId>.json` (enqueued ids, policy, started). On app restart the existing interrupted-run detection (D17) reattaches by re-reading backlog status; nothing is held in memory. A loop node carries its own `budgetUsd`, checked against `core/ledger.js`'s existing ceilings. |
| **B13** | Model sets | **A named, reusable list of active model ids** in settings (`modelSets: { analysts: [...] }`). One thing to pick in a fan-out, a mode, or a comparison, instead of N pickers. This is the smallest change that makes multi-model authoring bearable, and it is a prerequisite for B5 being pleasant. |
| **B14** | Where the model picker lives | **On the node**, as a badge that opens a popover — not only in the Inspector. Selecting a model should not require finding the right panel. The Inspector keeps the full field set. |

---

## 2. Phases

Each phase ships independently and leaves the app better than it found it. P0–P1 touch no
engine code. The learn-flow becomes *authorable* at the end of P2 and *chainable* at the end
of P4.

### P0 — Models you can actually pick (UI only) — **shipped**

*The complaint that started this: "the model pickers have to be easier to use."*

| Item | Detail |
|---|---|
| **P0.1 Key-first onboarding** | Paste an OpenRouter key → catalog fetch fires automatically → a **starter set** is proposed and activated in one click (a cheap fast model, a strong reasoner, a long-context reader, a wildcard). Today the path is Settings → Providers → key → Models tab → Fetch → add ids one at a time. That is six steps before the app does anything. |
| **P0.2 Model rows carry facts** | The OpenRouter catalog already returns context length, tool support and pricing (`Settings.jsx` renders them in a `<datalist>` and then throws them away). Show price/1M, context, tools on the active-model row and in every picker option. Picking a model for a lane is a cost decision; the number belongs where the decision is. |
| **P0.3 Model sets (B13)** | A named group of active models. Settings UI to create/edit; used by P2 lanes, modes, and compare. |
| **P0.4 Node-level picker (B14)** | A model badge on the node card → popover with search, the active list, sets, and "type an id". Reuses the `WorkerPicker` resolution logic; `Inspector.jsx:182` becomes the popover's body rather than a second implementation. |
| **P0.5 Honest empty/unrouted states** | The `unrouted` pill exists; extend it — a picker offering a model no connected provider can serve should say so at the point of choosing, not at run time. |

**Done when:** a new user with only an OpenRouter key reaches a runnable flow with three
distinct models assigned in under two minutes, and no picker requires typing a model id.

**Shipped** (2026-08-14). Saving a key switches to the Models tab, fetches the catalog, and
proposes four models from four different labs, priced; one click activates them. Facts
(price/1M in+out, context, tool support) are persisted at fetch time as `settings.modelFacts`
and render on active-model rows, catalog search results, every picker option, and the node
badge. `settings.modelSets` holds named groups, which filter every picker. `WorkerPicker` is
now one popover control (`src/ModelPicker.jsx`) used by the Inspector, the node library, the
launch composer, and a new badge on every AI node card — portalled to `<body>`, because React
Flow's transformed viewport eats a `position: fixed` child. `canServe` moved to
`src/providerMirror.js` so the unrouted warning and Settings share one rule.

Two things learned that P2+ should not relearn: a template instance carries **no `type`** in
the flow file (resolution supplies it — gate on the resolved node), and Settings' catalog
effects both wrote the whole `catalog` array, so whichever landed second wiped the other.

---

### P1 — Typed run inputs, and a repo you can paste

| Item | Detail |
|---|---|
| **P1.1 `inputs:` block in the DSL** | Sibling to `modes:` and `expose:`. `inputs: { repo: { type: repo, label: Repository, required: true } }`. Types: `text`, `url`, `repo`, `choice`, `file`, `model`, `modelSet`. |
| **P1.2 Inputs are nodes (B7)** | Each declared input materialises an input node addressable in the `flow` block (`inputs.repo -> lanes`). The implicit `input` node stays exactly as it is for the ordinary "type what you want" case — a flow with no `inputs:` block is unchanged in every respect. |
| **P1.3 Composer controls** | `LaunchInputs.jsx` grows a control per type. It currently switches on *override field* (`worker`, `effort`, `category`…); it now also switches on *input type*. Keep the two lists separate — an override is a knob on a node, an input is content. |
| **P1.4 `ref:add` + run-time adoption (B8)** | `ReferenceLibrary.adopt(url, { name })`: shallow clone, pin the commit, record `about`. New API command `ref:add`, new tool `add_reference` (effects `read`+`write`, scope `workspace`, risk `caution`) so an agent can adopt a repo a task points at. Name derived from the URL, collisions suffixed. |
| **P1.5 `repo` input wiring** | A `repo`-typed input adopts on run start and emits the reference name; downstream nodes get `reference:<name>` in context and `search_references` in their toolset. |
| **P1.6 Reference panel** | The library is invisible in the UI today (`ref:list` exists, nothing renders it). A small page: what is cloned, at which commit, when fetched, with update/remove. Q-L8 asks how many repos before the index is noise — that question cannot be answered while nobody can see the list. |

**Done when:** a flow declares a repo input, the composer shows a URL field, and running it
leaves a pinned read-only clone that `search_references` finds.

---

### P2 — Fan-out lanes (and the expansion spine)

**P2.0 — Extract the spine first.** Pull the "materialize children into my box, then walk them
as a scoped subgraph" logic out of `runOrchestrator` into `core/nodes/expand.js` +
`runContainer(runId, flow, node, children, opts)`. Re-point the orchestrator at it and prove
parity with the existing tests before adding a second consumer. This is the load-bearing
refactor of the whole plan; do it under its own commit with the suite green.

> **Shipped** (2026-08-14). `core/nodes/expand.js` exports `runContainer(runner, runId, flow,
> node, children, opts)` — the extra leading `runner` is deliberate: it makes the dependency
> visible (store, setNodeStatus, runNode, runPendingTasks, stopRequests, config.maxParallel,
> and nothing else) rather than hiding it in a class. Alongside it: `readyChildren`,
> `containerWave`, `ensureChildStatuses`, `aggregateChildren`. `opts` carries the per-consumer
> parts — `kind` (how the box names itself in its own error messages), `title`,
> `aggregateLabel`, and `label` (how a child is titled in the aggregate, which is where a
> fan-out will put its lane names). `runOrchestrator` keeps everything above "the children now
> exist" — planning, the bounded re-ask, materialization, the summary port — because that is
> the only part that genuinely differs per consumer. Parity: the suite is identical either
> side of the change (720/723; the 3 failures are pre-existing Windows path issues in
> `benchmark`/`references`), plus `tests/expand.test.js` pins the seam directly.

| Item | Detail |
|---|---|
| **P2.1 `fanout` node type** | `type: fanout` with `lanes: [...]` (B5), a `goal`, and an optional `template:` naming which library template each lane instantiates (default `general-analysis`). |
| **P2.2 Lane presets** | Ship named lane shapes so the common ones are one click: **Standard** (do the brief), **Wildcard** (look only for the odd, hidden, undocumented, or surprising), **Adversarial** (look only for what is done badly, fragile, or wrong), **Contrarian** (argue the opposite of the obvious reading). These are `instructions` presets on a lane, not new node types. |
| **P2.3 Cross-lane brief (B6)** | Each lane's assembled prompt gets: the shared goal, its own lane instructions, the labels + one-line intents of sibling lanes, and the instruction to surface **at least one finding no other lane is positioned to reach**. Lane outputs never cross. |
| **P2.4 Model-set binding** | Point a fan-out at a model set (P0.3) and it mints one lane per model. This is the ten-second path to "five models on one question". |
| **P2.5 Lint rules** | `fanout-lanes` (at least one, unique ids), `fanout-worker` (lane worker must be an active/known model), `fanout-template`. |
| **P2.6 Canvas** | Fan-out renders as a box with lane children, each child badged with its model. Collapsed shows `N lanes · M done`. |

**Done when:** one node, five lanes, five models, five outputs into a `combine` — authored in
the UI without touching YAML.

---

### P3 — Sub-flows: a flow is a brick

| Item | Detail |
|---|---|
| **P3.1 `flow:` node shape** | A third node shape beside `use:` (template) and `type:` (raw): `nodes: { learn: { flow: learn-from-repo, mode: deep } }`. |
| **P3.2 Splice + namespacing (B1)** | At run start, resolve the referenced flow, splice its nodes as children of the call site with ids `<callId>/<innerId>`, map the inner `input` node to the call site's incoming edge(s) and the inner `output` node to the call site's output port. Uses `runContainer` from P2.0. |
| **P3.3 Ports** | A sub-flow's declared output ports are the ports of its `output` node's upstream; `<subflow>.<port>` addressing works in the parent's `flow` block. Unknown port → the existing `unknown-port` lint error, extended to resolve through flow references. |
| **P3.4 Depth + cycles (B3)** | New lint rules `unknown-flow`, `flow-cycle`, `flow-depth`. Cycle detection runs on the flow-reference graph. The runner re-checks depth at start — a flow edited after linting must not be able to recurse the engine. |
| **P3.5 Call-site overrides (B4)** | `mode:` and `overrides:` on the call site, validated against the *inner* nodes' `overridableFields` by the existing `mode` lint machinery. |
| **P3.6 Canvas (B2)** | Collapsed box; expand in place; the Inspector for a sub-flow node shows the inner node list with its override tags and an "open the source flow" link. |
| **P3.7 Versioning honesty** | A sub-flow is referenced **by id, resolved at run start** — editing the inner flow changes every caller. That is the intended behaviour (a brick you improve improves everywhere) and it is a real hazard, so: the run snapshot records the resolved inner flow verbatim, so a completed run always shows what actually ran. Pinning by version is deliberately *not* built; revisit if it bites. |

**Done when:** `learn-from-repo` can be dropped into another flow as a single node, run, and
inspected — and a flow that references itself fails `npm run flow -- lint`.

---

### P4 — The chain: flow → backlog → loop → done

This is the phase the user's example actually turns on, and the newest ground. Build it last
because the three phases above make it small.

| Item | Detail |
|---|---|
| **P4.1 `backlog-plan` template (B9)** | Library template, `baseType: aiStep`, `role: plan-backlog`, output port `tasks`. Contract: prose rationale, then ONE fenced JSON block — `[{ title, goal, doneWhen[], value, effort, level, gates[], blastRadius[], dependsOn[] }]`, matching `core/backlog.js` `DEFAULTS()` field-for-field. Documented in `FLOW_NODES.md` next to the plan contract it mirrors. |
| **P4.2 `loop` node type (B10–B12)** | `type: loop` with `waitFor`, `budgetUsd`, `parallelism`, `maxTasks`. Enqueues via `Backlog.add` (never by writing files — §5.2's rule about the canonical directory), starts/joins the supervisor via the existing `loop:start` path, persists `runs/<id>/loop/<nodeId>.json`, polls terminal status, writes a report. |
| **P4.3 Reattach on restart** | Extend the D17 interrupted-run detection: a run whose only in-flight node is a loop node reattaches by reading backlog status, not by re-running anything. Resume stays an explicit user action, consistent with D17's reasoning. |
| **P4.4 Parked work surfaces on the canvas** | A parked task belonging to a loop node renders as a gate on that node with the park reason and an approve/answer affordance — routed through the existing gate UI, not a new one. This is the "more connected UI" the brief asks for: the Loop page and the run canvas stop being two unrelated worlds. |
| **P4.5 Cross-navigation** | Loop page task rows link to the run that enqueued them; a loop node links to its tasks on the Loop page. `.flyt/backlog/` task frontmatter gains `sourceRunId` + `sourceNodeId` (the parser already preserves unknown fields, so this is additive by design). |
| **P4.6 Budget honesty** | The loop node's spend is drawn from `core/ledger.js`, attributed to the task ids it enqueued. A loop node that hits its own ceiling parks rather than stops — the D35 distinction between the three ceilings applies unchanged. |

**Done when:** a flow run reaches `done` **because the supervisor landed the last task it
queued**, and the canvas shows which.

---

### P5 — Learn from a repo (the payload)

| Item | Detail |
|---|---|
| **P5.1 `flows/learn-from-repo.flow.yaml`** | `inputs.repo` (repo) + `inputs.goal` (text) → adopt → **fanout** with lanes {architecture, testing/verification, wildcard, adversarial, contrarian} → **compare** → **combine** → **backlog-plan** (gated) → **loop** → output. Ships as a seeded flow with a stable slug id so it survives packaging (D28's `flow-*` exclusion rule). |
| **P5.2 A `.flyt/skills/` companion** | The lanes need to know what *this* project is, or "what can we learn" has no anchor. A `learn-target.md` skill in the bound project supplies the current architecture and open problems — exactly the split GOALS.md describes (template names the expertise, project supplies it). |
| **P5.3 Run it against `self_improving_coding_agent`** | Already in `DEFAULT_REFERENCES`, so P1.4 is exercised by a repo whose behaviour is known. Target imitations: the scored archive, best-archived-as-meta-agent, and the asynchronous overseer that D35 deliberately deferred (§11.6) — the loop was always going to want it; this is how it gets designed from prior art rather than from scratch. |
| **P5.4 A benchmark case** | Add a `benchmark/*.bench.md` case for the chain with an independent probe: given a fixed small repo, does the flow produce ≥3 well-formed backlog tasks that a supervisor can claim? Per Q-L3, a case earns its place by covering a class the loop handles badly — "did the handoff produce work the loop can actually take" is precisely that class. |

---

### P6 — Connectedness pass

Small, but it is half of what "the UI has to be simpler and more connected" means:

- One **library** surface: flows, node templates, tools, model sets, references — five catalogs
  currently living in four unrelated places.
- Every artifact links to what produced it and what it produced (run ↔ task ↔ flow ↔ commit).
- Delete `nodes/node-ms2r06ba-omz2.json` — an untitled empty template shipped by accident.
- `README.md` still doesn't mention modes/refiner/compare (noted in `DECISIONS.md` §5); fold
  the doc debt in here rather than opening a seventh plan.

---

## 3. Risks, and what would make us stop

| Risk | Guard |
|---|---|
| **The spine refactor (P2.0) destabilises the orchestrator** | Parity-first: re-point `runOrchestrator` at `runContainer` and ship *only that* with the existing suite green, before any second consumer exists. If parity can't be proven, build fan-out standalone and leave the orchestrator alone — a duplicated walker is cheaper than a broken run engine. |
| **A run that waits days becomes unresumable** | B12: no in-memory state; the loop node's truth is backlog file status, re-derived on every poll and on reattach. Test by killing the app mid-wait — the same test D17 already has a shape for. |
| **Sub-flow splice explodes the canvas** | Collapsed by default (B2); cap total spliced node count per run and fail the run at start with a clear error rather than degrading the canvas silently. |
| **Fan-out cost** | Five lanes on a long repo is five long-context calls. Lanes are individually budgeted; the fan-out node reports estimated cost *before* the run when every lane's model has catalog pricing (P0.2 exists partly for this). |
| **The learn-flow produces plausible, useless tasks** | This is the real risk, and it is why P4.1 is a strict contract and P5.4 is a probe. A backlog task that no supervisor can claim is the failure mode, and it is mechanically detectable. |
| **Scope creep into visual programming** | §0.2 is the line. Any proposal for conditionals, iteration counts, or expression syntax in the DSL gets refused by pointing here. |

---

## 4. Sequencing summary

```
P0 models ─┐
           ├─► P2 fan-out ─┬─► P3 sub-flows ─┐
P1 inputs ─┘   (spine)     │                 ├─► P5 learn-flow ─► self-improvement
                           └─► P4 loop node ─┘
                                              P6 connectedness (continuous)
```

P0 and P1 are independent and can run in parallel. P2.0 gates everything after it.

---

## 5. Open questions

- **Q-B1.** Does a sub-flow's inner gate pause the *parent* run, or park like a loop task?
  (Attended: pause is right. Unattended: D35 rule 7 says park. It may have to depend on who
  is watching, which the runner does not currently know.)
- **Q-B2.** Should model sets be global or per-project? Templates and flows are global (D22
  T2); sets probably follow, but a project-specific "the models that are good at Rust" is an
  obvious want.
- **Q-B3.** How do lane outputs reach the combiner without blowing context on a large repo?
  Per-lane output budgets, or a summarisation step per lane (`OUTPUT-VIEW-PLAN.md`'s summary
  node is nearly this already).
- **Q-B4.** Does the loop node deserve its own worktree budget separate from the project's
  rolling ceilings, or is one ledger enough?
- **Q-B5.** Sub-flow pinning (P3.7) — if "edit the brick, change every caller" bites, what is
  the smallest honest pin? A content hash recorded per run is already there for forensics; a
  *pinned* reference is a bigger idea.

---

## 6. Relationship to existing docs

- Implements the composition half of **D5**'s "AI helper as builder" precondition — you cannot
  have an AI build workflows out of bricks until bricks exist.
- Extends **D27**'s "one run-configuration primitive" to a second application point (call
  sites), rather than inventing a parallel mechanism.
- Consumes **D35**'s loop wholesale; adds no new autonomy, only a doorway into it.
- Reverses two **`GOALS.md`** non-goals (§0.2), recorded as **D36**.
