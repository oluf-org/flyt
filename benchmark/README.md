# The benchmark suite

A fixed set of scored cases the loop is run against, so that "improve yourself" can be told
apart from churn (`LOOP-PLAN.md` §12.1).

```
flyt bench list                  the cases
flyt bench run                   clone, work the suite, score it
flyt bench compare               is it better than last time
```

## How a run works

1. The repository is cloned — at a **commit**, outside every repo, thrown away afterwards.
2. Each case's `setup` runs in the clone and is committed, so a case may seed its own failure.
3. The cases are written into the clone's backlog and **the ordinary loop works them**: same
   supervisor, same worktrees, same gates, same reviewer, same ledger. Nothing here
   re-implements the loop, because a benchmark of a different system is not a benchmark.
4. Afterwards each case's **probe** runs in the clone. `landed` and `verified` are separate
   numbers, and the gap between them is the point.

Scores land in `.flyt/scores/` and are copied into `.flyt/archive/<date>/` at day's end.

## Writing a case

`<id>.bench.md` — YAML frontmatter, then the body the agent will read as its task.

```yaml
---
title: What it must achieve
level: low            # the band it STARTS at; escalation is part of the score
probe: node benchmark/probes/<id>.mjs      # required
setup: node benchmark/setup/<id>.mjs       # optional, committed into the baseline
weight: 1
gates: []             # extra gates for this case, on top of the project's
---
```

Three rules, each learned the hard way somewhere:

- **A case with no probe is refused at load.** An unscored case in a scored suite inflates
  every number after it.
- **The body and the probe must agree, exactly.** The probe is the grader and the body is the
  only thing the agent sees, so anything the probe checks belongs in *Done when* in the words
  the probe uses. A probe that tests something the case never asked for measures luck.
- **`setup` must leave the suite green.** The cases share one clone worked in sequence, which
  is what an overnight run actually looks like; a setup that reddens the baseline fails every
  *other* case for reasons that have nothing to do with them. The runner records the baseline
  so contamination is visible rather than assumed away — seed failures somewhere the existing
  tests do not reach, and let the case's own probe be what catches them.

## The cases

| id | class of work | seeded |
|---|---|---|
| `pure-function` | a small pure module plus tests — the `taskline` V1 acceptance (`DESIGN-SPEC.md` §11.1), replayed in this repo's house style | — |
| `fix-duration` | a defect in existing code that the suite does not cover: find it, fix it, prove it | yes |
| `cli-flag` | extend a subsystem in place — the harness work that is most of what this loop does | — |

Three is a starting point, not a target (`LOOP-PLAN.md` Q-L3). The suite grows when the loop
meets a class of task it handles badly; that is what a case is *for*.
