# Authoring a Flyt tool

Use this when the work adds or changes a tool the model may call.

`TOOLS.md` at the repository root is the contract. Read it before writing the
module; this skill is the discipline, not the reference.

## The loop, and the step people skip

```
flyt tools                          # what already exists, with effects and risk
flyt tools show <id>                # a neighbour's schema, as a shape to copy
core/tools/<id>.js                  # the module — run() lives in source
core/tools/builtins.js              # register it in BUILTIN_MODULES
flyt tools run <id> --arg k=v       # CALL IT. Now, before anything else.
tests/<id>.test.js                  # then a test, then npm test
```

Call the tool before you believe it works. A tool that has only ever been read
is a guess: the parameter you added is not the one the schema declares, the
library returns a `Selector` where you assumed a string, the page needs a header
you did not send. Every one of those is a five-second `flyt tools run` and a
wasted node in a paid run.

Do not edit `tools/<id>.json` to change behaviour. It is seeded from the module
and refreshed on launch; only `enabled`, `keywords` and `examples` survive. A
schema edited there is a lie that the next launch deletes.

## What must be true before it is done

- **`description` is a prompt.** It is pasted into the model's tool list and is
  the only thing deciding whether the tool is ever called. Say what it is for,
  when to prefer it over the neighbour it resembles, and what it returns.
- **Effects are declared honestly.** `write`, `shell` and `destructive` are
  gated; `network` is not. Getting this wrong either bypasses the approval gate
  or buries a harmless tool behind it.
- **Third-party content is `trust: 'untrusted'`, and the RESULT says so.** Text
  from the network arrives in the model's context next to its instructions. A
  policy document does not travel with it; a `trust` field and a `note` in the
  returned object do.
- **A fact about the installation is a result, not a throw.** No API key, no
  interpreter, no package — return `{ available: false, reason, remedy }` and
  exit clean. A thrown error costs the agent a turn deciding whether a retry
  will help, and it will not.
- **A throw reads as an instruction.** "…is not a URL. Pass an absolute address
  like https://example.com/page", never a stack trace.
- **The full result is archived and the preview is bounded.** The model gets a
  preview plus a handle; the artifact keeps everything.
- **`flyt tools problems` is empty** and `npm test` is green.

## Where a new tool lands

Ceilings are written in toolset names and selectors, not tool ids, so a new tool
joins whatever selector already describes it — `effects:read` puts it in
`read-only` and therefore in `repo-write`, `repo-full` and `loop`;
`uses:network` puts it in `web`. Check where it landed rather than assuming:
adding a network tool to `read-only` by declaring `effects: ['read']` widens
every ceiling in the app at once.

A tool may narrow a ceiling. It must never widen one.

## Borrowing a library that is not JavaScript

Use `core/python.js`. Do not spawn an interpreter from a tool module, and do not
add an npm dependency to avoid the question.

- Script text lives in this repository. The bridge takes a script and a payload,
  never a command line.
- Arguments go as JSON on stdin, never argv.
- Resolve with `pythonFor(ctx)`. Never hard-code `python`.
- A missing package returns a remedy naming `flyt python setup --packages <p>`.

## Do not

- Do not add a tool that duplicates one that exists. Extend the existing one
  with a parameter, or say plainly why a second tool is the honest answer.
- Do not make a tool that returns untrusted text `autoExecute: true`.
- Do not report a tool finished on the strength of the code alone. The evidence
  is the output of `flyt tools run`, pasted into the task's completion.
