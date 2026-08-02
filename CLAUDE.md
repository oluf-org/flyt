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

One active plan. Nothing else is a plan.

- `PIVOT-PLAN.md` — **the investigator pivot (D35)**. Value moves from *doing
  things with LLMs* to *seeing what LLMs are doing*: an immutable per-attempt
  call ledger (usage, cost, latency, TTFT, throughput, bounded redacted wire),
  metrics on the run surface, a cross-run Investigator page over a disposable
  derived index, an empty node library behind a hidden kernel with the old
  templates as presets, prompt/model/limits as user-owned node fields, and
  conditionals + bounded loops that can branch on metrics.
  **P1–P6, P8 and P10 landed. Outstanding: P7 (the builder — a native chat
  surface backed by a hidden Flyt flow; its kernel nodes exist, the surface does
  not), P9 (sweeps + compare on metrics), P11 (verification — §9's eight checks;
  items 2, 5, 6, 7 are automated, items 1, 3, 4, 8 need a live provider).**
  D35 is already written into `DECISIONS.md`; the plan file stays until P11.

Two plans are paused, not cancelled:

- `TOOLS-PLAN.md` — **paused** at P5 by `PIVOT-PLAN.md` §7's gate. P1–P4 landed
  (tools are files; results are artifacts; two-tier grants; the v1 catalog).
  P5–P10 (declarative HTTP tools, MCP client, tool clerk, Flyt-as-MCP-server,
  code mode, Tools page) are shelved and were due for re-evaluation once
  PIVOT-PLAN P4 shipped — which it now has. Draft D34 lives in its §22.
- `SETTINGS-MODELS-PLAN.md` — **absorbed** into PIVOT-PLAN P6, but not retired:
  its P6 (Models tab) and P7 (shared `ModelPicker`) are still outstanding and
  are what a per-node model picker should eventually be built on. Draft D32
  lives in its §11.

Everything else is shipped and retired to git history. As of the 2026-07-25 pass: the markdown output view and summary nodes are D30, packaging/CI/auto-update is D31 (superseding D19), and configs/compare/judge is D27 — whose only open remainder is the sweeps design recorded in that entry. Code comments citing `OUTPUT-VIEW-PLAN`, `BUILD-AND-CICD-PLAN`, or `CONFIGS-COMPARE` are provenance pointers into git history, not references to files that should exist.

## Standing rules

- Flows live in `flows/<id>.flow.yaml` + `.layout.json`; node templates in `nodes/*.json`; per-project config in `.flyt/` (D15, D22, renamed in D29).
- **Both stores ship EMPTY (D35).** Nothing is installed on first launch. The ten
  templates and five pipelines live in `presets/` and are copied in only when the
  user clicks Add. `nodes/_system/` is the app-owned kernel — rewritten every
  launch, hidden from every list, never editable. Do not "fix" an empty library.
- **Every model call writes a record** to `runs/<id>/calls/<seq>.json` (D35).
  The wrapper lives in `callModel()`; adapters opt into wire capture by returning
  a `wire` field and nothing else. `runs/_index/` is derived and disposable —
  never read it as truth, and never make it one.
- **The app is Flyt; a *flow* is still the domain noun (D29).** `.flow.yaml`, `flowlang`, `FlowRunner`, `flow.nodes` and `FLOW_LANG.md`/`FLOW_NODES.md` keep their names on purpose — `grep -i flow` returning thousands of hits is the intended end state, not a half-finished rename. Do not "complete" it. `core/brand.js` is the only source of the product name (and the only place the old one may still appear); `tests/brand.test.js` enforces both halves.
- Keep the DSL dependency footprint at zero (D24); respect the visual anti-ideas list (D26).
- Completed plans are retired to git history — don't resurrect them. Record new decisions in `DECISIONS.md` instead of creating new plan docs.
