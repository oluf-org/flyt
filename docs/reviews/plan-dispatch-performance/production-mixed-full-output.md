Four tasks: an independent 12-row operational failure audit, an independent arithmetic sum (7+11+13), a dependent doubling of that sum, and an independent min/max range report on [4,0,9]. Workers answer directly and self-verify; no file writes. audit, sum, and range run as independent roots; double waits only on sum.

## Operational failure audit table (audit)
# Artifact: audit-report

| # | Concern | Failure symptom | Prevention measure | Observable verification |
|---|---|---|---|---|
| 1 | Corrupt JSON | Parser throws SyntaxError on load; service fails to start | Atomic write (temp file + rename); parse-validate before commit; retain last-known-good copy | Inject truncated JSON into config → loader logs parse error with byte offset, falls back to last-known-good, startup completes with fallback event recorded |
| 2 | Unknown fields | Misspelled key silently ignored; downstream reads missing value | Strict schema validation with key allowlist; reject rather than drop unknown keys | Submit payload with deliberate typo'd key → rejected with error naming the exact key; request id appears in rejection log |
| 3 | Interrupted write | Zero-length or mid-record file after crash; partial record on read | Write to temp, fsync, then atomic rename; publish only complete units with checksums | SIGKILL process mid-write → target file is absent or previous version intact; recovery sweep finds zero partial temps; published-file checksum matches manifest |
| 4 | Missing backup | No restorable copy when recovery is needed; restore command fails | Scheduled backups with retention policy; prune blocked until backup verified complete | Daily job report shows success + manifest; test restore to scratch dir yields file with matching checksum; alert fires on any day with no verified backup |
| 5 | Stale cache | User sees old value after an update commits | Event-driven invalidation on write; bounded TTL; versioned cache keys | Update record then immediate read-through cache → value equals source of truth; invalidation log shows purge keyed to changed entity; max observed entry age ≤ TTL bound |
| 6 | Duplicate retry | Same operation applied twice — double charge, duplicate row | Idempotency key with dedupe table; unique constraint on request id | Replay identical request twice with same key → second returns the first result, exactly one row in table, row count stays 1, unique-violation attempt logged |
| 7 | Network timeout | Call hangs indefinitely; thread pool exhausts; cascading failure | Explicit connect/read timeouts; bounded retry with backoff; circuit breaker | Point client at delayed/blackhole endpoint → call aborts at configured limit with recorded timeout error; breaker opens after threshold and emits event; p99 latency caps at limit |
| 8 | Full disk | ENOSPC on write; service crashes or silently drops records | Space monitor with high-watermark alert; log rotation; retention pruning before full | Fill test volume past watermark → alert fires before 100%, service rejects new writes with explicit error (no crash), rotation deletes oldest file and free-bytes metric rises |
| 9 | Invalid encoding | UnicodeDecodeError or mojibake on read; garbled stored text | Enforce UTF-8 at ingest; validate bytes before persist; transcode or reject | Upload file containing invalid byte 0xFF → rejected citing offset and byte value; every stored string round-trips byte-identical on read-back; reject counter increments |
| 10 | Zero quantity | Invoice/order for zero items accepted; totals distorted | Domain rule quantity > 0 enforced at validation boundary | Submit quantity=0 → rejected naming the field; quantity=1 accepted; aggregate query returns zero records with quantity=0 |
| 11 | Empty collection | Crash on len() division or KeyError when list is empty; bulk op silently no-ops | Explicit guard clause / defined no-op semantics for empty input before any aggregate | Call handler with empty array → defined response (empty result / logged no-op), zero stack traces in error log; empty-set mean returns null per spec, not a divide-by-zero |
| 12 | Incompatible version | Mismatched client/server → missing RPC, cryptic parse failure | Handshake with version negotiation; minimum-version gate with clear rejection | Connect with below-minimum version → handshake rejects stating required minimum vs received version, both logged; minimum-version pair succeeds; compat-matrix run shows expected pass/fail per pair |

Self-verification: rows 1–12 cover each listed concern exactly once, in list order — twelve rows total, none omitted or duplicated; every row has all three columns filled with a symptom, a prevention, and a specific check/observable signal (no generic "test it"). No tools used; read-only as required.

## Compute 7+11+13 (sum)
**Artifact: computed-sum**

Inputs: 7, 11, 13

Forward calculation:
- 7 + 11 = 18
- 18 + 13 = **31**

Self-verification (re-order check):
- 7 + 13 = 20
- 20 + 11 = 31 ✓ agrees with forward result

Result: 7 + 11 + 13 = 31 (verified by re-addition; no unverified coverage — all three inputs and both calculation paths are shown above).

## Double the computed sum (double)
**Artifact: doubled-sum**

Consumed input (from sum task, finished result): **31** — taken as-is from the completed `computed-sum` output ("Result: 7 + 11 + 13 = 31, verified by re-addition"). I did not recompute 7+11+13 independently; the consumed finished value is the sole input.

Doubling calculation:
- 2 × 31 = **62**

Self-verification (round-trip check):
- Forward: doubling the consumed value → 2 × 31 = 62 ✓
- Reverse: halving my result → 62 ÷ 2 = 31 ✓ matches the consumed computed-sum exactly, so the round-trip holds.

**Result: 62** (exactly twice the consumed finished result of 31, with calculation 2 × 31 = 62; dependency: sum only — no reference to audit).

## Min and max of [4,0,9] (range)
**Artifact: range-report**

**Collection:** [4, 0, 9]

**Minimum: 0**
**Maximum: 9**

**Self-verification — pairwise comparison of all three elements:**
- 4 vs 0 → 0 < 4, so 0 is the smaller of the pair
- 4 vs 9 → 4 < 9, so 4 is the smaller of the pair
- 0 vs 9 → 0 < 9, so 0 is the smaller of the pair

0 is smaller than both other elements (confirmed in two comparisons), so min = 0. 9 is larger than both other elements (4 < 9 and 0 < 9), so max = 9. All three elements participated in the pairwise check; the result is consistent across every pair.

**Why zero must remain in the collection:**
Zero is a genuine, valid element of [4, 0, 9] — it was supplied as part of the input and is a legitimate numeric value, not a defect, placeholder, or error. It is precisely the value that makes the minimum 0 rather than 4. If zero were dropped (e.g., misinterpreted as "empty" or filtered out as insignificant), the smallest remaining element would be 4, and the reported minimum would become 4 instead of the true minimum 0. That would misrepresent the data: the collection's actual lower bound is 0, and any downstream consumer relying on the min would be given a wrong, higher floor. Every supplied element must therefore be preserved exactly as given; filtering or "correcting" the input is out of scope for a read-only range computation.