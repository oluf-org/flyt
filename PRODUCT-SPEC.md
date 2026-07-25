# Flyt — Product Specification

**Status:** Design specification (pre-implementation for most of the product vision).
**Last defined:** 2026-07-15, via a structured design interview with the owner (Olav).
**Read alongside:** `DESIGN-SPEC.md` (how it works, built vs. planned) and `DECISIONS.md` (the calls made and still open).

> **Important framing.** This document describes *intent*, not current behavior. Today the app is a working core (file-based state, a node library, a canvas, a flow DSL, and one execution engine with bounded parallelism and mock/real model adapters). Most of the *product* — the coding-agent toolbox, workspace binding, streaming UI, model routing, and the subscription model — is specified here but **not yet built**. See `DESIGN-SPEC.md` for the exact line between the two.

---

## 1. The thesis

Flyt exists to test one idea:

> **The power of a good result may come less from the raw strength of a single model and more from the way tasks are decomposed, routed, and handled.**

The project began with an observation while using a strong model (Fable): maybe what felt powerful was not only the model, but a *structured way of handling tasks*. Flyt is the attempt to make that structure explicit, visible, and reusable — to build a "powerful AI agent" by splitting work into well-defined tasks, routing each to the right model, and showing the whole thing happening transparently.

Everything else in this document serves that thesis. If decomposition + routing genuinely beats a single strong prompt, Flyt should be able to *demonstrate* it (see §7, model-comparison / ranking).

---

## 2. One-sentence pitch

**A transparent, multi-model AI builder that makes a developer feel in command of the agent — pick a workflow, describe what you want, and watch it execute step by step on a live canvas.**

The canvas is not the product and the engine is not the product; the two work hand-in-hand, and without either the product falls apart. The primary interface is a text input where you describe what you want. The canvas is the **live window into what the agent is doing** — the transparency layer that turns an opaque chat box into something you can watch, understand, and trust.

---

## 3. Who it's for

**Primary audience:** developers — specifically users of coding agents like Claude Code, GPT/Codex, and Cursor. Flyt aims to be a **better replacement for a chat window** for building software, and a real step up for "vibe-coding": pointing an agent at your project and having it build features.

**Secondary / origin user:** the owner, as a power user, building large and complex features for coding projects — with good documentation and visualization of what was done, so it's possible to keep an overview of what's going on across a big change.

**Sophistication assumption:** the user is technical and comfortable with code, repos, and the idea of models and tools — but wants *less* fighting with prompts and *more* structure and control. The app's job is to hide prompt-engineering, context assembly, and task decomposition; the user's job is to describe intent and stay in command.

---

## 4. The differentiator (why switch)

Honest positioning against Claude Code / Cursor / Codex:

- **What Flyt will *not* win on:** being the fastest, cheapest, or absolute easiest to start. Incumbents own those. Failing to be *roughly competitive* on speed/cost/ease is, by the owner's own statement, the thing that would kill the project (see §8).
- **What Flyt wins on — the felt outcome:** **mastery and control.** An AI builder that makes the user feel more in command of the agent, rather than at the mercy of a chat box. Customizability (of workflows, nodes, models, and tools) exists in service of that feeling: the user shapes *how* the work is done, sees every step, and can intervene.

The one-line value proposition to a future user:

> *"Stop hoping the chat box does the right thing. Build the agent, watch it work, and stay in control."*

**Open item:** the differentiator is directional, not yet proven or sharpened into measurable user value. It is the single most important sentence to validate. Tracked in §9 and `DECISIONS.md`.

---

## 5. Product surfaces (target)

Four first-class surfaces, three of which exist today:

1. **Node Library (Nodes page)** — *built.* Nine reusable AI node templates today (Plan, Plan-eval, Step-eval, Final-eval, Stitch, Code-general, Code-design, Documentation, and Test-creation — the last being the only tool-using `agentTask`). A template constrains *how* a step runs: model, tools, instructions, skills, approval. It never contains a hand-written prompt. (Note: `orchestrator`, `input`, and `output` are engine/DSL node *types*, not Node Library templates.)
2. **Workflows (canvas + dropdown)** — *built.* A workflow is a DAG built from template instances. The canvas is both the authoring surface (today) and the live run view. Workflows are picked from a dropdown to run.
3. **Toolbox (Tools page)** — *planned.* A peer to the Nodes page: a tool *creation* suite where custom tools are authored and viewed (e.g. HTTP GET requests, computer-control primitives, file tools). This is the app's unit of extensibility for *capabilities*, as the Node Library is for *steps*.
4. **Run panel + live canvas** — *built (mock), streaming planned.* Describe the request; it becomes the workflow's User Input; press Run; watch nodes light up as they execute.

**Authoring direction (planned):** the raw canvas is a temporary authoring surface. The intended model is *canvas-based, but with an AI helper acting as the builder*, plus a distinct **view mode** for watching a run. The DSL and canvas are two views of the same workflow file; humans use the canvas, AI writes the DSL. Workflows are **not** generated fresh per request today — the model is "pick a curated workflow from a dropdown." AI-chosen or AI-reconfigured workflows are a future possibility, not v1.

---

## 6. Business model

- **Today:** bring-your-own-key. Users add an OpenRouter (or Anthropic) key in Settings; all inference is on their own account. This stays true for the foreseeable near term.
- **At ship:** a **subscription with a capped, app-issued key.** The intended shape: a ~$20/month subscription issues a key usable up to at most ~$20 of OpenRouter spend. This lets a hosted product exist without the owner fronting unbounded inference cost — the cap makes the unit economics safe by construction.
- **Implication:** the app stays a local Electron client; the subscription needs only a thin key-issuing/metering backend, not a full hosted inference stack.

**Open items:** metering, key issuance, abuse limits, and what happens when a user hits the cap mid-run are all undefined. Distribution (installers, code-signing, auto-update) is explicitly *not on the radar yet*.

---

## 7. Headline capabilities the thesis implies

Two capabilities follow directly from §1 and are currently **undocumented elsewhere and unbuilt**, but belong in the product:

1. **Model comparison / quality demonstration.** The ability to show the *same model, decomposed workflow vs. single prompt* — surfacing the quality difference decomposition buys. This is the thesis made testable.
2. **Model ranking per task type.** Because the whole point is routing each task to the model that's best (or most efficient) at it, the app is a natural place to *rank models against task types*. Crucially, this ranking data is not just a benchmark — it is the **input to the routing matrix** (see `DESIGN-SPEC.md` §Routing). Ranking → routing → better ranking is the real, honest "adaptive" loop, in place of vague "self-improvement."

---

## 8. What success and failure look like

**Daily-use trigger (what makes the owner open it every day):** the *feeling of mastery* — an easy-to-use AI builder that makes the user feel more in control. Concretely, that depends on the planned pillars landing: real file/bash tools against a real workspace, streaming visibility, and parallel + orchestrated execution.

**v1 "done":** the minimum bar at which the owner would show it to another developer and say *"use this instead of Cursor."* That means the coding-agent loop works end to end against a real project, transparently, with the mastery/control feel intact.

**Abandonment triggers:**
- The thesis fails — decomposition + routing turns out *not* to beat just asking a strong model directly.
- The product can't get close enough to competitors on being **efficient, quick, cheap, and easy to jump into**.

---

## 9. Non-goals (current)

Inherited from `GOALS.md` and unchanged in spirit:

- Full general-purpose visual programming (arbitrary loops, conditionals, sub-flows as a user-facing language).
- Large-graph tooling (auto-layout at scale, minimap, virtualization) beyond what keeps small graphs pleasant.
- Per-request AI-generated workflows (a *future* possibility, not v1 — the model is a curated dropdown).
- Non-file state stores; production-grade sandboxing (a safety model is planned, but not enterprise-grade isolation).
- Distribution/packaging polish (installers, signing, auto-update) — later.

---

## 10. Open questions (product)

Consolidated, tracked in `DECISIONS.md`:

1. **Sharpen the differentiator.** "Mastery and control" is directional. What is the concrete, demonstrable user-felt win over Cursor/Claude Code? What would prove it?
2. **Ease-of-entry parity.** What is the minimum "quick, cheap, easy to start" bar the app must clear to survive against incumbents, and how is it measured?
3. **Thesis validation.** How, specifically, does the app demonstrate that decomposition + routing beats a single strong prompt (see §7.1)? Is a comparison mode a v1 feature or a research aside?
4. **Subscription mechanics.** Key issuance, metering, cap-exhaustion behaviour mid-run, abuse prevention.
5. **AI-helper authoring UX.** What does the "AI helper as the builder" interface actually look like, and how does it relate to the view-mode run surface?
