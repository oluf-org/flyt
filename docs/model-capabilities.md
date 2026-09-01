# Model capabilities and request contracts

Flyt treats model capabilities as attributed runtime data, not model-name heuristics. The canonical types and built-in registry are in `kernel/src/models/capabilities.ts`. Each capability leaf has:

- `value`, including `null` for explicitly unknown values;
- `confidence`: `verified`, `reported`, `inferred`, or `unknown`;
- `source`: a provider document, persisted catalog, local probe, or named conservative default;
- optional `observedAt` for time-sensitive catalog and probe facts.

The registry covers context/input/output limits; text, image, PDF, audio, and video input; native, parallel, and built-in tools; JSON Schema and synthetic-tool structured output; reasoning variants, request fields, and replay protection; input/cached/output pricing; cache behavior; provider provenance; and provider overhead.

Built-in first-party facts are intentionally small and sourced. Any configured model not in that table still receives a complete profile whose facts are explicit unknowns. At host composition, persisted provider catalog facts overlay context, tool, and price fields without erasing their attribution.

## Request resolution

Before each provider attempt, including every fallback rung, the LLM seam writes a `context.budget` record. Every controlled value records:

```text
field + requested + modelLimit + providerLimit + effective + reason
```

The context equation is:

```text
system instructions
+ messages
+ tool schemas
+ attachments
+ reserved output
+ provider-specific overhead
```

The manager never edits the session log. Its effective, per-attempt message view may apply these recorded policies in order:

1. prune superseded tool previews while retaining artifact handles;
2. retain recent complete turns;
3. include explicitly selected artifacts by handle;
4. add a durable compaction checkpoint.

If fixed input still cannot fit, dispatch fails with `context_budget_exhausted`. A provider error is not used as a sizing oracle.

## Structured task graphs

Task-graph planning requests `TASK_GRAPH_SCHEMA` and negotiates:

```text
provider JSON Schema response
→ forced submit_task_graph tool
→ textual JSON fallback
```

The synthetic submission call is consumed as the response payload; it is never persisted as a pending executable tool call. Static validation diagnostics are returned as a structured `task_graph_validation_result` value alongside the exact rejected candidate.

After bounded repairs, the graph degrader preserves valid tasks, removes only invalid or ambiguous edges and artifact claims, breaks deterministic cycle-closing edges, and topologically reorders when necessary. A simple request may become a single worker. Repeated reasoning-only token exhaustion and materially ambiguous complex requests fail closed. Every applied transformation is stored in `plan.transformations` and the `task_graph_degraded` warning.

## Reasoning replay

`Message.replay` stores opaque provider-native items with provider, required flag, and protection (`signed`, `encrypted`, or provider-dependent). OpenAI/OpenRouter and Anthropic transforms replay items only to the provider that issued them. The harness never rewrites signatures, encrypted content, tool-call ids, or reasoning items into visible text.

## Provider transforms and compatibility matrix

Provider wire differences live under `core/adapters/transforms/` behind the existing LLM seam:

- `openai.js`
- `openrouter.js`
- `anthropic.js`
- `kimi.js`
- shared canonical tool-call and compatibility outcomes

`tests/fixtures/provider-compatibility.json` and `tests/providerCompatibility.test.js` cover native calls; empty, omitted, double-stringified, partial, unknown, and case-mismatched arguments and names; multiple calls; reasoning-only exhaustion; interrupted streams; tool-result replay; signed and encrypted reasoning replay; and structured-output failures.

## Tool-call lifecycle

Each call has one append-only state sequence:

```text
received → normalized → validated → authorized
         → running → completed | failed | interrupted
```

Only the normalized name and argument object are persisted as callable data. Validation and authorization failures settle the original id. At the beginning of a resumed loop, every nonterminal state, including legacy `llm.response` and `tool.call` records, is reconciled to an explicit `interrupted` state before another model request runs.
