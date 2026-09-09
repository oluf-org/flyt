# Performance audit — 9 September 2026

The strongest finding is a repeatable main-process stall caused by history refreshes rereading completed session logs. The bundle warning is a separate startup concern. There is evidence for focused changes to recovery, history loading and rendering boundaries; there is not yet evidence that the application needs to be rebuilt.

Inspected baseline: Flyt 2.1.8, commit `0be02ec`. The original audit added measurement scripts without changing product behavior. The implementation follow-ups below record the optimizations and regression framework. Performance fixtures use synthetic history; the final acceptance check also ran a real workflow and goal in an isolated workspace with configured providers. The user's installed application and exact lag episode have not been profiled. Source line numbers in the original findings refer to the inspected baseline.

## Four remaining tasks completed — 9 September 2026

These changes were implemented in the requested order, with a before/after measurement at each step. The starting point already included the worker, summary caching, shared history feed, composer isolation and paint changes described later in this document. Gains in this table are incremental to that starting point, not to the original release.

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

Remaining measurement scope: installed release builds, a slower machine, multiple simultaneous projects, missed-watcher behavior on network filesystems, and a 30–60 minute soak have not been benchmarked here. These four changes do not implement the proposed end-user diagnostics recorder. The original findings and intermediate results below are retained as historical evidence, including budgets that were still failing at those intermediate stages.

## Measurements

The core probe calls the real `createEngine` / `createApi` implementation using temporary projects. Each settled run contains 213 canonical events, including 200 synthetic streaming chunks. The final baseline was run separately from the Electron probe. These are small runs: approximately 133 kB each.

| Completed runs | Session data | History refresh, three samples | Longest heartbeat gap during a refresh |
|---:|---:|---:|---:|
| 10 | 1.33 MB | 32–43 ms | 43 ms |
| 100 | 13.32 MB | 300–307 ms | 312 ms |
| 500 | 66.59 MB | 1,522–1,575 ms | 1,575 ms |

Every refresh reread all of the fixture's session bytes, including the second and third refreshes with no history changes. `run:list` had comparable costs. This is recurring work, not just a cold-cache penalty. The heartbeat is a five-millisecond timer: its observed gap includes timer scheduling and OS noise, so it is useful evidence of large stalls, not a sub-millisecond profiler.

The Electron probe launches the actual production `dist` with its real preload and IPC handlers, types into the composer through Electron input events, opens Chats, and observes two polling periods. With 100 runs:

- Application entry to composer DOM observed: **483 ms**. This excludes Electron process launch and fixture generation and is not a cold-start or full run-readiness measurement.
- Chats navigation to populated rows observed: **233 ms**. Readiness polling adds up to roughly 50 ms of observation overhead.
- Seven `history:activity` calls during the scenario: **146–164 ms each**.
- Main-process heartbeat gaps reached **360 ms**.
- The longest recorded renderer event timing was **296 ms**; the longest recorded animation frame was **255 ms**.
- Typing's input-handler-to-next-animation-callback proxy was much smaller: **8.5 ms p95, 17.1 ms maximum**. This excludes delay before the input handler and does not measure completed paint. It illustrates why one number called “lag” would be misleading.

Machine: AMD Ryzen 7 3800X, Windows. Core probe: Node 22.12.0. Electron probe: Electron 44.0.0 / Node 24.18.1. Different runtimes account for some differences between core and Electron measurements; compare repeated measurements within the same harness and environment.

Raw baseline evidence: [core samples](reviews/performance-2026-09-09/core.json), [Electron timeline](reviews/performance-2026-09-09/app.json).

## Implementation follow-up — 9 September 2026

The first implementation targets the measured history stall and adds repeatable work budgets. It does not complete every item in the acceptance plan.

### Changes implemented

- **Recovery hints:** `RunController` owns a bounded, process-local cache of canonically validated terminal sessions. Routine scans still discover files and check their identity, size, modification time and change time, but unchanged terminal logs require no body reads. Appends, replacement and same-size edits invalidate the hints. Explicit per-run reconciliation bypasses them, including when it waits behind a concurrent history scan. Ownership, leases and claims remain checked before recovery writes; resume/restart retain canonical validation. Recovery yields between files after roughly eight milliseconds of work.
- **Summary index:** `RunStore` caches derived summary rows against the fingerprints of `meta.json` and `prompt.md`, detects external edits on each list read, and removes deleted entries during asynchronous scans. Both caches cap at 10,000 entries; they are rebuildable and never execution authority. The API builds cold summary rows in yielding batches. Lifecycle reads remain fresh, avoid duplicate reads and avoid exception-producing opens for normally absent owner/lease files.
- **Shared history:** Work and Chats receive the same active-project feed. It allows one pending request, coalesces activity invalidations into a trailing refresh, schedules the next poll after completion, pauses while hidden, refreshes on visibility return, and preserves loaded rows on refresh/error. Stale responses cannot update a replacement subscription.
- **Rendering:** Reply draft state lives in its own component, so keystrokes do not rerender Work or refold its trace. Work memoizes derived data against trace/snapshot identity; the existing event bridge supplies fresh outer trace identities. Drafts survive temporary hiding within the same run. Closed activity details do not construct or serialize their bodies; live details still open, and user expansion survives updates.

### Measured results

The same Windows / Ryzen 7 3800X / Node 22.12.0 core scenario was repeated before and after the changes, without the Electron probe or full test suite running alongside it. Five warm samples per endpoint follow one separately reported cold scan. “Cold” means empty process caches, not a cold filesystem or installed-app launch.

| Runs | Before: history refresh range | After: warm history range | After: warm history median | After: maximum heartbeat gap across warm list/history samples |
|---:|---:|---:|---:|---:|
| 10 | 30–42 ms | 2.76–3.35 ms | 2.93 ms | 16.10 ms |
| 100 | 289–295 ms | 21.87–22.87 ms | 22.13 ms | 32.11 ms |
| 500 | 1,488–1,534 ms | 106.14–114.24 ms | 108.51 ms | 47.41 ms |

Every warm list/history sample recorded **zero explicit session-read bytes and zero summary-body opens**. At 500 runs, the cold scan still took **1,465 ms**, but its maximum heartbeat gap was **39.89 ms**, compared with a roughly 1.5-second uninterrupted baseline stall. This is less repeated work and better scheduling, not elimination of all cold work. The 500-run fixture still misses the proposed 100 ms history-duration target.

Evidence: [same-session before measurements](reviews/performance-2026-09-09/core-before-implementation.json), [final core results](reviews/performance-2026-09-09/core-after.json). The fixture now wraps its block in a canonical sequence so opening Work exercises a real activity list; this adds 45 bytes per run relative to the original fixture, with the same event/chunk counts.

The extended production Electron scenario checks composer typing, Chats navigation, two polling periods, opening a completed run, reply typing, and detail expansion/collapse. The 100-run scenario passed with **two polls in eleven seconds**, instead of separate host/page polling streams. Those polls took **23.64–24.46 ms**, with **no recorded main heartbeat gaps over 50 ms during that polling phase**. Chats navigation to observed rows took **30 ms**, versus 233 ms in the original audit; opening a completed run to an observed reply field took **63 ms**. The composer DOM appeared at **481 ms**. The first history call still took **464 ms**, overlapping recovery and Build startup; main-process gaps elsewhere reached **266 ms**. Startup has not been fixed.

The 100-run scenario's composer input-to-animation proxy was **28.2 ms p95 / 86.3 ms maximum**; reply typing was **95.9 ms p95 / 124.7 ms maximum**. The reply target is therefore still unmet even in this fixture. Composer isolation is an implemented reduction in render work, not a demonstrated end-to-end typing-latency improvement. [Final Electron timings and raw attribution](reviews/performance-2026-09-09/app-after.json).

A second Electron scenario uses ten runs with **2,000 chunks and a 2 MiB tool result per run** (34.16 MB of session data). Both polling calls took about **3 ms**; opening the run to an observed reply field took **110 ms**. Typing and opening/closing the large tool result passed. Its reply input-handler-to-animation proxy was **73.8 ms p95 / 118.9 ms maximum**, so this scenario does **not** establish the proposed typing target. These are small samples that exclude input queue delay and completed paint. [Large-payload Electron results](reviews/performance-2026-09-09/app-large-after.json).

### Regression framework and validation

- `npm run test:perf` runs deterministic regression tests for unchanged logs of different sizes, large tool results, external append/replacement/same-size edits, new/deleted/renamed runs, project isolation, live ownership, denied recovery claims, targeted validation overlapping a scan, history subscription behavior, and deferred payload rendering. The renderer test gives 300 closed tool steps payloads that throw if serialized; only the live step constructs its body.
- `npm run perf:check` measures cold and warm API paths and fails if unchanged warm list/history reads session or summary bodies. Reports include raw samples, hardware/runtime, min/median/p95/p99/max and saved failure reasons. Small-sample p95/p99 often equal the maximum; they are not precise tail estimates.
- CI runs this work-budget gate on Windows, macOS and Linux with 10/100/500 runs and three warm repetitions, and uploads the JSON report even when the gate fails. Shared-runner timings are recorded without a hardware-sensitive millisecond gate.
- `npm run perf:app` now checks a foreground window explicitly; a hidden/occluded window correctly pauses its history feed. It reports per-phase input proxies and polling samples. Its timing values are observations; typing/content/expansion and polling-count assertions are the automated gates.

Validation: full suite **2,608 passed, four skipped** after the initial implementation; the final recovery/rendering follow-up passed **80 focused tests**, followed by **17 performance-only tests** including a real fixture-to-Work projection check. Production build and stack lint passed. The existing bundle warning remains (DailyRoot approximately **523.15 kB** minified). All final core read budgets and both Electron scenarios passed. An intentionally impossible 0.000001 ms warm-history budget exited 1 and saved both expected failures before exit. [Failure-gate evidence](reviews/performance-2026-09-09/expected-budget-failure.json), [validation record](reviews/performance-2026-09-09/implementation-validation.json). The configured CI matrix has not been run remotely in this session.

### Highest-yield remaining work

1. Move canonical parsing and cold indexing off the main thread, or make individual large-log reads bounded. Yielding between files cannot bound the cost of one large file. Discovery/stat/lifecycle work still scales with the number of runs; this implementation retains incremental recovery checks in list endpoints instead of fully separating recovery into activation/change-driven services.
2. Profile long-run opening and reply interactions before further changes. Initial snapshot/log transfer and trace folding remain, as do unwindowed block activity lists. Deferred bodies and composer isolation remove specific work but do not prove an end-to-end typing budget.
3. Split secondary startup destinations and remove unnecessary background snapshot work once measured. Startup still has stalls, and the bundle boundary has not changed.
4. Add live-stream timing replay, multi-active-project and Goals scenarios, installed-release cold launches, slower hardware and a 30–60 minute soak. The opt-in in-app recorder remains unimplemented; no memory-leak or full real-use performance claim follows from these synthetic probes.

## Read-only worker follow-up — 9 September 2026

Cold canonical inspection, summary indexing, canonical `run:snapshot` / `run:log` reads and display snapshot pushes now use a Node worker thread, including reads of active runs. Recovery inspection and summary rows cross the worker boundary in batches of 32. The existing API response shapes remain unchanged. Lifecycle decoration still runs through `RunController`, yielding after roughly eight milliseconds. UI snapshot reads no longer opportunistically materialise derived files; execution settlement, explicit mutations and recovery retain their existing write paths.

The worker imports the same canonical parser and snapshot projection as the main process. It does not launch execution, acquire claims, update leases, repair logs or materialise snapshots. An unchanged terminal observation is accepted only against the current file fingerprint. Nonterminal or unstable observations fall through to the existing claimed, canonical reread and recovery write path. Ownership-marker presence defers broad inspection until the controller has checked liveness; active logs are not parsed on every poll. Targeted validation bypasses terminal hints. If execution validation was waiting behind a cancelled display request, it retries independently.

Project switch/close aborts obsolete display reads. Cancelling an active read terminates its worker, including a single large synchronous parse; requests belonging to other projects remain queued and restart after termination. Failed workers reject the active read and restart for later work. Shutdown rejects pending reads and awaits termination. The queue caps at 128 pending requests, summary caches at eight project stores with 10,000 rows each, terminal hints at 10,000, and the worker event cache at four files / 32 MiB of source bytes (not a total heap limit). Same-size edits and file replacement invalidate stored event caches using identity and nanosecond timestamps.

### Measurements

The serial core gate passes with zero main-process session parsing or summary-body opens on cold list reads, and zero body reads in either process for warm history. Worker counters are now included in the existing read-budget gate, so moving I/O cannot hide repeated work. These measurements use the same Windows / Ryzen 7 3800X / Node 22.12.0 fixture and five warm repetitions as the earlier follow-up:

| Runs | Cold duration, including worker startup | Cold main heartbeat gap | Warm history median | Maximum warm main heartbeat gap |
|---:|---:|---:|---:|---:|
| 10 | 254 ms | 18.29 ms | 4.20 ms | 16.33 ms |
| 100 | 549 ms | 19.18 ms | 26.39 ms | 20.69 ms |
| 500 | 1,927 ms | 20.03 ms | 133.02 ms | 20.64 ms |

At 500 runs, the cold scan's main heartbeat gap fell from **39.89 to 20.03 ms**, and the maximum warm gap from **47.41 to 20.64 ms**. Total latency increased: cold was previously 1,465 ms and warm history's median was 108.51 ms. Worker startup, messaging and extra fingerprint/discovery work are a measurable tradeoff; the proposed 100 ms history target remains unmet. [Core worker results](reviews/performance-2026-09-09/core-worker.json).

A separate, serial comparison runs the same read-only projection over three uncached logs, each with 10,000 streaming chunks and a 16 MiB tool result. Worker startup is excluded. Output equality is asserted. Main-process projection caused **120–157 ms** heartbeat gaps; worker projection reduced them to **16–20 ms**, while total projection durations remained similar (main median 133 ms, worker median 132 ms). This isolates the single-file stall that yielding between files cannot address. [Single-file comparison](reviews/performance-2026-09-09/worker-parsing.json).

Both production Electron scenarios passed. The harness now starts a second synthetic project's cold history while typing in the composer and requests snapshots/logs while typing a reply. It asserts that actual input events occur during in-flight reads, records the overlap, and verifies drafts, rows and detail expansion. The 100-run scenario recorded eight composer inputs and one reply input during reads; the large-payload scenario recorded ten and one respectively.

- **100 runs:** run opening observed at 64 ms; shared polling at 28–31 ms; maximum startup/main gap 269 ms. Composer/reply input-to-animation p95 were 36.8 / 56.4 ms. [Electron worker results](reviews/performance-2026-09-09/app-worker.json).
- **10 runs, 2,000 chunks and 2 MiB tool results:** run opening observed at 87 ms (previously 110 ms); polling at 4–4.5 ms; maximum startup/main gap 257 ms. Composer/reply proxy p95 were 49.7 / 71.7 ms. [Large-payload worker results](reviews/performance-2026-09-09/app-large-worker.json).

The remaining startup gaps are comparable to the previous 266 ms maximum. Moving parsing does **not** establish that whole-app startup or reply typing is fixed. The expanded scenario has additional concurrent work and small samples, and its input proxy still excludes queue delay and completed paint. Execution-owned materialisation, controller recovery writes, renderer log transfer/folding, and other startup services remain separate work.

### Validation and reproduction

Worker regressions cover batch equivalence, read-only files, cache invalidation, active/queued cancellation, worker exit and restart, shutdown, project switching with stale snapshot suppression, execution validation surviving display cancellation, ownership/denied claims, a file changed after inspection, and matching canonical recovery with a torn tail. The package integrity check now requires both worker modules. Production build and stack lint pass; the existing DailyRoot bundle warning remains. Installed-release runtime behavior and remote CI were not measured.

Validation: full suite **2,620 passed, four skipped**; **26 performance tests passed**. The final active-run/display-push follow-up passed **110 focused API, engine, workflow, lifecycle, projection and performance tests**. Both Electron scenarios and all core read-budget gates passed. [Worker validation record](reviews/performance-2026-09-09/worker-validation.json).

Run the existing `npm run test:perf`, `npm run perf:check` and `npm run perf:app` commands. For the isolated large-file comparison, run `node scripts/measure-worker-parsing.mjs`; it writes `.flyt/performance/worker-parsing.json` unless `FLYT_PERF_OUTPUT` is set. All scenarios use temporary synthetic data without provider calls.

## Startup and reply CPU attribution — 9 September 2026

This follow-up profiles the worker implementation before changing product behavior. The confirmed startup bottleneck is **Build command-contract compilation**. The fix is limited to `kernel/src/api/contract.ts`: an empty schema or `true` already accepts every JSON value, so those validators no longer create Ajv instances. All constrained schemas still compile eagerly in isolated instances. There is no new validator cache, shared schema namespace, worker, or recovery path. This matches [JSON Schema's definition of unconstrained schemas](https://json-schema.org/understanding-json-schema/basics).

### Attribution

The harness now captures a main-process V8 CPU profile before importing the Electron entry, a renderer CPU profile before the first application navigation, and a Chromium timeline covering startup, run opening and reply input. Profile start-command brackets map CPU samples onto epoch time with recorded alignment uncertainty (approximately 2–17 ms in these recordings). A renderer User Timing marker aligns the Chromium timeline with IPC, heartbeat and interaction timestamps. Hidden source maps resolve renderer samples to source functions without changing the production JavaScript bytes. CPU samples are estimates; nested inclusive times must not be added together.

- **Build initialization:** the standard fixture's largest profiled main gap was 312 ms. `createV2BuildController → registerStackCommands → CommandMap.register → compileContract → validator` spent about 191 ms compiling schemas. Seven legacy Build commands each compiled three unconstrained contracts, repeatedly initializing Ajv and its meta-schemas. The large fixture confirmed approximately 197 ms in `compileContract`, within a 322 ms main gap. `discoverContributions → readContribution` contributed another 62–64 ms. The fix removes the 21 unnecessary compilations; a deterministic regression gate now checks that real Build registration makes zero Ajv compile calls.
- **Other startup work:** initial module loading, `createEngine`, seeding/tool-store setup and telemetry initialization remain. Native `createWindow`/`ImageView` also contributed about 100 ms in the profiled launch. These explain why removing Build compilation does not eliminate startup stalls.
- **Snapshot/log transfer and folding:** in the large fixture after the change, opening a run took 87 ms to the observed reply DOM. `readDailyRun → watchingFromRun → foldTrace` accounted for approximately one 1.6 ms CPU sample. The renderer's largest native reply-message task was about 11 ms; its first layout took 22 ms. This recording does not identify trace folding as the dominant stall. IPC durations include worker waits and result preparation; they are not a direct measurement of serialization alone.
- **React and presentation:** the large opening recorded about 7 ms under the React scheduler, including `BlockEditor.NodeView`. During reply typing, React samples were small and the largest renderer task was about 10 ms in the after recording. In the before recording, the GPU thread reached 69 ms in `Scheduler::RunTask` and 47 ms in `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`. Slow interactions clustered near the first reply frames and spent most of their time waiting for presentation. This supports investigating first-frame raster/compositor work next; it does not establish which CSS effect or GPU operation causes all of the delay. React commit durations from a special profiling build were not collected.

The recorder now reports **input queue delay, handler duration and presentation delay** from Event Timing, selecting the longest event for each interaction ID before computing percentiles. Presentation delay is `startTime + duration − processingEnd`, clamped at zero for quantization. These are Chromium estimates with 8 ms rounding and a minimum 16 ms reporting threshold; faster interactions are omitted. They are not INP or physical display-latency measurements. The previous input-to-animation metric remains separately labeled. See Chromium's [interaction breakdown](https://developer.chrome.com/docs/performance/insights/inp-breakdown).

### Comparison and evidence

Three serial before/after repetitions use each existing fixture, alternating which variant runs first. They use the same production renderer, temporary project/profile data, real Electron input and IPC, and no provider calls. CPU tracing is disabled for these comparisons. The baseline temporarily removes only the fast path from the generated kernel module; the driver restores that file in `finally`. Product source and all recovery/worker behavior remain identical between variants. The test window stays on top to maintain the required foreground state. An earlier occluded run correctly paused polling and is retained as an invalid measurement, excluded from the comparison.

| Fixture | Maximum main gap before, three runs | Maximum main gap after, three runs | Median reduction | Median gap overlapping Build, before → after |
|---|---:|---:|---:|---:|
| 100 runs, 200 chunks/run | 329–345 ms | 181–189 ms | 335 → 188 ms (44%) | 335 → 107 ms |
| 10 runs, 2,000 chunks and 2 MiB tool result/run | 329–358 ms | 202–214 ms | 353 → 210 ms (40%) | 353 → 118 ms |

Build IPC duration also fell: the standard fixture's median was **307 → 87 ms** and the large fixture's **334 → 102 ms**. Heartbeat gaps include scheduling and neighboring work, so they are distinct from the IPC and sampled-function durations. This meets the startup-stall improvement criterion. Composer DOM readiness and run-opening latency did not improve consistently across both fixtures: standard run opening was 73–82 → 71–78 ms, large opening 90–126 → 95–126 ms. No general navigation or cold-launch speedup is claimed.

**Reply typing remains above target.** The standard fixture's per-run interaction p95 was 136–176 ms before and 144–152 ms after. Afterward, its input-queue p95 was 0.4 ms, handler p95 1.0–1.1 ms and presentation p95 144–152 ms. The large fixture's interaction p95 was 152–168 → 120–184 ms; afterward, queue p95 was 0.4–9.0 ms, handler p95 0.9–1.0 ms and presentation p95 108–184 ms. These thresholded, small-sample tails establish neither a consistent typing improvement nor the proposed 50 ms target. They do show why further React isolation would be speculative without investigating the first presented frames.

All twelve valid comparison scenarios preserved the typed composer/reply drafts, including after concurrent reads and detail expansion/collapse; each observed exactly two shared polls in eleven seconds and delivered real input while reads were in flight. Recovery checks and full-suite validation are recorded in [validation.json](reviews/performance-2026-09-09/startup/validation.json).

Results are recorded in [the comparison report](reviews/performance-2026-09-09/startup/comparison.json). Raw profiled reports: [standard before](reviews/performance-2026-09-09/startup/attribution-before.json), [standard after](reviews/performance-2026-09-09/startup/attribution-after.json), [large before](reviews/performance-2026-09-09/startup/attribution-large-before.json), [large after](reviews/performance-2026-09-09/startup/attribution-large-after.json). Their CPU profiles, Chromium traces and matching renderer source maps are preserved in [startup-profiles.zip](reviews/performance-2026-09-09/startup/startup-profiles.zip); extract it to inspect the profiles and timelines in DevTools. The before/after CPU reports were reprocessed with source mapping and recursive-inclusive de-duplication from the original recordings.

Reproduce profiling with `npm run perf:profile`. It builds production JavaScript with hidden source maps and enables finite CPU/timeline capture. `FLYT_PERF_OUTPUT` selects the JSON report; neighboring `-main.cpuprofile`, `-renderer.cpuprofile` and `-trace.json` files contain the raw recordings. Use the same `FLYT_PERF_RUNS`, `FLYT_PERF_CHUNKS` and `FLYT_PERF_TOOL_BYTES` values as the existing scenarios. Use `npm run perf:app` for comparisons without profiling overhead. The production bundle warning remains; installed-release launches, live streams, slower hardware and a soak remain outside this measurement.

## Reply presentation follow-up — 9 September 2026

The confirmed contributor is the **sticky reply bar's translucent background and `backdrop-filter: blur(8px)`** in `src/v2/workStyles.css`. It adds graphics work just as the first reply frames are being presented. The product change makes that surface opaque with `background: var(--canvas)` and removes the filter. Its position, dimensions, input behavior and focus indicator remain the same.

### Distinguishing first use from sustained typing

The probe now optionally appends a second reply burst after one second, starting another snapshot/log read. Across twelve valid comparison runs, the first burst's sampled interaction p95 ranged from 104–160 ms with the original blur. The second burst was already 16–24 ms. Thus the previous reply tail describes a stall concentrated near opening/focusing the reply view, not continuously slow keystroke handling.

Single-run screening controls did not eliminate the initial tail: disabling concurrent reply reads recorded 112 ms p95; disabling Work animations/transitions recorded 136 ms; replacing the native focus outline recorded 168 ms. Removing the backdrop filter alone recorded 104 ms, and an opaque surface recorded 104 ms, against 128 ms in the screening baseline. These are exploratory samples, not separate validated optimizations. They narrow the investigation; they do not rule out data or React costs in larger live workloads.

Reusing the same synthetic Chromium profile across three launches recorded 136, 144 and 144 ms first-burst p95, while later bursts stayed at 16–24 ms. A fresh on-disk cache is therefore not a sufficient explanation. Per-view/process graphics initialization is plausible, but shader compilation or a particular driver function has not been established as the remaining root cause.

### Controlled result and trace attribution

Three unprofiled fresh-profile repetitions per variant and fixture used the same production JavaScript, alternating variant order. The before variant used the original CSS; the after variant injected only the opaque reply-bar override. Four focus-contaminated runs were retained separately and replaced; all twelve accepted comparisons have zero focus recoveries. One earlier run lost draft characters when unfocused and was also excluded. The harness now focuses the window before each initial typing phase and records any subsequent recovery.

| Fixture | Original first-burst p95, three runs | Opaque first-burst p95, three runs | Median of run p95 values | Later-burst p95, both variants |
|---|---|---|---|---|
| 100 runs, 200 chunks/run | 128, 136, 160 ms | 88, 64, 72 ms | **136 → 72 ms (47% lower)** | 16–24 ms |
| 10 runs, 2,000 chunks and 2 MiB tool result/run | 152, 104, 144 ms | 32, 48, 88 ms | **144 → 48 ms (67% lower)** | 16–24 ms |

These are small, thresholded Event Timing samples grouped by interaction ID: entries below 16 ms are omitted and durations are quantized to 8 ms. The values are not whole-session INP or percentiles over every keystroke. [Raw comparisons and timing breakdowns](reviews/performance-2026-09-09/reply/reply-comparison.json) can be regenerated with the neighboring `compare-reply.mjs`.

Matched CPU/Chromium recordings on the rebuilt large fixture restore the original CSS with `blurred-reply` for the before recording and use unmodified production CSS afterward. During the first reply burst:

- GPU-thread `Scheduler::RunTask` maximum overlap fell **67.81 → 30.34 ms**; summed spans fell **188.28 → 119.93 ms**. These are GPU-process thread durations, not a measurement of GPU hardware execution time.
- Renderer-main maximum tasks stayed **10.82 → 10.31 ms**. Initial run-opening layout stayed **21.81 → 21.50 ms**. These costs did not account for the improvement.
- Raster flush work remains: `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` maximum overlap was **25.09 → 30.29 ms**. Removing blur does not eliminate first-frame rasterization. The 68 ms before task contains shader-cache activity and presentation but lacks enough nested instrumentation to assign its full cost to a specific native function.

This combination of repeated CSS intervention and correlated trace evidence establishes the blurred reply surface as a contributor. It does not establish that all presentation delay comes from blur. Both profile recordings regained focus during the later burst; only their unaffected opening/first-reply phases are used for this attribution. Profiled timings are kept separate from unprofiled comparisons. [Before profile report](reviews/performance-2026-09-09/reply/reply-profile-large-blurred-reply.json), [after profile report](reviews/performance-2026-09-09/reply/reply-profile-large-baseline.json), and [raw profiles, traces and matching assets](reviews/performance-2026-09-09/reply/reply-profiles.zip).

The machine used Windows, AMD Ryzen 7 3800X and NVIDIA RTX 3080, driver 32.0.15.9186, hardware-accelerated ANGLE D3D11 / Skia GaneshGL. The reports now capture GPU details after the measured phases. The complete GPU-info query sometimes produces a Chromium command-buffer error during forced test-app shutdown; successful reports and scenario assertions precede it. This is recorded as a harness limitation, not evidence of a typing-time GPU crash.

### Shipping change, validation and remaining work

The actual rebuilt CSS, without an injected override, recorded **88 ms** first-reply p95 in the standard fixture and **56 ms** in the large fixture; later bursts were **16 and 24 ms**. Both verified the opaque computed style and sticky positioning, exact drafts after reads and detail expansion/collapse, real input during in-flight reads, and two shared polls in eleven seconds. The standard run had a focus recovery during the earlier composer phase; its reply phases were unaffected. [Standard build verification](reviews/performance-2026-09-09/reply/reply-production-100-baseline.json), [large build verification](reviews/performance-2026-09-09/reply/reply-production-large-baseline.json), and [inspected screenshot](reviews/performance-2026-09-09/reply/reply-production-large-baseline.png).

Production build passed with the existing chunk warning. All **30 performance tests and 9 daily Work tests passed**, including worker-assisted recovery, canonical validation, ownership and torn-tail cases. This CSS change introduces no recovery or draft-state logic. [Validation record](reviews/performance-2026-09-09/reply/validation.json).

The improvement is measured, but the proposed 50 ms first-burst target remains inconsistent. Before another optimization, capture the remaining 20–30 ms raster/flush spans with native GPU-process attribution on an installed build and a second GPU; correlate them with the first focused-input paint and font/glyph work. Compare run-opening and later typing separately, including a live-stream case. Avoid adding warm-up delays to the measured interaction or changing global GPU flags to make this fixture pass. There is no current evidence for another broad React/worker redesign.

To reproduce, set `FLYT_PERF_REPLY_REPEAT='1'` and use `npm run perf:app` for unprofiled timings or `npm run perf:profile` for attribution. After this fix, the default `baseline` experiment means current production CSS; use `FLYT_PERF_REPLY_EXPERIMENT='blurred-reply'` to restore the old style. Set unique `FLYT_PERF_OUTPUT` paths and alternate the variants. Optional `FLYT_PERF_PROFILE_KEY` reuses only a named synthetic profile; omit it for a fresh profile. `FLYT_PERF_SCREENSHOT='1'` captures the final synthetic view. Clear these environment variables afterward. Screening files named `reply-screen-*` and comparison files named `reply-confirm-*-baseline-*` predate the CSS build and therefore use the original blurred baseline; each report records its computed style.

## Remaining raster operation identified — 9 September 2026

The large remaining native operation is **shader compilation/linking for the selected conversation row's inset highlight**, painted as Skia `FillRRectOp`. The trigger is `src/v2/workStyles.css:35`:

```css
.work-history-item.active {
  /* Other selected-row styling omitted. */
  box-shadow: inset 2px 0 0 var(--accent);
}
```

The row also has `border-radius: 8px`. Its initial paint occurs while the newly opened run's first reply interactions are waiting for presentation. The stall is not the cost of drawing each subsequently typed character.

The recorder's new `FLYT_PERF_RASTER=1` option adds `disabled-by-default-skia.gpu`, `disabled-by-default-skia.shaders`, and `gpu.angle` to CPU/timeline profiling. These expose the chain previously hidden inside `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`:

```text
GrDrawingManager::flush
  → OpsTask::onExecute
    → FillRRectOp
      → shader_compile / GrGLProgramBuilder::finalize / cache_miss
        → driver_link_program
          → Program::MainLinkLoadEvent::wait
            [ANGLE worker tasks run D3DCompile]
```

In the first focused baseline, `shader_compile` took **31.37 ms**, including **28.59 ms** in `driver_link_program` and **28.49 ms** waiting for ANGLE's link/load tasks. A corresponding vertex `D3DCompile` worker span took **20.44 ms**. These nested/concurrent durations must not be added. ANGLE's [implementation of the link/load wait](https://chromium.googlesource.com/angle/angle/+/refs/heads/main/src/libANGLE/Program.cpp) confirms that it waits for the worker event and link subtasks. The later reply burst had no shader compilations; baseline `AtlasTextOp` spans during initial typing peaked at only **0.14 ms**.

### Isolation and confirmation

Thirteen focused recordings used the same production build, synthetic large fixture and renderer input scenario. All completed their draft, detail-toggle, read-overlap and polling assertions with zero focus recoveries. The controls changed only injected styles:

- Squaring the textarea, removing its focus outline, or holding Send-button opacity constant did not remove the roughly 32 ms compile.
- Hiding the run's block display also retained it. Hiding the history sidebar/header removed it; hiding only the history sidebar then removed it as well.
- **Removing only `.work-history-item.active`'s inset shadow removed the `FillRRectOp` shader compilation.** A fresh matched pair repeated this result: **31.95 ms → no such compile**. That baseline span straddled opening and typing, with about **20.9 ms overlapping the typing phase**; it is one operation, not two.
- Squaring activity cards/notches or all Work corners did not reliably eliminate this shader. Broad corner removal is therefore not the proposed fix.

The matched pair still recorded **56 ms first-burst p95 in both variants**. Several other initial shader compilations remained under `FillRectOp`, approximately 6–13 ms each. This establishes a specific cause of the previously unattributed raster span, **not an additional proven end-to-end latency improvement or the 50 ms target**. No selected-state styling was removed from production in this investigation. The next focused implementation should preserve the selected-row indicator while replacing the inset-shadow draw, then compare unprofiled first-interaction maximum and tail timings as well as run-opening presentation. A replacement can create different shaders, so its benefit must be measured.

[Per-operation summaries](reviews/performance-2026-09-09/raster/raster-summary.json), [matched baseline](reviews/performance-2026-09-09/raster/raster-confirm-baseline.json), [matched shadow-removal control](reviews/performance-2026-09-09/raster/raster-confirm-no-history-shadow.json), and [matched CPU profiles, native timelines and renderer assets](reviews/performance-2026-09-09/raster/raster-confirm-profiles.zip) preserve the evidence. The adjacent `summarize-raster.mjs` accepts report paths and can read neighboring extracted trace files for the matched pair.

Reproduce with `FLYT_PERF_CPU=1`, `FLYT_PERF_RASTER=1`, `FLYT_PERF_REPLY_REPEAT=1`, and the large fixture variables, then run `node scripts/profile-app.mjs` against a built production bundle. Compare `FLYT_PERF_REPLY_EXPERIMENT=baseline` with `no-history-shadow`. These are diagnostic variants, not product preferences. An initial all-category trace serialized picture/display lists for over 500 ms and failed its input/read-overlap assertion; it was excluded and its report retained as `excluded-deep-trace.json`. The final recorder deliberately excludes those categories.

The system temporary drive filled during one fixture setup, before profiling started. Completed synthetic profiles were preserved on the workspace drive, and the final matched pair used fresh profiles with both `TEMP` and `TMP` pointing to `.flyt/performance/temp` on that drive. No timing claim uses the failed launch. Native attribution remains specific to this Windows/NVIDIA/ANGLE configuration. This investigation changed the profiling harness and documentation only; script syntax checks and all six performance-metrics tests passed.

## Selected-history marker replacement — 9 September 2026

The targeted product change replaces `.work-history-item.active`'s inset shadow with an absolutely positioned **2 px accent marker**, inset 8 px from the top and bottom. The active row keeps its background, text color, rounded shape and layout. The marker does not intercept pointer events. The matched screenshot and computed geometry show the same **211 × 49 px** row at the same position before and after; [the inspected production screenshot](reviews/performance-2026-09-09/marker/marker-profile-baseline.png) shows the selected row and intact reply draft.

### Measured result

The matched native trace confirms that the replacement avoids the identified shader: **31.23 ms `FillRRectOp` compilation before, no such compilation afterward**. Smaller `FillRectOp` and other initial compilations remain. The profiled first-burst p95 was 120 → 48 ms, but that single pair is attribution evidence; the unprofiled repetitions below establish the interaction result. [Native raster summaries](reviews/performance-2026-09-09/marker/raster-summary.json), [before profile report](reviews/performance-2026-09-09/marker/marker-profile-history-inset-shadow.json), [after profile report](reviews/performance-2026-09-09/marker/marker-profile-baseline.json), and [profiles, traces and matching built assets](reviews/performance-2026-09-09/marker/marker-profiles.zip).

Three fresh-profile unprofiled repetitions per variant and fixture used the same rebuilt JavaScript/CSS, alternating order. `history-inset-shadow` restores the old shadow and suppresses the marker; `baseline` uses the actual production marker without an override. Both variants use synthetic profiles/data on the workspace drive.

| Fixture | Original first-burst p95, three runs | Marker first-burst p95, three runs | Median p95 | Median worst interaction |
|---|---|---|---|---|
| 100 runs, 200 chunks/run | 64, 64, 64 ms | 40, 56, 32 ms | **64 → 40 ms (38% lower)** | **96 → 64 ms** |
| 10 runs, 2,000 chunks and 2 MiB tool result/run | 80, 96, 104 ms | 40, 40, 72 ms | **96 → 40 ms (58% lower)** | **104 → 64 ms** |

The second burst's p95 ranged from 16–24 ms before and 16–32 ms afterward. This follow-up establishes improvement in the initial burst, not in sustained typing. Individual after runs still exceeded the proposed 50 ms target. These are small Event Timing samples grouped by interaction, excluding durations below 16 ms and quantized to 8 ms; they are not percentiles over every keystroke or session INP. [Full distributions, indicator styles and assertions](reviews/performance-2026-09-09/marker/marker-comparison.json) can be regenerated with `node docs/reviews/performance-2026-09-09/marker/compare-marker.mjs docs/reviews/performance-2026-09-09/marker`.

### Probe correction and behavior validation

Two preliminary standard-fixture trials failed the probe's required input/read overlap: snapshot/log reads finished within approximately 3 ms, before the separate return from `executeJavaScript` allowed the main process to send a key. One successful preliminary trial used that same earlier scheduling. All three reports are retained with `excluded` or `previous-input-scheduling` names and are outside the final comparison.

The probe now dispatches the first reply key when the real main-process snapshot handler starts; subsequent keys remain 30 ms apart. It records actual renderer event timestamps and still asserts overlap with an in-flight read. It adds no artificial I/O delay or warm-up pause. The entire twelve-run unprofiled comparison was restarted under this scheduling for both variants. The two native profile recordings above predate this probe correction, already passed overlap, and are kept separate from the unprofiled timing cohort.

All twelve final runs passed with **zero focus recoveries**, input during real reads, two shared polls in eleven seconds, and exact composer/reply drafts preserved through concurrent reads and detail expansion/collapse. Computed-style assertions verified the marker's presence, 2 px width, lack of shadow and `pointer-events: none`. Production build and focused regression results are recorded in [validation.json](reviews/performance-2026-09-09/marker/validation.json).

To reproduce, build production assets and compare `FLYT_PERF_REPLY_EXPERIMENT=history-inset-shadow` with `baseline`, setting `FLYT_PERF_REPLY_REPEAT=1` and unique output paths. Use `FLYT_PERF_CPU=1` plus `FLYT_PERF_RASTER=1` only for native attribution, separately from latency repetitions. Set `TEMP` and `TMP` to the existing workspace `.flyt/performance/temp` directory to keep these synthetic profiles off the space-constrained system drive. No draft, recovery, selection-state or application data code changed.

## Original findings and priorities

### 1. History refresh performs recovery over completed history — measured, highest priority

`src/v2/DailyRoot.jsx:174` polls `history:activity` every five seconds, even when another destination is selected. `src/v2/ChatHistoryPage.jsx:13` adds another poll while Chats is mounted. Both call `core/api.js:1075`, which awaits `runController.reconcile(projectId)` before returning summary rows.

`core/runController.js:139` deduplicates simultaneous recovery requests, but deletes the entry when recovery finishes. The next refresh repeats recovery. `kernel/src/session/jsonl.ts:561` enumerates sessions and synchronously reads the complete log of each non-live run merely to discover that its last stage is terminal.

Git history places the history endpoint in `d2db511` (v2.1.6, 8 September). This connects a recent feature to recurring work in an existing recovery path. It is a plausible explanation for the reported recent deterioration, not a controlled comparison against the installed previous release.

Recommended change: separate recovery from ordinary list reads. Recover on project activation and relevant ownership/lifecycle changes; maintain a rebuildable summary index and an invalidation strategy for newly discovered or changed sessions. An unchanged completed run should require no full-log read during routine history refresh. Keep lease/owner checks and canonical-log validation before resume or other mutations. Do not fix responsiveness by skipping those correctness checks or trusting potentially stale `meta.json` as execution authority.

Have one shared history subscription/cache per active project. Pause unnecessary polling when the document is hidden, avoid duplicate consumers and overlapping requests, and preserve already loaded rows while refreshing. Use activity changes to invalidate the relevant summaries. A cached history read should remain cheap as total historical log bytes grow.

### 2. Long-run rendering still contains unbounded work — verified code paths, cost not measured yet

`src/v2/Work.jsx` computes `runView(trace, snapshot)` on every render, including reply typing. `src/v2/runView.js:276` walks the trace to rebuild block states, metrics and activity, then sorts activity items. `src/v2/BlockEditor.jsx:132` constructs and formats activity bodies even inside collapsed native `<details>` elements, and `BlockActivity` mounts every item.

Consequences to measure: increasing reply latency as a conversation grows, formatting large tool results the user has not opened, and repaint/layout costs when live updates arrive. This is distinct from the measured history stall.

Recommended change: isolate composer state from the run view; memoize derived data against actual trace/snapshot changes; incrementally update per-block summaries; page/window long activity lists; mount expensive details only when expanded. Preserve text selection, scroll position and the user's expanded items. `React.memo` alone is insufficient where parent code creates new objects on every update.

### 3. Startup boundary is too coarse — measured bundle, inferred impact

The build succeeds but reports a **522.52 kB** minified DailyRoot chunk (154.97 kB gzip), alongside 147.54 kB entry JavaScript and approximately 296 kB total CSS. The warning threshold is 500 kB. Its existence does not identify an ongoing runtime bottleneck, and raising the warning limit would improve nothing.

`src/Root.jsx` lazily imports the entire daily host with `fallback={null}`. `DailyRoot` and `Shell` statically import secondary destinations, so moving everything behind a single lazy import does not make the prompt surface small. Models, Goals/evaluation, Library and other secondary screens belong behind finer boundaries where dependencies permit. The block editor is shared with Work, so splitting it requires understanding that dependency rather than simply moving a filename.

The app already starts Build asynchronously, but doing work in a promise still consumes the main process or renderer thread. `DailyRoot` also joins projects, recents, workflows and settings through `Promise.all`, coupling their availability. `index.html` loads a Google Fonts stylesheet over the network; bundling fonts would remove an avoidable network-dependent startup variable. Font swap helps text display but does not remove the stylesheet request.

Recommended sequence: render stable application chrome and an editable composer promptly; hydrate essential state independently; show genuine readiness for actions that require the kernel; load secondary screens on intent or after essential work settles. Preloading while the user types is appropriate if the preload itself cannot monopolize the interactive threads. Move expensive parsing/indexing to a worker or utility process, and break remaining main-thread work into bounded tasks. Preserve drafts across loading and navigation.

### 4. Snapshot and other background paths need their own budgets

`StoredStackSnapshotReader` caches parsed events for unchanged files, but rereads on size changes and still projects snapshots. The initial `readDailyRun` requests both snapshot and log; loading a long run can transfer and fold significant data even if Trace is closed. DailyRoot can also fetch ten block-history snapshots for the selected Build workflow while another screen is active.

Goals polls at 1.5 seconds and rechecks requirements every five seconds; its authoring UI also writes local storage during editing. Telemetry and diagnostic logs have synchronous I/O paths. These are inspection findings, not demonstrated causes in this run. Instrument them before changing their semantics.

There are useful optimizations to retain: canonical event batches every 80 ms, background-project push suppression, incremental trace feeding, cached stored events, paged Chats/Trace lists, deferred formatting of Trace's unknown-event payload, and memoized Markdown. There is no reason to discard those systems wholesale.

## Measuring normal usage

The added harness records IPC duration and main-process heartbeat stalls alongside Chromium event timing, long tasks and long animation frames. The samples use absolute timestamps, so slow actions can be aligned across processes. No IPC arguments, return payloads, typed text or DOM text are included by the recorder. Script attribution identifies code locations when Chromium provides it. Detailed payload privacy still needs review before making general-purpose production recordings shareable.

For the shipping app, add an opt-in **Record performance** control under diagnostics, with Stop/export and a short bounded in-memory history. The synthetic harness is a foundation for that feature, not a recorder already installed in the normal app. A useful recording should contain:

| Signal | What it distinguishes |
|---|---|
| Input queue delay, handler duration, presentation delay | Typing/click lag versus waiting for results |
| Long frames/tasks and renderer CPU profiles | JavaScript, layout/paint and garbage-collection costs |
| Main-process heartbeat plus handler and subsystem spans | IPC queue starvation versus expensive API work |
| Event batch counts/bytes and snapshot fold durations | Excess updates or costly data transfer |
| React commits for selected subtrees, in a profiling build | Unnecessary or expensive rendering |
| Process CPU and memory samples across a session | Sustained load or possible memory growth |
| App/window/shell/composer/run-ready milestones | Blank-window time versus deferred service readiness |

Use batched, capped records and sampling. Do not synchronously append a diagnostic line for every frame or token: the recorder must not become the next source of lag. Keep expensive CPU tracing opt-in and finite. Group Event Timing entries by interaction ID before deriving interaction percentiles; the harness's raw event entries are not a complete INP implementation. A single end-of-run heap sample does not establish a memory leak.

Electron's [performance guide](https://www.electronjs.org/docs/latest/tutorial/performance) recommends keeping its main process and renderer free of blocking work. Chromium's [INP breakdown](https://developer.chrome.com/docs/performance/insights/inp-breakdown) and [Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames) explain the timing and attribution signals used here.

## Running the probes

From the repository:

```powershell
npm run perf:core
npm run perf:app
npm run test:perf
npm run perf:check
```

Reports default to `.flyt/performance/core.json` and `app.json` and are overwritten by the next run. These are ignored runtime artifacts; the checked-in baseline above is preserved separately. Set `FLYT_PERF_OUTPUT` to keep a separate report.

The app probe creates its own profile, home and 100-run project. It uses the production bundle but a development Electron launch, and leaves the temporary profile under the OS temp directory for investigation. It does not open the user's real projects. To exercise the fixture manually after the automatic scenario:

```powershell
$env:FLYT_PERF_RUNS = '500'
$env:FLYT_PERF_RECORD_SECONDS = '60'
npm run perf:app
```

For a core regression gate, select fixture sizes and an explicit budget:

```powershell
$env:FLYT_PERF_COUNTS = '10,100,500'
$env:FLYT_PERF_MAX_HISTORY_MS = '100'
npm run perf:core
```

The timing budget now applies to warm history samples; cold validation is reported separately. The 500-run fixture still exceeds that proposed 100 ms budget. The gate writes evidence and failure reasons before exiting nonzero. Clear these environment variables when returning to default measurement mode. Core `syncReadBytes` counts explicit `fs.readSync` reads, not all filesystem operations; `summaryReadCalls` counts `meta.json`/`prompt.md` opens. Instrumentation itself has overhead.

Use `FLYT_PERF_REPEATS` (2–100, default 5) for core repetitions. Both probes accept `FLYT_PERF_CHUNKS` (0–10,000) and `FLYT_PERF_TOOL_BYTES` (0–16 MiB per run). The large-payload Electron scenario above used:

```powershell
$env:FLYT_PERF_RUNS = '10'
$env:FLYT_PERF_CHUNKS = '2000'
$env:FLYT_PERF_TOOL_BYTES = '2097152'
$env:FLYT_PERF_OUTPUT = '.flyt/performance/app-large.json'
npm run perf:app
```

Clear those environment variables afterwards; they otherwise affect later measurements. Fixture generation is outside measured action time and uses temporary synthetic projects.

Original audit validation: production build passed with the existing warning; core fixture row-count assertions and Electron typing/navigation assertions passed; an intentionally impossible 1 ms budget failed with a saved report; 19 existing build, daily-work and projection tests passed. Implementation validation is recorded in the follow-up above.

## Acceptance plan for the optimization work

Start by eliminating the measured repeated recovery scans, then share history loading, isolate the composer and split startup work. Establish baselines before changing each area. Keep pure function timing tests, production Electron interaction scenarios and real-use recordings as separate layers.

Extend the current settled-history scenario with long live streams, large tool results, hundreds of generated blocks, multiple active projects, Goals/evaluation polling, slow/offline network, cold launch, project switching, Trace expansion and a 30–60 minute soak. Replay recorded event shapes and timing without executing provider/tool effects. Test installed release builds as well as `dist`; include a slower machine and controlled CPU throttling for the renderer, while recognizing that renderer throttling does not throttle Electron's main process.

Proposed starting targets, to calibrate on declared hardware: typing response p95 under 50 ms and p99 under 100 ms; cached navigation feedback under 100 ms; no recurring foreground main-process tasks over 50 ms; frame work within the display's budget (16.7 ms at 60 Hz); usable composer within one second of a defined cold-launch boundary. Background work can take longer, provided it yields promptly and the UI keeps accepting input. Run several repetitions and track distributions and relative regressions; one noisy sample should not determine release quality.

The next implementation should demonstrate that unchanged history stops rereading session bodies, that recovery remains correct after crashes and external changes, and that the Electron scenario has materially smaller recurring stalls. That is a reviewable performance improvement with a regression test, rather than a speculative deep clean.
