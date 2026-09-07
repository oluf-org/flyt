# Migration backlog: settings v1 → v2

Sole source of facts: `migration.md` line 2 (v1 theme light/dark + fontSize integer pixels; v2 appearance.theme same values + accessibility.fontScale decimal; fontScale = fontSize / 16; unknown fields → legacyExtras; backup before conversion; atomic replacement; v1 untouched on failure; tests for 16→1.0, 24→1.5, corrupt JSON, unknown fields, interrupted writes).

All paths below are **proposed paths — they do not exist in the workspace today** (workspace currently holds only `migration.md`). No application code is modified by any task; blast radius is scripts/tests only. Assumptions are labeled, not sourced facts.

---

## Task 1 — Standalone settings v1→v2 conversion utility

**Goal.** Per migration.md line 2: convert the local settings file from v1 (theme: light/dark; fontSize: integer pixels) to v2 — `appearance.theme` keeps the same value; `accessibility.fontScale = fontSize / 16` as a decimal (16 → 1.0; 24 → 1.5); every unrecognized field is moved verbatim into `legacyExtras`. No application-code changes.

- **Proposed path:** `scripts/migrate-settings-v2.mjs` *(proposed, not existing)*
- **Blast radius:** scripts/migrate-settings-v2.mjs only.
- **Value/Effort:** 5 / 3.

**Compatibility.** Reads only the v1 shape described in migration.md; emits only the v2 keys it specifies (`appearance.theme`, `accessibility.fontScale`, `legacyExtras`); theme value passes through unchanged; unrecognized fields preserved exactly, not dropped or coerced.

**Testing.** Standalone run against a fixture v1 file; conversions 16→1.0 and 24→1.5 verified; unknown-field round-trip checked verbatim.

**Rollback.** Conversion is read-then-write; on any failure it exits before modifying the v1 file, so the original file is already the valid state. Durable restore is Task 2's rollback command.

**Acceptance tests.**
1. A standalone script reads the v1 settings file and writes a v2 file containing only `appearance.theme` (unchanged value), `accessibility.fontScale = fontSize / 16`, and `legacyExtras`.
2. fontSize 16 yields fontScale 1.0; fontSize 24 yields 1.5.
3. Unknown fields are preserved exactly, verbatim, in `legacyExtras`.
4. On any conversion failure the script exits without modifying the v1 file.
5. No application source files are modified.

**Labeled assumption:** a Node.js runtime runs the `.mjs` script (extension as supplied; runner not specified by migration.md).

---

## Task 2 — Atomic backup and single-command rollback

**Goal.** Per migration.md safety rules: write a backup of the original v1 file before conversion; write the v2 file via atomic replacement (temp file + atomic rename) so an interrupted write never leaves a partial file; provide a one-command rollback that restores the pre-conversion backup byte-identically and logs the restore. If conversion failed, the untouched v1 file is already the valid state. No application-code changes.

- **Proposed path:** `scripts/rollback-settings.mjs` *(proposed, not existing)*
- **Blast radius:** scripts/rollback-settings.mjs only.
- **Value/Effort:** 5 / 3.

**Compatibility.** Operates on the same v1/v2 settings files as Task 1; atomic rename pattern leaves either the original v1 file or a complete v2 file. Conversion flow invokes backup before any v2 write — settle the exact invocation during implementation.

**Testing.** Simulate interruption between temp-file write and rename; verify no partial file ever appears; verify restore byte-identical via checksum comparison; verify log entry written.

**Rollback.** This task *is* the rollback: one command restores the pre-conversion backup and logs the action; executable independently of Tasks 1 and 3.

**Acceptance tests.**
1. A backup of the v1 file exists before any new (v2) file appears.
2. An interruption between temp-file write and rename leaves either the original v1 file or a complete v2 file — never a partial file.
3. A single command restores the pre-conversion backup, and the restored file is byte-identical to it.
4. The rollback logs the restore action and runs independently of the conversion and test tasks.
5. No application source files are modified.

**Labeled assumptions:** the pre-conversion backup is produced by this task (e.g., a backup mode of `scripts/rollback-settings.mjs`) so the declared blast radius holds; Node.js runtime for `.mjs`.

---

## Task 3 — Regression test suite for v1→v2 migration

**Goal.** Test-only suite covering the five cases migration.md requires, runnable without the application: 16 → 1.0; 24 → 1.5; corrupt JSON; unknown fields; interrupted writes.

- **Proposed path:** `tests/migration.test.mjs` *(proposed, not existing)*
- **Blast radius:** tests/migration.test.mjs only.
- **Value/Effort:** 4 / 2.

**Compatibility.** Exercises Tasks 1–2 scripts via their public file behavior only (no imports into app code); can run in parallel for authoring, but verification runs after the other tasks land because conversion and interrupted-write cases depend on their scripts.

**Testing.** This is the testing task — see acceptance tests.

**Rollback.** Tests never mutate real settings; they operate on temporary fixtures. Task 2's rollback remains the restore path for production files.

**Acceptance tests.**
1. fontSize 16 converts to fontScale 1.0 and fontSize 24 converts to 1.5.
2. Corrupt JSON: conversion fails, the v1 file is untouched, and no v2 output is written.
3. Unknown fields are preserved exactly in `legacyExtras`.
4. Interrupted write: the result is either the original v1 file or a complete v2 file — never a partial one.
5. All five named cases pass and the tests change no application code.

**Labeled assumptions:** Node.js runtime with a test runner for `.mjs`; the runner is unspecified by migration.md, so choose a local one without adding infrastructure.

---

## Unverified coverage

Nothing here has been executed: all acceptance tests are pending implementation. Unverified by source: exact backup file naming/location, how the conversion flow invokes Task 2's backup mode, the chosen test runner, and CLI argument shapes — migration.md line 2 does not specify them; each is deferred to implementation with the labeled assumptions above. It is also unverified whether any test-runner infrastructure already exists in this workspace (none was observed).
