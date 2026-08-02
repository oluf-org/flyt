# TOOLS-PLAN.md — the Toolbox

**Status:** Draft 1 — 2026-07-25. Design settled in interview; unbuilt.
**Supersedes:** `DESIGN-SPEC.md` §7 ("The Toolbox — [PARTIAL] → [PLANNED]"), which this
document expands into an implementable plan. Draft decision **D34** lives in §22 and lands
in `DECISIONS.md` when the last in-scope phase closes.
**Read with:** `GOALS.md` (principles), `DECISIONS.md` (D15 workspace/config, D16 safety,
D24 zero-dependency, D29 brand, D31 packaging), `FLOW_NODES.md` (node catalog),
`FLOW_LANG.md` (DSL), `DESIGN-SPEC.md` §6.2 (skills — the closest existing analogue) and §9
(safety model).

> **One-sentence goal:**
> A tool is a file, not a function — so the toolbox can be browsed, authored, imported from
> the outside world, granted narrowly, searched by an agent that doesn't know what exists,
> and audited afterwards.

---

## 1. Why this exists

### 1.1 What is actually built today

`DESIGN-SPEC.md` §7 and §11 are **stale** — they say only `write_file`, `create_task` and
`write_task_md` are registered, and list `read_file` / `create_file` / `bash` as PLANNED.
They are built. The true current state:

- **`core/tools/index.js`** — a real registry. A tool is
  `{ name, description, parameters (JSON Schema), run(args, ctx) }`. `registerTool` adds one,
  `getTools(names)` returns a named subset (unknown names silently dropped so a stale flow
  can't crash a run), `validateArgs` is a hand-rolled JSON-Schema subset validator, and
  `executeTool` validates → runs → times → **never throws** → appends `tool_call` to
  `log.jsonl`.
- **Six tools:** `read_file`, `create_file`, `write_file`, `bash`, `create_task`,
  `write_task_md`.
- **`DESTRUCTIVE_TOOLS`** — a hardcoded `Set` of three names (`write_file`, `create_file`,
  `bash`). It is the sole input to the per-call approval gate.
- **`core/tools/fileHost.js`** — file tools act on the bound project when `ctx.workspace`
  exists, else on the run's own `runs/<id>/workspace/` sandbox. Both confine every path.
- **`core/agent.js`** — two execution paths, NATIVE (OpenAI-style function calling on
  `openrouter | openai | kimi` when `worker.supportsTools`) and TEXT (a fenced ` ```tool `
  block protocol for anthropic + mock). `MAX_ITERATIONS = 8`.
- **Grants** — `AGENT_TOOLS` in `src/flowTypes.js` is a flat array of six strings.
  `WORK_TOOLS` maps a work node's task type to a fixed list; only `Test-creation` gets
  `bash`, and it alone defaults `approveToolCalls: true`. In the DSL, `tools` is an override
  valid **only** on `agentTask` templates (`FLOW_LANG.md`, lint rule `invalid-override`).
- **`core/safetyCheck.js`** — the three-layer command screen (DENY patterns → ALLOW patterns
  → small-model classifier, fail-closed to `caution`). It applies to shell commands only.

### 1.2 The three things it can't do

1. **A tool cannot be created without editing source.** Every tool is a hand-written JS
   module registered at import time. There is no way for a user — or an AI — to add a
   capability. This breaks principle #1 (files are the source of truth) for the one subsystem
   where everything else in the app is already a file: node templates are `nodes/*.json`,
   flows are `flows/*.flow.yaml`, skills are `.flyt/skills/*.md`. **Tools are the last
   hardcoded thing.**
2. **The toolbox cannot grow past a handful.** Grants are flat arrays of literal strings
   typed into a template. That works at six tools. At sixty — the moment one MCP server is
   connected — the model's context fills with schemas it will never call, and accuracy
   degrades. This is a measured effect, not a hypothetical (§2.2).
3. **Nothing can be granted dynamically.** The orchestrator materializes nodes mid-run with
   `template`, `category`, `contextSpec` and `goal` — but their tools come from a static
   `WORK_TOOLS` lookup on the task type. An orchestrator that decomposes "get the current
   date and redesign the landing page" into two nodes cannot give one of them a clock and the
   other a browser, because it has no vocabulary for saying so and no catalog to say it from.

### 1.3 What this plan is not allowed to break

- **The allowlist is the safety envelope.** `DESIGN-SPEC.md` §6.2 forbids skills from
  widening the tool set precisely because "expertise that could quietly expand what an agent
  may *do* would undermine it." Any dynamic grant mechanism must preserve that invariant, not
  argue its way around it (§6).
- **Fail-closed.** `safetyCheck.js`'s comment — "a safety check that fails open is not a
  safety check" — is the house rule. Every new decision point inherits it.
- **Never silent.** Skills log `skills_injected` on every hit and `skill_missing` **with a
  reason** on every miss. Tool resolution gets the same treatment.
- **Zero-ish dependencies (D24).** The DSL is hand-rolled on principle. `package.json` has
  six runtime deps, four of which are React. Adding an SDK is a decision, not a default.

---

## 2. The landscape — what the field settled on

Researched 2026-07-25. This section exists so the design choices below can be read against
what everyone else is doing, and so the "and better" in the brief is checkable rather than
asserted.

### 2.1 MCP is about to change more than it ever has

The **`2026-07-28`** revision — the release candidate locked 2026-05-21, final **three days
from this document's date** — is the largest revision since launch:

| Change | Consequence for Flyt |
|---|---|
| **Stateless core.** `initialize`/`initialized` handshake removed (SEP-2575); `Mcp-Session-Id` removed (SEP-2567). Protocol version, client info and capabilities travel in `_meta` on **every** request. A new `server/discover` fetches capabilities on demand. | A client is dramatically simpler to hand-roll — no session lifecycle, no reconnect logic, no sticky routing. A *server* becomes an ordinary stateless HTTP handler. This is what makes §8 and §9 affordable without an SDK. |
| **`Mcp-Method` + `Mcp-Name` headers required** on Streamable HTTP (SEP-2243); servers reject headers that disagree with the body. | Trivial to emit; must not be forgotten. |
| **`ttlMs` + `cacheScope` on list results** (SEP-2549), modeled on HTTP `Cache-Control`. | The tool index (§7) gets a correctness-preserving cache with an explicit expiry, instead of guessing. |
| **Multi round-trip requests** (SEP-2322): a server returns `InputRequiredResult` with `inputRequests` + an opaque `requestState`; the client gathers answers and **re-issues the original call**. Server-initiated requests are only legal while processing a client request (SEP-2260). | Maps cleanly onto Flyt's existing `awaiting_input` gate (§14.5). An MCP server asking a question and `ask_human` become the same mechanism. |
| **Full JSON Schema 2020-12** for `inputSchema`/`outputSchema` (SEP-2106) — `oneOf`, `anyOf`, `allOf`, conditionals, `$ref`/`$defs`. Output schemas unrestricted; `structuredContent` may be any JSON. **Implementations must not auto-dereference external `$ref` URIs** and should bound schema depth. | `validateArgs` is a flat-schema validator. It needs composition and local `$ref` support, a depth bound, and a hard refusal to fetch remote refs (§4.4). |
| **Extensions framework** (SEP-2133), reverse-DNS IDs, negotiated via an `extensions` capability map. Two official ones ship: **MCP Apps** (server-rendered UI in a sandboxed iframe) and **Tasks** (server-directed long-running work: `tools/call` returns a handle, client drives `tasks/get`/`update`/`cancel`; `tasks/list` removed). | Tasks is exactly the shape a flow-as-a-tool needs (§9) — a Flyt run takes minutes. MCP Apps is out of scope but is why §15 shouldn't paint itself into a corner. |
| **Roots, Sampling and Logging deprecated** (SEP-2577) — annotation-only, ≥12 months before removal. | Do not build on them. Use tool parameters/resource URIs instead of Roots; call providers directly instead of Sampling; `stderr`/OpenTelemetry instead of Logging. |
| **Auth hardening** — `iss` validation per RFC 9207, `application_type` in Dynamic Client Registration (fixes the common desktop-client localhost-redirect rejection), credential binding to the issuer. | Relevant to the deferred OAuth phase (§19 P11). The `application_type` fix matters specifically because Flyt is a desktop app. |
| **Error code** for a missing resource: `-32002` → standard `-32602`. | Don't match on `-32002`. |

**Consequence for this plan:** target `2026-07-28` as the primary wire format. It is both the
future and, because statelessness removed the handshake and the session, *by far the easier
one to implement from scratch*.

### 2.2 The context-bloat problem, and the two answers to it

Everyone hit the same wall: passing every tool schema up front eats context, degrades
accuracy, and breaks past a few dozen tools. Two answers converged:

**Tool Search / deferred loading (Anthropic).** Tools are marked deferred — discoverable but
not loaded. The agent calls a search tool (regex or BM25) and pulls in schemas on demand.
Reported: **~85% token reduction**, and on MCP evaluations Opus 4 going **49% → 74%**. Now
applied to MCP inside Claude Code.

**Code mode (Cloudflare, Anthropic).** The model writes a script against a typed API instead
of emitting JSON tool calls; a sandbox runs it. Cloudflare compresses **2,500+ endpoints into
2 tools and ~1,000 tokens** (`search()` + `execute()`). Anthropic reported a **98.7%**
reduction on a Drive-to-Salesforce scenario (150k → 2k tokens); an MCP-server-as-TypeScript-API
comparison showed ~81%. The underlying claim, which has held up: **models are better at
writing code that calls tools than at selecting tools through JSON function-calling.**

Flyt takes both (§7, §11), and the balance the field has settled on: code mode is *the
long-tail escape hatch, not the front door*.

### 2.3 The dissenting architecture: UTCP

The Universal Tool Calling Protocol argues a tool protocol should be a **descriptive manual,
not a prescriptive middleman**: a JSON manual describes how to call a tool over its *native*
interface (HTTP, gRPC, WebSocket, CLI), the agent then talks to it directly. The pitch is
eliminating the "wrapper tax" — no server to write, deploy or maintain, and existing auth,
billing and rate limiting keep working untouched. It explicitly does not compete with MCP; it
subsumes it as one call type.

**Flyt should take the idea, not the standard.** UTCP has real adoption but nothing like
MCP's. What matters is the insight: *for a plain HTTP API, a declarative manual beats writing
a server.* That is precisely §10 — a `provider: http` tool is a Flyt-native UTCP manual, and
if UTCP consolidates, importing one becomes a parser, not a re-architecture.

### 2.4 Discovery: the registry

The **Official MCP Registry** (Anthropic/GitHub/Microsoft) holds ~2,000 servers behind one
REST API (`GET /v0/servers`), API-frozen at v0.1 since 2025-10-24. Metadata is
`server.json`; a server publishing `/.well-known/mcp/server.json` is auto-discoverable.
**Most clients still don't integrate it** — they ship manual JSON config files.

**That gap is the opportunity.** Registry-backed discovery in the Tools page is cheap (one
frozen REST endpoint) and is a place Flyt can be straightforwardly better than the norm. It
is scoped as a late, optional phase (§19 P8b) because it is additive, not structural.

### 2.5 Sandboxing, and what the research actually says

For running agent-generated code:

- **`vm2` — rejected.** Documented sandbox-escape advisories. Not a security boundary.
- **`node:vm` — rejected as a boundary.** Same-process, escapes are well documented. Fine for
  trusted input; code mode's input is model output shaped by untrusted tool results, which is
  the definition of untrusted.
- **`isolated-vm` / V8 isolates** — what Cloudflare runs; fresh isolate in milliseconds, own
  heap, own globals, deny-by-default. **Native module** → per-platform prebuilds and an
  `electron-rebuild` step in the D31 pipeline.
- **QuickJS-in-WASM** — engine sits *behind* the boundary rather than beside it;
  capability-based; ~300 ms first run (WASM compile), ~0.5 ms after. Still a dependency, and
  an interpreter rather than native V8.
- **Child process with no ambient authority** — zero dependency, uses what Node already has,
  and the isolation that matters here (no fs, no net, no env, no API keys) is achievable by
  simply not granting it.

On **gating**, the pattern that converged is not "approve every call": it is
*auto-execute allowlists* — a generated script runs unattended only if every tool it can
reach is on the auto-execute tier — plus **approval tokens that bind validated code to a
context and expiry so code can't be substituted after validation**. And the warning worth
heeding: *human-in-the-loop is defeated by dialogs that appear too often or carry too little
context* — users approve without reading. That is an argument for **one legible script
approval** over twelve blind ones.

**Chosen:** child process + auto-execute allowlist (§11). Zero-dep, keeps every call flowing
through `executeTool`, and puts the human in front of one readable artifact.

### 2.6 Scorecard — where "better" is claimable

| Property | Typical client | Flyt's target |
|---|---|---|
| Tool definitions | code, or opaque server config | **files** — inspectable, diffable, version-controllable, the same contract as nodes and flows |
| Grants | all-or-nothing per server | **two-tier**: a static ceiling per node + a narrow runtime grant inside it (§6) |
| Discovery | flat list in context | **cheap index first, LLM clerk only when keywords fail** (§7) |
| Provenance of a call | a log line, maybe | a `tool_call` record, a **result artifact on disk**, and a node on the canvas (§13, §17) |
| Third-party trust | server config implies trust | **trust tiers by source**; an untrusted tool's self-declared risk can only ever gate it *harder* (§12) |
| Code mode gating | per-call prompts, or nothing | **auto-execute allowlist + one script approval + runtime tier enforcement** (§11.4) |
| Human input | out of band | `ask_human` on the **existing** `awaiting_input` gate, same mechanism as an MCP `InputRequiredResult` (§14.5) |

---

## 3. The design in one page

```
                      ┌──────────────────────────────────────────┐
                      │            THE TOOL LIBRARY              │
                      │        tools/<id>.json  (files)          │
                      │                                          │
   provider: builtin ─┤  read_file  write_file  bash  edit_file  │
   provider: http    ─┤  jira_issue  deploy_staging  get_time    │
   provider: mcp     ─┤  github__create_pr   figma__get_file     │
   provider: flow    ─┤  (later: a Flyt flow, callable as a tool)│
                      └───────────────┬──────────────────────────┘
                                      │ every tool carries:
                                      │   effects · source · trust · schema
                                      ▼
    ┌───────────────────────────────────────────────────────────────────┐
    │  CEILING (static, authored)          GRANT (dynamic, ≤ ceiling)   │
    │  toolset on the template/flow  ──▶   what this node actually got  │
    └───────────────────────────────────────────────────────────────────┘
                                      ▲
                        ┌─────────────┴─────────────┐
                        │                           │
              plan time: the CLERK          run time: search_tools
              (orchestrator asks,           (the agent asks itself,
               grants get baked into         still capped by the ceiling)
               the generated node spec)
                        │                           │
                        └─────────────┬─────────────┘
                                      ▼
                       ┌──────────────────────────────┐
                       │  index lookup (BM25/regex)   │  ← free, answers most
                       │      ↓ miss / fuzzy brief    │
                       │  LLM clerk node              │  ← costs a call, logged
                       └──────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │  EXECUTION                          │
                    │  JSON calling (default)             │
                    │  code mode (opt-in, child process)  │
                    │    → executeTool: validate · risk   │
                    │      · gate · run · log             │
                    │    → result artifact + handle       │
                    └─────────────────────────────────────┘
```

**Five sentences.** (1) A tool is a file describing what it does, what it costs you if it
misbehaves, and where it came from. (2) A node's *ceiling* is authored and static; its
*grant* is narrow and may be decided at run time, but can never exceed the ceiling. (3)
Finding the right tool is a cheap index lookup, and only an LLM's job when the index can't
answer. (4) Execution is unchanged in shape — everything still goes through `executeTool` —
but the result lands on disk and the model gets a handle. (5) Nothing about where a tool came
from can make it *less* gated than Flyt decided it should be.

---

## 4. Data model

### 4.1 A tool is a file

`tools/<id>.json`, app-level, peer to `nodes/<id>.json`. **App-level only** — decided in
interview. Tools are portable capability, like node templates; skills stay the project-scoped
thing (D15). A repo-specific script is reachable via `bash` or a `provider: http` tool
pointed at localhost; it does not need its own store, and a second store would double the
resolution rules for marginal gain.

> **Deliberate asymmetry, stated so it isn't read as an oversight:** skills are per-project
> because *expertise* is project-specific; tools are app-level because *capability* is not.
> "Run the tests" means something different in every repo (skill); "make an HTTP request"
> does not (tool).

```jsonc
{
  "id": "jira_create_issue",           // ^[a-z][a-z0-9_]*$ — also the model-visible name
  "title": "Create a Jira issue",      // human label for the Tools page
  "description": "Create an issue in a Jira project. Returns the issue key and URL.",
  "provider": "http",                  // builtin | http | mcp | flow
  "enabled": true,

  // --- what it costs you if it misbehaves (§12) ---
  "effects": ["network", "write"],     // read | write | network | shell | destructive
  "risk": "caution",                   // safe | caution | danger  (RISK_LEVELS, reused)
  "autoExecute": false,                // may run unattended inside code mode (§11.4)

  // --- provenance (§12.2). Written by Flyt, not by the author. ---
  "source": { "kind": "user", "importedFrom": null, "importedAt": null },
  "trust": "review",                   // trusted | review | untrusted

  // --- the model-facing contract ---
  "parameters": { /* JSON Schema 2020-12, object root */ },
  "outputSchema": { /* optional; any JSON Schema */ },

  // --- discovery metadata for the index (§7.1) ---
  "keywords": ["jira", "ticket", "issue", "bug", "backlog"],
  "examples": ["file a bug for the login crash", "open a ticket in PROJ"],

  // --- provider-specific block; exactly one, keyed by `provider` ---
  "http": { /* §10 */ },

  // --- result handling (§13) ---
  "result": { "preview": "json", "maxPreviewChars": 2000, "artifact": true }
}
```

**Built-ins are files too**, shipped and seeded on first launch exactly as
`SEED_NODE_TEMPLATES` seeds `nodes/`. Their `http`/`mcp` block is absent and
`"provider": "builtin"` binds the id to a module in `core/tools/`. They are **read-only in
the UI** (you may disable one, or clone it to edit) — the `run()` lives in source, so an
editable definition would lie about what executes.

### 4.2 Toolsets

A named, reusable bundle. `tools/sets/<id>.json`:

```jsonc
{
  "id": "repo-write",
  "title": "Repo (read + write)",
  "description": "Read, search and modify files in the bound workspace.",
  "include": ["read_file", "glob", "grep", "edit_file", "write_file", "create_file"],
  "includeSets": ["read-only"],        // composable; cycles rejected at load
  "exclude": ["bash"]                  // applied after include, wins
}
```

Also resolvable as **selectors**, so a ceiling doesn't need editing every time the library
grows:

- `effects:read` — every tool whose effects are a subset of `{read}`
- `provider:mcp` — everything from MCP servers
- `server:github` — one MCP server's tools
- `trust:trusted` — first-party only
- `*` — everything (legal, loud in the UI, never a default)

Seeded sets: `read-only`, `repo-write`, `repo-full` (adds `bash`), `web`, `none`.

### 4.3 The registry, reworked

`core/tools/index.js` keeps its exported surface — `registerTool`, `getTools`, `validateArgs`,
`executeTool`, `DESTRUCTIVE_TOOLS` — because `core/agent.js` and the executor call it and
those call sites should not churn. What changes underneath:

- **`ToolStore`** (`core/toolstore.js`, mirroring `nodestore.js`) owns `tools/*.json`,
  normalization, defaulting and validation. The in-memory registry becomes its cache.
- **A `provider` interface.** Each provider module exports
  `{ kind, load(def), run(def, args, ctx) }`. `builtin` resolves to a `core/tools/*.js`
  module; `http` executes a request (§10); `mcp` proxies a `tools/call` (§8); `flow` is
  reserved (§9.4).
- **`DESTRUCTIVE_TOOLS` becomes derived, not literal:**
  ```js
  export const isDestructive = tool =>
    tool.effects.some(e => e === 'write' || e === 'shell' || e === 'destructive');
  ```
  The exported `Set` stays as a deprecated alias over the built-ins for one release so no call
  site breaks in the same commit that changes the semantics.
- **`AGENT_TOOLS`** (`src/flowTypes.js`) stops being a hardcoded array of six strings and
  becomes a snapshot of the library delivered over IPC, so the Nodes page and the DSL linter
  validate against what actually exists.

### 4.4 Schema validation — what has to change

`validateArgs` handles `type`, `required`, `properties`, `items`, `enum`,
`additionalProperties`. MCP `2026-07-28` lifts tool schemas to full **JSON Schema 2020-12**.
Realistically:

**Must add:** `oneOf` / `anyOf` / `allOf`, `$ref` + `$defs` (**local only**), `const`,
numeric bounds (`minimum`/`maximum`), string bounds (`minLength`/`maxLength`/`pattern`),
`nullable` via `type: [..]` arrays.
**Must refuse:** external `$ref` URIs — the spec says implementations *must not*
auto-dereference them, and a validator that fetches a URL from an untrusted server schema is
an SSRF primitive. Refuse loudly at load: the tool is imported **disabled** with the reason
shown.
**Must bound:** schema depth (proposed 32) and validation time — again a spec
recommendation, and cheap insurance against a hostile schema.

Still hand-rolled, still zero-dep (D24). Roughly +200 lines with a table-driven test suite.
This is the one piece of "just use ajv" pressure in the whole plan; it is resisted because a
validator is exactly the kind of thing D24 exists to keep in-house, and the subset needed is
bounded and testable.

---

## 5. Resolution and precedence

When a run needs the tool `x` for node `n`:

1. **Library lookup** — `ToolStore` by id. Missing → the grant is dropped, `tool_missing`
   logged with the reason, and the node runs without it. *Never fatal* — the skills rule
   (`DESIGN-SPEC.md` §6.2) applied to tools.
2. **Enabled?** A disabled tool resolves as missing, with `reason: "disabled"`.
3. **Inside the ceiling?** (§6) If not, the grant is **refused**, `tool_grant_refused` is
   logged with the ceiling that refused it, and — unlike a missing tool — this is surfaced in
   the node's retrospective as a *problem*. A refused grant means something tried to exceed
   its envelope; that must be visible, not merely absent.
4. **Provider healthy?** An `mcp` tool whose server is down resolves as missing with
   `reason: "server_unreachable"`, not as an error. A dead integration degrades a node; it
   does not fail a run.
5. **Bind.** The tool is added to the agent loop's `tools` array with its schema.

**Grant precedence**, narrowest wins:

```
per-node runtime grant (search_tools / clerk)   ← must be ⊆ ceiling
  ↑ within
per-node override in the flow  (flows/<id>.flow.yaml)
  ↑ within
node template default          (nodes/<id>.json)
  ↑ within
CEILING: template/flow toolset (the hard limit — nothing below may exceed it)
```

---

## 6. Grants — the two-tier model

**The invariant, restated:** *no mechanism may grant a tool the authoring surface did not
already permit.* Skills obey it. The clerk must too.

### 6.1 Ceiling vs grant

- **Ceiling** — `toolCeiling` on a node template or flow node. A toolset id, a selector, or a
  literal list. Authored by a human (or an AI writing DSL, which is lint-checked and
  human-reviewable before it runs). May be broad: `"effects:read"` is a perfectly good
  ceiling — it says "this node may reach any read-only tool, and I don't care which."
- **Grant** — what the node actually gets. May be static (`tools: [...]`, today's behavior)
  or resolved at run time by the clerk or `search_tools`. **Always intersected with the
  ceiling before binding.**

```yaml
# flows/<id>.flow.yaml
- id: research
  template: work
  toolCeiling: read-web          # toolset id — the hard limit
  tools: [http_fetch]            # the static grant; may be widened at run time,
                                 # but only to other members of `read-web`
```

Absent `toolCeiling`, the ceiling is **exactly the static grant** — so every flow authored
today keeps its present semantics unchanged, and dynamic granting is strictly opt-in. That is
the migration story: no flow file changes, no behavior changes, until someone adds a ceiling.

### 6.2 What the ceiling is for

It is the thing a human reasons about. "This orchestrator's children may read the repo and
hit the network, but may never run a shell command or write a file" is one line
(`toolCeiling: read-only + web`), it is legible on the canvas, and no amount of clever
planning by a model can get past it. Compare the alternative — auditing which of forty
generated nodes was handed `bash` — and the ceiling pays for itself.

### 6.3 Orchestrator inheritance

An orchestrator's children inherit the **orchestrator's** ceiling, narrowed further by their
own if they declare one. A child can never widen its parent's envelope. This closes the hole
that would otherwise open the moment planning became tool-aware: a node that decides what
other nodes may do must not be able to decide they may do more than it may.

### 6.4 DSL and lint changes

- `toolCeiling` — new node field. Valid on `agentTask` templates and on `orchestrator`.
- `tools` — relaxed from "agentTask only." An `aiStep` may now hold read-only tools
  (`get_time`, `http_fetch`, `search_tools`) because a planner that can check the time or
  read a page plans better. The existing `invalid-override` lint rule becomes:
  *`tools` on a non-agentTask node may only name tools whose effects ⊆ `{read}`.*
- New lint errors:
  | code | severity | when |
  |---|---|---|
  | `unknown-tool` | error | grant names a tool not in the library |
  | `unknown-toolset` | error | ceiling names a set that doesn't exist |
  | `grant-exceeds-ceiling` | error | static grant ⊄ ceiling |
  | `child-exceeds-parent` | error | child ceiling ⊄ orchestrator ceiling |
  | `ungated-danger` | **warn** | a `danger`-risk tool granted with `approveToolCalls: false` |
  | `broad-ceiling` | warn | ceiling is `*` |
  | `readonly-tools` | error | *(built)* a non-agentTask node grants a tool whose effects ⊄ `{read}` — the relaxed `invalid-override` rule, given its own name |

`npm run flow -- lint` stays the machine gate (`GOALS.md`): an AI authoring a flow with tools
lints until `ok: true`, exactly as today.

---

## 7. The Clerk — finding a tool you don't know exists

Two mechanisms, cheapest first. This mirrors `safetyCheck.js` deliberately: patterns before
models, because the expensive path must never be the only thing standing between the user and
a correct answer.

### 7.1 Layer 1 — the index (free, deterministic)

`core/toolIndex.js` builds an in-memory BM25 index over each tool's `id`, `title`,
`description`, `keywords` and `examples`. Rebuilt on library change; for MCP-sourced tools,
cached per the server's `ttlMs` (SEP-2549) rather than a guessed interval.

Exposed to agents as a real tool:

```jsonc
{
  "id": "search_tools",
  "description": "Find tools available for a task. Returns names + descriptions; call load_tool to get a schema.",
  "effects": ["read"], "risk": "safe", "autoExecute": true,
  "parameters": { "type": "object", "required": ["query"], "properties": {
    "query":  { "type": "string", "description": "What you need to do, in plain words." },
    "regex":  { "type": "string", "description": "Optional regex over tool names." },
    "limit":  { "type": "integer", "default": 8, "maximum": 25 }
  }}
}
```

Results are **already filtered by the calling node's ceiling** — an agent is never told about
a tool it could not be granted. `load_tool(name)` then pulls the full schema into context.
This is the Anthropic deferred-loading pattern, and it is why a hundred-tool library costs
roughly what a six-tool library costs today.

**Tools above a node's `effort`-appropriate risk are ranked down, not hidden** — hiding them
would make the agent hallucinate a workaround; ranking them down while showing the gate
requirement lets it choose knowingly.

### 7.2 Layer 2 — the Clerk node (a model call, only on demand)

A **Node Library template**, `tool-clerk`, role `tool-clerk`, `kind: ai`. It exists as a node
rather than a hidden service for the reason `DESIGN-SPEC.md` §9 gives for the command-guard
node: *because it's a node, its verdict is a logged, inspectable artifact.*

**Input:** a brief. **Output port `grants`:** one fenced JSON block, in the same house style
as every other contract in `core/planEval.js`:

```json
{
  "grants": [
    { "for": "gen-clock",  "tools": ["get_time"],
      "why": "needs the current date" },
    { "for": "gen-redesign", "tools": ["read_file", "edit_file", "browser_preview"],
      "why": "edits the page and needs to see the result" }
  ],
  "unmet": [
    { "need": "publish to the CDN", "suggestion": "no tool covers this; consider an http tool" }
  ]
}
```

- `for` is a generated node id, or `"self"`.
- Every entry is intersected with the ceiling **after** the model answers. The clerk is an
  *advisor*, never an authority — it cannot widen anything, so a prompt-injected clerk output
  is a bad suggestion, not a privilege escalation.
- **`unmet` is required and load-bearing.** An honest "no tool does this" beats granting three
  tools that don't and letting the work node discover it the hard way. It surfaces in the UI
  as "your library is missing X" — the natural prompt to author one.
- Invalid JSON → one bounded re-ask (the `planEval.js` convention), then degrade to the index
  results. **Never fatal**: unlike plan-eval, whose whole job is creating nodes, the clerk's
  failure has a good fallback.

### 7.3 When each runs

**Plan time (primary).** The orchestrator and `plan-eval` may consult the clerk while
declaring nodes. Resolved ids are **baked into the generated node spec**, land in the run's
`flow.json`, and are visible on the canvas *before anything executes*. This is the
inspectability win and it is why plan-time is primary — Flyt's differentiator (D3: mastery and
control) is that you can see what is about to happen.

The node-materialization contract (`FLOW_NODES.md`) gains an optional field:

```json
{ "nodes": [{ "id": "gen-impl", "template": "work", "goal": "...",
              "tools": ["read_file", "edit_file"] }] }
```

Validated against the orchestrator's ceiling (§6.3); an out-of-ceiling entry is dropped, the
node is still materialized with what remains, and the violation goes to
`nodes/<id>-errors.md` + `log.jsonl` — graceful failure, exactly as `plan-eval` handles a
malformed `nodes` array today.

**Run time (escape hatch).** Any node whose ceiling is broader than its grant gets
`search_tools` + `load_tool` bound automatically. An agent that discovers it needs something
finds it, inside the ceiling, logged as `tool_granted_runtime`.

### 7.4 Ordering

Index first, always. The clerk runs when: the index's top score is below threshold; the brief
covers **multiple distinct capabilities** (your example — a clock *and* a browser — is
precisely the case keyword search handles badly); or the caller asks for it explicitly. Every
decision logs which layer answered, so "is the clerk earning its cost?" is answerable from
`log.jsonl` rather than by intuition.

---

## 8. MCP client — connecting out

### 8.1 What gets built

`core/mcp/` — hand-rolled, zero-dep (D24), targeting `2026-07-28`:

```
core/mcp/
  client.js       // JSON-RPC 2.0: request/response, ids, errors, timeouts
  transport-stdio.js   // child_process.spawn, newline-delimited JSON on stdin/stdout,
                       //   stderr → log (Logging is deprecated; stderr is the replacement)
  transport-http.js    // fetch: MCP-Protocol-Version, Mcp-Method, Mcp-Name headers,
                       //   _meta clientInfo on every request, ttlMs/cacheScope honored
  servers.js      // server registry, lifecycle, health, reconnection/backoff
  import.js       // tools/list → tools/<id>.json records
  compat.js       // 2025-11-25 shim: initialize handshake + Mcp-Session-Id
```

Statelessness is what makes this affordable. No handshake, no session store, no sticky
routing, no SSE stream to hold open — a `tools/call` is one self-contained POST. The estimate
is ~400 lines for the client and both transports.

`compat.js` is isolated deliberately: it is the only place that knows sessions ever existed,
so it can be deleted when it stops earning its keep, and its absence can't complicate the
main path in the meantime.

### 8.2 Server configuration

`tools/servers/<id>.json` (app-level, alongside the library):

```jsonc
{
  "id": "github",
  "title": "GitHub",
  "transport": "stdio",                    // stdio | http
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${secrets.GITHUB_TOKEN}" },   // §4.1 / §10.3 — refs only
  // for http: "url": "https://…", "auth": { "type": "bearer", "token": "${secrets.X}" }
  "enabled": true,
  "trust": "untrusted",                    // default for anything imported (§12.2)
  "toolPrefix": "github__",                // namespacing — collisions are otherwise certain
  "expose": ["create_pr", "list_issues"],  // null = all; the user curates
  "autoImport": false                      // re-import on tools/list change, or ask
}
```

### 8.3 Import → library records

`tools/list` results become ordinary `tools/<id>.json` files with
`"provider": "mcp"`, `"source": { "kind": "mcp", "server": "github", "importedAt": … }`,
`"trust": "untrusted"`. Consequences that matter:

- **Imported tools are visible, diffable and version-controllable** like every other tool.
  You can see what changed when a server updates — which is more than most clients offer.
- **Names are prefixed.** `github__create_pr`. Two servers with a `search` tool is not an edge
  case, it's Tuesday.
- **`effects` are inferred, then reviewed.** MCP annotations (`readOnlyHint`,
  `destructiveHint`) are read as *hints only* — a server's self-report cannot lower its own
  gating (§12.3). The inference is conservative: anything not provably read-only is `write`.
- **Re-import is a diff, not a clobber.** A changed schema shows as a change; a user's local
  overrides (`enabled`, `autoExecute`, curated `keywords`) survive.

### 8.4 What is deliberately not consumed

**Sampling** (deprecated — and letting a server drive Flyt's model calls would put a
third party inside the run's cost and safety envelope), **Roots** (deprecated; superseded by
tool parameters), **Logging** (deprecated; stderr + `log.jsonl` instead), **MCP Apps**
(out of scope — see §20), **Resources** and **Prompts** (v1 imports tools only; resources are
a natural §13 extension via handles, prompts overlap skills and need their own thinking).

**Elicitation / `InputRequiredResult`** *is* consumed: a server that returns one parks the run
at the `awaiting_input` gate, the user answers in the composer, and the client re-issues the
original call with `inputResponses` + the echoed `requestState` (§14.5). Same machinery as
`ask_human`, same machinery as the prompt refiner. One gate, three uses.

---

## 9. Flyt as an MCP server — flows as tools

**Scope (decided in interview): flows only.** Not the tool library, not runs-as-resources.

### 9.1 Why this is the right half to build

It is the direction that makes Flyt *worth connecting to*. Re-exporting a tool library makes
Flyt a proxy — a thing that already exists in a dozen forms. Exposing a **flow** — a planned,
decomposed, multi-model, human-gated, fully-audited pipeline — as a single tool call is
something no other MCP server offers. `flyt_run_ultra_pipeline` in Claude Code is D2's thesis
(structure beats raw model power) delivered to an audience already holding the alternative.

### 9.2 Shape

Stateless spec ⇒ a plain HTTP handler, no session store, no sticky routing. Off by default;
enabled in the Tools page; binds `127.0.0.1` on a configurable port; a bearer token required
even on loopback (any local process can reach loopback).

- `tools/list` → one tool per flow with `expose:`d run inputs, plus a `prompt` string.
  Description assembled from the flow's name, description and node inventory.
- `tools/call` → starts a run, returns a **task handle** (Tasks extension, §2.1): a flow takes
  minutes, so returning a handle is the only honest answer. The client drives `tasks/get`.
  Task creation is server-directed, which fits — Flyt knows a flow is long-running, the caller
  doesn't.
- A run started over MCP is an ordinary run: same `runs/<id>/`, same canvas, same artifacts,
  `meta.startedBy: "mcp:<client>"`.

### 9.3 Gates over MCP

A flow with `requiresApproval` parked at a gate returns an `InputRequiredResult` — the *same*
mechanism, now in the server direction. The external client shows the approval; the decision
comes back on the re-issued call. **A gate is never silently auto-approved because the caller
was a machine.** That is the whole safety model, and it does not get an exception for
convenience.

### 9.4 `provider: flow` (reserved)

A flow as a tool *inside* Flyt — sub-flows by another name. The field is reserved in §4.1 so
the shape exists; building it is out of scope (`GOALS.md` lists sub-flows under non-goals) and
it needs a depth guard first, per the unresolved half of D8.

---

## 10. Declarative HTTP tools

The UTCP insight (§2.3), Flyt-native: for an ordinary HTTP API, a manual beats a server.

### 10.1 Definition

```jsonc
{
  "id": "get_weather", "provider": "http",
  "description": "Current weather for a city. Returns temperature in °C and conditions.",
  "effects": ["network"], "risk": "safe", "autoExecute": true,
  "parameters": { "type": "object", "required": ["city"],
                  "properties": { "city": { "type": "string" } } },
  "http": {
    "method": "GET",
    "url": "https://api.example.com/weather?q={{city}}&key=${secrets.WEATHER_KEY}",
    "headers": { "Accept": "application/json" },
    "body": null,                       // template for POST/PUT/PATCH
    "timeoutMs": 15000,
    "maxResponseBytes": 5242880,
    "response": {
      "type": "json",
      "select": "$.current",            // narrow the payload before the model sees it
      "map": { "tempC": "$.temp_c", "conditions": "$.condition.text" }
    }
  }
}
```

**`{{arg}}`** interpolates a validated argument; **`${secrets.NAME}`** resolves a secret
(§10.3). Two syntaxes on purpose — they have different trust and different failure modes, and
one syntax would eventually let an argument name a secret.

**Interpolation is escaped by position.** Into a URL path/query → percent-encoded; into a JSON
body → JSON-encoded; into a header → CR/LF rejected outright. This is injection prevention,
and it is not optional: the arguments come from a model that read output from a server we do
not trust.

### 10.2 Network policy

`DESIGN-SPEC.md` §9 lists "network policy for HTTP tools" as an open item. Closing it:

- **Deny-by-default to private space.** `localhost`/`127.0.0.0/8`, `::1`, RFC1918,
  link-local (`169.254.0.0/16` — including cloud metadata at `169.254.169.254`), `.local`.
  Overridable **per tool** with an explicit `allowPrivate: true` and a UI warning, because
  local dev servers are a real use case and a blanket ban would just get switched off.
- **Resolve-then-pin.** Resolve the hostname, check the resolved IP against the policy, and
  connect to that IP — closing DNS-rebinding, where a name passes the check and then resolves
  somewhere else.
- **Redirects re-checked** at every hop; capped at 5.
- **Response size capped** (`maxResponseBytes`), body streamed and truncated rather than
  buffered whole.
- **Optional per-tool `allowedHosts`** — an allowlist beats a denylist when the author knows
  the answer.

### 10.3 Secrets — refs only, never inline

Decided in interview.

- A definition may reference `${secrets.NAME}` and **may not contain a literal credential.**
  Load-time lint flags anything that looks like one (`sk-…`, `ghp_…`, long high-entropy
  strings, an `Authorization` header with a non-ref value) and **imports the tool disabled**
  rather than quietly accepting it.
- Values live in app-level storage outside `tools/`: `secrets.json` in userData (gitignored,
  file-mode 0600 where the OS supports it), with env-var fallback (`FLYT_SECRET_<NAME>`).
  **OS keychain (Electron `safeStorage`) is a follow-up**, not v1 — it adds a platform matrix
  to D31's packaging and is a strict improvement that can land later without changing any
  definition file.
- **Secrets never reach the model.** Interpolation happens in the provider at request time.
  The tool-call record written to `log.jsonl` and the result artifact store the URL with
  secrets replaced by `${secrets.NAME}` — the audit trail must be safe to read, share and
  attach to a bug report.
- A tool referencing an unset secret is **disabled with a visible reason**, not failed at call
  time in the middle of a run.

### 10.4 OpenAPI import

Point at a spec URL or file → each operation becomes a candidate tool: `operationId` → id,
`summary`/`description` → description, parameters+requestBody merged into one JSON Schema,
`servers[0]` + path → URL template, HTTP method → `effects` (`GET`/`HEAD` → `read+network`;
everything else → `write+network`).

**Import is a review screen, not a button.** A 200-operation spec is 200 tools nobody wants;
the user picks. Import wholesale is available and clearly labelled as a bad idea. Failure to
parse names the operation and the reason and continues — one bad operation must not lose the
other 199.

---

## 11. Code mode

**Framing (§2.2):** the long-tail escape hatch, not the front door. Opt-in per node.

### 11.1 Why

A five-step chain over MCP tools costs five round trips, five schema-laden contexts and five
chances to mis-shape JSON. As a script it is one call, and the intermediate results never
enter the context at all. The reported gains are large enough to matter (81–98.7%), and the
underlying finding — models write code better than they select tools — is well replicated.

### 11.2 Shape

`codeMode: true` on a node. Granted tools are projected as a typed JS module:

```js
// generated per node, from the granted tools' JSON Schemas
export async function read_file({ path }): Promise<{ content: string }>;
export async function http_fetch({ url, method }): Promise<{ status: number, body: any }>;
export async function github__create_pr({ title, body, base }): Promise<{ url: string }>;
```

The model writes a script; it runs; it returns a value; that value becomes the tool result
(§13). The full script is written to `runs/<id>/tools/<n>-script.js` — **an artifact, per
principle #1.** It is reviewable after the fact and, when gated, before.

### 11.3 Isolation — child process, zero dependency

A `node:child_process.fork` of `core/tools/codeRunner.js`:

- **No ambient authority.** Empty-ish `env` (no API keys, no secrets, no `FLYT_*`), cwd set
  to an empty temp dir, no workspace path passed.
- **No direct fs or net.** The script's only channel out is `process.send` → the host. Node's
  `fs`/`net` are not *removed* (that isn't reliably possible), which is why the process gets
  nothing worth reaching: the workspace path, the API keys and the secrets are simply not in
  it. A script that requires `fs` finds an empty temp dir.
- **Every tool call round-trips to the host**, where it goes through the unchanged
  `executeTool` — validated, risk-checked, logged. **Code mode does not create a second
  execution path.** That is the single most important property here: one audit trail, one
  validator, one gate.
- **Bounded:** wall-clock timeout (default 60 s), memory cap
  (`--max-old-space-size`), call-count cap (default 50), output cap. Exceeding any of them
  kills the process and returns a truthful error.
- Rejected: `vm2` (escapes), `node:vm` (not a boundary), `isolated-vm`/QuickJS (native/WASM
  deps vs D24 and D31's packaging pipeline) — §2.5.

### 11.4 Gating — the hard part, solved

The pattern from the research (§2.5), adapted:

1. **Every tool carries `autoExecute: boolean`.** True for read-only, safe, first-party
   things. False by default for everything imported.
2. **Static determination.** Before running, compute the set of tools the script *can* reach —
   which is exactly the node's grant, because the projected module is the only channel out.
   No AST analysis needed, and none trusted: the grant is the bound.
3. **If every tool in the grant is `autoExecute`** → the script runs unattended. Logged, not
   prompted. This is the common case and it is what keeps code mode usable.
4. **Otherwise → one script-level gate.** The human sees the script, the tool list, and the
   risk tiers involved, and approves once. One legible artifact beats twelve dialogs — the
   research is explicit that over-frequent prompts are how human-in-the-loop actually fails.
5. **Runtime enforcement regardless.** Every RPC call still hits `executeTool`. A call whose
   risk exceeds the approved tier **pauses the script mid-flight** at the ordinary approval
   gate. Approving a script is not a blanket write-off.
6. **The approval binds to the script.** Hash the script text; the approval is valid for that
   hash, that run, that node, and expires with the run. The failure mode this closes —
   approve-then-substitute — is a documented one.

### 11.5 Interaction with the existing agent loop

Code mode is a **third protocol** alongside NATIVE and TEXT, selected per node, and recorded
in `node_start`'s `protocol` field, which already exists for exactly this reason (`native |
text | none` → `native | text | code | none`). The `DESIGN-SPEC.md` §4.1 note stands: the log
said *that* tools were called, never *how*, and that gap must not reopen.

Requires a tool-capable model. On a model without one it falls back to TEXT with a logged
`code_mode_unavailable`.

---

## 12. Safety and trust

Extends `DESIGN-SPEC.md` §9 and closes three of its four open items (`network policy` §10.2;
`what "skip safety" reaches` §12.5; `allowlist/denylist` §12.3 — `dry-run/diff preview`
remains open, §21).

### 12.1 `effects` — the vocabulary

| effect | meaning | gate default |
|---|---|---|
| `read` | reads state, changes nothing | never gated |
| `write` | modifies the workspace or remote state | gated when `approveToolCalls` |
| `network` | makes outbound requests | not gated; subject to §10.2 |
| `shell` | executes commands | gated by default; §12.4 |
| `destructive` | deletes / is irreversible | **always** gated, `approveToolCalls: false` cannot disable it |

`destructive` is the one that ignores configuration. Everything else in the app is
overridable at the user's risk (D16's opt-out principle); irreversibility is where that stops.

### 12.2 Trust tiers by source

| tier | who | consequence |
|---|---|---|
| `trusted` | built-ins shipped with Flyt | declared `effects` believed; `autoExecute` honored |
| `review` | user-authored (HTTP, OpenAPI import) | believed after the user saves it — they wrote it |
| `untrusted` | MCP-imported, or any auto-discovery | declared effects are a **floor, not a ceiling**; `autoExecute` forced false until promoted |

Promotion is explicit, per tool, in the Tools page, and is recorded with a timestamp.
Demotion is automatic when an imported tool's schema or description changes: a server that
silently rewrites a tool's description is the **rug-pull** attack, and re-review is the answer.

### 12.3 An untrusted tool's self-report can only gate it harder

```js
const effectiveRisk = tool.trust === 'untrusted'
  ? maxRisk(declaredRisk(tool), inferredRisk(tool))   // the stricter of the two
  : declaredRisk(tool);
```

A server claiming `readOnlyHint: true` on a tool named `delete_everything` gets no benefit
from the claim. Hints raise gating; they never lower it. Same fail-closed logic as
`safetyCheck.js`.

### 12.4 The smart screen, generalized

`safetyCheck.js` screens shell commands. Generalize it to `caution`-risk tool calls:

- **DENY** — pattern layer, per effect class. Shell keeps its existing table verbatim. HTTP
  gains one: private-space targets (§10.2), credential-looking arguments outbound.
- **ALLOW** — the cheap path that keeps this affordable. Every `read`-effect tool, every
  `trusted` tool at `safe` risk, every workspace-confined write. This is the overwhelming
  majority of calls and it costs nothing.
- **Classifier** — the same small fast model, the same 8 s budget, the same fail-closed
  `caution`. Now sees `{ tool, effects, trust, args }` rather than a command string.

The tightness of the budget is the point and is preserved: a safety check that adds ten
seconds to every call is one the user switches off.

### 12.5 What "skip safety" may reach

D16 promises an opt-out. Bounding it: skipping approvals may reach anything up to and
including `shell`. It may **never** reach `destructive`, and it may **never** apply to an
`untrusted` tool that has not been promoted. Off is off for the things you can't undo and the
things you didn't write.

### 12.6 The injection surface, named

A tool result is untrusted input that enters a model's context and influences its next tool
call. This is the central threat and the mitigations are already load-bearing above, listed
here so they're auditable as a set: **the ceiling** (§6 — injection can't reach outside it);
**grants are intersected after the clerk answers** (§7.2 — a compromised clerk output is a bad
suggestion); **untrusted tools can't self-promote** (§12.3); **`destructive` always gates**
(§12.1); **results are artifacts with bounded previews** (§13 — a megabyte of adversarial text
doesn't get inlined); **secrets never enter the context** (§10.3).

---

## 13. Results — artifacts and handles

Decided in interview; and it's what the stateless MCP spec independently recommends (the
explicit-handle pattern, §2.1).

Every tool call writes `runs/<id>/tools/<seq>-<tool>.json`:

```jsonc
{ "seq": 14, "tool": "http_fetch", "node": "gen-research", "task": "task-3",
  "args": { "url": "https://…" },          // secrets redacted to ${secrets.NAME}
  "ok": true, "ms": 412,
  "result": { /* the full, untruncated result */ } }
```

The model receives a **bounded preview** plus a handle:

```
tool_result(seq=14, tool=http_fetch, 84KB)
{ "status": 200, "body": { "items": [ …first 2000 chars… ] } }
[truncated — 84,102 bytes total. Full result: runs/…/tools/14-http_fetch.json
 Handle: @tool:14 — pass to read_tool_result(handle, jsonPath?) or use in code mode.]
```

- `read_tool_result(handle, jsonPath?)` — a built-in for pulling more, or a narrowed slice,
  without re-running the call. Idempotent, free, `read`-effect.
- **Handles compose.** In code mode the value is just in scope. In JSON mode a handle can be
  passed to another tool that accepts one. This is the pattern MCP's own spec now recommends
  over hidden session state, and its stated advantage applies here too: *the state is visible
  to the model rather than hidden away.*
- Preview shape per tool (`result.preview`): `json` (structure-preserving truncation — keep
  keys, truncate values, so the model can see the *shape* of what it got), `text` (head+tail),
  `image` (dimensions + a reference; the bytes are not inlined), `none`.
- `bash.js`'s existing 100k per-stream cap becomes a preview bound; the full output now
  survives on disk instead of being destroyed by truncation.
- Retention follows the run. `runs/` is already the inspectable record; tool results join it.

---

## 14. The v1 first-party catalog

Decided in interview: **agent essentials + ask_human + web/time essentials.** Browser preview
and computer control are designed-for but out of v1 (§20).

| tool | effects | risk | auto | notes |
|---|---|---|---|---|
| `read_file` | read | safe | ✓ | exists; gains `offset`/`limit` for large files |
| `glob` | read | safe | ✓ | **new** — pattern → paths, respects `.gitignore` |
| `grep` | read | safe | ✓ | **new** — content search, ripgrep-shaped, capped results |
| `edit_file` | write | caution | ✗ | **new** — §14.1 |
| `write_file` | write | caution | ✗ | exists |
| `create_file` | write | caution | ✗ | exists |
| `bash` | shell | caution | ✗ | exists; gated via `safetyCheck.js` |
| `get_time` | read | safe | ✓ | **new** — ISO + local + tz; §14.4 |
| `http_fetch` | network | caution | ✓ | **new** — §10.2 policy applies |
| `web_search` | network | safe | ✓ | **new** — configured provider key |
| `ask_human` | read | safe | ✗ | **new** — §14.5 |
| `search_tools` | read | safe | ✓ | **new** — §7.1 |
| `load_tool` | read | safe | ✓ | **new** — pull a schema into context |
| `read_tool_result` | read | safe | ✓ | **new** — §13 |
| `create_task` | write | caution | ✗ | exists |
| `write_task_md` | write | safe | ✓ | exists; run-scoped only |

### 14.1 `edit_file` — the biggest single gap

Today a node changing one line of a 2,000-line file must reproduce all 2,000. That is slow,
expensive, and the dominant source of a coding agent silently destroying unrelated code.
Contract: `{ path, oldString, newString, replaceAll? }`; `oldString` must match **exactly
once** unless `replaceAll`; zero or multiple matches is an error the model can correct from.
Returns a unified diff. Goes through `fileHost` and `noteWorkspaceWrite` like every other
write, so the concurrent-write ledger (V1 task 6) keeps working.

### 14.2 `glob` / `grep`

Not shelling out matters: `bash` is `shell`-effect and gated; searching a repo is `read` and
should never be. Making search a first-class read tool means a node that only needs to *find*
things never needs a ceiling that includes shell.

### 14.3 `http_fetch` / `web_search`

`http_fetch` is the generic HTTP tool the declarative provider generalizes; both obey §10.2.
`web_search` takes a provider key from settings and is disabled with a visible reason when
unset (§10.3's rule).

### 14.4 `get_time`

Trivially small and worth stating why it's on the list: it is your worked example, it is the
canonical demonstration that a node's grant should be *narrow* (a clock is not a network
tool), and models are systematically wrong about the current date. `{ iso, local, timezone,
unix }`.

### 14.5 `ask_human` — reuse `awaiting_input`

Decided in interview. The gate exists: `handleRefineQuestions` parks a run at
`awaiting_input`, `answerInput` closes it, answers are written to `nodes/<id>.answers.md`, and
it survives an app restart via the persisted-state path.

`ask_human({ question, context?, options? })`:
- Parks the run at `awaiting_input`, `pendingGateKind: 'tool'` (a sibling of the refiner's
  `'input'` so the UI can word the prompt correctly).
- Answer written to `runs/<id>/tools/<seq>-ask_human.json` and returned as the tool result.
  The agent continues with the answer in context.
- **Bounded**: a cap per task (proposed 3) mirroring the refiner's one-round cap, so an agent
  cannot interrogate the user indefinitely. Exhaustion returns a truthful "no more questions
  available — proceed on your stated assumptions."
- **Same gate serves the MCP elicitation path** (§8.4) and the outbound-server gate path
  (§9.3). Three features, one mechanism, one UI, one restart-recovery story.

---

## 15. The Tools page

Peer to the Nodes page. All four surfaces in v1 (decided in interview).

**15.1 Library.** Grouped by provider/source. Per tool: title, id, description, effects
chips, risk badge, trust badge, grant count ("used by 3 templates"), enabled toggle. Built-ins
read-only with a Clone action. Filters by effect, provider, trust, enabled.

**15.2 Author.** Form for `http` tools (method, URL, headers, body, response mapping) with a
schema builder for parameters and a raw-JSON escape hatch. Live lint: unknown secret refs,
inline-credential detection, private-space URLs, schema errors. OpenAPI import → the review
screen (§10.4).

**15.3 Test-run.** A form generated from the JSON Schema, a Run button, the raw result. No
flow, no run. This is what makes authoring an HTTP tool tolerable and it is the only honest
way to verify an MCP server actually works. A test run is logged as a test run (never
attributed to a flow run) and obeys every gate a real call would.

**15.4 MCP servers.** Add (stdio command or URL), connection health, latency, protocol
version negotiated, last `tools/list` + `ttlMs`; browse the catalog and curate `expose`;
promote trust with a confirmation naming what promotion means; a diff view when a re-import
changes something. Plus the toggle for Flyt's own outbound server (§9) with its port, token
and the flows exposed.

**15.5 Grants matrix.** Templates × toolsets. One screen answering "what can reach `bash`?"
and "what can this template do?" — currently a question requiring nine files opened. Toolset
editor lives here. Ceilings are editable inline; a warning when an edit would invalidate an
existing static grant (the `grant-exceeds-ceiling` lint, surfaced before save rather than at
lint time).

**15.6 In-run visibility.** Tool calls already reach `log.jsonl` and the inspector. Additions:
each call's result artifact linked from the inspector; the gate dialog shows effects, risk and
trust, not just name and args (the research is blunt that low-context dialogs get
rubber-stamped); code-mode script approval renders the script with syntax highlighting and the
reachable-tool list.

---

## 16. Observability

New `log.jsonl` events. Existing `tool_call` is unchanged in shape — additive only, so
anything reading today's logs keeps working.

| event | when | fields |
|---|---|---|
| `tool_resolved` | grant bound to a node | `node`, `tools[]`, `ceiling`, `source: static\|clerk\|runtime` |
| `tool_missing` | grant names an absent/disabled tool | `node`, `tool`, `reason` |
| `tool_grant_refused` | grant exceeded the ceiling | `node`, `tool`, `ceiling` — **also a retrospective problem** |
| `tool_search` | `search_tools` called | `node`, `query`, `layer: index\|clerk`, `results[]`, `ms` |
| `tool_granted_runtime` | runtime grant | `node`, `tool`, `why` |
| `mcp_server_state` | connect/disconnect/error | `server`, `state`, `protocolVersion`, `reason` |
| `mcp_import` | tools imported | `server`, `added[]`, `changed[]`, `removed[]` |
| `tool_trust_changed` | promotion/demotion | `tool`, `from`, `to`, `by: user\|auto`, `reason` |
| `code_mode_script` | script about to run | `node`, `scriptHash`, `reachableTools[]`, `gated: bool` |
| `secret_missing` | tool disabled for an unset secret | `tool`, `secret` |
| `tool_artifact_failed` | the result artifact could not be written (P2) | `tool`, `error` |
| `tool_ceiling_inherited` | a generated node took its owner's ceiling (P3) | `node`, `from`, `ceiling`, `declared?` |

`node_start.protocol` (set in `core/nodes/executor.js`) gains `code`. Every field above exists so a question that is currently
answered by intuition — "did the clerk earn its cost?", "what actually got granted?", "which
server changed under us?" — becomes a `jq` query over `log.jsonl`.

---

## 17. Testing

House pattern: `node --test tests/**/*.test.js`, no framework, real files in temp dirs.

- **`toolstore.test.js`** — load/normalize/validate; malformed definition disabled not
  crashing; built-in seeding idempotent; id validation.
- **`validateArgs.test.js`** — table-driven over the 2020-12 subset; composition; local `$ref`;
  **external `$ref` refused**; depth bound.
- **`grants.test.js`** — ceiling intersection; clerk output exceeding a ceiling is dropped and
  logged; orchestrator child cannot widen its parent; absent ceiling ⇒ today's semantics
  (**a regression test on the migration promise**).
- **`toolIndex.test.js`** — ranking; ceiling filtering (a tool outside the ceiling is never
  returned); `ttlMs` honored.
- **`mcp/client.test.js`** — against a **fixture server** speaking `2026-07-28` over both
  transports: required headers present, `_meta` clientInfo on every request, `InputRequiredResult`
  round trip re-issues with `requestState` echoed, `-32602` handled, `ttlMs` respected. Plus a
  `2025-11-25` fixture for `compat.js`.
- **`http-tool.test.js`** — interpolation escaping per position; private-space denial;
  DNS-rebinding pin; redirect re-check; size cap; **secret redaction in the logged record**.
- **`safety.test.js`** — untrusted tool cannot lower its own gating; `destructive` gates with
  `approveToolCalls: false`; skip-safety cannot reach `destructive` or an unpromoted untrusted
  tool.
- **`codeMode.test.js`** — child process has no secrets in env; every call reaches
  `executeTool`; caps enforced; script-hash approval binding rejects a substituted script.
- **`askHuman.test.js`** — parks at `awaiting_input`, answer returns as the tool result, cap
  enforced, restart path recovers.
- **Two end-to-end runs on mock:** a flow granting a clerk-resolved tool set, and a code-mode
  node chaining three calls. Both assert on the *files* — `runs/<id>/tools/*` — because that
  is what "file-based state is the single source of truth" means when tested.

---

## 18. Migration and compatibility

Nothing in this plan changes the behavior of an existing flow until someone opts in.

1. **Built-ins become files** — seeded on first launch, `ensureSeedTools()` mirroring
   `ensureSeedPipelines()`. Existing string grants (`tools: [write_file]`) resolve unchanged.
2. **No ceiling ⇒ ceiling = the static grant** (§6.1). Every flow on disk keeps exactly its
   present envelope.
3. **`DESTRUCTIVE_TOOLS` stays exported** as a deprecated alias over the built-ins for one
   release; `isDestructive()` is the new path.
4. **`WORK_TOOLS`** survives as the default ceiling for work nodes by task type. Same lists,
   new name for what they mean.
5. **`AGENT_TOOLS`** becomes a live snapshot; the DSL linter validates against the real
   library, so an unknown tool becomes a lint error where it previously failed silently at run
   time. This is a *behavior change in the honest direction* and is called out in the phase's
   acceptance.
6. **Doc debt to clear in P1:** `DESIGN-SPEC.md` §7 and §11 both understate what is built
   (§1.1). Correct them in the same commit that changes the code, so the ledger is right
   before the plan adds to it.

---

## 19. Phases

Each phase is independently shippable and leaves the app working. Acceptance is a thing you
can run, not a thing you can assert.

### P1 — Tools become data — **[LANDED 2026-07-26]**
`core/toolstore.js`, the provider interface, `effects`/`risk`/`trust`/`source` on every record,
`tools/*.json` seeding, `isDestructive()`, `AGENT_TOOLS` from the store, `validateArgs`
extended to the 2020-12 subset. No new capability; no user-visible change except correctness.
**Accept:** every existing test passes untouched; the six built-ins load from files; a flow
authored before P1 runs identically; `DESIGN-SPEC.md` §7/§11 corrected. — *All four met: 583
tests green (24 new in `toolstore.test.js` + `validateArgs.test.js`), `tools/*.json` seeded and
loaded through `loadLibrary()`, and `DESIGN-SPEC.md` §7/§8/§9/§11 corrected (§8 and the §9
confinement item were stale in the same direction).*

> **One field added beyond §4.1: `scope: 'run' | 'workspace'`** (default `workspace`). The
> gate had to stay bit-identical to pre-P1, and `effects: ['write']` alone would newly gate
> `create_task` and `write_task_md` — both of which only ever touch `runs/<id>/`, the same
> category as `log.jsonl`. So `isDestructive()` reads *effects ∩ {write, shell, destructive}
> **and** reach outside the run*, which derives exactly the old three-name set from the record
> and gives §12.1 a principled boundary: **the gate protects what lies outside the run.**
> Imported tools default to `workspace`, so the default is the fail-closed one.

### P2 — Results as artifacts — **[LANDED 2026-07-26]**
`runs/<id>/tools/`, previews, `read_tool_result`, handles, secret redaction in records.
**Accept:** a `bash` call producing 200 KB leaves the full output on disk and a bounded
preview in context; the inspector links the artifact. — *Both met (`tests/toolResults.test.js`,
and the inspector's tool-call section now ends each entry with `full result: tools/<n>-<tool>.json
(N bytes) · @tool:n` plus a click-to-open link over the confined `run:openArtifact` IPC).*

Notes on what the build settled:
- **`bash`'s 100k-per-stream cap became 5 MB**, a memory bound rather than a context bound —
  the preview is what protects the context now, and the full output survives on disk.
- **The `json` preview cuts long strings head-AND-tail**, not head-only. A captured stdout has
  its verdict at the bottom; keeping only the head would preserve the shape and lose the answer.
- **`read_tool_result` is granted, not auto-bound.** It joins `AGENT_TOOLS` and both `WORK_TOOLS`
  lists rather than being attached behind the grant's back — §6's invariant holds even for a
  tool that is read-effect, run-scoped, and can only reach results the same run produced.
- **One event beyond §16: `tool_artifact_failed`** (`tool`, `error`). Archiving is best-effort —
  a full disk must cost you the archive, not the call that already succeeded — and a silent
  best-effort write is exactly the thing this plan's "never silent" rule forbids.

### P3 — Grants and ceilings — **[LANDED 2026-07-26]**
`toolCeiling`, toolsets + selectors, intersection, orchestrator inheritance, the six lint
rules, `tools` relaxed to read-only on `aiStep`.
**Accept:** `grants.test.js` green including the no-ceiling regression; `npm run flow -- lint`
rejects a grant exceeding a ceiling with a useful message. — *Both met: 16 tests in
`tests/grants.test.js`, and the CLI reports* `ERROR grant-exceeds-ceiling node "research": tool
"bash" is granted but outside its toolCeiling (read-only)` *with exit 1.*

Notes on what the build settled:
- **A second selector, `uses:`.** `effects:read` is a SUBSET test ("reaches nothing beyond
  read"), which is what a *ceiling* wants — but it makes `effects:network` admit every
  read-only tool, so the seeded `web` set would have meant "everything that only reads".
  `uses:network` is the membership twin, and a *grant* usually wants that one.
- **`readonly-tools` replaces the old `invalid-override` job.** Relaxing `tools` to `aiStep`
  left `invalid-override` with nothing to catch through the schema layer (every schema-legal
  key is now overridable), so the read-only constraint became its own rule. It is in
  `RUNTIME_RULES`: a lint warning is not a safety boundary, and the runner drops a non-read
  tool from an `aiStep` regardless.
- **The aiStep half is wired, not just linted.** A granted `aiStep` runs through `runAgent`
  (`trackedRunAgent`), records `protocol` on `node_start` like an agentTask, and falls back to
  the plain model call when the grant is empty — so every existing flow takes its old path.
- **`ToolStore.catalog()` returns `{ tools, sets }`** — the shape the linter reads. It was
  `{ library, sets }` for an hour, which silently gave every ceiling rule an EMPTY library and
  passed a flow that granted `bash` under `read-only`. `tests/grants.test.js` pins the shape.
- **One event beyond §16: `tool_ceiling_inherited`** (`node`, `from`, `ceiling`) when an
  orchestrator's ceiling reaches a node it generated.

### P4 — The v1 catalog — **[LANDED 2026-07-26]**
`edit_file`, `glob`, `grep`, `get_time`, `http_fetch`, `web_search`, `ask_human`.
**Accept:** a real coding run edits a large file surgically (diff shows only the intended
hunk); `ask_human` parks, answers and resumes, including across an app restart. — *The
`edit_file` half is met at the tool level rather than through a live model: a 2,000-line file
is edited, the other 1,999 lines are asserted byte-identical, and the returned diff contains
exactly the two intended `+`/`-` lines (`tests/catalog.test.js`). The `ask_human` half is met
end to end in `tests/askHuman.test.js`, restart included.*

Notes on what the build settled:
- **The network policy (§10.2) landed here, not in P5**, because §14.3 says `http_fetch` obeys
  it and a network tool without it would be the SSRF primitive this plan keeps naming.
  `core/tools/net.js` denies private space by name and by DNS answer, **pins** the vetted
  address (`node:http`'s `lookup`, not `fetch` — global fetch would resolve a second time, and
  the gap between the two resolutions is the rebinding window), re-checks every redirect hop,
  and streams to a byte cap. P5's declarative HTTP tools reuse it.
- **`ask_human`'s restart story is the ANSWER, not the promise.** A crash takes the call stack
  with it, as it always has. Answers are files (`runs/<id>/answers/<task>.json`), so the
  rewound task recalls what it was already told instead of asking twice — which also makes the
  3-question cap survive a restart.
- **`glob`/`grep` are read-effect on purpose.** Searching a repo through `bash` would need a
  ceiling containing the shell; now a node that only needs to FIND things never does. Both
  respect `.gitignore` plus a hardcoded floor (`node_modules`, `.git`, `dist`, …).
- **`web_search` is disabled with a reason, not failed at call time.** The main process
  re-reads the library on every settings change, so adding a key makes the tool appear without
  a restart. **Stated gap:** there is no Settings *field* for the key yet — `settings:set`
  accepts `{ search: { provider, apiKey } }` and `publicSettings()` reports only whether one
  exists. The field is deferred to P8 rather than added now, because Settings is mid-redesign
  under `SETTINGS-MODELS-PLAN` and this would collide with it.

### P5 — Declarative HTTP + secrets
`provider: http`, positional escaping, network policy, `secrets.json` + env fallback,
inline-credential lint, OpenAPI import + review screen.
**Accept:** a hand-written HTTP tool runs from a flow; a private-space URL is denied; a
literal token in a definition imports disabled with the reason shown; a real OpenAPI spec
imports N reviewed tools.

### P6 — MCP client
`core/mcp/`, both transports, `2026-07-28` + `compat.js`, server config, import to library,
prefixing, effect inference, re-import diff.
**Accept:** a real public MCP server connects, its tools appear in the library as files, one is
granted to a node and called successfully in a run; the fixture-server suite is green on both
protocol versions.

### P7 — Index, search, Clerk
`core/toolIndex.js`, `search_tools`/`load_tool`, the `tool-clerk` template + contract, the
optional `tools` field in node materialization, plan-time and runtime paths, the layer-choice
logging.
**Accept:** your worked example runs — an orchestrator given "get the current date and redesign
the landing page" materializes two nodes with *different, correct, narrow* tool grants, visible
on the canvas before execution, and the clerk reports `unmet` honestly when the library lacks
something.

### P8 — The Tools page
Library, author, test-run, MCP server manager, grants matrix, in-run visibility upgrades.
**Accept:** a tool can be created, tested and granted without touching a file by hand or
restarting the app.

### P8b — Registry discovery *(optional, additive)*
Browse `registry.modelcontextprotocol.io` in the server manager; one-click add from
`server.json`. Small, and the thing most clients still don't do (§2.4).

### P9 — Code mode
`codeRunner.js`, the projected module, child-process isolation, RPC-to-`executeTool`, the
auto-execute allowlist, script-hash-bound approval, caps, `protocol: code`.
**Accept:** a node chains four MCP calls in one script; the intermediate results never appear
in context; every call is in `log.jsonl` identically to JSON mode; a substituted script is
rejected; a `caution` call mid-script still pauses.

### P10 — Flyt as an MCP server
Stateless HTTP handler, flows as tools, Tasks-extension handles, gates as
`InputRequiredResult`, loopback + bearer token.
**Accept:** Claude Code (or any `2026-07-28` client) lists Flyt's flows, calls one, polls the
task, answers an approval gate, and receives the result.

### P11 — MCP OAuth *(deferred, not excluded)*
> **Reconciliation, stated because the interview answers pulled two ways:** the MCP-dependency
> answer put OAuth after v1; the non-goals answer declined to exclude it. Both are honored —
> OAuth is **in this plan** as its own late phase, not a non-goal, and v1 ships bearer-token +
> env auth. It is last because it is the only place a dependency is likely, and isolating it
> keeps that decision from contaminating P6.

OAuth 2.1 + PKCE, Dynamic Client Registration with `application_type` (SEP-837 — the fix that
specifically unblocks desktop clients like Flyt), `iss` validation (RFC 9207 / SEP-2468),
issuer-bound credentials (SEP-2352), refresh tokens (SEP-2207). **Decide then, on evidence:**
hand-roll, or take one contained dependency behind the same adapter boundary `compat.js`
occupies. Do not pre-commit.

**Suggested cut for a first useful release: P1–P7.** That is data-backed tools, safe grants,
the real agent toolkit, HTTP tools, MCP, and the clerk — everything in your brief except the
UI and the two force multipliers.

---

## 20. Non-goals for v1

Decided in interview. Designed-for, not built.

- **Browser preview** — your redesign example wants it and the architecture accommodates it
  (`effects: [read, network]`, an Electron `BrowserWindow` since the app already ships one,
  returning a screenshot + DOM text via an `image`-preview handle). Deferred: it needs the
  result-artifact work (P2) and a window-lifecycle design of its own.
- **Computer control** (`DESIGN-SPEC.md` §7's "basic computer-control primitives") — largest
  blast radius, largest platform-support cost, and it would be the first tool where the
  workspace confinement model means nothing.
- **Flyt as a tool aggregator** — the outbound server exposes flows only (§9.1).
- **Runs/artifacts as MCP resources** — low risk, real value, but resources are unimplemented
  in the client too; do both together later or neither.
- **Tool marketplace / packs / publishing** — importing from MCP and OpenAPI is in; a
  Flyt-native sharing ecosystem is not. (P8b's registry browsing is *consumption*, not
  publishing.)
- **MCP Apps** — server-rendered UI in a sandboxed iframe. Interesting, orthogonal, and it
  would drag a whole security review into a release that already has one.
- **`provider: flow`** — reserved, not built (§9.4); blocked on D8's unresolved depth guard.
- **Cost tracking for tool calls** — `GOALS.md` keeps spend tracking a non-goal; tools don't
  get an exception.

---

## 21. Open questions

**Q-T1 — Diff preview before writes land.** The one `DESIGN-SPEC.md` §9 open item this plan
does *not* close. `edit_file` returning a diff (§14.1) is the enabler; showing it in the gate
*before* the write commits is a UX design of its own. Proposed: resolve during P8.

**Q-T2 — Does the clerk become a run stage, or stay a node?** As a node it is inspectable
(§7.2) but it is also a node someone must remember to wire. A hidden service call is
frictionless and invisible. Current answer: node, because inspectability is the product (D3).
Revisit if flows end up with a clerk node in every one of them — that would be evidence the
default is wrong.

**Q-T3 — Tool versioning.** An MCP server changing a tool's schema currently triggers
re-review (§12.2). Should the library keep the old version pinned so a run mid-flight isn't
changed underneath it? Leaning yes for runs in progress, no for the library.

**Q-T4 — `MAX_ITERATIONS = 8`.** Eight is fine for six tools. With `search_tools` +
`load_tool` consuming turns before real work starts, it may be too tight. Make it per-node and
effort-derived, or raise the constant? Measure in P7 rather than guess now.

**Q-T5 — Ceiling defaults for AI-authored flows.** When the (planned, D5) AI helper writes a
flow, what ceiling does it choose? A conservative default that gets widened by hand, or
inferred from the flow's goal? This is where the safety model meets the ease-of-use principle
and it deserves its own answer.

**Q-T6 — MCP server process lifecycle.** stdio servers are child processes. Do they run for
the app's lifetime, per run, or lazily with an idle timeout? Leaning lazy + idle timeout, but
it interacts with restart resilience (§10 of `DESIGN-SPEC.md`) and needs the interaction
thought through.

**Q-T7 — Does the ceiling belong on the *flow* as well as the node?** A flow-level ceiling
("nothing in this workflow may touch the network") is a stronger, simpler promise than
per-node ceilings, and would compose with them by intersection. Cheap to add in P3 if wanted;
listed rather than assumed because it adds a level to the precedence chain in §5.

---

## 22. Draft D34 — for `DECISIONS.md` when the last in-scope phase closes

> ### D34 — Tools are files, grants are two-tier, and discovery is cheap before it is smart
>
> **Context.** Tools were the last hardcoded subsystem: six JS modules registered at import,
> granted through flat string arrays, with a three-name `DESTRUCTIVE_TOOLS` set as the entire
> risk model. Nothing could be added without editing source, nothing could be granted
> dynamically, and the toolbox could not survive contact with an MCP server's catalog. The
> `2026-07-28` MCP revision — stateless, sessionless, handshake-free — made connecting to the
> outside world dramatically cheaper to implement than it had been.
>
> **Decision.**
> 1. **A tool is a file** (`tools/<id>.json`, app-level), carrying `effects`, `risk`, `trust`
>    and `source` alongside its schema. Built-ins are seeded files bound to modules; HTTP tools
>    are declarative; MCP tools are imported as ordinary records. Tools are app-level while
>    skills stay project-level (D15) because capability is portable and expertise is not.
> 2. **Grants are two-tier.** An authored, static `toolCeiling` is a hard limit; the runtime
>    grant is any subset of it. Nothing — clerk, agent, orchestrator or imported server — can
>    exceed the ceiling. This preserves the invariant D-spec §6.2 protects for skills: the
>    allowlist is the safety envelope. Absent a ceiling, the ceiling is the static grant, so
>    every pre-existing flow keeps its exact semantics.
> 3. **Discovery is cheap before it is smart.** A BM25 index answers first and free
>    (`search_tools`); an LLM `tool-clerk` node runs only on fuzzy or multi-capability briefs
>    and is an *advisor* whose output is intersected with the ceiling. Same tiering as
>    `safetyCheck.js`, same reason.
> 4. **Trust is by source and only ever gates harder.** Built-in `trusted`, user-authored
>    `review`, imported `untrusted`. An untrusted tool's self-declared risk raises its gating
>    and never lowers it; `destructive` gates unconditionally; skip-safety may not reach
>    `destructive` or an unpromoted untrusted tool.
> 5. **Results are artifacts with handles.** Every call writes
>    `runs/<id>/tools/<seq>-<tool>.json`; the model gets a bounded preview and a handle. This
>    is principle #1, and independently what the stateless MCP spec recommends over hidden
>    state.
> 6. **MCP is hand-rolled and zero-dep** (D24), targeting `2026-07-28` with an isolated
>    `compat.js` for `2025-11-25`. OAuth is deferred to its own late phase, where the
>    dependency question is decided on evidence rather than pre-committed.
> 7. **Code mode is opt-in per node**, isolated in a child process with no ambient authority,
>    with every call still flowing through `executeTool`. It runs unattended only when every
>    reachable tool is `autoExecute`; otherwise one script-level approval, hash-bound, with
>    runtime tier enforcement still active. Rejected: `vm2` (escapes), `node:vm` (not a
>    boundary), `isolated-vm`/QuickJS (native deps vs D24/D31).
> 8. **Flyt's outbound MCP server exposes flows only** — the half that makes Flyt worth
>    connecting to (D2: structure beats raw model power). Gates are surfaced as
>    `InputRequiredResult`, never auto-approved because the caller is a machine.
>
> **Status.** Provisional until P1–P10 land; §21 lists what is still open.

---

## Sources

- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) — stateless core, extensions, Tasks, MCP Apps, auth hardening, JSON Schema 2020-12
- [Model Context Protocol prepares to break with its stateful past](https://www.theregister.com/devops/2026/07/23/model_context_protocol_prepares_to/) — `server/discover`, on-demand capabilities
- [The MCP 2026-07-28 Rewrite: What Breaks and How to Migrate](https://www.developersdigest.tech/blog/mcp-2026-07-28-breaking-changes)
- [Tool search tool — Claude Platform Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) — `defer_loading`, regex + BM25 discovery
- [Anthropic brings MCP tool search to Claude Code](https://tessl.io/blog/anthropic-brings-mcp-tool-search-to-claude-code/) — ~85% token reduction; 49% → 74% on MCP evals
- [Code Mode: give agents an entire API in 1,000 tokens (Cloudflare)](https://blog.cloudflare.com/code-mode-mcp/) — 2,500+ endpoints → 2 tools; V8 isolates
- [Cutting MCP Token Costs by 92% at 500+ Tools](https://www.getmaxim.ai/articles/cutting-mcp-token-costs-by-92-at-500-tools/) — 98.7% on Drive→Salesforce; ~81% API-as-TypeScript
- [Code Mode for MCP: The Long-Tail Escape Hatch, Not the Front Door](https://dev.to/aws-heroes/code-mode-for-mcp-the-long-tail-escape-hatch-not-the-front-door-40ga)
- [Code Mode and the Architecture of Token-Efficient MCP Agents](https://www.getmaxim.ai/bifrost/blog/code-mode-and-the-architecture-of-token-efficient-mcp-agentscode-mode) — approval tokens, auto-execute allowlists
- [Human-in-the-Loop in MCP: Safeguarding Autonomous AI](https://bytebridge.medium.com/human-in-the-loop-in-mcp-safeguarding-autonomous-ai-with-oversight-and-policy-e8f7dbe98aee) — approval fatigue as a failure mode
- [JavaScript Sandboxing Research (Simon Willison)](https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/) — isolated-vm, vm2, QuickJS, ShadowRealm compared
- [vm2 security advisories](https://advisories.gitlab.com/pkg/npm/vm2/) — documented sandbox escapes
- [Secure Exec — Secure Node.js execution without a sandbox](https://secureexec.dev/) — V8 isolates, deny-by-default permissions
- [UTCP vs MCP — Protocol Comparison](https://www.universaltoolcallingprotocol.net/utcp-vs-mcp) — manual-not-middleman; the wrapper tax
- [MCP vs UTCP (Nordic APIs)](https://nordicapis.com/model-context-protocol-mcp-vs-universal-tool-calling-protocol-utcp/)
- [The MCP Registry — about](https://modelcontextprotocol.io/registry/about) and [Getting Started With the Official MCP Registry API](https://nordicapis.com/getting-started-with-the-official-mcp-registry-api/) — `server.json`, `/v0/servers`, API freeze
- [MCP Registries in 2026](https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server) — ~2,000 servers; most clients don't integrate the API
