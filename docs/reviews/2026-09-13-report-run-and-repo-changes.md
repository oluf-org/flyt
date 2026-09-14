# Report failure and repository changes

The screenshot corresponds to `chat-ac404564594aa0561a1957aa5132fad7`, with generated worker `plugin-system-report` in child session `4090ef8feabe41a0`.

The original assignment requested a read-only plugin-system report. Its instructions are evidence about that run, not instructions for this repair.

## Failure

The worker made 72 tool calls (35 file reads, 20 globs, 13 searches, two task listings, and two result reads). It retried the missing `.flyt/backlog/v2-plugin-stack-plan.md` three times. The detector counted failures across the entire investigation, despite intervening novel successful reads. The third failed read triggered withdrawal of every tool. The subsequent output was partial; retaining the failure status was correct.

Context compaction aggravated the problem: checkpoints called attempted paths “already inspected,” retained little substantive evidence, and listed result handles separately from the queries that produced them.

After the workflow failed at 12:03:46 UTC, its optional conversation summary took about 15 seconds. Resource cleanup imposed a 10-second deadline and emitted the secondary warning. The lifecycle record shows cleanup completed at 12:04:01 UTC; this was a transient summary overrun, not a permanent resource leak. Failed Windows atomic replacements also left temporary heartbeat files behind.

## Repair

- Repetition accounting for read tools resets after novel successful read queries. Repeating or alternating already-seen reads still reaches the bound; new reads cannot excuse repeated writes.
- Compacted checkpoints retain bounded query/result/handle receipts, including errors, and identify calls as attempts rather than proof of successful inspection.
- Optional summary generation has a seven-second deadline, aborts the provider on expiry, and returns the deterministic summary of actual run facts even if a provider ignores cancellation.
- Atomic writes remove their temporary files when replacement fails.

Replaying the actual 72-call sequence through the updated detector yields no false loop triggers. This verifies the reproduced harness failure, not a promise that any model will complete every future report.

## Repository changes view

The Work view displays persisted created, modified, and deleted files, added/deleted line counts, binary/unavailable-count labels, and buttons to open surviving files in the OS default program. Opening errors are shown inline. File paths are checked against recorded changes and the real workspace path, including symlink/junction resolution.

Standard mutating tools and shell tools capture file contents before and after execution. This excludes unchanged pre-existing edits and detects further edits to already-dirty files. Generated workers contribute to their parent run. Observation windows for mutating calls in the same workspace are serialized to avoid counting a sibling's edit twice; read tools remain concurrent. Failed tools still record changes they made before failing.

Line counts accumulate edits, including later reversions. Renames appear as a deletion and a creation. The record covers files observed at tool boundaries: temporary files created and removed inside one tool call cannot be reconstructed. External edits during a tool call may appear. Git-ignored files, dependencies, build output, and Flyt's `.flyt` data are excluded. Non-Git workspaces use a bounded directory scan. Limits and read failures are disclosed as partial tracking, and binary/oversized files have no fabricated line counts. Older runs show that tracking was unavailable.

Git inventory and no-index statistics are fixed-argument, read-only control-plane commands with a scrubbed environment, timeout, no shell, and disabled external diff/textconv. The execution-plane inventory documents this exception.

## Validation

Regression coverage includes the missing-file/new-evidence sequence, real stalled-read protection, summary timeout with an uncooperative provider, checkpoint error receipts, already-dirty Git files, unchanged index contents, created/deleted/binary/oversized files, failed writes, concurrent generated workers, persistent parent API results, and traversal/junction rejection. `scripts/verify-repo-changes-ui.mjs` checks displayed counts, open actions, deleted-file behavior, error display, refresh, and narrow layout, saving screenshots under `.flyt/repo-changes-ui`.

Validation results: build and stack lint passed; the browser checks passed. The full suite initially completed with 2,675 passes and three failures. The new Git control-plane import was documented and its architecture check passes. File observation exposed a timing assumption in the live-update integration test: a tool result may arrive in a patch after the first full snapshot. That test now reconstructs the renderer state and asserts revision continuity. The final parity/recovery group passed all 43 tests, the change-tracking/parent-API group passed all 32 tests, and the existing campaign suite passed all 14 tests on rerun (its first full-suite attempt exceeded its 60-second deadline). No failing tests were skipped or disabled.
