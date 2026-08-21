# Flyt v2 — plugins, stacks and blocks

Status: **approved plan; Phase 0 landed 2026-08-21, Phase 1 next.** Durable choices are promoted to
`DECISIONS.md` as D52–D63 and the standing rules they amend are already updated
in `CLAUDE.md` and `GOALS.md`. This file is the working plan; when the flag
flips (Phase 5) it retires to git history and `DESIGN-SPEC.md` describes what
exists.

Readable version of this document (same content, for humans):
https://claude.ai/code/artifact/9379356a-8d3f-44df-a029-83bb009b4633

## Why

Three problems, one answer.

1. The UX is split across seven destinations. Finding a flow, a node template, a
   tool or a model means knowing which of four lists it lives in. The node
   library is unusable at its current size and has auto-named orphans in it.
2. The canvas is free positioning plus hand-drawn edges. It stores a
   presentation-only `.layout.json`, permits arrangements that do not parse, and
   is more machinery than the composition it expresses needs.
3. DeepSeek Harness ships a better version of several things we built: a plugin
   system where everything including the agent loop is replaceable, an
   append-only session event log, and a trace UI built on it.

We keep what we are good at — approvals and ceilings, worktree-isolated
unattended work, inspectable run folders, spend measured from the call trace —
and adopt their kernel, their plugin contract and their session-log invariant.

## The promise

**Any plugin written for deepseek-harness runs in Flyt unmodified, if it touches
only the standard seams and events.** This is a tested contract, not an
intention: a CI compat suite installs a fixed set of real published dsh plugins
and asserts they load, register and execute (D54). A plugin reaching into dsh
package internals needs a shim, and that is the stated limit.

## Vocabulary (D52)

| Noun | Is | Was | Lives at |
|---|---|---|---|
| **Plugin** | installable package contributing blocks, tools, stacks, skills, adapters, gates or UI | — | `node_modules` + `plugins/` |
| **Stack** | what you compose and run | Flow | `stacks/<id>.stack.yaml` |
| **Block** | one step in a stack, contributed by a plugin | Node / node template | plugin-owned, no loose JSON |

Rename map. `core/brand.js` owns legacy migration names and gains one more
generation; old names are read for migration and adopted on first write, exactly
as `.llmflow/` -> `.flyt/` works today.

| Today | Becomes | Note |
|---|---|---|
| `flows/<id>.flow.yaml` | `stacks/<id>.stack.yaml` | read-migrated |
| `flows/<id>.layout.json` | deleted | layout derived from containment (D59) |
| `nodes/<id>.json` | plugin-contributed block defs | built-ins move into `flyt-blocks-core` |
| `FlowRunner`, `flowlang` | `StackRunner`, `stacklang` | |
| `flow.nodes` | `stack.blocks` | DSL key |
| `FLOW_LANG.md` / `FLOW_NODES.md` | `STACK_LANG.md` / `BLOCKS.md` | the two contracts survive as contracts |
| `runs/<id>/flow.json` | `runs/<id>/stack.json` | now a projection |

**Do not rename opportunistically.** v1 code keeps v1 names until Phase 5. The
renames happen inside the v2 tree and at cutover, in one commit, not scattered
through unrelated work.

## Architecture

Four bands, bottom to top.

```
SURFACES   Work (permanent) | Build (permanent) | Trace (transient)
           ---------------- typed RPC, renderer <-> main ----------------
PLUGINS    flyt-* plugins            |  dsh + third-party plugins
POLICY     tool ceiling | approval | effect contract | spend
SEAMS      ctx.sessions ctx.tools ctx.llm ctx.fs ctx.shell ctx.agents
           ctx.commands ctx.sandbox
KERNEL     Cordis — plugin tree, typed events, reversible effects, injection
           cordis-plugin-loader: bundles -> profile patch -> home patch -> CLI
EVENTS     turn/start -> agent/pre-step -> step/start -> llm/stream ->
           tool/call -> tools/pre-execute -> tools/post-execute ->
           step/end -> turn/end
```

The policy band spans the full width on purpose: a third-party plugin's tool
reaches execution through the same ceiling and approval gate ours does.

### Seams

| Seam | Flyt's provider | Replaces |
|---|---|---|
| `ctx.sessions` | `flyt-session-jsonl` | `core/state.js`, run persistence |
| `ctx.tools` | `flyt-tools` + `flyt-approvals` | `core/toolstore.js`, `core/toolsets.js` |
| `ctx.llm` | `flyt-adapters-*` | `core/adapters/`, `modelSource.js` |
| `ctx.fs` | `flyt-fs-workspace` / `flyt-fs-worktree` | `core/workspace.js`, `core/worktree.js` |
| `ctx.shell` | `flyt-shell-screened` | `core/safetyCheck.js` path |
| `ctx.agents` | `flyt-stack-runner` | `core/flowRunner.js` scheduler |
| `ctx.commands` | `flyt-api` | `core/api.js` command map |
| `ctx.sandbox` | `flyt-worktree-realm` | new, bounded |

The idea we are buying is the **seam**: a service definition, a provider, and
consumers that never know which provider they got. That is why worktree
isolation can become a provider of `ctx.fs` rather than a special case threaded
through the runner.

Composition follows dsh layering exactly — bundles, profile patch, home patch,
CLI overlay — so a patch replaces a row by id. Flyt ships one profile per
surface (`flyt-desktop`, `flyt-cli`, `flyt-loop-worker`), which is how a Loop
worker gets a genuinely narrower tree instead of the same tree with flags off.

### Language boundary (D53)

TypeScript covers the kernel wiring, seam interfaces, session event schema and
Zod config schemas. The existing JS core and React renderer stay JS and consume
generated `.d.ts`. The rule that stops this rotting: **the boundary is the
seam.** Anything a third-party plugin can touch is typed; anything only we call
may stay JS. D24's dependency-light rule survives, scoped explicitly to the DSL
parser and core command surface, which stay hand-written.

## The session log (D55)

Today `runs/<id>/` is the durable record. In v2 an append-only event log is the
record and the run folder is a **projection materialised beside it** — same
directory, still openable in a text editor, still the thing you send someone
when a run goes wrong. Principle 1 is unchanged; what changes is which file.

| Path | Role |
|---|---|
| `runs/<id>/session.jsonl` | **Canonical.** Every turn, step, message, model request, tool call, permission decision, gate result. |
| `runs/<id>/stack.json` | Projection — resolved stack at run start |
| `runs/<id>/meta.json` | Projection — stage, statuses, gates, errors, workspace |
| `runs/<id>/blocks/*.md` | Projection — block output (was `nodes/*.md`) |
| `runs/<id>/tools/*.json` | Projection — complete tool results, still stored in full |
| `runs/<id>/calls/*.jsonl` | Projection — but the **ledger reads the log**, so a settled call cannot escape a ceiling by failing to be projected |

Invariant adopted verbatim: **model-visible means logged.** Anything reaching a
model request must be reconstructable from the log via `deriveMessages()`. That
one rule gives replay, fork, resume and an honest trace UI from one mechanism.

What it breaks, stated plainly:

- `core/state.js` and every reader of run state, rewritten against the log.
- Resume stops reconstructing completed nodes from status files and replays to
  the last durable event. D17's guarantee gets stronger, not weaker.
- Renderer snapshot patching becomes event subscription; revision-mismatch
  resync becomes "replay from cursor", which is strictly simpler.
- Pending tool calls that die with the process become reconstructable, closing a
  gap `DESIGN-SPEC.md` §9 currently lists as permanent.
- Old runs open in a compatibility reader, read-only. They do not gain a trace.

## The block language (D56, D59)

Containment replaces edges. The graph is derived from nesting, so there is no
layout file and no way to draw a stack that does not parse.

| Block | Holds | Bound |
|---|---|---|
| `Sequence` | blocks, top to bottom | implicit |
| `Parallel` | lanes side by side | `maxParallel`; lanes isolated until aggregation (D37) |
| `Repeat N` | a body | literal N, authored, capped |
| `For each` | a body | a typed list an upstream block declared; roster capped |
| `Until` | a body + named gate | max attempts, authored |
| `If` | a body, optional else | structured predicate (below) |
| `Sub-stack` | a reference | splices with namespaced ids (D36) |

An `If` condition is **not an expression**. It is *source / operator / literal*,
where source must name a field a block declared in its structured output schema:

- `evaluation.score` `<` `7`
- `gate.result` `is` `failed`
- `plan.tasks` `is empty`

Operators are a closed set. No concatenation, no arithmetic, no boolean algebra
beyond a flat all-of / any-of list, no reference to anything a block did not
declare. The linter rejects a predicate whose source is not a declared output
field — so adding a conditional forces the upstream block to have a real output
contract, which is a feature.

Lint rules that ship with it:

- every container declares its bound statically; unbounded fails lint;
- nesting depth is capped, counting orchestrator containers (D8) and loop bodies
  together;
- a predicate source must resolve to a declared structured-output field on a
  genuinely upstream block;
- a `For each` roster must come from a typed list output, never from prose;
- total block count and worst-case expansion are bounded and reported before a
  run starts.

`npm run flow -- lint` becomes `npm run stack -- lint` and gains these.

## Trust and permission (D57, D58)

A third-party tool's first hour:

1. **Install.** Tools register into `ctx.tools` as *unclassified* and
   *ungranted*. Unclassified tools are in no toolset, so no existing stack's
   ceiling can reach them. Nothing it ships can act yet.
2. **Inference.** Flyt reads declared capabilities, schema and injected seams,
   then assigns the strictest plausible classification: `ctx.fs` writes ->
   `write`; `ctx.shell` or spawning -> `shell` + `destructive`; network ->
   `untrusted-input`. Ambiguity resolves upward, never down.
3. **One confirm pass.** The install screen shows the guess per tool with
   effect, scope, risk and trust. You confirm or edit. This is the only moment
   classification is cheap.
4. **Still ungranted.** Classification is not a grant. A block receives the tool
   only when a ceiling names it, and children still narrow and never widen.

Inference decides *how dangerous we assume it is*; humans decide *whether it
runs*. Those must not collapse into each other. Inference is only ever allowed
to be wrong in the restrictive direction, where the symptom is a tool that
refuses and a person who notices.

### Skills that request tools

The standing rule was "skills add instructions and never grant tools". Impeccable
is instructions plus 23 commands plus a detector CLI, and a skill that cannot
reach its own detector does not work. The amendment is narrow and the word doing
the work is **request**:

- a skill may declare `requiresTools: [...]` — a request, recorded in the skill
  file, visible in the library;
- attaching the skill surfaces the request; a human grants or does not; an
  ungranted request degrades visibly rather than blocking the skill;
- a granted request **still cannot exceed the block's static ceiling**;
- unattended, a skill's tool request is never auto-granted. The Loop worker gets
  the `loop` set and nothing a skill talked it into.

If this goes wrong, the symptom will be a skill that reads as harmless being the
reason a tool was granted. The fix is to make the grant moment louder, not to
re-ban the request.

## Surfaces (D60, D63)

**Work** (permanent) — everything happening. Lander composer stays the front
door (D25). Below it the running stack renders as the stack you built: active
block lit, output streaming inline, parallel lanes animating together. Run
history and the Loop board are sections of this surface. *Absorbs Home, Runs,
Loop, and the run-view half of the canvas.*

**Build** (permanent) — everything authored. Block editor is the body. One
unified faceted library replaces four lists: search once, get stacks, blocks,
plugins, tools, skills and models, each with install or insert. *Absorbs Flows,
Library, Models, Settings, and the authoring half of the canvas.*

**Trace** (transient) — appears when anything runs; persists as that run's
record so a finished run's trace reopens. The session log rendered for humans:
turns and steps nested, prompt assembly expandable, every model request with
finish reason, usage, timing and content/reasoning split (D40), every tool call
with arguments and full result, every permission decision, every route record
naming requested source, effective provider and why that rung won.

Division of labour: **Work stays calm, Trace holds the detail.**

Every Build operation is available to an agent through `ctx.commands`, and every
agent operation renders in the editor as it happens — a block inserted by a
model animates the way a dragged one does. One code path, two callers (D63).

## Plugin UI (D61)

dsh's web client is itself a bundle and host<->browser traffic goes over their
type-safe RPC generation. Plugins extend UI at declared points rather than by
shipping arbitrary code into the renderer. We match that:

| Extension point | A plugin may |
|---|---|
| Block configuration | declare its block's settings schema; Flyt renders the form |
| Tool view | register a renderer for its tool's arguments and results |
| Trace decoration | contribute event renderers so its events read as more than JSON |
| Settings section | declare a configuration surface, validated against its schema |
| Library entry | describe itself — name, icon, category, docs |

All over the typed RPC contract, all rendered with Flyt components. A plugin
cannot break the window, leak renderer state, or opt out of the design language.
A sandboxed iframe escape hatch is designed for, not built, and stays open until
a real plugin demands it.

## Impeccable, both directions

**Inward** — install it into this repo so its commands and 59 deterministic
detector rules critique the new Work and Build surfaces as they are built.
Output lands in `.impeccable/critique/`; findings become backlog tasks. A UI
refactor justified by the old UI being hard to use should be audited by
something that does not share our taste.

**Outward** — Impeccable installs into `.claude/`, `.cursor/`, `.codex/` by
writing a provider-shaped skill payload plus a hook manifest. Flyt becomes one
more provider: `.flyt/skills/` learns to accept that payload, and the detector
CLI arrives as a plugin contributing tools, which the skill then *requests* per
D58. The outward direction is a forcing function — if a skill system built for
someone else's harness installs into ours cleanly, our loader is compatible in
fact rather than in principle.

## What survives the port

### Stacks — four, from nine

| Stack | From | Change |
|---|---|---|
| **Pipeline** | `default-pipeline` + `pipeline-low/medium/high/ultra` | five collapse to one stack with an *effort* dial |
| **Research** | `research` | as-is; ceiling stays `web` + `read-only` |
| **Learn from a repo** | `learn-from-repo` | as-is; subject scope and attribution stay explicit (D38) |
| **Spec an idea** | `spec-an-idea` | as-is; interrogation keeps its multi-round contract (D46) |
| **Loop task** | `loop-task` | ported first — it is how the app builds the rest |

Archived to git history: `flow-msypx3qz-ds2w`, `flow-msyrtfyx-21b3`,
`flow-mt2jzfkc-ntj2`, every `.layout.json`, the four redundant pipeline variants.

### Blocks — twelve templates into four plugins

| Plugin | Contributes |
|---|---|
| `flyt-blocks-core` | work, general-analysis, combine, split, plan-start |
| `flyt-blocks-judgement` | evaluation, compare, prompt-refiner |
| `flyt-blocks-inquiry` | interrogate, orient |
| `flyt-blocks-loop` | backlog-plan, Loop handoff block |

`translation` and `node-ms2r06ba-omz2` archived; translation may return as an
example plugin.

### Tools — grouped by existing toolset

The six sets (`none`, `read-only`, `repo-write`, `repo-full`, `web`, `loop`)
already describe coherent groups, so they become plugin boundaries:
`flyt-tools-repo`, `flyt-tools-web`, `flyt-tools-backlog`, `flyt-tools-inspect`,
`flyt-tools-human`. The sets survive as named ceilings on top. A set is a grant,
a plugin is a delivery; conflating them is how ecosystems get plugins that grant
themselves things.

## Phases

Tasks `t-0035`..`t-0040`, one per phase, chained by `dependsOn`. Each is a
decomposition target, not a single attempt: a worker claiming one should break it
into child tasks with `enqueue_task` rather than attempt it whole.

**Phase 0 — kernel, seams, session log. Landed 2026-08-21** (`t-0035`, hand-built
as `t-0041`..`t-0048`). What exists is described in `DESIGN-SPEC.md` §10; what
follows is the plan it was built from.
Cordis added; TS kernel package stood up; eight seams defined and provided;
`flyt-session-jsonl` with `deriveMessages()` and replay; run folder rebuilt as a
projection; plugin loader reading `dsh.bundle` / `dsh.profile` and `cordis.yml`;
permission bridge wiring ceiling and approval onto `tools/pre-execute`. Compat
suite in CI from day one. Nothing user-visible ships; the old app runs untouched.

**Phase 1 — block editor, Work/Build shell, Trace.** `t-0036`, hand-built, flag
off. Containment-and-snapping editor with derived layout; two surfaces; Trace
reading the log. `Sequence` and `Parallel` only — the containment model needs to
be right before it holds four more container types.

> **Handoff test.** `loop-task` runs end to end on the new kernel, authored in
> the new editor, watched in Trace. Until this passes the app cannot build
> itself and Phase 2 does not start. Once it passes, the remaining phases are
> the Loop's work and the human role changes to fixing what the Loop hits.

**Phase 2 — port the canonical set.** `t-0037`. Four stacks, four block plugins,
five tool plugins, six toolsets as ceilings. This is where the app is stressed on
work that matters: a Loop worker porting the plugin that defines Loop workers is
exactly the kind of thing that finds problems.

**Phase 3 — control flow.** `t-0038`. `Repeat N`, `For each`, `Until`, `If`, the
predicate schema, the lint rules. `STACK_LANG.md` updated in the same tasks that
change the grammar.

**Phase 4 — plugin ecosystem surface.** `t-0039`. Install flow with conservative
inference and one confirm pass; unified faceted library; five UI extension points
over typed RPC; skills that request tools; Impeccable both directions.

**Phase 5 — cutover.** `t-0040`. The flag flips. `FlowCanvas.jsx`,
`FlowEdge.jsx`, `flowLayout.js`, `NodesPage.jsx`, `NodePicker.jsx` and the old
runner are deleted in one commit. `DECISIONS.md`, `GOALS.md`, `DESIGN-SPEC.md`,
`STACK_LANG.md`, `BLOCKS.md`, `TOOLS.md` updated to describe what exists.

## Risks

| Risk | Shape | Mitigation |
|---|---|---|
| dsh is a developer preview | APIs move under us; the compat promise decays quietly | CI compat suite against pinned real plugins; a red build is the alarm. Pin Cordis, upgrade deliberately. |
| Session-log migration | Rewriting the truth store touches resume, spend, approval reconstruction and every reader at once | Phase 0, hand-built, behind a flag; old runs read through a compatibility reader rather than converted |
| Editor harder than the canvas | Containment, snapping, depth and derived layout are more UI work than free positioning | Phase 1 ships Sequence and Parallel only; containers land in Phase 3 |
| Loop builds its own replacement | Workers on the old runner port the plugin defining workers | That is the point; the flag keeps the old runner intact until the handoff test passes |
| Two languages drift | The JS/TS boundary blurs and the typed seam stops being typed | The boundary is the seam; enforced in review |
| Scope | Kernel swap + truth-store swap + UI rewrite + ecosystem promise | Every phase leaves a working app. Stalling at Phase 2 leaves a better kernel and the old UI, which is not a bad place to stop. |

## Open questions

Not blockers for Phase 0, but each changes something downstream.

1. Does Flyt *publish* its plugins as dsh bundles, making us a contributor rather
   than only a consumer? Changes naming and packaging throughout.
2. Session persistence default: JSONL (inspectable, matches principle 1) or
   SQLite (fast for long sessions)? dsh ships both as swappable providers so we
   can defer, but the default matters for "openable in a text editor".
3. Do Flyt *profiles* become user-facing, or stay internal? User-visible is
   powerful and is also a fifth noun.
4. Does the Loop board stay a distinct section inside Work, or dissolve into the
   run list? Six columns is a lot of surface to absorb.
5. The iframe escape hatch for plugin UI — what real plugin would force it?
6. Old runs: compatibility reader only, or a one-time converter into session logs
   so they gain a trace?
