# LLM Flow — Critical Review

**Purpose:** Honest assessment for the project owner. Read this, then adjust goals, scope, architecture, or priorities as needed.  
**Date:** 2026-07-13  
**Based on:** Full exploration of current codebase (3 commits), runs/, flows/, README, and all core + UI modules.

---

## Executive Summary

The project has a strong, coherent core idea ("file-based AI orchestration with a live visual canvas") and has executed the first three logical milestones quickly. However, several important features the user may want are only partially realized, some are architecturally hard, and a few directions risk undermining the very qualities (transparency, responsiveness, trustworthy feel) that make the project interesting.

**Biggest risks of misunderstanding:**
- The "flow builder" is a lightweight 4-node-type DAG layered on top of the original pipeline, **not** a general visual AI programming environment.
- Parallelism, restartability, large graphs, and streaming are aspirational or explicitly broken today.
- Performance/feel have received nice polish touches, but the fundamental architecture (full snapshots, sync FS, no streaming) will fight you as soon as you move beyond tiny examples.

The critical review below is direct so you can course-correct early.

---

## 1. Areas at High Risk of Feature Misunderstanding

| Claim in current system | What it actually is today | What a user might reasonably assume it is |
|-------------------------|---------------------------|-------------------------------------------|
| "Flow builder" / editable canvas | 4 node types (input, agentTask, aiStep, output). aiSteps = single LLM call. Only agentTasks get tools + full agent loop. Sequential execution. | A general-purpose visual programming canvas for arbitrary AI agents, branching, loops, parallel steps, reusable subflows. |
| Built-in "Linear pipeline" flow | Read-only visual representation. Running it from the flow UI throws an error. Real execution is the separate classic `Pipeline`. | The built-in flow is the same thing you run from the prompt box. |
| `dependsOn` on tasks | Used only for input wiring and ordering inside a sequential while-loop. | Real parallel execution with dependency graph scheduling. |
| Retrospectives + history | Only fed into classic planner via `historyDigest()`. Nothing similar for aiSteps. | Automatic self-improving / adaptive behavior across runs for all flows. |
| Human approval on custom nodes | Works via in-memory Promise gates. | Survives app restart / crash and can be resumed later. |
| "Graph execution" | Two completely different code paths (classic vs FlowRunner) that happen to share some files. | One unified engine. |

**Recommendation:** Be extremely explicit in GOALS.md and any user-facing copy about the current limited semantics of custom flows.

---

## 2. Hard, Expensive, or Likely-to-Disappoint Features

### True Parallelism
- **Current state:** Both `Pipeline.resume()` and `FlowRunner.execute()` use a single sequential `while (pending task) { await run one }`.
- **Why hard:** The file contract, append-only log, live `currentTaskId` / `nodeStatus`, retrospective emission, and UI progress model are all built around sequential visibility. Adding real concurrency requires:
  - Scheduler + locking or careful file coordination.
  - Changes to how "active" state is represented (multiple actives?).
  - Potential re-thinking of the "one spinner / one animated edge" feel policy.
- **Risk:** Implementing it poorly will make the UI confusing and the audit log harder to follow. It may be a bad idea until the sequential version is rock-solid and the value of parallelism is proven with real user flows.

### Restart / Crash Resilience for Long-Running Flows
- **Classic pipeline:** Relatively resilient (approvals re-check `meta.stage`).
- **Custom flows:** `FlowRunner.gates` is a plain `new Map()` of `resolve` functions. Comment in code: *"flow runs cannot resume after an app restart."*
- **Impact:** Any flow that uses `requiresApproval` on a node becomes un-approvable if the app is closed. This directly conflicts with "trustworthy" feel for anything longer than a few minutes.
- **Fix cost:** Non-trivial (persist pending gates + a way to re-attach listeners after restart, or move approval state fully into files + polling).

### Context Bloat & Token Cost in Custom Flows
- `upstreamContext()` concatenates **every** upstream node's full output for aiSteps.
- No summarization, no selective passing, no token estimation.
- Combined with large task outputs written by agents, this will rapidly become unusable and expensive.
- **Bad idea if pursued naively:** "Just make bigger graphs" without addressing this will produce a system that only works for toy problems.

### Large Graphs & Editing Surface
- Current canvas editing is basic (manual positions, connect, delete, name).
- No auto-layout, validation, undo, minimap, edge data, type checking on connections.
- React Flow will start to feel sluggish without memoization work and virtualization once you have 15–30 nodes + inspector content.
- For users who want "the flow builder," the current surface will disappoint quickly.

### Sync Filesystem as Fundamental Contract
- Every read/write in `RunStore` and `FlowStore` is `...Sync`.
- Fine for current tiny runs on a developer machine.
- Becomes a liability for large outputs, many tool calls, or slower disks.
- Changing it later is a breaking philosophical shift (the "file-based" story changes).

### Streaming & Perceived Responsiveness
- LLM calls are fully blocking (`await callModel` → then write output → notify).
- No partial results visible in the canvas or inspector.
- With real models this means minutes of "nothing is happening" even when the model is generating.
- The current mock sleep + animated edge is good theater; real usage will expose the gap.

---

## 3. Performance, Responsiveness & Feel — Specific Assessment

### What Has Been Done Well (Intentional)
- Explicit motion policy in CSS: only one continuous animation at a time.
- Waiting pulse for approval gates, nice status glyphs.
- Debounced saves.
- Theme sync with native controls.
- Reduced-motion support.
- Deliberate mock latency so the UI can demonstrate progress.

### What Will Fight You
1. **Full snapshot over IPC on every mutation.**  
   `pushUpdate` sends the entire `snapshot` (prompt + plan + all tasks + all outputs + all retrospectives + nodeOutputs). As outputs grow this becomes heavy and causes re-renders of the whole canvas.

2. **React Flow recreation.**  
   `buildGraph` / `buildFlowRunGraph` + new node/edge arrays on every update. No `React.memo` on custom nodes, no stable references.

3. **Inspector pre blocks.**  
   Can contain very large text. Only capped at 320px; layout can jank when content arrives.

4. **Repeated full file reads.**  
   `upstreamContext`, `snapshot()`, task output collection, etc. do many `readFileSync` calls with no caching.

5. **Main-process sync I/O.**  
   During a run the orchestrator can be slowed by disk while the renderer waits for the next status.

6. **No budgets or measurement.**  
   Nothing logs "canvas update took X ms" or "stage transition latency."

### Realistic Targets You Should Decide On
Document these explicitly (suggested language is already in GOALS.md). Example measurable proxies:
- Status change visible < 100ms after the file write that triggered the IPC (on a typical dev machine).
- Able to switch to another run or edit a different flow with zero perceived hitch while a 10-task run is executing.
- A 15-node custom flow with moderate output sizes still feels responsive when dragging or selecting.
- "Open run folder" remains pleasant even when individual artifacts are 10–50k lines.

If these are not the actual targets, the current architecture may be over- or under-engineered.

---

## 4. Other Subtle Tensions & Bad-Idea Risks

- **Two mental models in one product.**  
  Classic stages (planner → router → executor) vs. canvas nodes (input → agentTask/aiStep → output). The router stage is classic-only. Task creation can happen in three different places. This is cognitively expensive.

- **File-based value is uneven.**  
  The transparency story is extremely strong for the classic pipeline (plan.md, tasks/*.md, retrospectives are gold). For pure chains of `aiStep` nodes the files mostly add indirection and repeated reads without proportional benefit.

- **"Adaptive from retrospectives" is currently marketing.**  
  Only a one-way text dump into the classic planner. No real feedback loop exists for custom flows or even for re-planning.

- **Over-generalizing the graph runner too early.**  
   Adding more node types or control flow before the current four types + sequential execution are delightful will multiply surface area without clear user value.

- **Treating the canvas like a toy vs. a serious tool.**  
   If the goal is serious workflow authoring, the editing experience needs auto-layout, better validation, and probably a grid + snap very soon. Otherwise it will be used only for demos.

---

## 5. Suggestions for Clarification (What You Should Decide)

Before investing more in the flow builder direction, answer:

1. **Primary value proposition?**  
   A. "The best way to run a reliable, inspectable, human-gated multi-model pipeline with optional visual extensions."  
   B. "A general visual canvas for authoring arbitrary AI workflows."  
   (These pull in opposite directions on parallelism, node types, restartability, and editing polish.)

2. **How important is restartability for flows with approval gates?** (This may force a change in how gates are represented.)

3. **What is the target graph size and output size you want to feel good?** (This should drive architecture choices around context, snapshots, and FS usage.)

4. **Is streaming / partial visibility a requirement or a nice-to-have?**

5. **Are the current four node types the complete set for the foreseeable future, or do you expect conditionals, loops, subflows, data mappers, etc.?**

---

## 6. Documentation Recommendations (Final)

### What Was Done in This Task
- Created `GOALS.md` (authoritative, AI-optimized, includes maturity history, principles, NFRs, current reality).
- Created this `CRITICAL-REVIEW.md`.
- Added (will add) pointer from README.

### Recommended Ongoing Practice
- Keep **GOALS.md** short enough to fit comfortably in an LLM context window (current version is designed for this).
- Put a "Principles" section at the very top that can be copy-pasted into system prompts: "You are working on LLM Flow. Always read GOALS.md first."
- Add a "Last verified" footer with date + short commit.
- When in doubt, document the **why** and the **deliberate non-goals**, not just the what.
- For performance: make the Quality Attributes section contain the observable behaviors you actually care about. Vague "must be responsive" is useless to future implementers.
- Consider a lightweight `DECISIONS.md` or section for big tradeoffs (file system vs DB, sync vs async, generality vs reliability).

### Suggested README top addition
```md
**Read [GOALS.md](./GOALS.md) first.** It contains the authoritative vision, principles, current architecture, and non-functional requirements (especially performance and feel).
```

---

## Conclusion

The project has a genuinely interesting and defensible core (file transparency + visual liveness + human control + model pluralism). The first three commits show good discipline in preserving the file contract while adding the graph layer.

However, several things the user probably cares about (smooth complex graphs, parallel work, reliable long-running flows with approvals, good feel at scale) are either not implemented or actively made harder by current choices.

The critical next step is for **you (the owner)** to read both GOALS.md and this review, then explicitly decide and document:
- The real priority ordering.
- Which hard problems are worth solving and which are out of scope.
- What "incredibly important" performance and feel actually mean in measurable terms.

Doing that now will save a lot of future AI (and human) confusion and mis-implemented features.

If any of the analysis above does not match your actual intent, the misunderstanding has already begun — which is exactly why this review was requested.
