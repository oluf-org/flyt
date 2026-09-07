# Storage decision — local mobile journal

Scope: JSON files vs embedded SQLite for a local mobile journal — ~50,000 entries, transactional imports, no backend or cloud, one developer. Criteria: correctness and low maintenance.

## Requirements check
- Transactional imports: SQLite has native transactions; JSON has none and needs hand-built replacement logic.
- 50,000 entries: SQLite uses indexes and targeted writes; JSON parses and rewrites a whole store or scans many files.
- No backend / no cloud: both are local and embedded — no differentiator.
- One developer: SQLite concentrates correctness in the engine; JSON pushes it into custom code that must stay correct indefinitely.

## Transactional correctness
- SQLite: each import runs in a single transaction. Commit is atomic and durable; a failed or interrupted import rolls back fully, and crash recovery restores the last committed state. No partially applied data.
- JSON: no transaction mechanism. All-or-nothing imports require hand-built temp-file + atomic rename; rename atomicity varies by mobile platform, and crash-mid-replace recovery becomes custom code. Simpler approaches leave partial data; per-entry files leave half-applied imports scattered.

## 50,000-entry performance
- SQLite: indexed lookups, date-range queries, and search stay fast; appends and edits are small targeted writes.
- JSON: a single-file store is parsed into memory each session and rewritten on every change, scaling with total size; a multi-file store forces manual scans and self-built indexes.

## Maintenance
- SQLite: mature embedded library, no server, declarative schema; atomicity, durability, and indexes built in.
- JSON: locking, atomic-write, recovery, and indexing logic must be written and maintained indefinitely — a recurring correctness burden for a solo developer.

## Recommendation
Choose SQLite. It is the only candidate that satisfies transactional imports out of the box, and at 50,000 entries it avoids whole-store rewrites and unindexed scans. JSON is rejected: no transactions, unsafe partial writes at import time, and permanent custom-code upkeep.

## Accepted tradeoffs (SQLite)
- Single-writer assumption: keep one process or connection writing.
- File growth after deletions; occasional compaction.
- Schema changes need careful versioning on app updates.
- Database file damage or deletion: mitigate with periodic export.
- Assumption: human readability of raw files is not a stated requirement; if it ever matters, the export path covers it.

## Migration / rollback outline
Assumption: an existing JSON store is being converted; for a fresh install only schema creation applies.
1. Create the SQLite schema alongside existing JSON data; leave JSON untouched as source of truth.
2. Import all entries in one transaction; on any validation failure, roll back and keep JSON authoritative.
3. Verify entry counts, spot checks, and date-range queries against the JSON source.
4. Switch reads and writes to SQLite only after verification passes; retain the JSON files.

Rollback: before cutover, delete the SQLite file and continue on JSON. After cutover, the retained JSON files plus subsequent periodic exports are the rollback and recovery artifact.

## Evidence & verification status
- Facts used: only the stated requirements (50,000 entries, transactional imports, no backend, no cloud, one developer) plus general, non-project-specific characteristics of embedded SQLite and JSON-file storage. No source code was executed and no benchmarks were run.
- Performance and platform-behavior claims (e.g., rename atomicity on mobile platforms, query speed at 50,000 entries) are asserted, not measured here. Validate the import path with a crash/retry test on the target platform before cutover (migration steps 2–3).
- Two assumptions are flagged above and are unverified: an existing JSON store is being converted (a fresh install reduces migration to schema creation), and raw-file human readability is not required. If either is wrong, revisit the migration outline or tradeoff list.
