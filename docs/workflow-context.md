# Workflow model context

Workflow execution uses `BlockRun.context = { mode: 'block-input', after, executionId }`.
The scheduler owns this contract. Ordinary AI steps, work blocks and task-graph
planners pass it to `runAgentLoop`, where requests are assembled from canonical
events tagged with the current block id and newer than the execution cursor.
Block configuration cannot widen this scope with `isolated: false`.

A sequence passes only its predecessor's output as the next block's input.
It does not inherit earlier system prompts, reasoning, tool calls or tool results.
A block keeps its own transcript across tool rounds and repair turns. To carry
earlier evidence forward, include it in the delivered artifact.

A parallel container freezes its input and upstream completion map on entry,
before the first execution wave. Each lane gets that input and its own map.
On resume, completed descendants are available only in their owning lane.
The container exit is the join: it publishes structured results downstream and
carries each lane's final output, labeled in declaration order. Nested parallel
containers follow the same rule.

The parent session remains the authoritative ordered audit log. Isolation uses
filtered views of that log, rather than duplicating events into ordinary block
child sessions. Active block records retain the context cursor for interrupted
executions; a fresh invocation starts a new cursor. `step.prompt` records the
block id, exclusive `afterSeq` and inclusive `throughSeq` needed to reconstruct
the request's canonical transcript.

Generated workers retain their existing linked child sessions, dependency
artifacts and profile policy. Parent cursors are not copied into child logs.
Child identities include the parent execution and context boundary, so a fresh
iteration or supervisor restart cannot reuse an earlier task's child transcript.
Retrying an interrupted task retains its own completed tool evidence. Retries
without evidence start fresh; completed writes retain checkpoint recovery.
Request call IDs include their durable turn sequence to distinguish retry calls.
Calls outside the workflow scheduler default to block isolation; an explicit
`isolated: false` still permits sharing within such a session.

Repeat, until and foreach bodies have durable execution IDs that include every
enclosing iteration index. Resume replays each completed invocation once and
then continues the remaining iterations. Foreach publishes the last completed
element's structured artifacts downstream. An interrupted until does not claim
it exhausted its pass budget. A supervisor restart invalidates all executions
of the named block and carries its guidance as explicitly scoped input.

Old iteration logs cannot identify multiple invocations reliably. Their single
unscoped outcome is reused only for the first iteration. Untagged transcript
events in old single-block logs are adopted only when the bounded log contains
exactly one possible owner; ambiguous multi-block history is excluded.

Message-mutating plugins are refused at both context assembly and request
preparation for scoped requests, before any provider call. In explicitly shared
sessions, a changed message array is stored as `step.prompt.content.messages`
with source `effective-messages`; unchanged requests keep compact canonical
locators. Plugin interception traces retain their hashes and owner names.

AI/work blocks accept `maxOutputWords`; task graphs accept
`workerMaxOutputWords`. Graphs also recognize explicit numeric ceilings in their
incoming brief: `under`, `below`, `fewer than`, `at most`, and `no more than N
words`. Other phrasings are not automatically interpreted. The smallest declared
ceiling applies, and strict bounds subtract one. Word counts use whitespace
separation. An oversized answer receives one tool-free correction; an invalid,
truncated or still-oversized correction fails visibly. Durable
`block.output.validation` events record the checks. Dependency handoffs include
recorded attempt counts, tool-result counts and word validation; other constraints
remain explicitly unverified rather than being inferred from a successful status.

Source previews use contiguous numbered lines and a precise `nextOffset` instead
of head/tail excerpts. Raw source remains in the durable tool result.
`startLine` and `startColumn` identify resumed pages, including long-line cuts.
Workers are instructed to cite supplied lines and identify unverified coverage.
These measures supply reliable evidence; they do not guarantee a model will never
make an unsupported claim.

This contract scopes automatic transcript assembly. It does not isolate the
filesystem or prevent an explicitly granted tool from reading other run data.
