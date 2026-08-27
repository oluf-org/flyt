# The stack language

A stack is a `.stack.yaml` file. It composes **blocks** — the steps a plugin
contributes — into **containers** that say how those steps run. Containment
replaces edges: the nesting *is* the graph, so there is no edge list to disagree
with the nodes and no layout file to disagree with both (D59). The drawing is
derived from the tree, which means there is no arrangement that draws but does
not parse.

This document describes what `kernel/src/stack/parse.ts` enforces, and nothing
else. Every refusal named below is one the parser actually raises; if you find a
rule here that the code does not make, the document is the bug.

> This is the v2 language. The v1 flow DSL is [`STACK_LANG.md`](./STACK_LANG.md)
> and keeps doing real work until the Phase 5 cutover.

## The file

```yaml
version: 2
id: review
name: Review a change
description: |
  Optional prose.
blocks:
  - id: read
    use: flyt-blocks-core:general-analysis
  - id: write
    use: flyt-blocks-core:work
```

`version` must be `2`. A version 1 document is a flow and is refused with where
it is read instead. `id` falls back to the filename when the document does not
name one. The root is an implicit `sequence`, so `blocks:` at the top level is
the whole stack.

Every node needs an `id`, unique across the file, matching
`^[A-Za-z0-9][A-Za-z0-9_-]*$`. Ids are how a predicate, a roster and a refusal
all point at something, so a duplicate is refused rather than resolved.

The YAML is a hand-written strict subset (D24): **block style only**. Flow style
— `{ source: a.b, operator: is }` — is refused. Write the mapping out.

## Blocks

```yaml
- id: judge
  use: flyt-blocks-judgement:evaluation
  title: Is this good enough?
  config:
    threshold: 7
  outputs:
    - name: score
      type: number
    - name: notes
      type: string
```

| Key | Meaning |
|---|---|
| `use` | the block a plugin contributed, `plugin:block` or a bare built-in name |
| `title` | optional, for the editor |
| `config` | carried to the block, never interpreted by the parser |
| `outputs` | the structured fields this block promises, each `name` plus a `type` |

`use` is kept as text. A stack may name a block nothing installed — saying so is
the library's job, not the parser's — and `missingBlocks()` reports it against
the registry.

`outputs` is the authored contract a conditional reads. Each entry is a mapping
with a `name` and a `type` from a closed set: **`string`, `number`, `boolean`,
`list`** (`string` when omitted). A type outside the set is refused, naming the
set. `list` is the one that carries weight — it is what lets a roster be told
from a sentence.

## Containers

| Kind | Holds | Bound |
|---|---|---|
| `sequence` | `blocks`, top to bottom, each fed what the one before produced | implicit |
| `parallel` | `lanes`, side by side | `maxParallel` |
| `repeat` | `body`, run `count` times | `count`, literal, ≤ 64 |
| `foreach` | `body`, once per roster element | `max`, literal, ≤ 64 |
| `until` | `body`, retried while a condition does not hold | `max`, literal, ≤ 16 |
| `if` | `body`, and an optional `else` | — |

A container needs its `kind` written out; children alone do not say which, and
guessing is refused. `for-each` is accepted as a spelling of `foreach` and
normalised, so nothing downstream has to know about both.

Each container takes only its own keys, and an unknown key is refused rather
than ignored — a misspelt `maxParallel` that silently meant "all of them" is the
failure that rule exists for.

### Parallel

```yaml
- id: fan
  kind: parallel
  maxParallel: 2
  lanes:
    - id: left
      kind: sequence
      blocks: [...]
    - id: right
      kind: sequence
      blocks: [...]
```

Every lane receives what entered the parallel, never what a sibling produced.
That is lane isolation (D37), and it is a consequence of the shape rather than a
rule the runner enforces: there is no shared carry for one lane to leak through,
and a lane cannot read a sibling's structured outputs either — including through
a predicate.

### Repeat

```yaml
- id: thrice
  kind: repeat
  count: 3
  body:
    - id: step
      use: flyt-blocks-core:work
```

`count` is a literal whole number the author wrote. Not an expression, not a
field, not a setting resolved later — a bound that can only be known after
spending money is not a bound.

### For each

```yaml
- id: each-task
  kind: foreach
  roster: plan.tasks
  max: 8
  body:
    - id: do-one
      use: flyt-blocks-core:work
```

`roster` is exactly `<block-id>.<field>`, naming a field an **upstream** block
declared with `type: list`. A roster naming a `string` field is refused, and so
is a roster naming a field nobody declared.

**There is no route from prose to a roster.** No split on newlines, no fallback,
no one-item convenience — in the file, and at run time too: a block that
declared a list and returned a string on the day iterates nothing rather than
being split.

The body runs once per element, each pass fed its own element rather than the
carry from the pass before. `max` is the bound, because the roster is not known
until the block above has run. A longer roster is cut to `max`, and the log
records by how much.

### Until

```yaml
- id: get-it-right
  kind: until
  max: 5
  condition:
    source: check.verdict
    operator: is
    literal: passed
  body:
    - id: attempt
      use: flyt-blocks-core:work
    - id: check
      use: flyt-blocks-judgement:evaluation
      outputs:
        - name: verdict
          type: string
```

`condition` is the same structured predicate an `if` takes. The body is parsed
before the condition, so a block inside it has declared its outputs by the time
the condition names one — an until normally asks about its own body's verdict,
which is the shape of "go round again".

Each pass is judged on its own verdict, not on one a previous pass left behind.
The accepted pass is what the until settles as, so whatever follows reads the
attempt that was accepted.

Running out of passes **fails the run**. An until whose condition never held has
not finished quietly; it failed to do the thing, and carrying on would hand the
next block work that was never accepted.

### If

```yaml
- id: gate
  kind: if
  predicate:
    source: judge.score
    operator: "<"
    literal: 7
  body:
    - id: revise
      use: flyt-blocks-core:work
  else:
    - id: ship
      use: flyt-blocks-core:work
```

Exactly one branch runs; the other is never entered. With no `else` and a
predicate that does not hold, the `if` changes nothing and its input passes
through to whatever follows.

## The predicate

A predicate is **source / operator / literal**. It is not an expression, and
that boundary is permanent (D56).

```yaml
predicate:
  source: judge.score      # <block-id>.<field>
  operator: "<"
  literal: 7
```

`source` is exactly `<block-id>.<field>` and must name a field a **genuinely
upstream** block declared in its `outputs`. A field declared below the predicate
that reads it is not upstream, and neither is one in a sibling lane.

Operators are a closed set:

`is` · `is not` · `<` · `<=` · `>` · `>=` · `is empty` · `is not empty`

`literal` is absent for `is empty` and `is not empty`, where there is nothing to
compare against. Ordering operators compare numbers only.

Several comparisons combine as **one flat list**, and only one flat list:

```yaml
predicate:
  allOf:
    - source: judge.score
      operator: ">="
      literal: 7
    - source: judge.verdict
      operator: is not
      literal: blocked
```

`anyOf` is the other. A combination inside a combination is refused — that is
the expression grammar this format keeps out. There is no `not`, no
concatenation, no arithmetic.

A field that was declared but that the block did not set on the day reads as
empty rather than throwing. The parser guarantees the field was promised, not
that it was delivered.

## The bounds

Static, checked before anything runs, so a stack that would cost too much is
refused rather than discovered.

| Bound | Value | What it caps |
|---|---|---|
| `MAX_DEPTH` | 6 | container nesting, counting every kind together |
| `MAX_REPEAT` | 64 | one repeat's `count` |
| `MAX_FOR_EACH` | 64 | one for-each's `max` |
| `MAX_UNTIL` | 16 | one until's `max` |
| `MAX_EXPANSION` | 512 | worst-case block executions over the whole tree |

`MAX_UNTIL` is lower than the others deliberately: a repeat's passes are work
somebody asked for, an until's are attempts at work that keeps not being right.

**Worst-case expansion** folds over the tree. A block is 1. A sequence and a
parallel are the sum of their children. A repeat multiplies its body by `count`,
a for-each by `max`, an until by `max`. An `if` runs one branch, so it is the
heavier of the two rather than the sum. Both numbers — total authored blocks and
worst-case executions — are reported before a run starts, and a stack over
`MAX_EXPANSION` is refused with the cap and its own worst case in the message.

## What refusals look like

Every refusal is a `StackError` carrying a dotted path and, where the source has
one, a line:

```
the predicate names field "confidence" on block "judge", which does not declare
it; "judge" declares score (blocks[1].predicate, line 8)
```

That shape is the point. A refusal names what was wrong, where it is, and what
would have been right — the alternative is a reader going to look for something
the message could have told them.

A container kind that is named but not built is refused **by name**, with the
phase that brings it, so somebody hand-writing a stack learns the boundary from
the error rather than from a plan document. Phase 3 built all four it held, so
that register is currently empty; the mechanism stays for the next one.

## What is deliberately absent

- **Arbitrary expressions.** Permanently (D56). A request for arithmetic or
  nested boolean logic is a decision for a human, not a widening to slip in.
- **Unbounded iteration.** Every container declares its bound statically.
- **A layout file.** The drawing is derived from containment (D59).
- **Roster from prose.** A for-each iterates a declared list or it does not run.
