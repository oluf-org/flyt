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
| D24 | Keep the flow DSL and core protocol infrastructure dependency-light and inspectable; the hand-written strict YAML subset is intentional. | Current |
| D27 | Runtime configuration is a per-node override map. Precedence is run input, mode/call-site override, node override, then template. Comparisons read immutable run snapshots. | Current |
| D28 | Packaged assets are read-only seeds; all mutable stores resolve through writable data roots. | Current |
| D29 | Flyt is the brand and `flow` remains the domain noun. `.flow.yaml`, `FlowRunner`, `flowlang`, and flow-named contracts are not unfinished rename work. | Current |
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

Decision numbers D30–D34 were never promoted from retired plan drafts and are intentionally unused.

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

Feature-sized work belongs in `.flyt/backlog/`. When one of these questions is resolved, update the relevant row and architecture contract instead of creating a new plan document.
