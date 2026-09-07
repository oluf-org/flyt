# Import Incident Runbook — Missing Notes After Interrupted Import

> **STATUS: DRAFT — iteration 1 of 2.** Every fact below traces to incident.md (one paragraph, line 2). Nothing is invented; anything I could not source is listed under Open Questions instead of asserted. Iteration 2 will fact-check and may change this document.

## Source and scope
Facts come only from incident.md's incident paragraph. This draft adds no causes, fixes, or product details that the source does not state.

## Safety rules (apply to every step)
- Work offline for the whole session.
- Never uninstall the app.
- Never clear storage.
- Preserve evidence before any fix, reset, or restore.

## Steps
1. **Confirm the report.** Record only what the source states: the import was interrupted and notes appear missing. Do not state or imply notes are lost.
2. **Go offline.** Keep every later step offline.
3. **Ask the user.** Ask whether an exported JSON backup exists (incident.md directs support to ask this).
4. **Preserve evidence first.** Take a copy of current app data and diagnostic logs before anything else. Stop before any action that changes or deletes data until that copy exists.
5. **Branch on the backup answer.**
   - No verified backup → escalate to engineering. Do not attempt repairs, resets, or restores.
   - Verified backup exists → go to Step 6.
6. **Restore only after explicit user confirmation.** If confirmation is absent or ambiguous, stop and wait. Rationale: import replaces notes, so a restore can overwrite data.
7. **Verify after restore.** Check the record count and two sample notes.
8. **Report honestly.** Do not claim a successful restore without the Step 7 verification. If verification fails or is inconclusive, report the restore as unverified and escalate to engineering.

## Open questions (resolve in iteration 2)
- Where the exported JSON backup lives and how to recognize it (the source names it but not its location).
- What counts as a "verified backup" before restore is allowed.
- Who defines "verified" — support, engineering, or the user.

## Iteration 2 plan
Re-read incident.md; check every statement above against it; correct or remove anything unsupported; add the review heading only after the checks pass. The safety rules must survive revision unchanged.
