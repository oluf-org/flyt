# Fable-at-home reliability evaluation

Date: 2026-09-01

## Executive assessment

The UI experiments did not show that GLM 5.3 Flash reasons too much. They showed that the harness previously had weak recovery at two structured boundaries:

1. A planner candidate could fail deterministic dependency-graph validation, but its only recovery was one loosely specified re-plan.
2. A worker could emit visible text that looked like a tool call without producing a native call. The loop then accepted that text as a finished answer even though no tool ran.

Reducing the response budget and adding more forceful action-first prompting did not make those boundaries reliable. The final workflow therefore removes the experimental 4,096-token and eight-step settings. The standard runtime gives workers a 32,768-token per-request ceiling, automatically continues length-truncated responses, and treats 120 tool rounds as a warning threshold rather than a workflow stop.

## UI experiment findings

Six Fable-at-home runs were exercised through the desktop UI with the Standard profile mapped to GLM 5.3 Flash. The important failure shapes were:

- The planner declared artifacts in `requires` without assigning the same names to any task's `produces`. Static validation found the exact broken edges, but the old repair prompt omitted the rejected JSON and allowed only one correction.
- A direct worker initially made valid `bash` and `glob` calls, but selected a Unix `ls -la` command in a Windows workspace.
- A later worker response rendered `create_file()` as visible text instead of sending a native structured call. No file operation occurred and no tool result could return to the model.
- Smaller token budgets and stricter “act first” instructions did not correct the tool protocol. They reduced the evidence available to diagnose the turn.
- Reasoning tokens were already reported by the provider in some calls. The missing part is consistent system-wide timing, aggregation, and correlation with the first useful action.

## Changes implemented

### Dependency-graph repair

- Invalid plans may receive up to three repair turns instead of one.
- Every repair turn receives the complete rejected candidate, numbered static diagnostics, the original brief, and minimal-edit rules.
- Each failed validation is recorded as an `invalid_task_graph` warning with the attempt number and full diagnostic array before another model call is made.
- The accepted plan is still validated before any generated task is announced or executed. Nothing bypasses the static safety checks.

The bounded count prevents an invalid-plan loop. It is a repair-attempt bound, not a reasoning-token restriction.

### Direct-worker tool-call recovery

- The provider adapter now carries recognized unparsed tool-call dialects across the kernel seam as explicit evidence.
- The agent loop narrowly recognizes a whole response such as `→ create_file()` only when the named tool was actually offered.
- It never executes narrated text and never invents missing arguments. It records a `tool_call_repair` warning and asks the model to issue a native call with complete structured arguments.
- Empty worker turns, including reasoning-only turns with no visible answer or native call, are recorded and receive an `empty_turn_repair` continuation.
- Repeated unusable turns are bounded and fail with a specific diagnosis instead of looking complete.

This follows the important harness principle demonstrated by OpenCode: tool activity is a state machine with durable pending/running/completed/error states, errors return through the model-visible interaction, and repeated identical activity is detected rather than silently spun. OpenCode's current processor records tool-input fragments before execution and has a three-call doom-loop guard ([processor source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts)). Its retry layer separately classifies transient provider failures and exposes retry state ([retry source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts)).

The Vercel AI SDK's repair design supports the same separation: malformed calls are preserved as calls, validation failures are provided to a repair turn, and the repaired result must still be a structured tool call ([official repair example](https://github.com/vercel/ai/blob/main/examples/ai-functions/src/generate-text/mock/tool-call-repair-reask.ts)).

### Workflow configuration

Fable at home is again a prompt-refiner plus validated task-graph workflow. Both authored model roles use the Standard profile. The temporary 4,096-token, eight-step, low-effort direct-worker configuration has been removed. The final instructions describe scope, native tool use, and verification without constraining how many reasoning tokens the model should use.

## Recommended next reliability work

1. Validate every native tool call against its JSON Schema at the kernel boundary before approval or execution. Return all schema errors as one tool result so the model can correct them in one turn. Preserve malformed raw arguments in the trace.
2. Persist streaming tool-input start/delta/end events. This distinguishes “model is still constructing arguments” from a stalled provider and permits crash-safe reconstruction.
3. Add a repeated-call guard keyed by normalized tool name and arguments. After three identical failed calls, surface a loop decision or request human review rather than allowing unbounded repetition.
4. Add stream-idle telemetry and a bounded provider recovery policy. A busy spinner without a recent chunk should become an explicit `stream_idle` state, not merely elapsed wall time.
5. Maintain model capability profiles from observed runs: native tool-call success, malformed-argument rate, preferred protocol, reasoning-field support, and finish-reason quality. Use these as routing evidence, not as hidden model rankings.
6. Add deterministic graph repair only for transformations with unambiguous semantics. Examples include inferred producer dependency edges and declared write-collision serialization, which are already safe. Do not guess which task should produce a missing semantic artifact.

## Proposed transparency metrics specification

### Design principles

- Store immutable raw events first; calculate dashboards and labels as projections.
- Separate observed values, provider-reported values, and estimates. Never write an estimate into a provider metric field.
- Correlate every model request, attempt, tool call, workspace effect, and gate with trace/span identifiers.
- Use monotonic elapsed time for durations and wall-clock UTC for cross-process correlation.
- Keep reasoning separate from visible content. “Reasoning share” is a measurement, not a failure label.
- Version event schemas and record the projection version that produced each derived metric.
- Redact secrets at ingestion while retaining safe structural information such as argument keys, byte counts, and hashes.

### Common event envelope

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "traceId": "run_...",
  "spanId": "span_...",
  "parentSpanId": "span_...",
  "runId": "...",
  "blockId": "...",
  "taskId": "...",
  "step": 2,
  "at": "2026-09-01T10:00:00.000Z",
  "monotonicMs": 12345.6,
  "kind": "llm.usage",
  "source": "provider_reported",
  "attributes": {},
  "measurements": {}
}
```

`source` should be one of `provider_reported`, `harness_observed`, `derived`, or `estimated`.

### Required raw events and measurements

| Area | Required observations |
| --- | --- |
| Model request | requested/effective provider and model, fallback rung, prompt messages/chars/tokens, cached tokens, tool schemas offered, configured output ceiling, temperature/effort, queue time |
| Model stream | request start, first byte, first reasoning delta, first visible-content delta, first tool-input delta, last chunk, idle gaps, stream end |
| Model result | finish reason, prompt/completion/reasoning/cached tokens, cost, visible and reasoning characters, parsed calls, unparsed dialect, error class |
| Planner | task count, graph depth/width, validation codes, candidate hash, repair attempt, repair outcome, final accepted-plan hash |
| Tool call | input start/end, tool name, schema-valid flag, validation diagnostics, approval decision/wait, execution start/end, result status/size/handle |
| Workspace | first observed change, files/bytes added/modified/deleted, diff size, changed-scope match, snapshot/patch hash |
| Verification | gate name, command hash, start/end, exit status, test counts, retry count, whether the final claim is supported by a recorded gate |
| Human interaction | question/approval type, requested time, response time, wait duration, stop while waiting, resumed/cancelled outcome |
| Scheduler | ready time, queue time, task start/end, parallel wave, cancellation, retry, restart and parent/child relation |

### Primary derived metrics

- `time_to_first_reasoning_ms`, `time_to_first_visible_token_ms`, `time_to_first_native_tool_call_ms`, and `time_to_first_workspace_effect_ms`.
- `tokens_before_first_visible_content`, `tokens_before_first_native_tool_call`, and `tokens_before_first_workspace_effect` where the provider exposes incremental usage; otherwise mark the estimate explicitly.
- `reasoning_token_share = reasoning_tokens / completion_tokens`, always segmented by model, task class, and outcome.
- `first_pass_plan_valid_rate`, `graph_repair_success_rate`, diagnostics per rejected plan, and repairs per accepted plan.
- `native_tool_call_rate`, `tool_schema_valid_rate`, `tool_repair_success_rate`, unparsed-dialect rate, and calls per successful workspace effect.
- `repeated_tool_call_rate`, failed-call recovery rate, approval wait share, and stream-idle incidence.
- `verification_closure_rate`: completed workspace-change runs with at least one relevant recorded successful gate.
- `useful_change_latency`, `total_run_latency`, token/cost per accepted plan, token/cost per successful tool effect, and token/cost per verified completion.
- `no_visible_output_rate`: calls with reasoning or billed output but no visible content or native call. This is a protocol/outcome fact and should not be named “over-reasoning.”

### Trace UI

The default technical trace should show a single expandable timeline:

`planner candidate -> static diagnostics -> repair -> accepted graph -> worker call -> tool validation -> approval -> execution -> workspace patch -> verification`

Each span should expose raw request/result metadata, timestamps, token breakdown, route/fallback reason, and links to complete stored tool results. A comparison view should group runs by workflow version, model, preset, and task class, and export both raw JSONL and a flat CSV projection.

### Evaluation policy

Do not define a global “too much reasoning” threshold. First collect distributions for successful and failed runs. A useful investigation flag is high reasoning share combined with no visible content, no native call, or no workspace effect; high reasoning followed by a correct, verified result is not the same condition.
