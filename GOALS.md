# Flyt — goals and boundaries

Flyt makes structured AI work understandable and controllable. The ordinary path should stay simple: open a project, choose or compose a stack, describe the job, and watch its blocks run.

## Product model

1. **Plugins** are installable units that contribute blocks, tools, skills, and typed UI descriptions.
2. **Stacks** compose those contributions as bounded containment in `stacks/*.stack.yaml`.
3. **Blocks** are the executable steps. Their definitions own their title, settings schema, outputs, and static tool ceiling.
4. **Runs** are append-only session logs with rebuildable projections for Work and Trace.
5. **Loop** is an optional supervisor that turns file-backed backlog tasks into isolated, gated, reviewed changes.

## Non-negotiable principles

1. **Files are the durable source of truth.** Stacks, tasks, session events, outputs, approvals, and measurements survive process death and remain inspectable.
2. **Human authority is the default.** Project writes and shell commands ask unless the user explicitly selects a more permissive mode. Unattended work is isolated, capped, verified, and reviewed.
3. **Artifacts are self-describing.** A task states its contract; a run records the resolved stack, model calls, tool calls, outputs, and route decisions that produced its result.
4. **Models are replaceable.** Provider and model selection are configuration, not architecture. Deterministic routing comes before extra model calls.
5. **Inspectability beats hidden convenience.** Work, Build, Trace, run files, diagnostics, and the backlog must tell the same story.
6. **The front door stays simple.** Advanced composition belongs in reusable stacks and plugins, not in a form rebuilt for every request.
7. **Slow work must not make a slow interface.** The renderer stays interactive and streams bounded, safe progress metadata.
8. **Verification is external to an agent's claim.** Declared gates, independent review, mechanical checks, and the post-merge canary decide whether unattended work lands.

## Product boundaries

- Flyt is a local, single-machine application; distributed execution is not a current target.
- The stack language is composition, not general-purpose visual programming. It supports six bounded containers and structured predicates over declared outputs, never arbitrary expressions or unbounded recursion.
- Stack layout is derived from containment and is never durable state.
- Production-grade process sandboxing is not claimed. File tools are workspace-confined; shell safety comes from approvals, screening, and Loop worktree isolation.
- General self-modification is not a product promise. Retrospectives and benchmarks provide evidence; deterministic code and explicit decisions decide what changes.
- New dependencies need a concrete payoff. The stack parser and core command surface remain small and inspectable.

## Quality bar

A useful Flyt run is easy to start, visible while it works, honest when blocked, resumable without repeating completed work, attributable to specific models and tools, bounded in cost and concurrency, and independently verifiable when it changes a repository.

Durable choices and unresolved product questions live in [`DECISIONS.md`](./DECISIONS.md). Current implementation details live in [`DESIGN-SPEC.md`](./DESIGN-SPEC.md).
