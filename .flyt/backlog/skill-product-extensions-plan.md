# Skills that would need a Flyt product extension

Status: **planning artifact.** This file pins the boundary between what a Flyt
skill (`.flyt/skills/<name>.md`, attached by a node's or task's `skills` list —
D15) can express today and what would require a change to the Flyt product
itself. Nothing listed here is implemented; each mechanism is marked below with
**requires Flyt product change**. Do not hide one of these in prose and do not
ship it as if it worked — a skill author who writes one will be told it did
nothing.

## What a Flyt skill is today (the boundary)

A skill is **instructions only**, resolved by name at run time and appended to
a node's or task's system prompt:

- `core/skills.js` `loadSkills()` reads `.flyt/skills/<name>.md`, injects its
  contents verbatim when the file exists, and logs-and-skips when it does not —
  a missing skill is never fatal, never a halt.
- The attachment point is declarative and static: a node template or flow
  node's `skills` list, or a backlog task's `skills` frontmatter. Resolution is
  project-scoped and confined; a name that is not on the project's list resolves
  to nothing (a warning, and otherwise silence).
- A skill cannot grant tools: tool grants and approval gates live on the node,
  and the skill sits inside that envelope.
- A skill has no invocation model of its own: nothing distinguishes "reachable
  by the agent" from "reachable only by the human", because the model is the
  only consumer of the prompt a skill produces. Prompts reach the model on every
  run; there is no notion of a skill sitting idle until someone types it.

The four mechanisms below all break one of those statements, which is exactly
what makes each one a product change rather than a skill-authoring technique.

## 1. Invocation gates / directional enforcement — requires Flyt product change

The subject skill roadmap's central axis is **invocation**: *user-invoked*
skills are reachable only by the human typing their name, with
`disable-model-invocation: true` (Claude Code) or
`policy.allow_implicit_invocation: false` (Codex) stripping them from the
model's and every other skill's reach; *model-invoked* skills keep a
model-facing description and stay reachable by model or user. A user-invoked
skill can never be reached by another skill — a directional invariant between
skills.

**Flyt cannot express any of this.** Nothing on a Flyt node or in a Flyt
`skills` list distinguishes who may invoke what, nothing forbids a model from
following a step that names another skill, and nothing is "only reachable by
the human" because a node runs only when someone starts the run. A skill that
declares `disable-model-invocation` would have the flag read by nothing.
Expressible only as prose, and even as prose it is not enforced — the model
can follow it or not.

Product change to close it: an invocation policy on skills (and on the skills a
node's step names), enforced by the runner — a directive annotation of the
skill or of the skill name inside a step, plus a rule that the model is not
shown, or may not fire, a skill the policy forbids it to reach. Directional
"user-invoked can never call user-invoked" enforcement, if wanted, is the same
change — the policy has to live in the product and be checked at run time, not
in a prompt.

## 2. Hard-dependency checks as halt-plus-remediation gates — requires Flyt product change

A hard per-repo dependency — skill output is *wrong*, not merely fuzzy, without
config some setup step seeds — is today expressed the way
`.flyt/skills/skill-authoring.md` already mandates: **prose**. The skill says
"run X if not", the human reads it and acts. Nothing halts on the artifact
being absent and nothing enforces that remedying it happened. It cannot: a
`skills` entry is a prompt, and prompts advise; they do not gate.

What the product would need to do: make a declared skill dependency a real
**halt-plus-remediation gate** — the missing artifact stops the node, says
what to run to provide it, and resumes only when the named setup actually ran
— instead of a best-effort adherence to a sentence in the prompt. This is a
product change, not a skill-authoring change, because halting is the harness's
job (the same machinery as `requiresApproval` and the `effect` contract), not
the model's. The skill side would only *declare* which artifact is hard;
enforcement, halting and the resume condition are product work.

## 3. Supporting-file / on-demand loading — requires Flyt product change

The roadmap pattern reads supporting material *on demand* rather than up
front — deep reference and deepening-classification files loaded only when a
pointer fires, keeping the always-loaded skill body small. Flyt has no such
machinery: **only the file named in the `skills` list exists to the product**.
`core/skills.js` checks, in order, exactly the one `.flyt/skills/<name>.md`;
it never follows relative pointers, never loads a second file on a condition,
and never lets a skill opt out of full injection. A skill saying "read
DEEPENING.md when the question is a dependency" is again only prose addressed
to the model — the model can choose to read it, but the product neither loads
it for the run nor guarantees the file will exist.

Product change to close it: supporting files that a skill may reference and
the runner loads on demand (a directory resource base alongside each skill,
plus a load condition), or at minimum loading with the file's presence checked
and its absence reported — not silent. The on-demand discipline (load only
when the pointer fires, keep the base body small) could stay a skill-authoring
convention, but the ability to *have* a supporting file at all is a product
change.

## 4. A human-only router — requires Flyt product change

A router over user-invoked skills — "tell me your situation, I name the skill
or sequence that fits" — is a *human-facing index*, not an executable skill.
The roadmap is explicit: a router can only hint, never fire: user-invoked
skills have no description, so nothing but the human can reach them, and router
prose that names skills for a human to pick from "isn't invoking anything".

**Flyt cannot express a human-only router.** There is no user-invoked vs
model-invoked split (mechanism 1), so there is no skill the model is excluded
from; there is no slash-command or picker surface to route from; and a node's
`skills` list is prompt material consumed by the agent, with no notion of
"these names are for the human". The only truthful way to ship one would be a
**Loop gate, a UI selector, or an on-node hint** — product surfaces, every one
of them. It must never be an executable skill node: wiring a router into a
stack as a runnable block would turn a human-facing directory into something
the agent executes, which is the opposite of what a router is.

## What does not require a product change (for contrast)

- Ordinary attached expertise, composed with existing flows — that is what
  `.flyt/skills/` is for today.
- Naming an artifact the human must provide, in prose, with the
  hard/soft-dependency discipline of `.flyt/skills/skill-authoring.md` — the
  current, honest way to express mechanism 2 until 2 lands.
- The one-line "ask the human" instruction inside a step, where the run can
  park for an answer at a node (`maxRounds`) — that *is* implemented, and it
  is not the same as a hard-dependency halt or a router.
- Tool grants, approvals and ceilings, which intentionally stay on the node —
  a skill must not widen authority; that is a design decision about the
  existing product, not a missing mechanism.

## How this file should be used

- When a skill needs one of the four mechanisms, the author writes a
  **separate product-change task** named after the mechanism; the skill lands
  with prose only and a pointer to that task. Do not claim the mechanism works.
- When the four mechanisms land, this file retires to git history and
  `DESIGN-SPEC.md` / the DSL contract describes them.