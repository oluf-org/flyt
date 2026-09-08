# Transparency telemetry

Flyt stores transparency data in two layers:

1. Date-partitioned `<application user data>/telemetry/events/YYYY-MM-DD.jsonl` is the immutable raw record.
2. `<application user data>/telemetry/telemetry.sqlite` is a rebuildable analytical index when the host runtime provides `node:sqlite`. It uses WAL journaling, `synchronous=NORMAL`, prepared inserts, bounded batches, and indexed time/kind/run columns. Older Node runtimes project directly from JSONL.

This combination is preferable to a local TSDB for the current workload. Flyt has one writer, moderate event volume, high-cardinality trace identifiers, relational drill-downs, and a strong requirement for portable raw exports. A TSDB adds a service, retention policy, and cardinality management without improving those queries. SQLite makes time-window aggregation and trace lookup cheap while JSONL preserves an inspectable source that cannot be coupled to a particular database schema.

## Data contract

All normalized events use schema version 1 and the common envelope in `core/telemetry.js`. Values are explicitly sourced as `provider_reported`, `harness_observed`, `derived`, or `estimated`. Derived dashboards include their projection version. Estimates never occupy provider-reported fields.

Model requests/results, stream milestones, planner diagnostics, tool calls and approvals, workspace effects, verification gates, human waits, and scheduler events enter through the existing immutable append boundaries. Canonical kernel session events and compatibility-run audit events use the same envelope. Collection begins with this telemetry schema; existing run logs remain available in their original trace surfaces and are not eagerly copied into the global store, avoiding a large first-launch I/O spike.

The execution host binds telemetry to the owning project, including when a different project tab is active. Projection version 2 understands both canonical camel-case usage and provider API usage fields, correlates model responses with requests, and recovers missing measurements from older normalized records. A rebuilt or out-of-date SQLite index replays the missing raw file bytes before serving queries. An index failure falls back to JSONL.

Loop lifecycle changes also write `loop.snapshot` metadata. Historical loop statistics select the latest snapshot per project and goal; they do not add another copy of child-run model usage to global totals. Open projects backfill their existing loop summaries from saved goal state and canonical child-session usage. These snapshots keep completed loops in global statistics after their project tab closes. Chat history remains project-scoped and reads saved runs and goals directly.

The global store is stricter than a run log: model bodies are represented by counts, tool arguments by sorted keys/byte counts/SHA-256 hashes, and secret-shaped fields are redacted recursively. Complete tool results remain in their run artifact and History links to that artifact.

## Request-level fields

Each request can be reconstructed from correlated `llm.request`, `context.budget`, `llm.telemetry`, stream milestone, `llm.response`, `tool.state`, and optional `context.checkpoint` events. Together they record:

- queue, dispatch, headers, first byte, first reasoning, first visible text, first tool call, and completion timestamps;
- input, output, reasoning, cached-read, and cache-write tokens;
- requested and effective output budgets plus pre-dispatch context utilization;
- finish reason and provider/model route;
- tool-call repair and validation counts;
- compaction input/output tokens, selected policy actions, and compression ratio;
- retry/failover reason and delay;
- tokens and cost accumulated since the last durable workspace progress.

Unavailable provider values remain `null`; the harness does not turn missing measurements into zeroes. Estimated values retain `source: estimated`.

## Performance properties

- Execution code only enqueues small metadata objects.
- A 120 ms/250-event bounded batch performs one append per active day, then one SQLite transaction.
- The raw append completes before the index transaction.
- SQLite runs in WAL mode so History reads do not block ingestion.
- Instrumentation and index failures are isolated from model and tool execution.
- Stream instrumentation observes the existing callback; it never enables streaming for a call that did not request it.

## Evolution boundary

Execution depends only on the small `record`/query behavior exposed by `TelemetryStore`; it does not depend on SQL. The common envelope, schema version, raw partitions, and pure projection functions are the migration boundary for a different local engine or future remote implementation. No network sink, account identity, upload queue, or cloud API exists in this version.
