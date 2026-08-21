# Flyt — goals and boundaries

Flyt makes structured AI work understandable and controllable. The ordinary path should stay simple: open a project, pick a flow, describe the job, and watch it run.

## Product model

1. **Node library** — reusable AI templates define how work is done: model, tools, instructions, skills, and approvals.
2. **Flows** — visible graphs compose templates and structural nodes. Humans can edit them on the canvas; agents can author the same graph through the flow DSL.
3. **Runs** — file-backed executions stream into the canvas and leave enough evidence to explain, reproduce, resume, or inspect the result.
4. **Loop** — an optional supervisor turns backlog tasks into isolated, gated, reviewed changes. It extends attended work; it does not replace it.

## Non-negotiable principles

1. **Files are the durable source of truth.** Templates, flows, tasks, run state, outputs, approvals, logs, and measurements must survive process death and remain inspectable. Short-lived coordination may live in memory, but correctness may not depend on it surviving.
2. **Human authority is the default.** Project writes and shell commands ask unless the user explicitly selects a more permissive approval mode. Unattended work must be isolated, capped, verified, and reviewable.
3. **Artifacts must be self-describing.** A task states its goal, dependencies, constraints, worker, and gates. A run records the resolved flow, model calls, tool calls, outputs, and retrospectives that produced its result.
4. **The model is replaceable.** Provider and model selection are configuration, not architecture. Static choices and deterministic routing come before extra model calls.
5. **Inspectability beats hidden convenience.** The canvas, run folder, CLI diagnostics, and backlog should tell the same story. A failure, refusal, missing capability, or degraded fallback must be visible.
6. **The front door stays simple.** Advanced composition belongs in reusable flows and templates, not in a form the user must rebuild for every request.
7. **Slow work must not make a slow interface.** The renderer stays interactive during model calls, streaming updates are incremental, and motion communicates state without competing for attention.
8. **Verification is external to the agent's claim.** For unattended changes, declared gates, review, and post-merge checks decide whether work lands.

## Product boundaries

- Flyt is a local, single-machine application. Distributed or cloud execution is not a current architectural target.
- The flow language is composition, not general-purpose visual programming. Typed inputs, bounded containers, sub-flows, fan-out, and the Loop handoff are supported. Bounded iteration and structured predicates over declared outputs are supported (D56); arbitrary expressions, arithmetic, and free boolean algebra are not, and are not a direction.
- Large graphs and unbounded recursion are outside the current UI and execution assumptions.
- Production-grade process sandboxing is not claimed. File tools are workspace-confined; shell safety comes from approvals, screening, worktree isolation for Loop tasks, and user-chosen risk.
- General self-modification is not a product promise. Retrospectives, benchmarks, and archives provide evidence; deterministic code and explicit decisions decide what changes.
- New dependencies need a concrete payoff. The flow parser, core command surface, and built-in infrastructure deliberately prefer small, inspectable implementations.

## Quality bar

A useful Flyt run is:

- easy to start;
- visible while it works;
- honest when it cannot proceed;
- resumable without repeating completed work;
- attributable to specific models, prompts, tools, and files;
- bounded in concurrency, recursion, time, and unattended spend; and
- independently verifiable when it changes a repository.

A rebuild of the product model onto a plugin kernel is approved and under way; the nouns become plugin, stack and block, and the plan is [`.flyt/backlog/v2-plugin-stack-plan.md`](./.flyt/backlog/v2-plugin-stack-plan.md) (D52-D63). This file keeps describing the shipping product until the Phase 5 cutover.

Durable choices and unresolved product questions live in [`DECISIONS.md`](./DECISIONS.md). Current implementation details live in [`DESIGN-SPEC.md`](./DESIGN-SPEC.md); this file should not become a status log or implementation plan.
