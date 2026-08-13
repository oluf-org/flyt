---
title: Give flyt task list a --limit flag
level: low
value: 3
effort: 2
weight: 1
probe: node benchmark/probes/cli-flag.mjs
---

## Goal

`flyt task list` prints the whole backlog. On a queue of forty that is unreadable in a terminal
and expensive in an agent's context, and the tasks anyone wants are the first few.

Add `--limit <n>` to `flyt task list` in `bin/flyt.js`: it caps how many tasks are printed, in
both the human output and the `--json` output. Without the flag, nothing changes.

Read the surrounding subcommands first and match them — this file has a house style for
argument handling, for the stdout/stderr split (machine-readable on stdout, prose on stderr),
and for how a subcommand reaches the command surface. A flag that works but is written in a
different idiom than the twenty around it is a worse change than no flag.

## Done when

- `flyt task list --limit 1 --json` prints at most one task.
- `flyt task list --json` with no `--limit` still prints every task.
- `flyt task list --limit 2` (no `--json`) prints at most two lines of task output on stdout.
- `npm test` passes.
