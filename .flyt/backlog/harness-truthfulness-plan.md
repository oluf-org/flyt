# Making the harness able to stop, and able to say what happened

Status: **implemented 2026-08-21.** Created the same day, from defects found
while hand-building Phase 0 (`t-0035`) and watching the Loop work three tasks.
Tasks `t-0049`–`t-0054`, all landed.

| Task | Landed as |
|---|---|
| `t-0049` | `core/loopLog.js`, `emitLoop` writing a day file, `flyt loop log`, the report's "What the loop said" |
| `t-0050` | `workSignature()` rebuilt on accomplishment, workspace sampling in `core/supervisor.js`, `medianMs` wired, **D64** |
| `t-0051` | `liveSpend()` / `totalsWithLive()` in `core/ledger.js`, used by `ledger:totals`, the report and the supervisor |
| `t-0052` | `checkFlags()` in `bin/flyt.js`, the flag table, and a test that reads the help |
| `t-0053` | `staleIndexLock()` in `core/diagnostics.js`; `--no-optional-locks` on the polled read landed with `t-0050` |
| `t-0054` | `COVERAGE` in `tests/dshCompat.test.js`, derived from the kernel's own `declare module` blocks |

One deviation from the sequencing below: `t-0054` was gated behind Phase 1 on
the grounds that it should arrive "with the seam that needs it". That was
backwards. The rule exists to catch the seam that gains a provider, so
encoding it after that seam arrives is encoding it after the moment it was
supposed to fire. It is in now, listing every declared service and failing on
one it has never heard of — verified by adding a service and watching it go
red.

> A planning artifact, not a live `*.task.md`. It exists because the six
> defects below are four symptoms of two causes, and fixing them one at a time
> in the order they were noticed would leave both causes standing.

## The finding

The Loop spent $2.31 across five attempts on two tasks and landed one of them.
Every failure was budget exhaustion, and in each case the ladder that exists to
stop a task before it exhausts a budget did not fire. It could not have:

| Detector | Fires on | Why it never fired |
|---|---|---|
| `spin` | identical work, repeatedly | the work signature changes on every poll |
| `silent` | no event for 10 minutes | same |
| `burn` | money spent with nothing changing | same, and its counter was fed `usd: 0`, and it had no threshold |
| `outlier` | 4× the median for this class of task | `detectStall` is never given a `medianMs`, so the branch is unreachable |
| `groundhog` | the same gate failure three times | it fires — fed separately by `observeGate` |

One rung of five. `DESIGN-SPEC.md` §11 describes the ladder as how an
unattended loop protects itself; what shipped is a gate-failure detector and
four dead branches with tests in front of them.

**The cause of the first three is one line.** `workSignature()` hashes
`taskOutputs`, and `streamInto()` rewrites `tasks/<id>.md` every 250ms while a
model is talking. So every poll sees "new work", `repeats` resets to 0,
`lastProgressAt` resets, and `idleMs` stays at 0 for as long as the model keeps
producing tokens. Observed directly: an eleven-minute attempt with 40 model
calls, 66 tool calls and no workspace change reported `idleMs: 0, repeats: 0,
usdSinceProgress: 0` on every poll until it hit the per-task cap.

The second cause is smaller and shows up in every diagnosis: **the loop's
account of the night is memory-only.** `emitLoop` appends to a ring buffer and
emits an event. When the process ends, why each attempt failed is gone —
reconstructable only from run artifacts, one run at a time, by somebody who
knows where to look. Working out the paragraph above took an hour of reading
call traces.

## What "progress" has to mean

Streaming is the model talking. A tool call is the model acting. Neither is
accomplishment. The fix is to define progress as **the durable record
changing**, and to say so in one place:

- a node or task **status** changed;
- a **finished** node output changed (a node whose status is `done`, never a
  streaming buffer);
- the **workspace diff** changed, for a node that declared
  `effect: workspace-change` — the same `git status --porcelain` the effect gate
  already runs at the end of a task, asked once per poll instead of once;
- a **write** tool call settled, for a node that declared no effect.

Reading is not progress, and this is the case that matters: the attempt that
cost $0.97 made 66 tool calls, every one of them a read. A signature counting
tool calls would have called that progress too, which is why the workspace is
the measure where a workspace change was promised.

The risk is a false positive on a task that legitimately reads for a long time
before writing. Three things bound it: the ladder's first rung is a nudge and
not a kill, the thresholds are minutes rather than seconds, and a node that
declares no effect falls back to the tool-call signal.

## The order, and why

`t-0049` before `t-0050`, although `t-0050` is the bleeding wound: the durable
log is small, has no design risk, and is the instrument that makes `t-0050`
verifiable in the wild rather than only in tests. Everything after is
independent and can be worked in any order, or in parallel.

| Task | What it fixes | Who should do it |
|---|---|---|
| `t-0049` | the loop's account of the night dies with the process | Loop, medium |
| `t-0050` | four of five stall detectors cannot fire | **a human** — it redefines what the ladder means |
| `t-0051` | spend is reported late by every reader except `loop status` | Loop, low |
| `t-0052` | a mistyped flag silently changes what runs, including a cap | Loop, low |
| `t-0053` | a killed `git` leaves a lock that blocks every later commit, unattributed | Loop, low |
| `t-0054` | the compat promise is broader than the suite that tests it | with the seam that needs it |

`t-0050` is not the Loop's work. The Loop is the thing being changed, the change
is a redefinition rather than an implementation, and a worker that gets it
subtly wrong produces a harness that stops good tasks — which is worse than the
current harness that stops none.

## The defects, and what closes each

### `t-0049` — the loop's account of the night survives the process (HT-02)

`emitLoop` gains a file. One line per event under the project's `.flyt/`, with
the task id, so `flyt report` and a person can both answer "what happened to
t-0014 last night" without opening five run folders. Bounded like the ring
buffer is, rotated by day like the ledger. After the Phase 5 cutover this
becomes a projection of the session log (D55) rather than a second mechanism;
the file is written now because the loop needs it now, and D55 says the record
must not depend on memory surviving.

### `t-0050` — progress means the work changed, not that the model spoke (HT-01)

`core/heartbeat.js` `workSignature()`, plus the `medianMs` the supervisor never
passes. Closed when each of the five detectors has a test that makes it fire
against a *realistic* heartbeat — one whose streaming buffer is changing on
every poll — and a test that a task streaming steadily while accomplishing
nothing reaches an intervention. The thresholds get re-read at the same time:
they were tuned against a signature that reset constantly, so they have never
been exercised.

When it lands, the rule it establishes belongs in `DECISIONS.md` rather than
here: **progress is the durable record changing, not the model producing
tokens.** It decides what an unattended loop is allowed to keep paying for,
which is exactly the kind of thing the register exists to hold.

### `t-0051` — every spend reader counts what is in flight (HT-03)

`loop status` learned this today; `flyt spend`, `flyt report` and
`ledger:totals` did not. A person asking what a running loop is costing gets
the last settled total, which is $0 for the whole first attempt. One helper,
used by every reader, with `live` broken out so settled and in-flight stay
distinguishable.

### `t-0052` — an unusable flag is refused, not ignored (HT-04)

`flyt task list --stauts queued` runs, ignores the typo, and lists everything.
The sharp version is `--capusd 2`, which is an unbounded loop; the start line
does say "with no spending ceiling", which is the only reason that one is
survivable today. Each command declares the flags it accepts, an unrecognised
flag is an error naming the nearest match, and a numeric flag that is not a
number is an error rather than a silently dropped cap.

### `t-0053` — a stale `index.lock` is reported, never deleted (HT-05)

Flyt runs `git status --porcelain` on a poll and kills git on a timeout; git
takes `index.lock` to refresh the index. A killed refresh leaves a zero-byte
lock, and every later git write in that repository fails — including the
person's own commits, which is how this was found. `flyt doctor` should report a
lock that is old, empty and unclaimed, name Flyt as the likely author, and print
the command to clear it. It must not delete it: removing another process's lock
is how a real concurrent write gets corrupted.

### `t-0054` — the compat suite grows with the seams (HT-06)

D54 promises that any plugin touching only the standard seams and events runs
unmodified. The suite pins one real plugin against one service definition
(`skills`). That is honest today — it is the only dsh-shaped service definition
we implement — and it stops being honest the moment a seam gains a provider. The
rule to encode: a seam that gains a dsh-shaped service definition gains a pinned
plugin in the same task, or the suite fails saying which one is missing.

## Not in this plan

- **The three orphaned worktrees** and the `npm ci` this machine still owes
  after a manual repair: chores, not defects. `flyt work reconcile` already
  lists the orphans and deliberately does not remove them.
- **Workers that read for ten minutes before writing.** That is a worker
  behaviour question, and `t-0050` is what makes it *visible* and *stoppable*
  rather than what fixes it. If it survives a working ladder, it earns its own
  task with evidence attached.
