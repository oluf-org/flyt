# Loop supervision on the kernel runner

## Current architecture

Unattended Loop work has one execution route:

`Supervisor` → `stack:run` → `stacks/loop-task.stack.yaml` → kernel `StackRunner` → canonical `session.jsonl`

There is no `flow:run` fallback. A kernel composition or start failure is a harness failure, and the Supervisor parks the task with that evidence instead of creating a run with different control and recovery semantics.

The familiar Work entry remains intentionally separate. It still uses editable daily workflows, workspace tabs, the prompt composer, recent runs, and the Models library. A fresh install seeds an `Assistant` workflow for that entry. Those stores are a user-facing workflow product, not a Loop compatibility layer.

## Host composition

`core/kernelRunner.js` builds one worktree-scoped kernel host and installs:

- the canonical JSONL session store and run projection;
- the filesystem seam rooted at the exact task worktree;
- the canonical stack parser and stack store;
- all built-in block plugins and the kernel stack runner;
- the real model adapter bridge, including provider and CLI routing metadata;
- the application tool library behind kernel classification, ceiling, and approval gates; and
- the existing backlog, worktree pool, references, skills, and settings as tool context.

Booting a host is read-only with respect to the worktree. In particular, it does not create `.flyt/config.json`; host setup must never manufacture a protected-path diff before the worker acts.

Each run records workspace, approval mode, task, provider/model, Auto Router band constraints, effort level, skills, stack resolution, block state, tool calls/results, model usage, and stage transitions in `runs/<runId>/session.jsonl`. The host also forwards the configured retry and timeout policy to every adapter call. Compatibility snapshots used by the Supervisor and existing UI are projections rebuilt from that log, not a second source of truth.

## Control and recovery

- `run:snapshot` detects a kernel session and projects its status, current block, outputs, tool evidence, and usage.
- `run:stop` calls the live kernel agent registry and reports `not-live` honestly when another process owns the run or it has already settled.
- `run:resume` reconstructs the host from `run.created` metadata. Completed blocks are replayed; active blocks run again.
- An interrupted tool call is represented by a synthetic `NEVER_RETURNED` tool result when messages are derived, so the resumed model sees the break instead of a silently altered conversation.
- `run:restartNode` writes a durable pending transition plus the Supervisor's guidance, then resumes the same session.
- A settled run is materialised once more, removed from the live host maps, and its plugin graph is disposed. Later inspection reads the durable session, preventing one resident kernel per unattended attempt.

## Safety and observability

The Loop worker profile remains narrower than the desktop profile. Tool classification is not a grant: the block ceiling, runtime ceiling, and approvals seam all have to allow a call. Built-in tools execute with the task's existing worktree/backlog/pool/reference context and cannot escape the filesystem root supplied to the kernel.

The `workspace-change` effect is enforced inside the kernel block before it can report success. The host records a workspace signature observation after tool activity, and the effect block fails closed when no durable change is observed. Landing still independently checks blast radius, declared gates, diff review, merge, and post-merge canary.

Model usage in kernel `llm.response` events is understood by the existing ledger, including camelCase token and cost fields. The Supervisor therefore applies the same live burn, task, session, and rolling caps as before, while the run remains independently auditable from its session.

## Compatibility removed

The following Loop-only scaffolding is gone:

- the generated `loop-task.flow.yaml` seed and `LOOP_TASK_ID` coupling;
- the Supervisor's `flow:run` fallback;
- the temporary `npm run flow -- lint` alias; and
- the compatibility projection test.

`core/stackRunner.js`, `FlowStore`, `NodeStore`, and the workflow DSL remain because the product still exposes the familiar daily Work and workflow-library experience. They no longer participate in Loop supervision. Removing them would remove current user-facing behavior and is a separate migration, not Loop cleanup.

## Verification contract

`tests/loopKernelParity.test.js` exercises the production host rather than source-only mocks:

- work is confined to the worktree and the durable snapshot contains launch metadata;
- spend is recovered from canonical model events;
- missing workspace effect fails inside the kernel before landing;
- an interrupted session resumes in a newly composed host with missing-call evidence;
- stopping an unknown/non-live run fails explicitly; and
- a fresh Supervisor claims a real temporary-repository task, runs the kernel worker, passes project/default gates and independent review, merges, runs the canary, updates status, and records spend.

Run `npm test`, `npm run build`, and `npm run stack -- lint` before landing changes to this boundary.
