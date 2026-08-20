# Flyt skill authoring

Use this when repository research suggests reusable expertise for Flyt.

Create a skill only when the finding describes how work should be done
repeatedly in this project. Use a node template or flow for orchestration, a
tool for capability, and a core change for runtime enforcement.

For each proposed skill:

- Give it a safe kebab-case name and one precise trigger: which node or flow
  attaches it, and for what repeated situation.
- Put only stable operating instructions in `.flyt/skills/<name>.md`.
- Attach it explicitly: a template's or flow node's `skills` list, or a backlog
  task's `skills` frontmatter when the need belongs to one job rather than to
  every job of that kind. Do not claim model-driven discovery or slash-command
  invocation; Flyt does not currently implement either.
- Keep tool grants and approvals on the node. A skill must not widen authority.
- If the behavior needs frontmatter, supporting files, dependencies, routing,
  or invocation gates, describe that as a separate product change. Do not hide
  an unsupported mechanism in prose.
- Include an acceptance test that proves the skill was injected and changed
  the intended prompt or output without changing the node's tool grant.

Prefer a small skill that composes with an existing flow over a new generic
framework.
