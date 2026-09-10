# Performance results and probe guide

The 9 September 2026 audit found repeated main-process stalls from rereading completed session logs. The implemented fixes cover history caching and worker reads, shared polling, isolated reply input, cheaper paint, bounded activity rendering and startup loading. The original [core baseline](reviews/performance-2026-09-09/core.json) remains useful for comparison: refreshing 500 completed runs repeatedly took 1,522–1,575 ms and reread every session body.

This guide retains the final implementation evidence and the controlled reply comparison. Superseded intermediate reports, exploratory/invalid trials and bulky CPU/graphics archives were removed from the working tree; the original audit and recordings remain in Git history at commit `cb501d7`. Measurements and validation counts below are historical results, not a fresh performance certification of the current checkout. They use synthetic fixtures on Windows with a Ryzen 7 3800X; graphics measurements use an RTX 3080 and ANGLE D3D11. The installed app and the user's original lag episode were not profiled.

## Final implementation measurements — 9 September 2026

These changes were implemented in the requested order, with a before/after measurement at each step. The starting point already included the worker, summary caching, shared history feed, composer isolation and paint changes summarized below. Gains in this table are incremental to that starting point, not to the original release.

| Order | Change | Before | After | Interpretation |
|---|---|---|---|---|
| 1 | Build history only while its editor is visible; one compact worker response and short-lived cache | Ten snapshot requests per refresh, including hidden screens; 396–521 ms | Zero requests while hidden or cached; first visible request 224 ms | Avoids recurring unused work; first visible transfer falls from 15,230 to 2,651 bytes (83% less) |
| 2 | Directory index invalidates changed runs instead of fingerprinting every completed run every poll | 500-run warm history median 131.33 ms | 4.83 ms; final validation 4.97 ms | About 96% lower warm duration, with zero session or summary body reads |
| 3 | Incremental token-only view updates and activity pages of 60 | Fold/view median 2.96 ms, p95 31.08 ms; React server render median 432.97 ms | Fold/view median 0.10 ms, p95 0.23 ms; render median 19.25 ms | Less CPU work; mounted activity rows fall from 2,003 to 60 in the replay |
| 4 | Lazy secondary destinations, independent essential hydration and bundled fonts | DailyRoot 525.88 kB; entry-to-composer median 655.24 ms | DailyRoot 178.80 kB (179.11 kB with final acceptance fixes); median 456.02 ms | About 30% earlier observed composer, 66% smaller DailyRoot chunk |

Evidence: [Build before](reviews/performance-2026-09-09/four-tasks/build-history-before.json), [Build after](reviews/performance-2026-09-09/four-tasks/build-history-after.json), [history before](reviews/performance-2026-09-09/four-tasks/history-before.json), [history after](reviews/performance-2026-09-09/four-tasks/history-after.json), [final history gate](reviews/performance-2026-09-09/four-tasks/history-final.json), [live replay before](reviews/performance-2026-09-09/four-tasks/live-work-before.json), [live replay after](reviews/performance-2026-09-09/four-tasks/live-work-after.json), [six startup launches](reviews/performance-2026-09-09/four-tasks/startup-comparison.json).

The Build probe uses ten logs with 2,000 chunks and a 2 MiB tool result each, and checks that compact block history equals the previous snapshot-derived output. The compact result excludes tool payloads and full snapshots. The five-second completed-history cache also expires to catch external changes. Live rows are not cached. The editor visibility signal excludes the gallery and an overlaid Trace.

The directory index watches each history root in the read worker, rescans changed/owned/nonterminal entries, discovers additions/deletions on every request and performs a full fingerprint sweep every 30 seconds. Unsupported or failed watchers fall back to a full scan on every request. This is a rebuildable display cache: a missed filesystem event can delay an external display update until the fallback sweep. Targeted recovery, owner checks and canonical validation before execution mutations remain in the controller. The final gate passes at 10, 100 and 500 runs, with warm history medians of 0.96, 1.53 and 4.97 ms. The 500-run cold read still takes 2.04 seconds in the worker; its main-process heartbeat maximum is 28.06 ms.

The live replay uses 1,000 preceding steps and 120 batches of eight streaming chunks. Every incremental view is covered against the reference projection in regression tests; the benchmark checks the final view too. Structural events, skipped revisions, planner cases and settlement fall back to the full projection. Activity pages retain expansion state and expose Earlier/Later/Latest controls while keeping live rows visible. Replay and server rendering timings exclude browser layout, paint and input delay; they establish reduced computation, not a measured browser typing percentile.

Startup uses three fresh-profile production Electron launches before and three after, without CPU tracing. All six interaction scenarios preserve composer/reply drafts, overlap typing with actual reads, observe the shared polls, and require zero focus recovery. The first before launch includes a large unattributed stall; all samples are retained. Chats first navigation increases from a 50.68 ms median to 63.17 ms with the lazy boundary, still below the proposed 100 ms feedback target. Entry-to-composer begins inside application startup, not at OS process launch, and three samples are not a cold-start distribution. Essential projects/workflows/settings determine run readiness independently of recents; secondary destinations retain the application chrome while loading. Fonts are local WOFF2 files with their OFL notices included.

Validation: production build and lint pass. The full suite reports **2,630 passed, four skipped, zero failed**. Two existing server-rendered screen tests now await their lazy components. Worker/history correctness tests cover external appends, replacement, same-size edits, cancellation, owner changes and recovery; new tests cover directory invalidation/fallback, compact Build history, incremental live views, activity bounds and startup hydration.

Native computer-use acceptance ran the production bundle in a separate profile and workspace, using the configured `z-ai/glm-5.3-flash` provider. The Fable at home workflow created `greeting.txt`, read it back and completed; its bytes are exactly `Hello from Flyt!\n`. A goal with fixed ALPHA/BETA checks ran two real iterations: ALPHA passed 50%, ALPHA BETA passed 100%, and the goal reached Achieved with two model calls. [Workflow evidence](reviews/performance-2026-09-09/four-tasks/workflow-done.jpg) and [goal evidence](reviews/performance-2026-09-09/four-tasks/goal-achieved.jpg) show their completed views. The app was then restarted with the final production build for navigation and long-list acceptance.

The native check also caught reply drafts being lost when Trace unmounted Work. The shell now retains the current project's/current run's draft while the composer alone owns reactive input state, preserving typing isolation. The final native checks preserve a draft through both Trace and Chats navigation ([draft evidence](reviews/performance-2026-09-09/four-tasks/draft-retained.jpg)); the automated Electron scenario also passes its new Trace round-trip assertion. A separate 125-step synthetic fixture verified Earlier/Later paging and retained expansion after paging away and back ([activity evidence](reviews/performance-2026-09-09/four-tasks/activity-pagination.jpg)). All secondary destinations were opened, and Build history, goal iteration results and Statistics showed the completed real work. [Final validation record](reviews/performance-2026-09-09/four-tasks/validation.json) lists the checks and limits; [final app scenario](reviews/performance-2026-09-09/four-tasks/app-final.json) is a functional regression run kept separate from the startup timing cohort.

## Reply presentation results

The reply surface now uses an opaque background without backdrop blur. The selected history row uses a 2 px accent marker instead of a rounded inset shadow. These changes followed CPU/graphics attribution; the final unprofiled comparison is retained because it isolates the marker's effect and includes repeated trials and behavior assertions.

| Fixture | Old shadow: first-burst p95, three runs | Marker: first-burst p95, three runs | Median p95 |
|---|---|---|---|
| 100 runs, 200 chunks/run | 64, 64, 64 ms | 40, 56, 32 ms | 64 → 40 ms |
| 10 runs, 2,000 chunks and 2 MiB tool results/run | 80, 96, 104 ms | 40, 40, 72 ms | 96 → 40 ms |

[Comparison and per-run distributions](reviews/performance-2026-09-09/marker/marker-comparison.json) retain the twelve accepted raw recordings alongside their [comparison script](reviews/performance-2026-09-09/marker/compare-marker.mjs). It checks exact drafts, input overlapping real reads, two shared polls, zero focus recoveries and computed indicator styles. The variants alternate order with fresh synthetic profiles and the same production build. This cohort predates the final history/startup changes above; it isolates the marker change rather than measuring their combined effect.

These are thresholded Event Timing samples grouped by interaction ID, omitting events below 16 ms and quantized to 8 ms. They are not percentiles over every keystroke or whole-session INP. Individual runs still miss the proposed 50 ms target. Later-burst p95 ranges were 16–24 ms before and 16–32 ms after; no sustained-typing improvement is established.

## Implementation boundaries worth preserving

- Canonical parsing and display indexing run in a read worker. Recovery hints and summary caches avoid unchanged session/summary body reads; execution mutations still validate canonical state and ownership.
- Work and Chats share a coalesced history feed that pauses while hidden. Reply input owns its reactive state; the shell retains drafts across navigation. Closed details defer payload rendering.
- Unconstrained Build contracts bypass unnecessary Ajv compilation; constrained schemas still compile eagerly in isolated instances.
- Directory invalidation, compact visible Build history, incremental live projections, activity pages and lazy startup destinations are covered by the final evidence above and the performance regression tests.

## Running the probes

The [long-session snapshot review](reviews/snapshot-performance/README.md) records verified incremental replay, compact cache behavior beyond the raw-event budget, combined Work/Trace reads, memory and queue measurements, and Electron workflow/loop acceptance. Run its focused probe with `node scripts/probe-snapshot-performance.mjs` after building the kernel.

```powershell
npm run test:perf
npm run perf:check
npm run perf:core
npm run perf:app
```

`test:perf` runs correctness and work-budget regression tests. `perf:check` gates unchanged warm session/summary body reads; machine-dependent timings are recorded separately. CI runs that gate on Windows, macOS and Linux. `perf:app` builds and exercises production assets in development Electron with synthetic projects and real input/IPC; it does not open the user's projects or make provider calls. Temporary profiles may remain for investigation.

Reports default to ignored `.flyt/performance/core.json` and `app.json`, overwritten on the next run. Set `FLYT_PERF_OUTPUT` for a separate report. Keep routine recordings there; only promote a compact, valid comparison when it adds evidence for a new change.

The two focused replay probes also write to `.flyt/performance` by default and accept `FLYT_PERF_OUTPUT`:

```powershell
node scripts/measure-build-history.mjs after
node scripts/measure-live-work.mjs after
```

Build the kernel first with `npm run build:kernel`. These compare output equivalence and CPU work; live server rendering excludes browser layout, paint and input delay. The `before` mode exercises reference algorithms using the current checkout, not the complete historical application.

For a core timing budget:

```powershell
$env:FLYT_PERF_COUNTS = '10,100,500'
$env:FLYT_PERF_MAX_HISTORY_MS = '100'
npm run perf:core
Remove-Item Env:FLYT_PERF_COUNTS, Env:FLYT_PERF_MAX_HISTORY_MS
```

The optional duration budget applies to warm history samples; cold validation is separate. The retained final 500-run warm median is 4.97 ms. Failures are saved before a nonzero exit. Core `syncReadBytes` counts explicit `fs.readSync` reads, and `summaryReadCalls` counts summary-body opens; neither represents all filesystem work. Instrumentation adds overhead.

Use `FLYT_PERF_REPEATS` (2–100, default 5) for core repetitions. Both main probes accept `FLYT_PERF_CHUNKS` (0–10,000) and `FLYT_PERF_TOOL_BYTES` (0–16 MiB per run). A large Electron fixture uses `FLYT_PERF_RUNS=10`, `FLYT_PERF_CHUNKS=2000` and `FLYT_PERF_TOOL_BYTES=2097152`.

`npm run perf:profile` builds with hidden source maps and records finite main/renderer CPU profiles and a Chromium timeline beside the JSON output. Use `FLYT_PERF_RASTER=1` for graphics attribution. Keep profiled timings separate from ordinary latency comparisons. For reply comparisons, set `FLYT_PERF_REPLY_REPEAT=1` and alternate `FLYT_PERF_REPLY_EXPERIMENT=baseline` (current production CSS) with `history-inset-shadow` (old selected-row styling) or `blurred-reply` (old reply styling). Use unique output paths and clear environment overrides afterward.

## Remaining measurement scope

Installed releases, slower hardware, a second GPU, multiple simultaneous projects, network-filesystem watcher behavior and a 30–60 minute soak remain unmeasured here. The live replay demonstrates reduced computation but does not establish browser typing latency under streaming load. Cold indexing still takes time in the worker. The proposed end-user diagnostics recorder has not been implemented.

Starting targets to calibrate on declared hardware remain typing p95 below 50 ms/p99 below 100 ms, cached navigation feedback below 100 ms, no recurring foreground main-process tasks above 50 ms, and a usable composer within one second of a defined cold-launch boundary. These are proposed targets, not guarantees demonstrated by every retained sample. Future work should measure these remaining scenarios before selecting further optimizations.
