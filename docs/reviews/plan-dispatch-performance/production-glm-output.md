Three independent read-only analysis work packages: inventory total, latency reduction, release schedule. No file writes, no cross-dependencies.

## Inventory total (inventory)
**INVENTORY — Work package 1**

Input values used (quoted): apples=12, pears=0, plums=8.

Arithmetic verification: 12+0=12; 12+8=20; so 12+0+8=20. **TOTAL=20**, confirmed.

Zero-stock item preserved: pears=0 is kept explicitly, both in the quoted inputs and in the sum — it is not dropped or treated as missing.

Out of stock: **pears** (stock 0).

No measurements beyond the three supplied values were used; nothing invented. No tools, no file writes.

Scope note: this answer covers work package 1 (INVENTORY) only, per the assigned task. LATENCY (REDUCTION=37.5%) and RELEASE (QA=day 4, RELEASE=day 5) belong to separate workers and are not verified here.

## Latency reduction (latency)
**Worker 2 — LATENCY**

Input values (as supplied): before=240 ms, after=150 ms.

Formula: REDUCTION = (before − after) / before × 100 = (240 − 150) / 240 × 100 = 90/240 × 100 = **37.5%**.

REDUCTION = 37.5%.

Note: these two numbers alone do not establish statistical significance — no sample sizes, variance, or repeated measurements were supplied, so no significance claim is made. No measurements beyond the quoted inputs were used or invented.

## Release schedule (release)
**RELEASE (work package 3)**

Input values (quoted): API work = 2 days; UI work = 3 days; run concurrently from day 1; QA = 1 day after both finish; release = day 5.

Arithmetic check: concurrent start means combined duration = max(2, 3) = 3 days, so both finish at end of day 3. QA begins the next day and lasts 1 day → QA = day 4. Release follows QA → RELEASE = day 5. Both results match the supplied schedule (day 3 end → QA = day 4; release = day 5).

Rollback verification check: confirm the previous release version remains deployable — verify the prior release artifact/tag and its restoration procedure before the day-5 release.

No measurements were invented; all values above are from the request.