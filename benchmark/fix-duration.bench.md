---
title: Fix parseDuration — a minute is not an hour
level: low
value: 4
effort: 2
weight: 1
setup: node benchmark/setup/fix-duration.mjs
probe: node benchmark/probes/fix-duration.mjs
---

## Goal

`core/duration.js` parses the short durations the CLI accepts (`--since 24h`, `--since 30m`) into
milliseconds. It is wrong, and its tests pass anyway — they only cover hours.

Find the defect, fix it, and extend `tests/duration.test.js` so the case that was broken cannot
break again silently.

Do not delete or weaken the existing tests. Do not change the function's signature: callers pass
a string and expect milliseconds, or `null` for something it cannot read.

## Done when

- `parseDuration` returns milliseconds for each of the four units it claims to support:
  seconds, minutes, hours, days — so `'45s'` is 45 000, `'30m'` is 1 800 000, `'2h'` is
  7 200 000 and `'1d'` is 86 400 000.
- Something it cannot parse — `'soon'`, `''`, `null` — returns `null` rather than throwing or
  guessing.
- `tests/duration.test.js` exercises minutes and seconds by name, and `npm test` passes.
