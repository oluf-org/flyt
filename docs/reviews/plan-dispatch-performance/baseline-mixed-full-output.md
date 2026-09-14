Four-task graph. Three independent deliverables (audit, sum, range) run with no dependencies; double consumes only computed-sum from sum. All workers answer directly and verify their own results; no separate checking or inventory tasks. Read-only, supplied facts only.

## Operational-concern audit table (audit)
# audit-report — Operational-concern audit table

| Concern | Failure symptom | Prevention | Concrete observable verification |
|---|---|---|---|
| Corrupt JSON | Loader fails with a parse error, or silently yields wrong data, when a payload is not valid JSON. | Strict-parse every JSON payload on read and before use; fail fast on malformed bytes. | Place a truncated or brace-broken JSON file at the input path: the run must stop with a parse error naming that file and produce no output. |
| Unknown fields | A record carries a key the schema does not define; it is silently dropped or accepted, so later reads disagree with the source. | Strict allowlist schema: reject or explicitly log any unrecognized field. | Add one fabricated field to a record: the run must log that field by name as unknown and reject or quarantine the record. |
| Interrupted write | Target file exists but is truncated mid-record; the next read gets incomplete content. | Write to a temp file, flush, then atomically rename into place only after success. | Kill the writer mid-write: afterward the target path holds either the previous complete file or nothing — never a partial one; its checksum matches the last complete write. |
| Missing backup | After corruption or deletion the restore step fails because no prior copy exists. | Create and verify a backup before every overwrite; abort if none exists. | Before an overwrite, the backup path must contain a dated copy whose checksum matches the source; with backups disabled the run must abort with an explicit "no backup" error. |
| Stale cache | Reader serves cached values after the source changed; outputs show old data. | Version- or timestamp-stamp cache entries; compare against the source version before serving. | Change the source and re-run: output must show the new value or log a cache invalidation; an unchanged-source re-run may reuse cache — both outcomes visible in logs/output. |
| Duplicate retry | A retried request applies twice: a quantity is counted twice or a duplicate record appears. | Idempotency key per request; skip if that key was already processed. | Send the same request twice under one id: the second attempt must be reported as duplicate/skipped and the final count must equal one application, not two. |
| Network timeout | A remote call hangs; the run stalls indefinitely or fails much later with no clear error. | Per-call timeout plus bounded retries. | Point at an unresponsive endpoint: the call must fail within the configured timeout with a timeout error, and the log must show retries stopping at the configured maximum. |
| Full disk | Write fails partway; zero-byte or truncated output files appear. | Check free space before writing, fail cleanly below a threshold, and remove partial output on write error. | Run against a full disk or a quota below output size: the run must abort with a disk-space error and no partial or zero-byte file may remain afterward. |
| Invalid encoding | Bytes are invalid in the expected encoding (e.g. bad UTF-8); the decoder throws or output is garbled with replacement characters. | Decode strictly without silent substitution; validate encoding at input. | Feed a file containing invalid byte sequences: the loader must report an encoding error naming the file (and offset), and no garbled output may be produced. |
| Zero quantity | Zero is treated as missing or false (or breaks a division), yielding a default value or an error instead of zero. | Test presence and value separately from truthiness; guard every division by the quantity. | Run with quantity explicitly 0: output must record 0 — not a default, not "missing" — and no division error may occur. |
| Empty collection | An empty list crashes an aggregate (min/max/average over nothing) or returns a wrong sentinel value. | Handle the empty case explicitly with a defined empty result before computing aggregates. | Run with an empty input collection: the run must complete and emit an explicit empty result (e.g. "0 items" / empty table), not an exception. |
| Incompatible version | Data or component from a different version is consumed; layout mismatch causes errors or silently wrong values. | Stamp a version marker on data and components; check compatibility before use and refuse or migrate explicitly. | Present data stamped with an incompatible version: the reader must refuse with a version-mismatch message naming both versions; same-version data must pass. |

Completeness check: all twelve concerns appear, in the order given; every row has failure symptom, prevention, and verification; each verification names an operator-runnable action and an expected observable outcome (error line, log entry, checksum, count, or file presence/absence). No separate checking worker was added, per instructions.

## Compute 7+11+13 (sum)
**Task: Compute 7+11+13 — Result**

**Input terms (explicit):** 7, 11, 13

**Arithmetic, step by step (left to right):**
1. 7 + 11 = 18
2. 18 + 13 = 31

**Independent verification (re-add in a different order):**
1. 13 + 11 = 24
2. 24 + 7 = 31

Both orders agree: 18 + 13 = 31 and 24 + 7 = 31. Cross-check by complement: 31 − 13 = 18 and 18 − 11 = 7, recovering the original inputs, so no term was dropped or double-counted.

**Final finished result: 31**

**Artifact `computed-sum`** (contains input and result, as required):

```
artifact: computed-sum
input: 7, 11, 13
calculation: 7 + 11 = 18; 18 + 13 = 31
verification: 13 + 11 = 24; 24 + 7 = 31
result: 31
```

Scope note: this task is sum only. No audit table, doubled value, or range is included here — those belong to the separate audit, double, and range tasks; `double` consumes this artifact and depends only on `sum`. No tools were used and no files were written; the artifact is produced inline as text above, per the read-only constraint. Coverage is complete for this task's three requested elements (input terms, result, artifact). The one item I cannot record as machine-verified is the artifact write itself, since writes are disallowed — the artifact is stated, not stored.

## Double the computed sum (double)
**Task: Double the computed sum — Result**

**Consumed input (finished artifact `computed-sum`, from the sum task):** 31
- Taken as given from sum's finished result; not recomputed here.

**Doubling calculation (explicit):**
2 × 31 = 62

**Output: 62**

**Verification of the doubling (inverse operation):**
62 ÷ 2 = 31 — this returns exactly the consumed computed-sum (31), confirming the doubling.

**Artifact `doubled-sum`** (contains consumed input and doubled result, as required):

```
artifact: doubled-sum
consumed-input: computed-sum (from sum) = 31
calculation: 2 × 31 = 62
verification: 62 ÷ 2 = 31
result: 62
```

**Scope note:** this task is double only. It consumes computed-sum from sum and depends on nothing else — audit and range are unrelated, and no output of theirs was used or referenced. The sum itself was not recomputed from scratch; 31 was consumed as the finished result.

**Coverage note:** complete for the task's requested elements — consumed input (31), explicit calculation (2 × 31 = 62), output (62), inverse-check verification (62 ÷ 2 = 31), and artifact doubled-sum. Unverified: the physical write of the doubled-sum artifact (writes disallowed in this read-only context; the artifact is stated inline, not stored). The arithmetic itself is verified by the recorded inverse check.

## Min and max of [4,0,9] (range)
# range-report

**Collection:** [4, 0, 9]

## Result

- **Minimum = 0**
- **Maximum = 9**

## Verification: element-by-element scan

| Step | Element | Running min | Running max | Check |
|------|---------|-------------|-------------|-------|
| 1 | 4 | 4 | 4 | First element establishes both bounds. |
| 2 | 0 | 0 | 4 | 0 < 4, so min updates to 0; 0 ≤ 4, max unchanged. |
| 3 | 9 | 0 | 9 | 9 ≥ 0, min unchanged; 9 > 4, so max updates to 9. |

**Post-scan confirmation over all elements (4, 0, 9):**
- No element is smaller than 0: 4 ≥ 0 ✓, 0 ≥ 0 ✓, 9 ≥ 0 ✓
- No element is larger than 9: 4 ≤ 9 ✓, 0 ≤ 9 ✓, 9 ≤ 9 ✓

Both bounds hold for every element, so the reported minimum and maximum are correct for the collection as supplied.

## Why zero must remain in the collection

Zero is a valid data value, not an absence or an error. It is a genuine member of the supplied collection — the same status as 4 and 9 — and it carries real information: it records that the quantity measured at that position was actually zero.

If zero were removed, the minimum would change from 0 to 4. That is not a harmless simplification; it is a misrepresentation of the data. A report claiming "the lowest value observed is 4" is factually false for this collection, and any decision based on that claim (e.g., minimum capacity, lowest reading, smallest batch size) would be made against wrong facts. Treating zero as "missing" or "empty" confuses the value 0 with the concept of no value: an empty slot or an error has no number attached, whereas zero is a specific number attached to a specific element. Dropping legitimate zeros systematically biases minima upward and distorts ranges and spreads.

Therefore zero is **retained as the legitimate minimum**, and the collection is reported exactly as supplied: [4, 0, 9], with min = 0 and max = 9.

## Scope and provenance

- Inputs used: only the supplied collection [4, 0, 9]; no external data, no file reads, no tool executions.
- Dependency status: this task has no dependencies (independent of `audit`, `sum`, and `double`, as specified).
- Self-verification: performed above by the explicit three-element scan and the two all-element bounds checks; both pass.
- Unverified coverage: none within this task's stated scope. Every element of the collection was scanned and both bounds were explicitly confirmed for each element; no requested aspect of this task (min, max, zero-retention rationale, scan verification) is left unverified. Assertions about the other tasks (audit, sum, double) are outside this report's scope and no claims are made about them.