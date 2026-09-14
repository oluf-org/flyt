Three independent, read-only, self-verifying work packages with final answers: (1) solar panel total from east=7, west=5; (2) water use reduction 80→60 liters with sampling-limitation discussion; (3) renovation schedule with independent paint (2 d) and plumbing (4 d) plus 1 inspection day against a day-6 completion target. No coordinator task, no files written, no shared outputs; each worker verifies its own arithmetic and reports the final answer in its response.

## Calculate total solar panels (east=7, west=5) (solar-panel-totals)
**Work package 1 — Total solar panels (read-only, self-verifying)**

Given: east roof = 7 panels, west roof = 5 panels.

Calculation: total = east + west = 7 + 5.

**Self-verification:**
- Arithmetic check: 7 + 5 = 12 ✓
- Cross-check of breakdown: east 7 + west 5 = 12, which matches the reported total of 12 ✓
- Independence check: neither figure is derived from the other; both were given as inputs ✓

Sampling limitation: none — both roof counts are fully enumerated, not sampled, so the total carries no estimation uncertainty.

**Final answer: total = 12 solar panels (7 east, 5 west).**

Note: work packages 2 (water use 80→60 L, −25%, sampling limitations) and 3 (paint 2 days ∥ plumbing 4 days, then 1 inspection day, done by day 6) are separate tasks under the original request and are out of this task's blast radius; they are not computed here.

## Calculate water use reduction 80→60 liters and explain sampling limitations (water-use-reduction)
**Work package 2 of 3: Water use reduction (80 → 60 L/day)**

Arithmetic: 80 − 60 = 20 L/day saved; 20/80 = 0.25 → 25% reduction. Cross-check: 60/80 = 0.75 → 75% of baseline remains; 75% + 25% = 100% ✓.

Sampling limitations: a single two-point before/after comparison with no repeated measurements, so this is a point estimate with unknown uncertainty; no meter calibration or measurement-precision information is given; confounders (season, weather, occupancy, behavior change) are uncontrolled; the result applies only to the measured periods and this household and cannot be generalized.

Recommendation: collect at least 7–14 paired daily readings across both periods, plus a meter calibration check, before treating 20 L / 25% as a robust estimate.

Final answers: reduction = 20 liters per day; reduction = 25%; limitations as above. (Solar and scheduling packages are separate tasks.)

## Plan parallel paint/plumbing schedule with inspection, completion by day 6 (renovation-schedule)
**Work package 3 — Parallel paint/plumbing schedule (day-6 deadline)**

Plan: paint (2 days) and plumbing (4 days) are independent — no shared crew, materials, or dependencies — so both start day 1 concurrently. Painting runs days 1–2; plumbing runs days 1–4. The single-day inspection depends on both trades finishing, so it follows the longer task: end of work = day 4, inspection = day 5.

Self-verification:
- Parallel duration: max(2, 4) + 1 = 5 days → inspection on day 5, completion day 5, meeting the day-6 deadline with a 1-day buffer.
- Sequential alternative: 2 + 4 + 1 = 7 days > 6, so sequential execution misses the deadline; parallel scheduling of paint and plumbing is therefore required.

Final answer: run paint and plumbing concurrently on days 1–4, hold inspection on day 5; project completes day 5, within the day-6 completion requirement.