---
title: Add core/textUtils.js with a truncateMiddle helper and tests
level: low
value: 3
effort: 2
weight: 1
probe: node benchmark/probes/pure-function.mjs
---

## Goal

Three places in this codebase truncate long text by hand — `core/gates.js` clips gate output,
`core/benchmark.js` clips probe output, `core/worktree.js` truncates a diff. Two of them keep
the head and the tail because a failing suite puts the first failure at the top and the summary
at the bottom, and a middle-out cut loses both.

Add that as one shared, pure function.

Create `core/textUtils.js` exporting a named function `truncateMiddle(text, max)`:

- Returns `text` unchanged when it is `max` characters or shorter.
- Otherwise returns a string of **at most `max` characters** that begins with the start of
  `text` and ends with the end of `text`, with an elision marker between them.
- Pure: no I/O, no dependencies, no module state.

Match the house style of the modules named above: an ES module, a named export, a JSDoc
comment saying *why* rather than restating the signature, and no new dependencies (D24).

## Done when

- `core/textUtils.js` exists and exports `truncateMiddle`.
- `truncateMiddle('hello', 10) === 'hello'` — short text is returned unchanged.
- For a 26-character string and `max` of 12, the result is at most 12 characters, starts with
  the first character of the input, ends with the last character of the input, and is not equal
  to the input.
- A file under `tests/` exercises `truncateMiddle` by name, and `npm test` passes.
