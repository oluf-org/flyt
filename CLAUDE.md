# CLAUDE.md — guidance for AI assistants working in this repo

## Read first

1. `GOALS.md` — product goals and current status. Read this first.
2. `DECISIONS.md` — the "why" log (D1–D29). The authority on resolved decisions, deferred items, and open questions.
3. `DESIGN-SPEC.md` — how the system is built; the built-vs-planned ledger lives in §11.

## Reference docs

- `FLOW_LANG.md` — the `.flow.yaml` DSL spec (zero-dependency parser in `core/flowlang/`).
- `FLOW_NODES.md` — node catalog and strict JSON contracts (`nodes/*.json`).
- `RUN-MODE.md` — live-run UX decisions.
- `SUBSCRIPTION-AUTH-GUIDE.md` — provider OAuth/ToS research behind D23.
- `PRODUCT-SPEC.md` — product thesis and open product questions.

## Active work

- `LOOP-PLAN.md` — the autonomous improvement loop (headless supervisor, backlog, worktrees, budget/tiers, harness-run gates). Draft; carries draft decision D35.
- `OUTPUT-VIEW-PLAN.md` — the current implementation plan (markdown output view, canvas reader, summary nodes). Not started yet.
- `CONFIGS-COMPARE-DESIGN.md` — P1–P3 shipped; P4 sweeps still open.

## Standing rules

- Flows live in `flows/<id>.flow.yaml` + `.layout.json`; node templates in `nodes/*.json`; per-project config in `.flyt/` (D15, D22, renamed in D29).
- **The app is Flyt; a *flow* is still the domain noun (D29).** `.flow.yaml`, `flowlang`, `FlowRunner`, `flow.nodes` and `FLOW_LANG.md`/`FLOW_NODES.md` keep their names on purpose — `grep -i flow` returning thousands of hits is the intended end state, not a half-finished rename. Do not "complete" it. `core/brand.js` is the only source of the product name (and the only place the old one may still appear); `tests/brand.test.js` enforces both halves.
- Keep the DSL dependency footprint at zero (D24); respect the visual anti-ideas list (D26).
- Completed plans are retired to git history — don't resurrect them. Record new decisions in `DECISIONS.md` instead of creating new plan docs.
