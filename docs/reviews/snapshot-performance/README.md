# Long-session snapshot processing

Measured on Windows, AMD Ryzen 7 3800X, Node 22.12.0, September 10, 2026. [Recorded measurements](results.json) contain elapsed time, explicit bytes read, worker heap/external memory, process RSS, and queue delay after each implementation stage.

## Reproduction

The supplied `.flyt/performance/probe-next-area.mjs` was run before implementation. Its reproduced medians for the 23 MB session were 105.00 ms per 122-byte append; the 40 MB session took 150.21 ms unchanged and 376.73 ms for snapshot plus log. These agree with the reported behavior, with machine-dependent timing variation. Appends reread every byte; oversized combined requests read the file twice.

Rerunning the same probe after implementation produced 17.29 ms, 0.54 ms, and 236.08 ms respectively. These are worker request timings, not renderer input latency.

## Implementation and correctness

`StoredStackSnapshotReader` keeps a separate compact Work projection with an 8 MiB accounting budget. The raw-event cache remains 32 MiB; the worker retains at most four entries in either cache. The compact cache retains metadata, latest outputs, call accounting, conversation entries, and generated-task metadata. Historical stream text, model message bodies, and complete tool results do not enter it. Accounting charges folded compact input conservatively, including overwritten values; it is a cache admission estimate, not a V8 heap limit.

The stateful kernel projector uses the same event fold as full `projectRun`. Snapshot finalization operates on copied metadata/call arrays so terminal status normalization and unfinished calls cannot corrupt the next incremental fold. A comparison against the pre-change projector matched all 500 tested prefixes, including resumed runs and pending calls. Materialization still uses the complete canonical replay, including full tool artifacts.

Every request checks the file fingerprint (device, inode, size, mtime, ctime). A growing file is eligible for incremental processing only after a fixed-size buffer has hashed **every previously observed byte** and matched the cached SHA-256 digest. Only then does the canonical bounded line reader parse the suffix. The cache includes the observed partial tail in its digest and reparses from the last complete newline, preserving split UTF-8 characters. Identity changes, truncation, rewritten prefixes, malformed records, and sequence discontinuities rebuild. A race discards the folded generation and retries once; continued modification fails explicitly with `session_read_changed`, leaving the next request to resynchronize. No persisted sidecar, file-size assumption, or execution-owner hint authorizes reuse.

Work's `readRunView` uses one `run:snapshot` request with `includeLog`. The API performs the existing retirement, confinement, ownership/recovery, lifecycle decoration, cancellation, and revision-baseline checks. The worker returns snapshot and Trace events from the same canonical pass. Legacy bridges retain their existing two-method fallback. A standalone oversized log request reads only Trace and preserves the previous compact generation for subsequent verified snapshot continuity.

## Extended worker measurements

Five samples per warm action; one initial cold snapshot. `cold-open` uses a fresh worker and includes worker startup. The many-tool fixture is 42.98 MB with 10,000 stream events and 2,000 tool results of approximately 16 KiB each, plus model responses. The small fixture is 84 KiB. All fixtures are synthetic and the filesystem is warm.

The extended reference worker uses the original `readWorker.js` and `runProjection.js` with the shared kernel reader and metrics wrapper. The exact untouched baseline was reproduced separately above. Median milliseconds:

| Fixture | Unchanged before → after | Append before → after | Work + Trace before → after | Fresh-worker open before → after |
| --- | ---: | ---: | ---: | ---: |
| Small | 0.81 → 0.64 | 2.95 → 2.02 | 1.14 → 0.76 | 183.94 → 184.11 |
| 23.37 MB | 1.27 → 0.63 | 117.66 → 17.93 | 41.87 → 44.82 | 393.52 → 411.87 |
| 40.15 MB | 171.53 → 0.62 | 172.72 → 28.92 | 413.74 → 218.73 | 668.43 → 476.33 |
| 2,000 tools | 239.46 → 5.71 | 230.96 → 36.64 | 533.91 → 328.21 | 839.87 → 628.19 |

Warm unchanged snapshots now read zero body bytes at all four sizes. Oversized Work + Trace reads fall from 80.29 MB to 40.15 MB, and from 85.95 MB to 42.98 MB in the many-tool fixture. Changed snapshots still read approximately the entire file to verify continuity, but a regression test confirms that a one-event append performs only one JSON parse. Replacements or invalid sequences deliberately cost full replay.

An unrelated small snapshot queued behind an appended 40 MB snapshot completes in 29.58 ms rather than 172.82 ms; the many-tool case improves from 228.07 ms to 40.19 ms. Behind a full oversized Trace, completion is still expensive: 223.17 → 221.64 ms and 312.14 → 326.16 ms respectively. Large Trace parsing, structured cloning, and serialization remain on the shared CPU lane. Cancellation still terminates an active obsolete worker and preserves other queued requests.

Memory samples are **not forced-GC retained-heap measurements or peak measurements**. In the measurement immediately before the final standalone-log adjustment, median worker heap after appends fell from 112.07 to 33.92 MiB for 23 MB, from 118.98 to 42.91 MiB for 40 MB, and from 97.37 to 16.66 MiB for 2,000 tools. Repeated full Trace loads still produce substantial garbage and whole-process RSS fluctuates widely; the records do not support a universal RSS-reduction claim. The final-stage measurements and every intermediate stage are retained in `results.json`.

## Verification

- Final full suite: 2,640 passed, four skipped, zero failures (123 seconds).
- Performance suite: 44 passed; `perf:check` passed its unchanged-body-read budgets.
- Final focused snapshot suite: eight passed, including canonical equivalence with 2,000 tool calls and independent file eviction. Worker/snapshot tests after the standalone-log change: 15 passed.
- Lint and production build passed. `perf:app` passed against production assets. The final app performance recording observed the composer DOM at 445 ms, history rows after a click at 77 ms, and a selected run's reply after 74 ms. These synthetic app results do not establish live typing latency or an installed-release percentile guarantee.
- Canonical replay coverage includes generated children, reconfiguration, repeated outputs, pending/out-of-order call settlement, terminal-to-live transitions, same-size edits with restored mtime, growing prefix rewrites, replacement, truncation, sequence gaps, malformed records, partial trailing lines, concurrent writes, cancellation, byte/file eviction, and resynchronization.

Windows computer use exercised the actual Electron app in an isolated profile:

1. Opened both 40 MB historical sessions, inspected Work model/tool rows and Trace, and switched between runs.
2. Launched a two-step workflow through the composer. It streamed and completed both model turns; Work and Trace reflected the resulting runs.
3. Created and started **Snapshot loop acceptance** through Goals. Its fixed text check failed on `ALPHA` in iteration one and passed on `ALPHA BETA` in iteration two. Opened that iteration in Work and Trace.
4. Restarted the isolated profile and reopened a 40 MB session after workflow and loop activity.

Provider output was injected locally at the normal adapter seam; the UI's configured model label is not evidence of a real paid-provider call. The initial unconfigured profile also exercised the ordinary failed-run and degraded-summary display. No credentials or user projects were used.

## Remaining costs and reproduction

Strict immediate rewrite detection has an O(file bytes) verification cost on changes. Tail-only reads would require additional trustworthy writer evidence and an external-edit strategy; this implementation does not substitute a short prefix/tail sample or a delayed watcher for correctness. Very large partial lines may be reread until their terminating newline arrives. A compact projection over budget is evicted and rebuilt. Its first parse remains bounded by the canonical event-size limit, and returning a snapshot still costs its visible output size. Full Trace opens and materialization retain their complete-payload cost. Cold small/medium opens gain little and can be slightly slower from hashing and cache construction.

```powershell
npm run build:kernel
node scripts/probe-snapshot-performance.mjs .flyt/performance/snapshot-current.json
npm test
npm run test:perf
npm run lint
npm run perf:check
npm run perf:app
```

The probe samples memory through optional read-worker diagnostics and measures queue wait separately from request service. Its reports contain all samples; the promoted evidence keeps per-stage medians. Do not treat five synthetic warm samples as production tail-latency guarantees.
