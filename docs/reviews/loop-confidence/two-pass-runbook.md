# Incident runbook: interrupted import / missing notes

## Ready for review — iteration 2 of 2

> **STATUS: READY FOR REVIEW (revision after fact-check).**
> Iteration 2 outcome: every line was re-read and checked against `incident.md` (single content line: line 2). Facts are cited to that line; anything not stated there is explicitly labeled as a gap, extension, or assumption. No fact was added from outside the source. Prime directives unchanged: preserve user data at every step, no destructive fixes.

## Scope
- Situation: an import was interrupted; notes appear missing. (`incident.md`, line 2)
- Actors: support handles the incident; engineering is the escalation path. (`incident.md`, line 2)
- Source of truth: `incident.md` only. No fact below comes from code, memory, or outside knowledge.
- Prime directive: preserve user data at every step; no destructive fixes.

## Safety rules (apply to every step)
1. Work offline. (`incident.md`, line 2)
2. Never uninstall the app. (`incident.md`, line 2)
3. Never clear storage. (`incident.md`, line 2)
4. Preserve user data at every step; no destructive fixes. (Directive; consistent with `incident.md`, line 2.)
5. Do not claim a successful restore without verification. (`incident.md`, line 2)

## Steps

1. **Ask whether an exported JSON backup exists.**
   - Support must ask whether an exported JSON backup exists; record the answer before any recovery action. (`incident.md`, line 2)
   - This step is a question only — it must not touch app data or storage.
   - Ordering (resolved in iteration 2): `incident.md` states the ask first, then says "First preserve a copy of current app data and diagnostic logs". Sentence order and the word "First" attach to different things — the ask (read-only) comes first, and the copy is the first physical action. Both are non-destructive and both precede any restore, so the practical order is: ask → copy → escalate/restore. No conflict.

2. **Preserve current state first — before any recovery action.**
   - Take a copy of the current app data. (`incident.md`, line 2)
   - Take a copy of the diagnostic logs. (`incident.md`, line 2)
   - While doing this: work offline, never uninstall the app, never clear storage. (`incident.md`, line 2)
   - Gap (labeled): `incident.md` gives no exact commands or storage paths for the copies. Do not guess them; obtain the copy method from the user or engineering. Still a gap after the iteration 2 fact-check.

3. **Escalate if no verified backup exists.**
   - Escalate to engineering if no verified backup exists. (`incident.md`, line 2)
   - A backup counts as verified only once it is confirmed usable. Gap (labeled, still open): `incident.md` requires a "verified backup" but does not define the verification method — it does not say whether verification means a record-count check, a sample-note check, or something else. Confirm the method with engineering before relying on any backup, and treat a backup as unverified until then.
   - **STOP / escalate:** if no backup exists, or the backup cannot be verified, escalate to engineering and stop recovery actions. Do not improvise a restore.

4. **Restore only with explicit user confirmation — and only from the backup.**
   - Restore only after explicit user confirmation, because import replaces notes. (`incident.md`, line 2)
   - Restore from the verified backup only. Never hand-craft, edit, or partially apply data; no destructive fixes. (Safety restatement; the "import replaces notes" rationale is from `incident.md`, line 2.)

5. **Verify after restore.**
   - Verify the record count and two sample notes. (`incident.md`, line 2)
   - Do not claim a successful restore without verification. (`incident.md`, line 2)
   - If verification fails, stop and escalate; do not claim success.

## Open gaps (status after the iteration 2 fact-check)
- Exact backup/copy commands and storage paths — still open; not stated in `incident.md`.
- Definition of a "verified" backup and its verification method — still open; not stated in `incident.md` (see step 3).
- Ordering of the ask (read-only) vs. the preserve-copy (first physical action) — resolved in iteration 2: no conflict; see step 1.
- Restore mechanics (how the restore is performed) — still open; not stated in `incident.md`.

---
**Assumption (labeled):** `incident.md` is the only factual source; the truncated remainder of the original assignment did not introduce additional source facts. All content above is restricted to facts stated there, with gaps explicitly labeled rather than invented. Every incident fact cited above lives on line 2 of `incident.md` (the sole content line of that file).
