# Runbook — Interrupted Import, Missing Notes

## Ready for review

Iteration 2 revision. Every statement was re-checked against the supplied source; incident.md line 2 is the only fact source. Items marked [PLACEHOLDER] are unsupplied — get real values before executing; nothing was invented.

**Source:** incident.md, line 2 (incident narrative). Every sourced step cites it. Anything incident.md does not specify is a [PLACEHOLDER] — do not improvise or invent values.

## Safety rules (apply before any other action)

- Preserve user data: copy current app data and diagnostic logs first; never modify the originals.
- Never uninstall the app and never clear storage.
- Work offline.
- No destructive fixes of any kind.

## Steps

1. **Confirm the report:** the import was interrupted and notes appear missing. (incident.md:2)
2. **Preserve evidence:** copy current app data and diagnostic logs to [PLACEHOLDER: evidence copy location] before anything else. If the copy fails, stop and escalate. (incident.md:2)
3. **Ask about a backup:** ask whether an exported JSON backup exists; record the answer in [PLACEHOLDER: ticket location]. (incident.md:2)
4. **Decision point:** if no verified backup exists, stop and escalate to engineering. Treat "existence uncertain" as "not verified". (incident.md:2)
5. **Verify the backup:** confirm it is complete and valid before use: [PLACEHOLDER: verification method]. An unverifiable backup counts as no verified backup. (procedure detail not in incident.md — unsupplied; fill before use)
6. **Get user confirmation:** restore only after explicit user confirmation, because import replaces notes. Without it, stop. (incident.md:2)
7. **Restore:** from the verified backup, using [PLACEHOLDER: restore procedure]. (procedure detail not in incident.md — unsupplied; fill before use)
8. **Verify the result:** verify the record count and two sample notes. (incident.md:2)
9. **Report honestly:** report only verified results; never claim a successful restore without verification. (incident.md:2)

## Escalation

Engineering contact/channel: [PLACEHOLDER]. Sourced trigger: no verified backup exists (incident.md:2). Procedural triggers (unsourced): evidence copy fails, user declines confirmation, or post-restore verification fails. In every stop case, leave all data untouched; no destructive fixes.

## Fact-check notes (iteration 2)

- All nine steps and the safety rules trace to incident.md:2, the source's only narrative line; additions beyond it are conservative procedural rules.
- Placeholders (steps 2, 3, 5, 7; engineering contact) are unsupplied; fill with user-provided values before use.
- Step 3's "JSON" and step 8's "two sample notes" are quoted from incident.md:2, so both stay. Draft status replaced by the Ready for review heading.
