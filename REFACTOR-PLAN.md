# Refactor Plan — Flow DSL (`*.flow.yaml`)

**Status:** Proposed (2026-07-14)
**Goal:** Workflows are defined in a text-based, AI-authorable DSL. The canvas stays as the visualization/editor, but the script is the source of truth for *structure* (nodes + relations). Visual placement lives outside the script. A static linter lets an AI verify a workflow is correct before it ever runs.

---

## 1. Research summary & language choice

Options evaluated:

| Option | Verdict |
|---|---|
| **Custom declarative YAML DSL** (style of [Dify DSL](https://docs.dify.ai/en/use-dify/getting-started/key-concepts) / [GitHub Agentic Workflows](https://github.github.com/gh-aw/reference/frontmatter/)) | ✅ **Chosen.** LLMs generate YAML very reliably; JSON Schema provides ~60% of the linter for free (ajv); trivial round-trip with React Flow; no parser to build. Dify proves this exact pattern (YAML DSL ↔ ReactFlow graph) works, and even has community linters ([difyctl](https://github.com/JSLEEKR/difyctl)). GitHub's `gh aw compile` proves the "compile + lint before run" contract works for AI-authored workflows. |
| CNCF [Serverless Workflow](https://serverlessworkflow.io/) | ❌ State-machine semantics (states/actions/transitions) fit poorly with our node-template DAG; heavy adaptation for little gain. |
| Mermaid / DOT | ❌ Great for relations, no room for node config (overrides, approval, worker). Kept as an *export* format for docs. |
| CUE / Pkl / KCL | ❌ Strong validation but LLMs are far less trained on them; heavy toolchain dependency. |
| Code-like custom grammar | ❌ Must build parser/AST/linter from scratch; LLMs make more syntax errors in novel grammars. |

Key design decisions borrowed:
- **Dify:** stable string node IDs, graph as nodes+edges in YAML, versioned DSL (`version:` field).
- **gh-aw:** lint/compile step as a hard gate; machine-checkable schema, human/AI-readable body.
- **Everything:** positions are presentation, not semantics.

---

## 2. The DSL

File: `flows/<id>.flow.yaml`. Node IDs are the YAML keys (guaranteed unique by YAML itself). Edges are compact `->` strings — the cheapest possible syntax for an LLM to emit correctly.

```yaml
version: 1
id: default-pipeline
name: Default pipeline
description: Plan → route (approval) → verify.

nodes:
  plan:
    use: plan-start          # templateId from the Node Library
    title: Planning          # any template override, flattened
  route:
    use: plan-eval
    title: Routing
    requiresApproval: true
  verify:
    use: final-eval
    title: Verification

flow:
  - input -> plan            # `input` / `output` are implicit built-in nodes
  - plan.tasks -> route      # `.port` = sourceHandle (named output port)
  - route -> verify
  - verify -> output
```

Grammar of a `flow` entry: `source[.port] -> target [-> target2 ...]` (chains allowed). Everything else is plain YAML — no custom parsing beyond splitting the arrow expressions.

**What is NOT in the script:** `position`, canvas zoom, colors, edge geometry. **What IS:** nodes, template refs, overrides, relations, ports, approval gates, worker overrides.

### Layout separation
- Positions move to a sidecar file `flows/<id>.layout.json` (`{ nodeId: {x, y} }`), written only by the canvas.
- Nodes without a stored position get placed by the existing `layoutPositions()` auto-layout (`src/flowLayout.js`) — so an AI-authored flow renders sensibly with zero layout info.
- Stale layout entries (deleted nodes) are ignored and pruned on save.

---

## 3. Architecture

```
*.flow.yaml  ──parse──▶  canonical flow object  ──▶  flowRunner (unchanged semantics)
     ▲                        │        │
     │                        ▼        ▼
  serialize ◀── canvas edits  linter   FlowCanvas (+ layout.json / auto-layout)
```

New module: `core/flowlang/`
- `parse.js` — YAML → canonical object (the same shape `flowRunner` consumes today, minus positions). Deterministic, no side effects.
- `serialize.js` — canonical object → YAML. **Round-trip stable**: parse(serialize(x)) ≡ x, key order fixed, so diffs stay clean and AI edits don't churn the file.
- `schema.json` — JSON Schema (draft 2020-12) for the DSL, validated with `ajv`.
- `lint.js` — semantic rules on top of schema (below).
- `cli.js` — `npm run flow -- lint <file>` for AI/CI use.

`core/flowstore.js` becomes format-aware: reads both `.json` (legacy) and `.flow.yaml`; writes `.flow.yaml` + `.layout.json`. The canonical in-memory object stays what it is today, so `flowRunner.js` (1227 lines) needs near-zero changes.

Dependency added: `yaml`, `ajv` (both tiny, no native deps).

---

## 4. Static linter

Two layers, one command. Output is both human text and `--json` (machine-readable: `{ok, errors: [{rule, severity, nodeId?, edge?, message}]}`) so an AI can act on it programmatically. Non-zero exit code on error.

**Layer 1 — schema (ajv):** structure, required fields, types, override keys allowed per `baseType`, version field.

**Layer 2 — semantic rules:**

| Rule | Severity |
|---|---|
| `unknown-template` — `use:` doesn't exist in `nodes/` library | error |
| `unknown-node` — edge references undeclared node id | error |
| `unknown-port` — `.port` not in template's declared outputs (`ROLE_PORTS`/`outputs`) | error |
| `cycle` — graph has a cycle (reuse `wouldCreateCycle`) | error |
| `unreachable` — node not reachable from `input` | error |
| `dead-end` — node whose output reaches no `output` node | warning |
| `no-input` / `no-output` — missing entry/exit | error |
| `duplicate-edge` | warning |
| `invalid-override` — override key not valid for the template's baseType (e.g. `tools` on non-agentTask) | error |
| `unknown-tool` — tool not in `AGENT_TOOLS` registry | error |
| `orphan-approval` — `requiresApproval` on input/output nodes | warning |

Surfaces: CLI (for AI + CI), on-save validation in the app (badge on the canvas), and pre-run gate in `flowRunner` (refuse to run an invalid flow).

---

## 5. Canvas integration (two-way sync)

- **Script → canvas:** parse, merge layout.json, auto-layout the rest, render. A (later) side-by-side text editor pane re-parses on edit; lint errors shown inline.
- **Canvas → script:** node/edge add/delete/override edits call `serialize()` and rewrite the YAML; drag only rewrites `layout.json`. Because serialization is deterministic, canvas edits produce minimal diffs.
- The canvas becomes a *view/editor of the script*, never a second source of truth.

---

## 6. AI orchestration contract

What an AI needs to author a flow:
1. `npm run flow -- templates --json` → lists Node Library templates with their ports and allowed overrides (generated from `nodes/*.json` + `flowTypes.js`).
2. Write `flows/<id>.flow.yaml`.
3. `npm run flow -- lint flows/<id>.flow.yaml --json` → fix until `ok: true`.
4. Flow appears in the app dropdown automatically; human runs/approves it.

A short `FLOW_LANG.md` spec (grammar, rules, 3 examples incl. one invalid + linter output) becomes the AI-facing doc, referenced from GOALS.md.

---

## 7. Migration steps

| Phase | Work | Est. |
|---|---|---|
| **1. Core lib** | `core/flowlang/` parse/serialize/schema + unit tests (round-trip, fixtures from existing 4 flows) | 1–2 d |
| **2. Linter** | semantic rules + CLI + `--json`; tests per rule (valid/invalid fixture pairs) | 1–2 d |
| **3. Store** | `flowstore` dual-format read, YAML write, `layout.json` split; auto-migrate command `flow -- migrate` converts existing `flows/*.json` | 1 d |
| **4. Canvas sync** | serialize-on-edit, layout sidecar writes, lint badge, pre-run gate | 1–2 d |
| **5. AI contract** | `templates --json`, `FLOW_LANG.md`, wire lint into any flow-generating AI step | 0.5 d |
| **6. Cleanup** | drop legacy `.json` write path once all shipped flows are migrated; text editor pane (optional, later) | 0.5 d |

Compatibility: legacy `.json` flows keep loading throughout; nothing breaks mid-refactor. Principle #1 (file-based state) is preserved — the DSL file is just a better file.

## 8. Risks

- **Round-trip churn** — mitigated by deterministic serializer + fixture tests asserting byte-stable output.
- **`->` strings inside YAML** are technically a mini-grammar; keep it to `id[.port]` tokens only, validated by one regex, so it can't grow into a parser project.
- **Schema drift vs. Node Library** — templates change; linter loads templates at lint time rather than baking them into the schema.

## Sources

- [Dify DSL key concepts](https://docs.dify.ai/en/use-dify/getting-started/key-concepts), [difyctl linter](https://github.com/JSLEEKR/difyctl), [Dify workflow DSL skill](https://github.com/yzmw123/dify-workflow-dsl-skill/blob/main/SKILL.md)
- [GitHub Agentic Workflows overview](https://github.github.com/gh-aw/introduction/overview/), [frontmatter reference](https://github.github.com/gh-aw/reference/frontmatter/), [GitHub blog](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/)
- [Serverless Workflow spec](https://serverlessworkflow.io/), [spec repo](https://github.com/serverlessworkflow/specification/)
- [Pkl comparison docs](https://pkl-lang.org/main/current/introduction/comparison.html), [KCL intro](https://www.kcl-lang.io/docs/user_docs/getting-started/intro)
- [Mermaid](https://github.com/mermaid-js/mermaid)
