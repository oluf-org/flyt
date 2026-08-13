# LOOP-PLAN.md — the autonomous improvement loop

**Status:** Draft 1 — 2026-08-12. Design settled in interview; unbuilt.
**Extends:** `DESIGN-SPEC.md` §4 (routing), §5 (sub-agents/guards), §9 (safety) and §11.1's
recorded weak joint. Draft decision **D35** lives in §20 and lands in `DECISIONS.md` when the
last in-scope phase closes.
**Read with:** `GOALS.md` (principles — and §19 below, which reverses one of its non-goals),
`DECISIONS.md` (D8 depth cap, D12 routing, D13 retrospective scope, D15 project config, D16
safety, D18 BYO-key, D23 subscription auth, D24 zero-dependency), `TOOLS-PLAN.md` (§9 the
outbound MCP server, §12 trust tiers), `SUBSCRIPTION-AUTH-GUIDE.md` (the CLI delegation model).

> **One-sentence goal:**
> A supervisor that picks work off a backlog, runs it unattended on the cheapest model that
> can do it, verifies it with commands rather than claims, lands it, and records what happened
> — so that leaving for work and coming home to merged improvements is an ordinary Tuesday.

**Attended Flyt is unchanged.** Everything below is additive: a second way to start work. The
canvas, the run panel, the gates and the existing flows all behave exactly as they do today.

---

## 1. What this pivot actually is

Today a run begins because a human pressed a button, and ends when a human reads the result.
Every other capability in the app is already agentic — the runner spawns nodes, agents create
tasks, models pick their own prompts — but the *outermost* loop is a person.

The pivot replaces that outermost person with a **supervisor**: a headless process that owns
the queue, the money, the isolation and the verification, and that treats Flyt's own runner as
the thing it drives. The first workload is Flyt itself, because a harness that can improve its
own harness compounds and one that improves a stranger's repo does not.

Three properties make it a pivot rather than a feature:

1. **The process hierarchy inverts.** Electron stops owning the runner and becomes a viewer.
2. **Money becomes a first-class concept**, reversing a stated non-goal (§19).
3. **Verification stops being advisory.** An agent's claim of success is no longer what closes
   a task; a command's exit code is.

**There is no clock.** The loop is bounded by the backlog and the budget, not by a workday: it
runs until there is nothing ready to pick, a cap trips, or you stop it. A task is likewise
allowed to take hours. What replaces the clock is **supervision** (§11) — continuous status,
stall detection, and the authority to interrupt work that has stopped making headway. "Long
running" is a design target here, not a tolerated accident; "long *stuck*" is the failure mode
being engineered out.

---

## 2. What already carries the weight

This is much closer than the pivot sounds. The following exist and are load-bearing:

- **One engine that already spawns its own work.** `core/flowRunner.js` does topological walks,
  bounded-parallel waves, mid-run node materialization and the orchestrator container.
  `core/tools/create_task.js` already lets an agent queue follow-up work.
- **A verdict ladder.** step-eval returns `pass | retry | escalate` against a per-node retry
  budget (`flowRunner.js` ~2128–2188). Today `escalate` means *stop and ask a human*. §8
  re-points it at a stronger model tier first. That is a change of target, not new machinery.
- **A routing table.** `core/modelPriority.js` is already `provider × kind × effort` with
  per-provider rankings and a cross-provider order. It is the tier ladder's data model, missing
  only a price axis.
- **Cheap and expensive providers already wired.** `openrouter` (the route to DeepSeek and
  most others), `kimi`, `openai`, `anthropic`, plus `claude-code` and `codex` CLI delegation
  where the vendor's CLI holds the credential and a *subscription* pays instead of a meter
  (D23, `core/adapters/cliDelegate.js` — already Windows-aware, including the npm `.cmd` shim
  problem).
- **Unattended mode is already a concept.** `approvalMode: 'always'` exists, with `smart` in
  between backed by `core/safetyCheck.js`'s three-layer command screen.
- **Restart resilience.** `reconcileInterrupted` rewinds mid-flight work and `execute(resume)`
  continues from persisted file state without re-running completed nodes (D17). A supervisor
  that dies at 2pm can be restarted at 2:01pm.
- **Tools are files with effects, trust and two-tier grants** (TOOLS-PLAN P1–P3), and every
  tool result is already an artifact with a handle. The audit trail the loop needs is written.
- **569 tests, green in 11 seconds.** This is the single most important fact in the document.
  A fast, trustworthy suite is what makes harness-run verification (§7) cheap enough to run on
  every task, and what makes a benchmark (§12) possible at all.

---

## 3. The seven gaps

1. **Nothing starts a run but a human.** Every entry point is `ipcMain.handle('flow:run', …)`.
   There is no scheduler and no "when this run ends, start the next one."
2. **The backlog is run-scoped.** `create_task` writes `runs/<id>/tasks.json` and dies with the
   run. Nothing survives a run to be prioritized tomorrow.
3. **There is no money in the system.** Token `usage` is captured per call; nothing converts it
   to dollars and nothing enforces a ceiling. There is no price table anywhere in the codebase.
4. **Escalation ends at a human, not at a bigger model** — backwards for an unattended day.
5. **Verification is advisory.** `DESIGN-SPEC.md` §11.1 already names this the weakest joint:
   `bash` returns a non-zero exit as *data*, so an agent can report success over a red suite.
   Attended, you notice. Unattended, it compounds for eight hours and poisons the context of
   every task that follows.
6. **No machine interface.** `core/` is Electron-free by discipline, but every command is bound
   to `ipcMain`. Neither a daemon nor an AI can drive the app.
7. **A gate parks the entire run.** Unattended, one approval request wastes the rest of the day.

---

## 4. Architecture — the supervisor

### 4.1 Process model

```
  flyt-supervisor (headless node)          Electron (viewer)
  ├── backlog        (.flyt/backlog/)  ◄── HTTP + SSE on 127.0.0.1
  ├── scheduler      (pick → claim)        (queue, burn-down, review pile)
  ├── worktree pool  (N in flight)
  ├── FlowRunner ×N  (existing engine)     CLI (`flyt …`)
  ├── budget ledger  (.flyt/ledger/)   ◄── same HTTP surface, JSON out
  ├── gate runner    (tests, lint)
  ├── heartbeats     (status, stalls)      MCP (later, same seam)
  └── references     (read-only clones)
```

The supervisor is a plain node process, not an Electron one. That is what lets the loop survive
a closed window, what lets an AI drive it, and what makes the MCP server in `TOOLS-PLAN.md` §9
fall out of the same seam rather than needing its own design.

### 4.2 The `core/api.js` seam — the highest-leverage refactor in this plan

`electron/main.js` is 1162 lines, most of it `ipcMain.handle('x', (_e, …args) => …)` wrappers
whose *bodies* are already transport-agnostic (they call into `core/`). Lift those bodies into
a command surface:

```js
// core/api.js — one map, no Electron, no HTTP.
export function createApi({ registry, flows, tools, settings }) {
  return {
    'flow:run':      ({ projectId, flowId, userInput, workspaceDir, approvalMode, launch }) => …,
    'run:snapshot':  ({ projectId, runId }) => …,
    'loop:start':    ({ budget, parallelism }) => …,
    …
  };
}
```

Then bind it twice, thinly:

- `electron/main.js` — `for (const [name, fn] of Object.entries(api)) ipcMain.handle(name, …)`.
  The renderer's `window.flyt` contract does not change; this is a mechanical lift with the
  existing tests as the safety net.
- `core/server.js` — an HTTP binding, `POST /api/<command>` with a JSON body, plus
  `GET /api/events` as an SSE stream carrying the same snapshot diffs `core/snapshotDiff.js`
  already produces for IPC. Loopback-only, bearer token required even on loopback (any local
  process can reach 127.0.0.1 — the call `TOOLS-PLAN.md` §9.2 already made for the MCP server).

One command surface, three consumers (Electron, CLI, AI), no duplicated logic, and the event
stream is the *same* diff machinery rather than a second implementation.

### 4.3 The loop

```
  pick → claim → isolate → run → verify → review → land → record → repeat
                    │                        │        │       │
                    │                        │        │       └─ ledger + archive (§12)
                    │                        │        └───────── merge, push, canary (§6)
                    │                        └────────────────── second model on the diff (§7)
                    └─────────────────────────────────────────── worktree + branch (§6)
```

Each stage is a file transition, not a memory state — principle #1 holds. A supervisor killed
between any two stages restarts by reading the backlog directory.

---

## 5. The backlog

### 5.1 Shape

`.flyt/backlog/<id>.task.md` — YAML frontmatter plus a markdown body:

```markdown
---
id: t-0042
title: Give the gate runner a per-task timeout
status: queued            # queued|claimed|running|verifying|review|landed|failed|parked
priority: 0.72            # computed (§5.3), not typed by hand
tier: cheap               # starting tier hint (§8); the ladder may escalate
createdBy: agent:t-0031   # or human
createdAt: 2026-08-12T06:40:11Z
dependsOn: [t-0038]
blastRadius: [core/gates/, tests/gates.test.js]
gates: [npm test, npm run lint]     # extra gates beyond the defaults
budgetUsd: 1.50           # per-task ceiling (§9)
attempts: 0
---

## Goal
A hung `npm test` currently parks a worktree forever…

## Done when
- `runGates()` kills a gate after its timeout and reports `timeout` distinctly from `fail`
- a test proves the kill path
```

Markdown-with-frontmatter rather than JSON because a human writes these at 7am on a phone, an
agent writes them mid-run, and both need to read them. Same reasoning that made flows a DSL
rather than JSON (D24, `FLOW_LANG.md`).

### 5.2 Where it lives, and why that matters more than it looks

The backlog lives in the **main checkout's** `.flyt/backlog/`, which is **gitignored** in this
repo, and it is owned **solely by the supervisor**. Worktrees never write it.

This is not incidental:

- If the backlog were tracked, every parallel task's diff would carry bookkeeping churn and
  **every pair of parallel tasks would conflict on the same files.** A queue inside the thing
  being edited is a queue that fights itself.
- Agents inside a worktree therefore do not edit backlog files. They call `enqueue_task`, and
  the supervisor — which sits outside every worktree — applies it to the canonical directory.
  That tool *is* the "prompt itself" primitive, and routing it through the supervisor is what
  keeps a task from rewriting its own priority or deleting its own gates (§7.3).
- Project-level rather than app-level, per D15's split: a backlog is about *this* repo, the way
  skills are, while tools stay portable and app-level.

### 5.3 Picking — cheap and deterministic first

Same tiering as `safetyCheck.js` and the clerk in `TOOLS-PLAN.md` §7, for the same reason:

1. **Deterministic score, free.** `priority = value × readiness / effort`, where readiness is 0
   for anything with an unmet `dependsOn` or an unresolved `parked` reason, and a small bonus
   accrues to tasks that unblock the most other tasks. Ties break toward the oldest.
2. **LLM tiebreaker, only on ambiguity** (a cluster within a few percent, or an empty-ish
   queue where the question is "what *should* we do next"). This is also where new tasks get
   proposed — the picker is allowed to add to the backlog, which is how "it adds new tasks it
   can see to be useful" (e.g. *build a tool for X*) happens without a separate mechanism.

The picker is a node template like everything else, so its reasoning is an inspectable artifact.

### 5.4 Claiming — [BUILT]

A sibling **lock file created exclusively** (`fs.writeFileSync(lock, …, { flag: 'wx' })`, which
fails with `EEXIST` if another worker got there first) plus a `claimedBy`/`claimedAt` stamp. Two
workers cannot claim the same task; a crashed worker's lease expires and is reclaimable, and the
reclaim returns `stolen: true` so it is logged rather than silent — a quiet steal is how two
workers end up in one worktree.

*Changed from the draft's rename sketch.* Renaming `t-0042.task.md` → `t-0042.claimed.md` is
equally atomic, but it moves the task's own path around as its status changes, which puts status
in two places at once and breaks every link to the file. The lock file keeps one stable path per
task, keeps status solely in the frontmatter, and is what makes a lease expressible at all
(the lock's mtime is the lease clock).

---

## 6. Isolation and landing — the YOLO path, made survivable

**Decided:** worktrees for parallel tasks, commit and push, second-model review before merging
into `main`, plus automated tests and linting.

### 6.1 Worktrees

One `git worktree` per in-flight task, on branch `flyt/t-0042-gate-timeout`, created from
current `origin/main`. Default parallelism 2–3, bounded by budget and by how many `npm test`
runs the machine tolerates at once.

Worktrees live **outside the repo root** (default `<appData>/flyt/worktrees/<repo>/<taskId>`,
configurable). A nested checkout inside the working tree confuses grep, test runners and the
agent's own file tools. Outside, each worktree is simply *the run's workspace root*, so
`core/tools/fileHost.js` confinement works unchanged and an agent physically cannot reach
another task's tree.

Cleanup is `git worktree remove` — a failed task is thrown away by deleting a directory, which
is the property that makes YOLO tolerable.

### 6.2 The landing sequence

```
  gates green in worktree
      → reviewer model approves the diff            (§7.2)
      → merge --no-ff into main, push
      → CANARY: full suite on main after the merge
          green → record landed
          red   → git revert the merge commit, push, re-file the task with the evidence
```

The canary is the part most such systems omit. Two branches that each pass in isolation can
fail together, and with 2–3 parallel tasks landing per hour that will happen. Reverting a
`--no-ff` merge commit is a single clean operation, which is why the merge is never squashed.

### 6.3 The self-modification hazard

**The supervisor is running the code it is editing.** A merge that breaks the gate runner
breaks the thing that would have reverted it, and the loop eats itself at 11am.

Mitigation — **pin the supervisor**:

- The supervisor process runs from a separate checkout at a known-good revision
  (`<appData>/flyt/supervisor-pin/`), not from the working tree it edits.
- After a green canary, the pin advances only if the *new* revision passes the full suite **and**
  a supervisor self-test (start, claim a no-op task, land it, stop) in a scratch clone.
- If the pin fails to advance, the loop keeps running on the old pin and files a task about it.
  Improvements to the harness therefore reach the harness one verified step behind, never
  mid-flight.

This is the single most important safety property in the plan, and it is what separates "it
improves itself" from "it bricks itself while you are at work."

### 6.4 Push and review posture

Pushing task branches is free and gives you something to look at from your phone. The merge to
`main` is what the reviewer model gates. A `--dry-run` posture (push branches, do not merge) is
a one-line config for the first few days, and I would run it that way for the first two nights
before trusting auto-merge.

---

## 7. Verification — the definition of done

**Decided: tests plus a second-model review.** Both, and the harness runs the first one.

### 7.1 Gates are commands the supervisor runs

Not `bash` calls the agent makes and interprets. `core/gates.js` runs each declared gate in the
worktree with a timeout, captures bounded stdout/stderr as an artifact, and reports
`pass | fail | timeout`. Defaults come from the project's `.flyt/config.json`
(`npm test`, `npm run lint`); a task may *add* gates and may never remove them.

A failed gate returns its bounded output to the agent as guidance for another attempt, capped
by the existing retry budget — the pattern
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)
describes, and the one that closes `DESIGN-SPEC.md` §11.1's weakest joint.

There is no linter today (`package.json` has no `lint` script). Adding one is task zero of the
first backlog — it is exactly the kind of "improve your ability to improve" work that should
come first, and the loop cannot enforce a gate that does not exist.

### 7.2 The reviewer

A node template (`diff-review`) seeing the task goal, the full diff, the gate output and the
declared `blastRadius`. Verdict `approve | request-changes | reject` with reasons.
`request-changes` feeds the existing step-eval retry loop with the reasons as guidance;
`reject` parks the task for you.

The reviewer runs **one tier above** the model that wrote the code (§8) — a cheap model
reviewing its own cheap output is theatre — and never on the same model instance that produced
the diff.

### 7.3 Anti-gaming rules, enforced by the harness

An agent optimizing for "gates green" has three cheap exits. Close them mechanically:

- **Test count must not decrease.** Recorded per landing; a drop fails the task regardless of
  the suite being green.
- **A task may not edit its own gate configuration**, the supervisor pin, the gate runner, or
  `.flyt/backlog/` — unless the task is *explicitly about* that file, in which case it is
  marked `needs-human` and lands only with your approval. This is the reflexive-modification
  hole, and it must be closed in code, not in a prompt.
- **Diffs outside `blastRadius`** are surfaced to the reviewer as a specific question rather
  than blocking, since blast radius declared up front is often wrong in a benign way.

---

## 8. The tier ladder

### 8.1 Tiers

| Tier | Intent | Candidates |
|---|---|---|
| **T0 sub** | Anything the subscription covers; costs time, not dollars | `claude-code`, `codex` CLI delegation (D23) |
| **T1 cheap** | Mechanical work, high volume | DeepSeek, Kimi K2.7-code, small OpenAI/Anthropic tiers |
| **T2 mid** | Real reasoning, bounded | Sonnet-class, GPT-5-class |
| **T3 frontier** | Last resort before a human | Opus-class |

Tier membership is data — an added axis on `core/modelPriority.js`, which already ranks
`provider × kind × effort` — not a hardcoded list. That keeps it tunable from the ledger (§12),
which is the retrospective loop D13 scoped and never closed.

### 8.2 Escalation

- Every task starts at the lowest tier its class allows (`tier:` hint, defaulted by task kind).
- step-eval `retry` stays **same-tier**, with guidance — this is already built.
- A second failure **escalates one tier** and re-runs with the accumulated guidance and the
  gate output. This is the change: escalate means *bigger model*, not *wake the human*.
- Failure at the top of the ladder, or exhausting the per-task budget, means `parked:
  needs-human` — the task records what was tried at each tier, and the loop picks the next one.

### 8.3 Ordering under a subscription

Subscription-first inverts the usual ordering: T0 is tried before T1 even though T1 is
"cheaper" in tokens, because T0 is already paid for. The constraint on T0 is *throughput and
rate limits*, not money, so the ledger tracks T0 in **wall-clock and call counts** while
tracking T1–T3 in dollars. A rate-limited T0 falls to T1 rather than blocking.

---

## 9. Budget — subscription first, soft cap, hard cap

**Decided.** Three ceilings, one ledger.

- **`core/budget.js`** holds a price table (`$ per Mtok in/out`, per provider+model, a plain
  file so it is correctable without a release), an append-only ledger at
  `.flyt/ledger/<date>.jsonl` (one line per model call: task, node, tier, provider, model,
  tokens, dollars, duration), and the three ceilings.
- **Per-task cap** — exceeded, the task parks with what it spent and where.
- **Soft cap** — escalation stops. Everything runs at T0/T1 until the window rolls. The loop
  keeps working; it just stops reaching for the expensive answer.
- **Hard cap** — the in-flight task is allowed to finish its current node, then lands or reverts
  cleanly, the report is written, and the loop stops. Never a mid-write kill.

The soft and hard ceilings are **rolling-window**, not calendar-daily, because the loop has no
clock (§1): a run that starts at 22:00 should not get a fresh allowance at midnight. A 24-hour
trailing window is the default; the window length is config.
- **Enforcement is a pre-flight check** in the `callModel` path: a refused call returns
  `budget_exhausted` as a first-class outcome that the runner handles like any other node
  failure. Never an exception, never a crash, always a logged line.

Dollars are estimates derived from token counts and a local table; OpenRouter's reported cost is
preferred when present. The ledger records both so the table can be corrected against reality.

---

## 10. Gates in an unattended run

`approvalMode: 'always'` is the YOLO setting, and `smart` remains available for a more cautious
night. But mode alone is not enough: an `ask_human` call or an escalation gate still *blocks*.

In loop mode, **a gate parks the task and the supervisor picks the next one.** The question,
its context, and the run id go into the review pile. Nothing waits on a person who is at work.

The morning report (`flyt report`, and the Electron Loop view) is one page: what landed, what
reverted and why, what is parked and what it wants from you, what it cost, and what the loop
added to the backlog on its own.

---

## 11. Supervision — status, stalls, and interruption

With no clock bounding the day, this section carries the weight the clock used to. A task may
legitimately run for hours; the supervisor's job is to know the difference between *working*
and *stuck*, and to act on it without waiting for you.

### 11.1 Status is tracked, not inferred

Each in-flight task keeps a heartbeat record the supervisor owns (outside the worktree, so a
wedged run cannot lie about itself):

```
  task, run, worktree, tier, phase (running|verifying|review|landing)
  startedAt, lastNodeDone, lastFileEvent, lastModelCall, lastGateRun
  tokensSinceProgress, usdSpent, attempts, currentNode, lastToolCall
```

Fed by what the app already emits — `log.jsonl` events, snapshot diffs (`core/snapshotDiff.js`),
`node_start`/`tool_call`/`model_retry` — so this is aggregation, not new instrumentation. It is
also exactly the payload the CLI's `flyt loop status` and the Electron Loop view render, so one
record serves the machine and the human.

### 11.2 What counts as headway

Elapsed time is not a progress signal, and neither is token spend — a model can burn an hour
producing confident nothing. Headway is any of:

- a node completing, or a gate result whose **failure signature changes** (a different error is
  progress; the identical error is not)
- a **new** file event in the worktree — a write whose content hash differs from the last write
  to that path
- a tool result that is not byte-identical to a recent one from the same tool
- an approval or human answer arriving

Everything else is elapsed time. `tokensSinceProgress` is the counter that matters, and it is
the one that catches a polite infinite loop.

### 11.3 Stall detectors

| Detector | Signal | Default |
|---|---|---|
| **Silent run** | no file, tool or model event | 10 min |
| **Hung provider call** | one model call outstanding | 5 min (§11.5) |
| **Spin** | identical diff hash across attempts | 2 repeats |
| **Groundhog gate** | identical gate failure signature | 3 repeats |
| **Burn without progress** | `tokensSinceProgress` over threshold | per-tier |
| **Runaway spend** | rate departs from trailing average | 3× |
| **Wall-clock outlier** | task exceeds its class's median | 4× |

Thresholds are config, not constants, and every trip is logged with the evidence that tripped it
— a silent stall detector is as bad as no stall detector.

### 11.4 The interruption ladder

Detection without authority is just a dashboard. The supervisor escalates:

1. **Nudge** — inject the stall evidence as guidance and let the current node continue. Cheapest,
   and often enough: "you have run the same failing test three times."
2. **Restart the node** with accumulated guidance. `run:restartNode(runId, nodeId, guidance)`
   already exists and does exactly this.
3. **Escalate a tier** (§8) and restart, on the theory that the model is the bottleneck.
4. **Park the task** — `stop()` the run, keep the worktree for forensics, file the evidence,
   pick the next task.

The machinery for step 4 is built: RUN-CONTROL threads an `AbortController` into every model
call and registers it per run, so `stop()` aborts in-flight calls and unwinds cooperatively
(`flowRunner.js` ~514–531, 749–758). Interruption is wiring, not invention.

### 11.5 The one real gap — no request timeout

`DESIGN-SPEC.md` §11.1 recorded it and it is still true: **no model call has a timeout.** A
stalled connection never errors, so the retry budget never engages, and a node can sit
indefinitely — seen live at 347s on a node that normally takes 79–104s. Attended, you notice
and click stop. Unattended and clockless, that worktree is dead until you get home.

The fix is now small because RUN-CONTROL already threads the signal end to end: compose the
run's controller with a per-call deadline, and a timeout becomes an ordinary transient failure
the existing retry classifier already handles. **This is day-1 work, not day-5** — it is the
difference between "long running" and "hung since 09:20".

### 11.6 The overseer

Above the deterministic detectors sits the cheap LLM watcher
[SICA](https://arxiv.org/pdf/2504.15228) pairs with its self-improvement loop — reading
`log.jsonl` across all in-flight runs, on events rather than per token, looking for what a
threshold cannot express: work drifting off the task's stated goal, cosmetically-different
retries of the same failed idea, test files shrinking, gates or `.flyt/` being edited from
inside a worktree.

It is empowered to **pause and to park — never to approve**. A watcher that can only stop is
fail-safe; one that can also bless is a second, unreviewed decision-maker.

---

## 12. Measurement — tool feedback, the benchmark, and the archive

### 12.0 What each instance leaves behind — [BUILT]

The loop's job is to improve its ability to improve, and the **toolbox** is where that bites
first: an agent that needed `grep` and didn't have it burns six `bash` calls and a lot of
context reinventing it. The run still *succeeds* — slowly, expensively, invisibly — and nothing
learns. So every LLM instance leaves two things behind.

**The facts, derived.** Every retrospective now carries a `tools` summary — per tool: calls,
failures, time, sample errors — computed from the run's own tool calls. It costs nothing and
cannot be misremembered. Asking a model to recount what it just did would buy a worse answer at
a higher price.

**The judgment, offered.** What the log cannot know is whether a tool was *awkward* — three
calls where one should do, a whole file read to see twenty lines — and **what was missing**.
That arrives through `tool_feedback`, a tool rather than an extra model call per node, because
the loop cannot afford to double its call count to ask every instance how it felt. An agent
with nothing to say never calls it and pays nothing.

**Collected, not acted on.** Both land in `.flyt/feedback/pending/`, one entry per instance
(run + node), in the main checkout and never inside a worktree — the same canonical-location
rule as the backlog (§5.2). Facts overwrite; opinions accumulate, since a long task may report
more than once as it learns.

**The reviewer folds, then archives.** `feedback:digest` groups every entry into ONE document:
per tool (how heavily used, how often failed, what people said) and per *missing capability*,
with near-duplicate phrasings clustered by word overlap — "search file contents by regex across
the repo" and "regex search over file contents" are one request written twice, and the count of
who asked IS the argument for building it. Every group keeps the run, node and task it came
from, so the context is already assembled. The digest then archives exactly the entries it
covered, scoped by id, so an instance reporting mid-write is not swept away unread.

It deliberately does **not** enqueue a task per request. A hundred nodes asking for the same
missing tool should become one considered piece of work with a hundred contexts attached, not a
hundred duplicates to de-duplicate by hand. `--enqueue` adds a single task pointing at the
digest, and is off by default: the pile becomes work when someone decides it does.

### 12.1 The benchmark and the archive

Without this section, "improve yourself" degrades into churn that cannot be distinguished from
progress. SICA's finding is that the loop needs a **score** and an **archive**, and that the
best archived version is what proposes the next improvement.

- **A benchmark suite**: a fixed set of scored tasks the harness can run unattended against a
  *throwaway* clone (seeded from the `taskline` acceptance in `DESIGN-SPEC.md` §11.1 and from
  past real runs). Score per task: verified pass, dollars, wall-clock, attempts, top tier
  reached. A benchmark run is just a loop run with a fixed backlog and a fresh clone.
- **The archive**: `.flyt/archive/<date>/` — the day's ledger, the benchmark scores, the
  commits landed, the parked pile.
- **The gradient**: the picker (§5.3) and the tier table (§8.1) read the archive. "Did this
  make the loop better" becomes a number: same benchmark, fewer dollars, fewer attempts, fewer
  escalations.

The first benchmark run is the baseline, and it should happen on day 7 *before* the first real
overnight, or there is nothing to compare against.

---

## 13. The machine interface

Both surfaces bind the same `core/api.js` (§4.2).

**CLI** — `flyt`, following the precedent `core/flowlang/cli.js` already set (an AI authors a
flow, lints until `ok: true`, the app picks it up):

```
flyt loop start [--budget 20 --parallel 3 --dry-run]     # runs until stopped or capped
flyt loop stop|status|pause|resume
flyt loop interrupt <task> [--nudge "…" | --restart | --escalate | --park]   # §11.4 by hand
flyt task add "<goal>" [--priority --tier --gates] | list | show <id> | park <id>
flyt run <flow> --input "…" [--workspace <dir>]
flyt report [--since 24h]
flyt ref list | grep <pattern> [--repo opencode]         # the reference library (§16.1)
```

Every command takes `--json` and writes machine-readable output to stdout, human text to
stderr. That is the whole "interface easiest for an AI to access" requirement: an AI already
knows how to run a CLI and read JSON.

**HTTP** — `POST /api/<command>` + `GET /api/events` (SSE), loopback, bearer token. This is
what Electron attaches to, and what a remote agent would use.

**MCP** — later, and free: `TOOLS-PLAN.md` §9 already designed the outbound server (flows as
tools, task handles, gates surfaced as `InputRequiredResult`). It becomes a third binding of
the same command map rather than a new subsystem.

---

## 14. Electron becomes a viewer

A new **Loop** surface, and nothing else changes:

- the queue, with each task's priority, tier, attempts and spend
- in-flight worktrees, live, using the existing canvas run view per task
- budget burn-down against the soft and hard caps
- landed / reverted / parked piles, with diffs and the reviewer's reasons
- the benchmark trend across archived days

The app connects to the supervisor over HTTP if one is running and falls back to owning its own
runner if not, so attended use with no supervisor works exactly as today.

---

## 15. The week

Each day is demoable, and days 6–7 can slip without killing the thing.

| Day | Build | Demo |
|---|---|---|
| 1 ✅ | **Per-call request timeout** (§11.5); `core/engine.js` + `core/api.js` extraction; `core/server.js`; `bin/flyt.js` | Start a run from a terminal with Electron closed, and kill a hung provider call |
| 2 ✅ | Backlog files, atomic claim, `enqueue_task`, deterministic picker | `flyt task add`, `flyt task ready`, `flyt task take` — and an agent queueing work mid-run |
| 3 | Worktree pool, gate runner, `diff-review` node, merge + push + canary + auto-revert, supervisor pin | A task lands on `main` with nobody watching |
| 4 | Price table, ledger, three ceilings, tier ladder wired into step-eval escalation, subscription-first ordering | A task escalates cheap → frontier; a hard cap stops the loop cleanly |
| 5 | Heartbeats, stall detectors, the interruption ladder, park-don't-block gates, the report | A deliberately wedged task gets nudged, restarted, then parked — unattended |
| 6 | Electron Loop view over HTTP/SSE; reference library + read-only reference root | Watch the queue burn down; an agent greps opencode mid-task |
| 7 | Benchmark suite, archive, baseline run | The first real overnight, with a number to beat |

**Day 0, before any of it:** clone the reference repos (§16) and add the lint script. The loop
cannot enforce a gate that does not exist, and the lint script is the smallest possible instance
of the thing this whole plan is for.

**Day 2 landed** (`backlog`, `enqueue_task`). `.flyt/backlog/*.task.md` with atomic
lock-file claiming and leases (§5.4), the deterministic picker (§5.3), `task:*` on the command
surface, and `flyt task add|list|show|ready|take|release|stats`. **`enqueue_task` is the
automated-task-creation half**: an agent mid-run records work it noticed — a missing tool, a
refactor a later change needs — into the backlog instead of doing it inline (blowing the
current task's scope) or forgetting it. A test drives a real agent loop end to end to prove it.

The LLM tiebreak (§5.3 layer 2) is deliberately **not** built yet: the deterministic score
handles an unambiguous queue for free, and until there is a real backlog to watch it rank
badly, an LLM tiebreak would be a model call bought on speculation.

**Day 1 landed** (`6e59418`, `7b58d09`, `364c3e1`). `npm run flyt -- run <flow> --input "…"`
starts a run with no Electron in the process, answers its gates with `--gates approve`, and
exits non-zero if the run parks or fails; `npm run serve` puts the same commands on loopback
HTTP with SSE. Two things the work itself taught, both now pinned by tests: a deadline must be
unref'd or a headless command lingers for the longest deadline it ever armed, and the project
registry's own "unknown project" throw had to become a typed 404 — over IPC it read fine, over
HTTP it would have told a caller the server broke.

The overseer (§11.6) is deliberately *after* day 7: the deterministic detectors in §11.3 catch
most of what a model watcher would, cost nothing, and cannot themselves misbehave. Build the
cheap layer first and measure what still gets through — the same tiering as `safetyCheck.js`.

---

## 16. The reference library — recipes, not dependencies

**Zero new dependencies (D24), and no vendored code.** These repos are read as *recipes*:
proven answers to problems this harness is about to hit, written by people who hit them first.
Nobody — human or model — should design a session event stream from first principles when a
working one is sitting on disk to read.

### 16.1 Reference repos as a first-class, readable resource

The reference repos are **cloned locally and made readable to the agents**, not merely cited in
a document an agent may or may not open:

- Shallow clones under `<appData>/flyt/references/<name>/`, pinned to a commit, refreshed on
  request — **outside every workspace and every worktree**, so nothing can accidentally be
  edited into a task's diff.
- A **read-only reference root** in `core/tools/fileHost.js`, alongside the workspace root:
  `read_file` and `grep`/`glob` resolve against it under a `reference:` prefix; every write tool
  refuses it. Read-effect only, so an `aiStep` may hold it (§7 of `DESIGN-SPEC.md` already
  allows read tools on planners) and no grant widening is implied.
- `references/index.md` per repo — a short, hand-written map of *what this repo is good for and
  where that part lives* (a paragraph, not a summary of the codebase). Cheap to write, and it
  is what makes the difference between an agent grepping blind and an agent reading the right
  file. This index is itself a good early backlog task once the loop is running.

The point is leverage at task time: a task that says *"give the supervisor an event stream the
UI can attach to"* should begin by reading how opencode did it, and the harness should make
that the path of least resistance.

### 16.2 The repos, and what each is a recipe for

- **[opencode](https://www.teamday.ai/harness/opencode)** — *the server/client split.*
  `opencode serve` runs the harness headless over HTTP and every surface (TUI, web, Electron,
  IDE) is a client synchronized by an event stream. §4.1/§4.2 are that idea applied to a
  codebase that already keeps `core/` Electron-free. Also worth reading for session lifecycle
  and how one live session fans out to multiple attached viewers.
- **[self_improving_coding_agent](https://github.com/MaximeRobeyns/self_improving_coding_agent)
  / [SICA](https://arxiv.org/pdf/2504.15228)** — *the self-improvement loop itself.* The archive
  of scored versions with the best one promoted to propose the next improvement (§12), the
  asynchronous overseer (§11.6), and the benchmark-driven evaluation cycle. Its reported
  17%→53% SWE-bench Verified movement came from **scaffolding** changes — precisely this
  workload. The closest thing to a reference implementation of what we are building, and the
  first repo to clone.
- **[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md)**
  — *long-running sessions.* Gate commands that must pass before a session may finish, with
  bounded failure output fed back for another attempt (§7.1); explicit limits on continuations,
  turns and tokens (§9); supervisor restart with session rehydration (already D17 here);
  automatic compaction as context grows.
- **[Loop taxonomy](https://www.requesty.ai/blog/loop-engineering-how-to-build-ai-agent-loops-that-run-themselves)**
  — heartbeat / cron / hook / goal. This plan is a **goal loop bounded by a budget and a
  backlog**, with no clock; the other three are follow-on config, not v1.

Adding a repo to the library is a config entry plus an `index.md`. Expect the list to grow —
that is the point of it being a library rather than a bibliography.

### 16.3 Long-running tasks, and why this codebase is already shaped for them

The usual failure of a multi-hour agent task is context: one conversation grows until the model
is reasoning over its own exhaust. prime-agent answers with automatic compaction. **Flyt answers
structurally, and already does:** a long task is not one long conversation, it is a run with
many nodes, each with its own scoped context assembled from `upstreamContext()` and its
`contextSpec` — with the orchestrator node materializing more of them as the work reveals
itself. Compaction is a summarize node; the shape is `FLOW_NODES.md`'s reflective planning
pattern.

So "design for long-running tasks" mostly means **not breaking that property**: keep node
contexts scoped, keep the orchestrator's children narrow, and let a long task be many small
scoped runs rather than one enormous one. The work is in §11's supervision, not in a context
window.

---

## 17. Risks

- **The loop lands forty commits of churn.** Mitigated by the benchmark (§12): unscored work
  is indistinguishable from progress, so score it. Also by the reviewer having `reject`.
- **A bad merge breaks the supervisor.** Mitigated by the pin (§6.3). This is the one that
  ruins a day.
- **Approval fatigue in reverse** — a morning review pile so large you ignore it. Cap the
  parked pile; when it exceeds N, the loop stops taking new work and says so.
- **Cheap models thrash.** Two failures at a tier escalate; a task that reaches the top tier
  twice gets its `tier:` floor raised in the backlog permanently, so the loop learns rather
  than repeats.
- **The long-session context problem.** Answered structurally rather than by compaction: many
  scoped node contexts against a shared file-based backlog, never one growing conversation
  (§16.3). The risk is regressing that property, not hitting it.
- **A task that runs for six hours and produces nothing.** The direct cost of removing the
  clock, and the entire justification for §11. Headway, not elapsed time, is the measure.
- **Windows specifics.** Worktrees, `renameSync` claims and CLI spawning are all Windows-aware
  already (`cliDelegate.js` solved the `.cmd` shim problem); path length and file locking
  during parallel `npm test` are the ones to watch.

---

## 18. Non-goals for this pivot

- Multi-machine or cloud execution. One Windows box.
- Replacing attended mode. Everything additive.
- A general scheduler (cron/heartbeat/hook loops). One goal loop, bounded.
- Sandboxing beyond worktree isolation + the existing safety screen. The blast radius is a git
  repo you can revert, and that is a deliberate acceptance, not an oversight.
- Making the *models* better. This is harness work; the loop improves scaffolding.

---

## 19. What this changes in the existing docs

- **`GOALS.md` non-goals** currently lists *cost tracking* alongside large graphs and A/B
  testing. §9 reverses it: budget is now a hard requirement, because unattended spend without a
  ceiling is the one failure mode with no upper bound. This needs D35, not a quiet edit.
- **`DESIGN-SPEC.md` §4** (routing, PLANNED) is delivered in part by §8 — the tier ladder is
  the matrix-first half of D12, with escalation as the policy instead of an LLM tiebreaker.
- **`DESIGN-SPEC.md` §5** (spawn guards, PLANNED) gains its missing budget ceiling from §9.
- **`DESIGN-SPEC.md` §9** (safety, PLANNED) gains the harness-run gate and the overseer.
- **`DESIGN-SPEC.md` §11.1**'s "weakest joint" is closed by §7, and its recorded *no request
  timeout* gap by §11.5 — which stops being a papercut and becomes a blocker the moment nobody
  is watching.
- **`DECISIONS.md` D13** (retrospective loop scoped to model-ranking → routing) is finally
  actionable via the ledger and archive (§12).
- **`TOOLS-PLAN.md` §9** (MCP server) becomes cheaper — it binds `core/api.js` rather than
  inventing a transport.

---

## 20. Draft D35 — for `DECISIONS.md` when the last phase closes

> ### D35 — The outermost loop is a supervisor, not a person
>
> **Context.** Every capability in Flyt was agentic except the outermost loop, which was a human
> pressing Run. Unattended operation needs four things the app did not have: work that survives
> a run, money that is counted and capped, verification that is executed rather than claimed,
> and a way in that is not Electron IPC.
>
> **Decision.**
> 1. **A headless supervisor owns the loop**; Electron becomes a client. Both bind one
>    transport-agnostic command surface (`core/api.js`), as does the CLI and, later, MCP.
> 2. **The backlog is files, project-level, gitignored, and supervisor-owned.** Agents append to
>    it only through `enqueue_task`, which the supervisor applies outside every worktree — a
>    queue inside the thing being edited is a queue that conflicts with itself and can rewrite
>    its own priorities.
> 3. **Isolation is a git worktree per task, outside the repo root**, landing by `--no-ff` merge
>    after gates and a reviewer model, with a post-merge canary that auto-reverts. The
>    supervisor runs from a pinned known-good revision so it cannot break the process that would
>    revert the change that broke it.
> 4. **Done means a command said so.** The harness runs the gates; an agent's claim is not
>    evidence. Test count may not decrease, and a task may not edit its own gates, the pin, or
>    the backlog.
> 5. **Escalation means a bigger model, then a human.** step-eval's existing `retry → escalate`
>    ladder re-points at tiers; a human is the last rung, not the second.
> 6. **Cost tracking becomes a requirement**, reversing a `GOALS.md` non-goal. Subscription
>    first (metered in time), then dollars under a soft cap that stops escalation and a hard cap
>    that stops the loop. A refused call is an outcome, not an exception.
> 7. **A gate parks a task; it never blocks the loop.**
> 8. **Improvement is scored or it did not happen.** A fixed benchmark against a throwaway
>    clone, archived per day, feeds the picker and the tier table.
> 9. **The loop has no clock; it has supervision.** Long-running tasks are a design target, so
>    the supervisor tracks per-task heartbeats, measures headway rather than elapsed time, and
>    holds the authority to nudge, restart, escalate or park. Every model call gets a deadline —
>    a call that cannot time out is a task that cannot be supervised.
> 10. **Patterns, not dependencies** (D24), and the recipes are kept readable rather than
>    remembered: reference repos — opencode, `self_improving_coding_agent`, prime-agent — are
>    cloned to a read-only root the agents can grep at task time. Read, never vendored, never
>    writable.
>
> **Status.** Provisional until the phases in §15 land; §21 lists what is still open.

---

## 21. Open questions

**Q-L1 — Provider access for the cheap tier. [RESOLVED]** OpenRouter for everything in v1 —
one key reaches DeepSeek and the rest, and the adapter is already built and validated live
(`DESIGN-SPEC.md` §4.1). Additional providers (Meta Muse and any other contributor-priced
endpoint) are a later key addition; because the tier table is data and `core/adapters/http.js`
speaks OpenAI-compatible, adding one is a config entry unless its auth is unusual.

**Q-L2 — Dry-run duration.** How many nights of push-branches-but-do-not-merge before
auto-merge is switched on. Proposed: two.

**Q-L3 — Benchmark content.** Which tasks constitute the fixed suite, and against which
throwaway repo. Proposed: seed from `taskline` plus three replayed real runs, growing as the
loop encounters classes of task it handles badly.

**Q-L4 — Parked-pile ceiling.** The N at which the loop stops taking new work because too much
is waiting on you.

**Q-L5 — Does the picker get its own budget?** An LLM tiebreak on every pick is a real cost at
forty tasks a day. Probably a cheap model with a hard per-day call ceiling, but measure first.

**Q-L6 — Windows process lifecycle. [PARTLY RESOLVED]** No schedule — the supervisor is a
long-running background process that outlives the UI and stops on a cap, an empty backlog, or
your say-so. Still open: whether it survives a reboot (a Task Scheduler *at-logon* entry) and
whether it should idle-poll an empty backlog or exit and be restarted by `flyt loop start`.
Proposed: at-logon, idle-poll with a long interval, since a picker that can add its own tasks
never truly runs out.

**Q-L7 — Stall thresholds.** §11.3's defaults are guesses. A "silent run" limit that is too
tight kills a legitimately slow provider call; too loose and a wedged worktree costs hours. They
should be per-tier and calibrated from the ledger's own trailing distribution after a week of
real data — which is itself a good early backlog task.

**Q-L9 — Should `.flyt/`-confined metadata writes gate?** `enqueue_task` and `tool_feedback`
both write project state that outlives the run, so both gate under `ask`/`smart` like any other
out-of-run write. That is honest — the gate derives from what a tool *does*, and scoping them
`run` to dodge the prompt would be a lie in the one field the safety model reads — but an
approval prompt teaches an agent that *reporting is expensive*, which is precisely the wrong
lesson. Under the loop's `always` mode both are free, so this only bites attended. Options: a
third scope for app-managed metadata, an ungated-write allowlist confined to `.flyt/`, or leave
it. Do not decide this from inside a tool that happens to want it.

**Q-L8 — Reference library scope.** How many repos before the index is noise, and whether the
clerk (`TOOLS-PLAN.md` §7) should index reference repos alongside tools so an agent can *find*
the right recipe rather than being told which one to read.

---

## Sources

- [opencode Harness — Run the Open-Source Agent Server-Side](https://www.teamday.ai/harness/opencode) — headless `serve`, server/client split, event stream to every surface
- [prime-agent — long-running agents](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md) — gate commands, continuation/token/wall-clock limits, supervisor rehydration
- [A Self-Improving Coding Agent (SICA)](https://arxiv.org/pdf/2504.15228) — archive of scored versions, best-archived-as-meta-agent, asynchronous overseer
- [self_improving_coding_agent](https://github.com/MaximeRobeyns/self_improving_coding_agent) — reference implementation of the above
- [Loop Engineering: AI Agent Loops That Run Themselves](https://www.requesty.ai/blog/loop-engineering-how-to-build-ai-agent-loops-that-run-themselves) — heartbeat / cron / hook / goal loop taxonomy
- [Long-Running Coding Agents: The 2026 Guide](https://o-mega.ai/articles/long-running-coding-agents-the-2026-guide) — one long loop beats an unmanaged swarm
