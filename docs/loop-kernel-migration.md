# Loop Supervision onto Kernel Runner — Migration

## Goal
Replace `core/stackRunner.js` compatibility runner with `kernel/src/plugins/stack-runner.ts` `StackRunner` (Cordis `ctx.agents`) for `stacks/loop-task.stack.yaml` without losing Loop capability, safety, recovery, or observability.

## Architecture delta
- **Before:** `Supervisor` → `api.invoke('flow:run', { flowId: LOOP_TASK_ID })` → `ProjectRegistry.createRunner` → `core/stackRunner.StackRunner` → `RunStore` (log.jsonl/files) + `FlowStore` + `NodeStore`.
- **After:** `Supervisor` → `api.invoke('stack:run', { stackId: 'loop-task' })` fallback `flow:run` → `kernel StackRunner` via `ctx.agents.start({ id, runId }, input)` → `JsonlSessionStore` (`runs/<id>/session.jsonl` canonical, projection rebuildable) + `StackStore` + `ctx.blocks` registry + `ctx.fs` (worktree), `ctx.tools`, `ctx.llm`, `ctx.approvals`.

Compatibility runner retained until parity passes (this document + parity tests are the gate). Deletion of `core/stackRunner.js`, `core/stacklang` graph parser, generated `compatibility/flows` + `compatibility/nodes` stores, and `bin/flyt.js` `flow` alias deferred to next task after `npm test` + manual `stack:run` smoke passes on real model.

## Seams mapped
| Loop need | Kernel seam | Notes |
|-----------|-------------|-------|
| workspace isolation | `ctx.fs` (`flyt-fs-worktree` provider) | Supervisor's `work:start` worktree dir becomes FsSeam root. No `workspaceDir` bypass. |
| model | `ctx.llm` (`flyt-llm-adapters`) | `level`/`worker` from `Supervisor.#workerFor` passed as `run.config.model`; `routeOf` handles OpenRouter Auto Router bands. |
| tools | `ctx.tools` (`flyt-tools`) + `tools/pre-execute` gate | `LOOP_CEILING` (`flyt-blocks-core:work` ceiling) intersect run ceiling; classification not a grant; approval mode `always` via `flyt-loop-worker` profile. |
| backlog | `ctx.commands` (`flyt-api`) `task:*` commands | Work block already has `create_task`, `enqueue_task`, `list_tasks`, `read_task`, `why_blocked`, `update_task`. |
| gates | `run_gate` tool + host `gates` | Supervisor runs same gate commands post-run for verification; no second semantics. |
| review/landing | `landTask`/`verifyTask` via `api` `work:*` | Unchanged; landing still reads `session.jsonl` via `explainRun`/`doctor`. |
| canary/spend | `Ledger` totals + `totalsWithLive` inclusive of `session.jsonl` `llm.response` usage | `JsonlSessionStore` logs `usage`/`route` on every `llm.response`; `deriveMessages` reconstructs cost even if run interrupted. |
| diagnostics | `session/append` → Trace/Work `deriveMessages` | Dotted vocabulary (`run.created`, `block.status`, `tool.result` etc.) — slash names are Cordis dispatch, not durable log. |
| skill | `ctx.skills` registry | Supervisor's `missingSkills` check stays — worktree missing `.flyt/skills/<name>.md` warned, not parked. |

## Supervisor change (this patch)
`core/supervisor.js` `#runTask` now tries `stack:run` first:

```js
let runId;
try {
  runId = await this.invoke('stack:run', {
    projectId, stackId: 'loop-task',
    input: this.#briefFor(task),
    workspaceDir: wt.dir,
    approvalMode: 'always',
    level, worker, loopTaskId: task.id,
    skills: task.skills ?? null
  });
} catch (e) {
  if (e?.code !== 'unknown_command') throw e;
  runId = await this.invoke('flow:run', { projectId, flowId: LOOP_TASK_ID, userInput: ..., workspaceDir: wt.dir, ... });
}
```

Keeps all existing `flow:run` mocks green (fallback), new path exercised by parity test via mocked kernel `stack:run`.

`core/api.js` adds `stack:run` command:
- Resolves `StackStore` from `engine.stackRoot` (seeded `stacks/` bundle) with `kernel.parseStack` and `ctx.blocks.resolve` guard.
- Boots kernel `flyt-loop-worker` profile lazily on first `stack:run` (sessions root = project's `runs/` dir, approvals `always`, tools/skills/commands/ui-extensions providers).
- Provides `ctx.fs` confined to `workspaceDir` (worktree) per invocation via scoped child context.
- Starts stack `{ id: stackId, runId }` with `input`, returns `runId`; heartbeat and `pool` ownership unchanged.

## Durable session & resumability
- `kernel/src/session/jsonl.ts` `JsonlSession` is the truth; `runs/<runId>/session.jsonl` appended before `llm.request`. Torn tail repaired on next `#sync`; `deriveMessages` injects `NEVER_RETURNED` synthetic `tool.result` for unreturned calls so interrupted runs resume from `agents.resume(runId)` without ghost tool shape change.
- Heartbeat still reads work signature + spend via `spendFromRun` (now `session` fold, not `retrospectives`). Stall detectors `detectStall`/`nextIntervention` ladder (nudge→restart→escalate→park) reads `block.status=active` same as compat `nodeStatus=active`; `currentNodeOf` mapping preserved.
- Ledger `totalsWithLive` includes live runs' `session.jsonl` `usage` so `loop:report` inclusive of in-flight spend.

## Safety parity
- `flyt-loop-worker` profile asserts `assertNarrower(desktop, loopWorker)` — worker never gains row desktop lacks.
- `block.ceiling` intersect `run.ceiling`; `inferTool` err toward restriction; plugin tool `unclassified` not grantable.
- Skill request never grants unattended; human `ask_human` vetoed by `approvals` seam when nobody present (denied, not guessed).

## Parity tests (new `tests/loopKernelParity.test.js`)
Covers the "remains resumable and explainable" clause:
- status: claimed→running→parked/done updates durable backlog file.
- retry: `flow:run` fallback via `unknown_command`; `stack:run` success records `runIds` and is stoppable via `agents.stop`.
- approval: gate veto -> `Parked for approval - gate: ...`.
- spend: `llm.response` `usage.cost` reaches `Ledger` even when run interrupted.
- worktree ownership: `attempt_live` deferred not parked; second attempt with stale lease reclaimed; cleanup respects `owner-mismatch`/`live-owner`.

## Commands
- `flyt stack -- lint` canonical linter (was `flow -- lint` alias). Alias kept one release, warned.
- `flyt run loop-task --input "…"` now prefers `stack:run` (kernel) via api; `flyt flow run` alias still hits compat path.

## Verification done this patch
- `npm run build:kernel && npm test` — existing suites pass (supervisor fallback preserves mocks).
- Manual smoke (mock provider, no creds):
  `node bin/flyt.js task add "probe-kernel-loop" --goal "write docs/probe.md with hello" --blast docs/probe.md --gates "npm test" && node bin/flyt.js loop start --maxTasks 1` → worktree created, `runs/<id>/session.jsonl` has `run.created`→`block.status:work:active`→`block.output`→`block.status:done`, `docs/probe.md` in worktree, landing canaried, ledger entry present, `flyt doctor` clean.

## Next steps (separate task after parity green)
- Delete `core/stackRunner.js`, `core/stacklang/{parse,serialize,lint}`, `core/flowstore.js` compat projection, `core/nodestore.js` generated nodes store, `compatibility/` seeding, `flow` CLI alias in `bin/flyt.js` + `package.json`, and `tests/loopCompatibility.test.js` seeding test.
- Remove `electron/main.js` `flow:run` IPC binding once renderer Work/Build uses `stack:run`.

## References
- `kernel/src/plugins/stack-runner.ts` `StackRunner.start` returns durable immediately, `settled()` awaited by heartbeat polling.
- `DESIGN-SPEC.md` §3 (kernel walks parsed containment), §5 (pre-execute gate), §8 (supervisor file-backed).
- `DECISIONS.md` D45/D57/D55/D62.
