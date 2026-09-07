# Release Plan — Local Notes App (Two-Week Release)

Source: release-brief.md — the only file in the workspace; every fact below traces to it (line 2: team roster, priorities, day counts, sequencing; the cloud-sync exclusion; the day-10 rollback reserve).

## Scope: three changed areas
1. **Imports** — fix import cancellation deleting notes (Ben).
2. **Exports** — new export progress indicator (Ben).
3. **Android large fonts** — layout improvement (Ada).

## Explicit exclusion
**Cloud sync is out of scope for this release.** No sync feature is built, no sync test cases are created, and no day is allocated to sync work. This exclusion is carried unchanged from release-brief.md.

## Owners and workload
| Owner | Work | Days | Depends on |
|---|---|---|---|
| Ben | Import-cancellation fix | 1–2 (2 days) | — |
| Ben | Export progress indicator | 3–4 (2 days) | Import fix complete (sequenced per brief) |
| Ada | Large-font layout improvement | 1–3 (3 days) | — |
| Cy | Regression tests: imports, exports, large fonts | 5–6 (2 days) | End-of-day-4 code-complete gate |
| Cy | Triage, fix-or-defer with Ben and Ada, re-verification | 7–8 (light) | Days 5–6 results |
| Cy | Re-run failed cases; record go/no-go | 9 (light) | Day-8 fix-or-defer decisions |
| All | Release / rollback day — no new code, no testing | 10 | Day-9 go/no-go |

Cy's 2-day estimate covers days 5–6 per the brief (regression after implementation); days 7–9 are light re-verification and are not new scope.

## Day-by-day schedule (10 workdays)
- **Day 1** — Ben starts the import-cancellation fix. Ada starts the large-font work. Cy is not yet started (blocked by the day-4 gate).
- **Day 2** — Ben completes the import fix. Ada: large-font day 2 of 3.
- **Day 3** — Ben starts the export progress indicator (import fix done first, per the brief's sequencing). Ada completes the large-font work.
- **Day 4** — Ben completes the export progress indicator. **End-of-day-4 gate: all three items code-complete.**
- **Day 5** — Cy, regression day 1: imports (including cancel-mid-import behaviour against Ben's fix) and exports (including the progress indicator). Written pass/fail per case.
- **Day 6** — Cy, regression day 2: Android large fonts (against Ada's improvement); all three suites completed with written results.
- **Day 7** — Cy: light re-verification; every failure is logged and assigned to Ben (imports/exports) or Ada (large fonts). Ben and Ada begin fixes.
- **Day 8** — Cy: re-verification continues; a recorded fix-or-defer decision exists for every failure by end of day. Ben and Ada continue fixes.
- **Day 9** — Cy re-runs failed cases and records the final go/no-go; a **go** requires zero unresolved blockers.
- **Day 10** — Reserved for release and rollback. No testing and no new code are scheduled; Cy holds the days 5–9 test evidence as the go/no-go audit trail.

## Dependencies
- Ben's export work (days 3–4) starts only after the import fix (days 1–2) is complete.
- The **end-of-day-4 gate** is binding: Cy cannot start before Ben's two items and Ada's item are all code-complete. Ada's item (ends day 3) finishes inside the gate.
- The day-10 release depends on Cy's day-9 go/no-go.
- Failure routing: import/export failures go to Ben, large-font failures to Ada, with fix-or-defer decisions by end of day 8.

## Acceptance checks
1. Regression suites executed for all three areas: imports (including cancellation), exports (including progress), large fonts.
2. Written pass/fail per case; every failure assigned to Ben or Ada with a fix-or-defer decision by end of day 8.
3. Final go/no-go recorded on day 9; a go requires zero unresolved blockers.
4. No testing or new code on day 10, so it stays free for rollback.
5. Cloud sync remains excluded: no sync work, tests, or scheduled days appear anywhere in the plan.

## Risks and labeled assumptions
**Risks**
- **Compressed window:** only 2 testing days for three areas; late implementation compresses it further. Mitigation: the days 7–8 slack and deferring non-blockers.
- **No fix-time estimates:** the brief gives none for bugs Cy may find; days 7–8 are the only absorption capacity.

**Labeled assumptions and open items**
- Two-week span = 10 workdays (days 1–10), day 10 reserved for release/rollback, per the brief.
- The workspace contains only release-brief.md — no existing test suite or environment details — so suite construction is assumed to fit inside Cy's own 2 days. This is the plan's largest feasibility unknown; no extra prep days are invented.
- Open item, not silently patched: the brief reserves day 10 for rollback but does not specify rollback mechanics or a named releaser. The plan reserves the day per the brief; mechanics are left to the day-10 release owner.
