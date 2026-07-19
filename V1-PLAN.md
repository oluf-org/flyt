# LLM Flow — V1 Task Plan

**Status:** Proposed (2026-07-15).
**Read alongside:** `PRODUCT-SPEC.md` (what/why), `DESIGN-SPEC.md` (built vs. planned), `DECISIONS.md` (decisions + open questions), `GOALS.md` (principles).

> **Definition of V1 (from `PRODUCT-SPEC.md` §8).** The minimum bar at which the owner would show it to another developer and say *"use this instead of Cursor."* Concretely: **the coding-agent loop works end-to-end against a real project, transparently, with the mastery/control feel intact.** When the final task below passes, V1 is complete.

## Scope decisions for this plan

- **Routing: lean.** Keep today's static category-based worker routing. The capability matrix, LLM tiebreaker, and comparison/ranking (the thesis-demonstration features) are **post-V1**. This matches the three V1-critical items named in `DECISIONS.md`.
- **Safety: minimal.** Approvals + workspace path-confinement only. The command-guard evaluator node, diff/dry-run preview, and safety opt-out are **post-V1**.
- **Business model / distribution: unchanged.** BYO-key for V1 (D18); the capped-key subscription (D18) and packaging/signing/auto-update (D19) are **out of V1**.
- **Workflow selection:** curated dropdown (D6); the AI-helper builder is **out of V1** (a run *view mode* is in — see task 9).

Anything not listed as a task below is deferred (see "Explicitly out of V1").

---

## The V1 task list (dependency-ordered)

Each task lists its source decision, its dependencies, and the acceptance check that means it is *done*.

### Phase A — Make the coding loop real (operate on an actual repo)

**1. Workspace binding + per-project config**
- Give a run a **target workspace** (a real project folder), selected at run time (resolves Q-D5 in favor of run-time selection: workflows stay workspace-agnostic).
- Per-project configuration lives in a **`.llmflow/` folder inside the project** (version-controllable), not appdata (D15).
- *Depends on:* none. *Acceptance:* a run can be pointed at an arbitrary local repo; `.llmflow/` is created/read there; the bound path is visible in the UI and recorded in `meta.json`.

**2. Real file tools: `read_file`, `create_file`, `write_file`**
- Extend the tool registry (`core/tools/`) so file tools act on the **bound workspace**, not `runs/<runId>/workspace/`.
- Enforce **path confinement** (traversal rejected) against the real workspace root.
- *Depends on:* 1. *Acceptance:* an `agentTask` can read an existing repo file, create a new one, and edit one; every call is logged to `log.jsonl`; no write escapes the workspace root.

**3. `bash`/shell tool**
- Add a shell tool (`core/tools/bash.js`) running commands with the workspace as cwd, confined and fully logged (D14 tools portion).
- Wire it into both the NATIVE and TEXT tool protocols in `core/agent.js`.
- *Depends on:* 1, 2. *Acceptance:* an `agentTask` can run e.g. tests/build commands in the real repo; output is captured to the task artifact and the log.

**4. Minimal safety envelope**
- Keep per-node **approval gates** as the oversight mechanism; ensure file + bash tools honor them.
- Harden **path/command confinement** to the bound workspace (the minimal envelope; command-guard node + diff preview are post-V1).
- *Depends on:* 2, 3. *Acceptance:* a gated node pauses before a destructive tool call; approving proceeds, rejecting aborts; confinement holds under adversarial paths.

### Phase B — Concurrency & resilience

**5. Incremental IPC (retire full-snapshot pushes)**
- Replace whole-snapshot-on-every-mutation with incremental/diffed renderer updates (§10, Q-D7). Prerequisite for both streaming and parallel status without re-sending everything.
- *Depends on:* none (can start in parallel with Phase A). *Acceptance:* a mutation pushes only the changed slice; the canvas still reflects state within one animation frame of the file write.

**6. Parallel `agentTask` / executor execution**
- Extend bounded parallelism (`maxParallel`) from `aiStep` fan-out to tool-using `agentTask`s (D7).
- Handle the three hazards (Q-D1): **concurrent-safe append to `log.jsonl`**, correct **multi-active node status**, and **workspace write-isolation** between concurrent tasks.
- *Depends on:* 2, 3, 5. *Acceptance:* two independent agentTasks run at once against the workspace without corrupting the log or each other's writes; the canvas shows both active.

**7. Restart resilience for completed steps**
- Ensure **completed steps survive an app restart** and a run resumes without redoing them (D17 near-term). Fuller pending-gate crash resilience stays post-V1.
- *Depends on:* 6. *Acceptance:* kill the app mid-run, relaunch, resume — completed nodes are not re-executed; the run continues from the right point.

### Phase C — Transparency & feel (the mastery/control pitch)

**8. Token streaming surfaced in the UI**
- Consume the adapter `onText` contract in the executor/runner → write incremental `nodes/<id>.md` → push to the renderer (§6, D10).
- Add a **streaming sidebar** showing the currently-working node's live output. (Status-summary-over-all-active-nodes stays post-V1.)
- *Depends on:* 5. *Acceptance:* with a real model, output appears progressively during a node's execution rather than only on completion.

**9. Dedicated run "view mode"**
- A live run view distinct from the edit canvas (D5 view-mode portion): status glyphs, streaming sidebar, "Open run folder," and **deliberate multi-active animation** (per the relaxed D9 rule).
- *Depends on:* 8. *Acceptance:* a user can start a run and watch it end-to-end in a purpose-built view; parallel nodes animate legibly; the run is understandable without opening files.

**10. Inject template `skills` into execution** *(close the known gap)*
- Skills are stored/edited but not injected (README + `GOALS.md` remaining gap). Wire attached skills into prompt/tool assembly so the feature is real.
- *Depends on:* 2. *Acceptance:* a template with a skill measurably changes execution; behavior is logged. *(Lowest priority in V1; drop if it threatens the timeline.)*

### Phase D — Real-model path & acceptance

**11. Validate the BYO-key real-model path**
- The default is `mock`. Verify the OpenRouter and Anthropic adapters drive the full loop (planning → tools → retrospectives) with a real key, including native tool-calling and retry/backoff under real latency.
- *Depends on:* 3, 6, 8. *Acceptance:* the Default pipeline and one agentTask-heavy workflow complete correctly on a real model via a user-supplied key.

**12. V1 acceptance — end-to-end coding loop on a real project *(final task)***
- Point LLM Flow at a real repo and have it **build a non-trivial feature end-to-end**: plan → approve → decomposed + parallel execution with real file/bash tools → verify → result landed in the workspace.
- Confirm the felt bar: transparent (watchable in view mode, streaming), controllable (gates work), resumable (survives restart).
- Update `GOALS.md`/`DESIGN-SPEC.md` status lines and the built-vs-planned table.
- *Depends on:* all of 1–11. *Acceptance:* the owner can run it on their own project and honestly say *"use this instead of Cursor."* **When this passes, V1 is done.**

---

## Dependency summary

```
1 ─► 2 ─► 3 ─► 4
      │    │
5 ────┼────┼────────────► 8 ─► 9
      └────┴─► 6 ─► 7
2 ─► 10
3,6,8 ─► 11 ─► 12 (all)
```

Critical path: **1 → 2 → 3 → 6 → 11 → 12**. Task 5 (incremental IPC) should start early because 8 and 6 both lean on it. Task 10 is optional and parallelizable.

## Explicitly out of V1 (post-V1 backlog)

Routing capability matrix + LLM tiebreaker (D12); model comparison / per-task ranking (P§7, Q-P3); context-analysis step (D11); orchestrator depth/budget guards beyond current behavior (D8, Q-D2); command-guard node, diff/dry-run preview, safety opt-out (D16); status-summary-over-all-active-nodes sidebar (§6); AI-helper workflow builder (D5); capped-key subscription backend (D18); packaging / signing / auto-update (D19); full async filesystem rework (§10).
