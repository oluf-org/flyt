# Flyt — durable decisions

This is a compact register of rules that still shape the product. Detailed interviews, implementation diaries, acceptance transcripts, and retired plans remain available in git history.

`Current` means the rule matches the code and should be preserved. `Provisional` means it guides new work but still needs evidence or a concrete design. A replacement note records previously cited wording that must no longer be followed.

## Product and interaction

| ID | Decision | Status |
|---|---|---|
| D1 | Flyt is both a coding agent and a visual stack builder; neither is a separate product. | Current |
| D2 | The thesis is that explicit structure can outperform or clarify an undifferentiated model turn. Claims require evidence. | Current |
| D3 | Compete on mastery, control, and inspectability rather than promising the cheapest or fastest agent. | Provisional |
| D4 | Text is the ordinary input; Work is the live transparency window and Build is the advanced authoring surface. | Current |
| D5 | Build and the stack language are two views of one containment tree. Conversational stack authoring remains an optional extension. | Current / Provisional extension |
| D6 | A run uses an explicitly selected reusable stack. Do not silently generate a new stack per request. | Current |
| D9 | Motion should be deliberate and legible. Parallel active nodes may animate together. | Current |
| D10 | Streaming is required so a real-model run never looks idle while producing output. | Current |
| D25 | Every project tab opens on Work; Build is one hop away and Trace opens over either when a run is addressed. | Current; supersedes lander wording |
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
| D22 | A project is a workspace tab. Runs and backlog are project-scoped; stacks, plugins, tools, models, and references remain reusable global libraries. | Current |
| D24 | Keep the stack language and core protocol infrastructure dependency-light and inspectable; the hand-written strict YAML subset is intentional. | Current; scoped by D53 to the parser and core command surface |
| D27 | Runtime configuration is a per-node override map. Precedence is run input, mode/call-site override, node override, then template. Comparisons read immutable run snapshots. | Current |
| D28 | Packaged assets are read-only seeds; all mutable stores resolve through writable data roots. | Current |
| D29 | Flyt is the brand and `flow` remains the domain noun. `.flow.yaml`, `FlowRunner`, `flowlang`, and flow-named contracts are not unfinished rename work. | Superseded by D52; historical v1 rule |
| D36 | Sequence, parallel lanes, bounded loops, structured predicates, and Loop handoff are one containment-based composition system. | Current; supersedes graph-node wording |
| D37 | Adaptive fan-out may select only from fixed lane presets, degrades to the authored roster, and keeps lane outputs isolated until aggregation. | Current |
| D38 | Repository-learning stacks orient to both the home workspace and the subject repository before planning; subject scope and attribution must be explicit. | Current |

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
| D20 | Keep one current overview, one architecture reference, one compact decision register, and the stack/block/tool contracts. Retire completed plans to git history. | Current; replaces the prior documentation structure |
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
| D64 | Progress is the durable record changing — a status, a finished output, the workspace — not a model producing tokens. An unattended loop may only keep paying for work that is changing something. | Current |
| D65 | An escalation must change something, or it is not one. A rung of the ladder that resolves to the same worker is refused the way the top of the ladder is, and a remedy the runner will not accept in the state that summons it is not a remedy. Ceremony that costs an attempt is worse than admitting there is nothing left to try. | Current; extends D64 |
| D66 | A run that is SPENDING is not stalled. The stall detectors measure the durable record (D64) and must also require that nothing has been spent for the same window, because reading looks identical to spinning from the outside and a slow model on a long context takes minutes a turn. Busy-and-unchanging is the burn detector's case, bounded in dollars. | Current; refines D64 |
| D67 | A cap named at `loop start` is measured from the moment that loop started — for the task as well as for the window. A cap in the project's config guards a rolling window. Counting a task's whole history against a session cap makes a task unworkable for money the session never spent. | Current |
| D68 | The session log has one vocabulary, written down, and it is dotted: `run.created`, `turn.start`, `llm.request`, `tool.result`, `block.output`. Cordis events are slash-named and dispatched inside a process; a session event is a line in a file that outlives it. Confusing the two is a category error, and a reader written against the wrong set matches nothing while its own tests pass. | Current |
| D69 | `ctx.blocks` is a Flyt SERVICE, not a ninth capability seam. The eight-name seam list is the dsh compatibility contract; a block is Flyt's own noun and dsh has no equivalent to be compatible with. One definition serves the scheduler, the editor and the library, because a second description of a block is one that goes stale. | Current |
| D70 | A red gate is triaged before a rung is spent: work that is salvageable is corrected in place, at the same band, with the failing tests handed back by name as feedback. The judgement is mechanical — the gate's output names the failures, and whether they sit in the diff is a set intersection — so it costs no call and no model is asked to adjudicate what the output already settles. Escalating is what happens when a bound says the work is past correcting, not what happens by default. | Current; extends D51 |
| D71 | Every correction has to make progress or run out. The bounds are the same failures returning after a correction aimed at them, an exhausted budget (two, raised to four only while the failure count strictly falls), breakage wider than the diff, and a second hang. A correction counts as an attempt but not as a rung: the money is real and the ladder is not what was missing. | Current; bounds D70 |
| D72 | What a failure tells a person and what it tells the next attempt are the same text, so it is written for a person: the failures by name, place and assertion, never a raw gate transcript. `blockedReason` is frontmatter that the board renders, `task:list` re-reads every three seconds, and the archive quotes — a field that holds twenty thousand characters of passing tests is not a reason, it is a payload. | Current |
| D73 | The v2 cutover keeps the familiar daily entry point. Work owns project tabs and the prompt composer, Models remains a first-class catalog/metrics destination, and Build alone authors canonical stacks. Compatibility run snapshots may be projected read-only into Work/Trace; they may not revive the retired canvas, router, or a second authoring source. | Current; extends D60-D63 |
| D74 | Loop supervision fails closed in both directions. Busy-but-unchanging work gets a default context ceiling between durable changes even without a dollar cap, with the trigger and last tool published. An explicit Stop sends cancellation immediately and has one non-renewable grace deadline; settlement releases the attempt and queue claim while retaining the worktree and durable evidence. | Current; extends D35, D40, D64-D66 |

Decision numbers D30–D34 were never promoted from retired plan drafts and are intentionally unused.

## Flyt v2 — plugins, stacks and blocks

Adopted 2026-08-21 and cut over in Phase 5. The implementation plan is retired to git history; `DESIGN-SPEC.md` describes what exists. Phases were tasks `t-0035`–`t-0040`.

| ID | Decision | Status |
|---|---|---|
| D52 | Plugin, Stack and Block are the three nouns. A plugin is installable and contributes; a stack is composed and run; a block is a step. | Current; supersedes D29 |
| D53 | Cordis is the plugin kernel and a real dependency. D24's dependency-light rule is scoped to the parser and core command surface, which stay hand-written. TypeScript covers the seams; the boundary is the seam. | Current; scopes D24 |
| D54 | dsh compatibility is a tested contract, not an intention: CI installs real published dsh plugins and asserts they load, register and execute. | Current |
| D55 | The append-only session event log is the canonical durable record; the run folder is a projection materialised beside it. Model-visible means logged. | Current |
| D56 | The block language admits bounded iteration (`Repeat N`, `For each`, `Until`) and structured predicates over declared outputs (`If`). Free expressions, arithmetic and boolean algebra remain out. | Current |
| D57 | A third-party tool is classified by conservative inference plus one human confirmation, and classification is not a grant. Inference may only err toward restriction. | Current |
| D58 | A skill may request tools; only a human grants, never above the static ceiling, and never unattended. | Current |
| D59 | Stack layout is derived from containment. There is no stored layout file and no unparseable arrangement. | Current |
| D60 | Trace is a transient surface that appears over Work or Build while work runs and persists as that run's record. | Current |
| D61 | Plugin UI is limited to declared extension points rendered by Flyt over a typed RPC contract. No arbitrary renderer code. | Current |
| D62 | The Work/Build cutover is complete. The Electron host always boots the kernel; old UI surfaces are retired; legacy flow files are migration inputs only. | Current |
| D63 | Every Build operation is available to an agent through the command surface, and every agent operation renders in the editor. One code path, two callers. | Current |

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

Feature-sized work belongs in `.flyt/backlog/`. When one of these questions is resolved, update the relevant row and architecture contract instead of creating a new plan document.
