Three fully independent read-only analysis work packages (inventory, latency, release). Each worker computes, self-verifies its own arithmetic, quotes the exact input values used, and returns a single answer of ≤130 words with all requested outputs preserved. No file writes, no tools, no coordinator, no dependencies between tasks.

## Work package 1: Inventory total and zero-stock status (wp1-inventory)
**Work package 1: Inventory total and zero-stock status**

Supplied facts, quoted verbatim: "apples=12, pears=0, plums=8".

Listing (zero-stock item preserved):
- apples = 12
- pears = 0
- plums = 8

Computation: TOTAL = 12 + 0 + 8.
Self-verification: 12 + 0 = 12; 12 + 8 = 20. ✓

**TOTAL = 20.**

Zero-stock item: **pears** — pears are explicitly **out of stock** (quantity 0).

No measurements beyond the three supplied values were used; no additional items, units, or estimates are asserted. This is a read-only analysis; no files were written and no tools were used.

## Work package 2: Latency reduction and significance caveat (wp2-latency)
Work package 2: LATENCY
Supplied facts, quoted verbatim: "before=240 ms", "after=150 ms".
Computation: (240-150)/240*100 = 90/240*100.
Self-verification: 240-150=90; 90/240=0.375; 0.375*100=37.5. Cross-check: 37.5% of 240 = 90 ms, and 240-90=150 ms — consistent.
REDUCTION=37.5%.
Caveat: these two numbers alone do not establish statistical significance. The inputs include no sample size, variance, or repeated trials, so no significance test can be run from them and no such claim is made.
No measurements were invented; only the two supplied values were used. Read-only: no files written, no tools used.

## Work package 3: Concurrent release timeline with rollback check (wp3-release)
**Work package 3 — Release timeline (analysis deliverable, single worker)**

Inputs quoted verbatim: "API work=2 days, UI work=3 days running concurrently from day 1, QA=1 day starting after both finish."

Arithmetic self-verified: with both tracks concurrent from day 1, API occupies days 1–2 and UI days 1–3; max(2,3)=3, so the concurrent track ends day 3. QA, at 1 day starting after both finish, runs on day 4 (QA=day 4). Release therefore falls on day 5 (RELEASE=day 5). Check: 3+1=4 (QA), 4+1=5 (release) — consistent.

Rollback verification check: before the day-5 release, confirm the prior release artifact/tag is retained and the documented rollback procedure is executable, so the day-4 QA gate can revert if release fails.

No invented measurements; no tools or files used.