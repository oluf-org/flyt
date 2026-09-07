# Goal Loop context recovery

The Everest security audit failed four times across the orientation and review
steps. Every failure was the Goal controller's 96,000-character request guard.
The provider context budget was larger, so normal file reading reached the
application guard before context compaction. Retrying repeated the same failure.

The adapter now receives the Goal's application bound, measures provider-shaped
messages, and checkpoints at 16,000 estimated input tokens. Compaction preserves
system instructions, the assignment anchor, recent complete tool exchanges, a
bounded findings/checkpoint record, and retrievable evidence. Oversized tool
previews can shrink without altering the canonical result. Fixed input that
cannot fit still fails explicitly. The full transcript remains on disk.

Canonical tool results now expose `@call:<block>/<call>` handles usable by
`read_tool_result` in the same run. Older logs can derive these handles without
being rewritten. Parallel tool batches retain their assistant call declarations
and every corresponding result during compaction.

Goal provider calls retry transient failures with bounded exponential backoff
(at most five attempts, respecting configured lower limits and Retry-After).
Each attempt reserves the shared call budget. Unpriced failures remain visible;
pause/stop interrupts backoff. Authentication failures, cancellation, and failures
with visible output or tool activity are not automatically replayed.

The audit recipe also assigned report creation to `general-analysis`, whose
ceiling is read-only. Its repaired recipe uses `work` with the existing auditor
system prompt, artifact effect, and the existing Goal tool grant. Authoring
guidance now explains this distinction and accepts an audit with zero confirmed
vulnerabilities.

Validation includes replaying all four saved failing request contexts through
the new context policy, a production-host test with 70 file reads and repeated
compaction, canonical evidence retrieval, transient retry/accounting, pause
during backoff, and the existing 50-iteration and restart tests. These checks use
mock provider responses; they do not establish the quality of a model's audit.
