# Flyt — durable decisions

This is a compact register of rules that still shape the product. Detailed interviews, implementation diaries, acceptance transcripts, and retired plans remain available in git history.

`Current` means the rule matches the code and should be preserved. `Provisional` means it guides new work but still needs evidence or a concrete design. A replacement note records previously cited wording that must no longer be followed.

## Product and interaction

| ID | Decision | Status |
|---|---|---|
| D1 | Flyt is both a coding agent and a visual workflow builder; neither is a separate product. | Current |
| D2 | The thesis is that explicit structure can outperform or clarify an undifferentiated model turn. Claims require evidence. | Current |
| D3 | Compete on mastery, control, and inspectability rather than promising the cheapest or fastest agent. | Provisional |
| D4 | Text is the ordinary input; the canvas is the live transparency window and an advanced authoring surface. | Current |
| D5 | Canvas and DSL are two views of one flow. Run view is shipped; a conversational flow builder remains an optional extension. | Current / Provisional extension |
| D6 | A run uses an explicitly selected reusable flow. Do not silently generate a new workflow per request. | Current |
| D9 | Motion should be deliberate and legible. Parallel active nodes may animate together. | Current |
| D10 | Streaming is required so a real-model run never looks idle while producing output. | Current |
| D25 | Every project tab opens on its lander; submitting from it unfolds into the run view. | Current |
| D26 | Avoid large backdrop blur, animated mesh gradients, 3D tilt, and fake skeleton shimmer. Modern Chromium CSS is welcome when it improves clarity. | Current |

## Execution, composition, and data

| ID | Decision | Status |
|---|---|---|
| D7 | Independent AI and agent tasks run with bounded parallelism; persisted claiming prevents double execution. | Current |
| D8 | Spawned work is represented as visible nodes and bounded containers; orchestrator depth must remain capped. | Current |
| D11 | Prefer explicit, inspectable context strategies (`none`, pointers, summary, full) over hidden context stuffing. Automatic selection is not designed yet. | Provisional |
| D12 | Use deterministic/model-metadata routing first; buy an LLM tiebreak only when measurements justify it. | Provisional |
| D13 | Retrospectives and benchmarks provide evidence. They do not authorize broad autonomous self-rewriting. | Current |
| D15 | Bind workspaces at project/run time. Shareable project configuration and skills use `.flyt/`; generated run storage follows the user's project-storage setting. | Current; replaces `.llmflow/` wording |
| D17 | Preserve completed steps across crashes and require an explicit Resume before project tools run again. | Current |
| D21 | Follow-ups extend a run with a visible continuation graph; completed prior work is not re-run. | Current |
| D22 | A project is a workspace tab. Runs and backlog are project-scoped; flows, templates, tools, models, and references remain reusable global libraries. | Current |
| D24 | Keep the flow DSL and core protocol infrastructure dependency-light and inspectable; the hand-written strict YAML subset is intentional. | Current; scoped by D53 to the DSL parser and core command surface |
| D27 | Runtime configuration is a per-node override map. Precedence is run input, mode/call-site override, node override, then template. Comparisons read immutable run snapshots. | Current |
| D28 | Packaged assets are read-only seeds; all mutable stores resolve through writable data roots. | Current |
| D29 | Flyt is the brand and `flow` remains the domain noun. `.flow.yaml`, `FlowRunner`, `flowlang`, and flow-named contracts are not unfinished rename work. | Superseded by D52; holds for v1 code until the Phase 5 cutover |
| D36 | Typed inputs, fan-out, sub-flows, backlog-plan, and Loop nodes are one composition system. Sub-flows splice into one run graph; the Loop node hands work to the existing supervisor. | Current; implemented |
| D37 | Adaptive fan-out may select only from fixed lane presets, degrades to the authored roster, and keeps lane outputs isolated until aggregation. | Current |
| D38 | Repository-learning flows orient to both the home workspace and the subject repository before planning; subject scope and attribution must be explicit. | Current |

## Tools, providers, and safety

| ID | Decision | Status |
|---|---|---|
| D14 | Tools are a first-class file-backed library with schemas, effects, scope, risk, source, and trust. A full authoring page is not yet shipped. | Current / open UI |
| D16 | Safety is layered: workspace path confinement, per-run approval mode, deterministic command screening, fail-closed model review, and explicit dangerous opt-out. | Current |
| D18 | Users connect their own providers through API keys or explicit vendor-CLI opt-in. A hosted capped-key subscription is not a current commitment. | Current; replaces hosted-subscription wording |
| D23 | Vendor CLI runtimes own subscription sign-in, token storage, refresh, and invocation. Flyt never copies or reimplements their OAuth credentials. | Current |
| D48 | A capability that exists only outside JavaScript is borrowed through ONE bounded bridge (`core/python.js`), not per tool. The tool supplies script text so what runs is reviewable, arguments travel as JSON on stdin, the interpreter is resolved and reportable rather than assumed, the environment lives outside every repository, and a missing interpreter or package is a result with a remedy. D24 keeps the parser dependency-free; it does not require reimplementing every library in the world. | Current |
| D49 | A tool must be callable outside a run (`flyt tools run`), and that door narrows authority rather than widening it: a write, shell or destructive tool refuses without an explicit confirmation. A capability that cannot be tried cannot be authored. | Current |
| D50 | "Which tool is better" is a measurement against fixed cases (`benchmark/tools/*.json`, `flyt tools bench`), never a model's impression. A tool that is not installed is reported unavailable and kept out of the totals: not set up is not the same as worse. | Current |

## Delivery and operations

| ID | Decision | Status |
|---|---|---|
| D19 | Installers, CI release builds, and auto-update are part of the current product. Signing and release policy remain deployment concerns. | Current; replaces distribution deferral |
| D20 | Keep one current overview, one architecture reference, one compact decision register, and the two flow contracts. Retire completed plans to git history. | Current; replaces the prior documentation structure |
| D35 | The outermost autonomous loop is a supervisor over a durable backlog, isolated worktrees, harness-run gates, review, canary, spend caps, heartbeats, benchmarks, and references. | Current |
| D39 | A failure must say what failed, preserve partial evidence, and offer a retry that may choose another model. | Current |
| D40 | Every model call records finish reason, usage, timing, and content/reasoning split. Liveness leases and `why`/`probe`/`doctor` make live and failed runs diagnosable. | Current |
| D41 | Loop models are chosen at launch/configuration time by effort band, and backlog work remains inspectable and editable through one command surface. | Current |
| D42 | Real runs, not code inspection alone, are the acceptance test for model resolution, gate behavior, and backlog claimability; operational failures require regression tests. | Current |
| D43 | Backlog tasks may be removed through the backlog API, and task ids are monotonic so deletion cannot silently reuse history. | Current |
| D44 | A repository-reading inherits its subject explicitly, diverse lanes should avoid correlated staffing where possible, and all model spend must reach the ledger. | Current |
| D45 | The Loop UI is a six-column board driven by shared blocker rules. Loop workers receive surgical edit, gate, backlog, run-inspection, web, and human-question tools through a bounded ceiling. | Current |
| D47 | Spend is measured from the call trace — every settled call, whatever became of the run or the node — and priced from the model catalog. A ceiling that cannot see a cost cannot bind it. | Current |
| D46 | Clarifying questions are a node's contract, not the gate's: the number of rounds a node may park for belongs to the node. Asking is a first-class deliverable path — the interrogation node asks before it specifies — and a parked run must be answerable from every surface that can show it. | Current |
| D51 | A rejection at review or at gates is a correction, not a rebuild: both judge work that exists and both name something specific, so the judged commit is recorded and the next attempt starts from it. An empty diff and a stall are not inherited. | Current |

Decision numbers D30–D34 were never promoted from retired plan drafts and are intentionally unused.

## Flyt v2 — plugins, stacks and blocks

Adopted 2026-08-21. The working plan is [`.flyt/backlog/v2-plugin-stack-plan.md`](./.flyt/backlog/v2-plugin-stack-plan.md); it retires to git history at the Phase 5 cutover, when `DESIGN-SPEC.md` describes what exists. Phases are tasks `t-0035`–`t-0040`.

| ID | Decision | Status |
|---|---|---|
| D52 | Plugin, Stack and Block are the three nouns. A plugin is installable and contributes; a stack is composed and run; a block is a step. Renames happen at cutover in one commit, never opportunistically. | Provisional; supersedes D29 |
| D53 | Cordis is the plugin kernel and a real dependency. D24's dependency-light rule is scoped to the DSL parser and core command surface, which stay hand-written. TypeScript covers the seams; the boundary is the seam. | Provisional; scopes D24 |
| D54 | dsh compatibility is a tested contract, not an intention: a CI suite installs real published dsh plugins and asserts they load, register and execute. | Provisional |
| D55 | The append-only session event log is the canonical durable record; the run folder is a projection materialised beside it. Model-visible means logged. | Provisional |
| D56 | The block language admits bounded iteration (`Repeat N`, `For each`, `Until`) and structured predicates over declared outputs (`If`). Free expressions, arithmetic and boolean algebra remain out. | Provisional; amends a GOALS boundary |
| D57 | A third-party tool is classified by conservative inference plus one human confirmation, and classification is not a grant. Inference may only err toward restriction. | Provisional |
| D58 | A skill may request tools; only a human grants, never above the static ceiling, and never unattended. | Provisional; amends the skills standing rule |
| D59 | Stack layout is derived from containment. There is no stored layout file and no unparseable arrangement. | Provisional |
| D60 | Trace is a transient third surface that appears while work runs and persists as that run's record. Work stays calm; Trace holds the detail. | Provisional |
| D61 | Plugin UI is limited to declared extension points rendered by Flyt over a typed RPC contract, mirroring dsh. No arbitrary renderer code. | Provisional |
| D62 | v2 ships behind a flag in the shipping app; the old surfaces keep doing real work until `loop-task` runs end to end on the new kernel; cutover is one commit. | Provisional |
| D63 | Every Build operation is available to an agent through the command surface, and every agent operation renders in the editor. One code path, two callers. | Provisional |

## Open decisions

These are questions, not commitments:

1. What measurable user win turns “mastery and control” into a product claim?
2. How should automatic context strategy be represented and evaluated without hiding work?
3. Which budget and node-count ceilings should apply to spawned containers beyond the existing depth caps?
4. Should model routing remain configured, or can benchmarks support a stable learned matrix?
5. What is the smallest safe scope for imported HTTP/MCP tools, schema versioning, process lifetime, and a Tools authoring UI?
6. Should sub-flow call sites be able to pin a content version, or is per-run snapshot provenance sufficient?
7. Are model sets global or project-specific when the set represents domain expertise?
8. Do sweep/leaderboard workflows provide enough value to justify N-way run cost and UI complexity?
9. Should approval show a proposed diff before a write is committed?
10. Which operational policy should govern unattended auto-merge, reboot startup, parked-queue limits, and benchmark retirement?
11. Does Flyt publish its own plugins as dsh bundles, making it a contributor to that ecosystem rather than only a consumer?
12. Session persistence default: JSONL, which stays openable in a text editor, or SQLite, which is faster for long sessions?
13. Do Flyt profiles become a user-facing concept, or stay internal composition?
14. Does the Loop board stay a distinct section inside Work, or dissolve into the run list?
15. Should old runs be converted into session logs so they gain a trace, or read through a compatibility reader only?

Feature-sized work belongs in `.flyt/backlog/`. When one of these questions is resolved, update the relevant row and architecture contract instead of creating a new plan document.
