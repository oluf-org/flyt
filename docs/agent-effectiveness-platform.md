# Agent effectiveness and platform contracts

This slice extends the v2 kernel without changing Flyt's outer invariants. Plugin classification and a block's static `toolCeiling` remain the maximum possible reach. The append-only `session.jsonl` remains authoritative. Task graphs remain validated deterministic parent programs. No global output-token clamp is introduced.

## Permission order

Tool authorization is evaluated in this order:

1. The tool must exist and carry Flyt's confirmed classification.
2. The block's static ceiling must name it.
3. Protected-secret patterns and unoverrideable resource denies are applied.
4. Explicit action/resource/effect rules are evaluated in authored order.
5. External resources require an allow rule marked `externalDirectory`; an ordinary allow or saved approval is insufficient.
6. An unexpired saved approval may allow an exact action/resource/effect match only for its project.
7. The attended approval mode resolves remaining `ask` decisions.

The policy types and pure evaluator live in `kernel/src/security/permissions.ts`. An approval can never widen classification or the static ceiling.

## Worker profiles and child sessions

Reusable worker profiles contain purpose, description, system prompt, model and fallbacks, reasoning variant, tool ceiling, resource rules, context strategy, and warning thresholds. Generated tasks name `workerProfile`; the scheduler intersects its ceiling with the parent ceiling.

Each task receives a deterministic child-session identity with parent run/block, task, profile, context boundary, lifecycle, and event-count metrics. Its transcript is a separate canonical JSONL session. The parent log records `child.session` links and continues to own graph ordering and outcomes.

## Tool scheduling and progress

A single model response may execute confirmed local read-only calls concurrently, bounded by `toolConcurrency`. Untrusted reads, writes, shell calls, and all other calls are serialization barriers. Calls and results are appended in original model order regardless of completion order.

Identical normalized calls are recorded as `tool.repetition` evidence with count, repeated failures, tokens since durable progress, and whether durable state changed. The worker is first asked to explain its changed hypothesis. A clear no-progress loop requires the explicit `approveRepeatedLoop` capability; an unattended loop cannot authorize itself.

## Transactional mutations

`applyMutationBatch` requires `sha256:` pre-edit hashes (or `absent` for creates), validates the entire batch before writing, produces structured per-file diffs, runs the supplied compiler/language-service diagnostic adapter, and returns a one-use revert capability. Revert refuses to overwrite a file changed after the batch.

## Platform contracts

- `api/contract.ts` compiles one request/response/error/event schema map for HTTP, IPC, and CLI transports and generates operation-specific TypeScript request, response, and error types plus a client.
- `session/index.ts` provides a WAL-backed, rebuildable SQLite index for runs, calls, tools, tokens, reasoning, tasks, permissions, retries, repairs, and artifact handles. It never becomes a write authority and is optional on hosts without `node:sqlite`.
- `plugins/interceptions.ts` defines ordered hooks for context assembly, model budgets and requests, retries, tool definitions and calls, and compaction. Observers cannot mutate. Mutating hooks require a trusted owner and every application records before/after hashes as `plugin.interception` events.
- `config/layers.ts` fixes precedence as global, project, workflow, mode, block, then run. Resolution returns leaf-level provenance and every overridden source.
