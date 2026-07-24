# CLAUDE.md — guidance for AI assistants working in this repo

## Read first

1. `GOALS.md` — product goals and current status. Read this first.
2. `DECISIONS.md` — the "why" log (D1–D27). The authority on resolved decisions, deferred items, and open questions.
3. `DESIGN-SPEC.md` — how the system is built; the built-vs-planned ledger lives in §11.

## Reference docs

- `FLOW_LANG.md` — the `.flow.yaml` DSL spec (zero-dependency parser in `core/flowlang/`).
- `FLOW_NODES.md` — node catalog and strict JSON contracts (`nodes/*.json`).
- `RUN-MODE.md` — live-run UX decisions.
- `SUBSCRIPTION-AUTH-GUIDE.md` — provider OAuth/ToS research behind D23.
- `PRODUCT-SPEC.md` — product thesis and open product questions.

## Active work

- `OUTPUT-VIEW-PLAN.md` — the current implementation plan (markdown output view, canvas reader, summary nodes). Not started yet.
- `CONFIGS-COMPARE-DESIGN.md` — P1–P3 shipped; P4 sweeps still open.

## Standing rules

- Flows live in `flows/<id>.flow.yaml` + `.layout.json`; node templates in `nodes/*.json`; per-project config in `.llmflow/` (D15, D22).
- Keep the DSL dependency footprint at zero (D24); respect the visual anti-ideas list (D26).
- Completed plans are retired to git history — don't resurrect them. Record new decisions in `DECISIONS.md` instead of creating new plan docs.
