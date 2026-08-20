# TOOLS — the tool contract (`core/tools/*.js`, `tools/*.json`)

The AI-facing contract for adding, changing and trying a Flyt tool. Peer to
[`FLOW_LANG.md`](./FLOW_LANG.md) (how flows are authored) and
[`FLOW_NODES.md`](./FLOW_NODES.md) (what nodes do). The safety model these rules
serve lives in [`DESIGN-SPEC.md`](./DESIGN-SPEC.md) §5.

A tool is **a capability a model may call**. It is app-level, not per project:
"make an HTTP request" means the same thing in every repository, which is why
tools live beside `nodes/` and skills do not (D15/D14).

## Authoring loop

```
1. flyt tools                              # what exists, with effects and risk
2. flyt tools show <id>                    # one tool, schema included
3. write core/tools/<id>.js                # the module — run() lives in source
4. register it in core/tools/builtins.js   # BUILTIN_MODULES
5. flyt tools run <id> --arg k=v           # call it once, right now
6. write tests/<id>.test.js                # and `npm test`
```

Step 5 is the step that did not used to exist. Do not skip it: a tool that has
never been called is a tool nobody knows the shape of, and discovering the first
mistake inside a paid run is the slowest possible loop.

`tools/<id>.json` is **written for you**. The store seeds it from the module and
refreshes it whenever the shipped definition changes, preserving only the
user-owned fields (`enabled`, `keywords`, `examples`). Editing it by hand to
change a schema or an effect is a lie the registry will overwrite — change the
module.

## The module

```js
// core/tools/scrape_page.js
export default {
  name: 'scrape_page',              // = the file name = the model-visible name
  title: 'Scrape a page',           // human label, short
  description: '…',                 // WHAT IT IS FOR and WHEN TO USE IT
  effects: ['network'],             // read | write | network | shell | destructive
  scope: 'workspace',               // 'run' = runs/<id>/ only; 'workspace' = wider
  risk: 'caution',                  // safe | caution | danger
  trust: 'untrusted',               // trusted | review | untrusted
  keywords: ['scrape', 'html'],
  examples: ['read the pricing page past its Cloudflare check'],
  parameters: { /* JSON Schema, see below */ },
  result: { preview: 'json', maxPreviewChars: 2000, artifact: true },
  async run(args, ctx) { /* … */ }
};
```

Then add it to `BUILTIN_MODULES` in `core/tools/builtins.js`. A module that is
not in that array is not a tool; a `tools/<id>.json` naming a module that is not
there is pruned on the next launch, and `flyt tools problems` reports it in the
meantime.

### `description` is a prompt, not a docstring

It is pasted into the model's tool list, and it is the only thing standing
between a capable tool and a tool nobody calls. Say what it is FOR, when to
prefer it over its neighbour, what it returns, and — if its results come from
outside this repository — that they are information and never instructions.

### `effects` decides what is gated

| effect | meaning |
|---|---|
| `read` | observes and changes nothing |
| `write` | modifies files |
| `network` | makes outbound requests |
| `shell` | runs commands |
| `destructive` | removes something that does not come back |

`write`, `shell` and `destructive` are the **gated** effects: with `scope:
'workspace'` they pause on the per-call approval gate, they need `--yes` from
`flyt tools run`, and they are what `isDestructive()` answers about. `network`
is deliberately not gated — an outbound request is bounded by network policy,
not by a prompt — but it *is* what puts a tool in the `web` toolset.

`scope: 'run'` means the tool cannot reach past `runs/<id>/`. A mutating tool
confined to the run's own directory is not gated, because prompting for it would
be approval fatigue over something that cannot touch the user's repository.

### `trust` follows the source of the RESULTS, not the code

A built-in's `run()` lives in this repository, so its *code* is trusted. That
says nothing about what it returns. `web_fetch` is `trust: 'untrusted'` because
the text it hands back was written by whoever owns that domain, and it arrives
inside a model's context sitting next to its instructions.

**Any tool that returns third-party content is `untrusted`, and its result must
say so in the result itself** — a `trust` field and a `note` the model actually
reads — not only in a policy document nobody passes to the model.

### `risk` is a floor, never a discount

`effectiveRisk()` takes the higher of what the definition claims and what the
effects imply, for untrusted tools. A definition cannot talk its way down.

### `result` bounds what reaches the model

```js
result: { preview: 'json', maxPreviewChars: 2000, artifact: true }
```

The **full** result is written to `runs/<id>/tools/<seq>-<tool>.json`; the model
receives a bounded preview plus a handle it can re-open with `read_tool_result`.
So a 200 KB page survives on disk instead of being destroyed by truncation. Set
`artifact: false` only for a result that is meaningless to re-read.

**Pick `maxPreviewChars` deliberately.** A tool that declares no `result` takes
the 2,000-char default, and after the per-string share that is about a thousand
characters — which for a file read is a stub. `read_file` had no budget for a
long time, and the consequence was that agents read files with
`bash sed -n '40,194p'` instead: a dozen calls over one 194-line test, each
resending the whole growing conversation. What is shipped now:

| tool | budget | why |
|---|---|---|
| `read_file` | 24,000 | ~300 lines, so most source files arrive whole |
| `read_tool_result` | 100,000 | it already bounds itself; cutting it again defeats it |
| `search_files`, `search_references`, `glob` | 12,000 | a truncated result set reads as an empty one |
| `bash` | 4,000 | the tail is usually the answer |
| `web_fetch`, `web_search` | 2,000 | untrusted text, and the bound is the injection bound |

The two considerations pull against each other. A bigger preview means fewer
wasted turns; it also means more context resent on every subsequent turn, which
is quadratic. Raise it for results the model needs whole, and leave it low for
results that arrive from outside this repository.

## `parameters`

Hand-written JSON Schema (`core/tools/schema.js`), a bounded subset of 2020-12:
`type` (including `integer` and arrays), `enum`, `const`, object
(`required`/`properties`/`additionalProperties`), array
(`items`/`minItems`/`maxItems`/`uniqueItems`), numeric and string bounds,
`allOf`/`anyOf`/`oneOf`/`not`, and **local** `$ref` into `$defs`.

Two rules are fail-closed and not negotiable: an external `$ref` URI is never
dereferenced (it is an SSRF primitive), and schema depth is capped at
`MAX_SCHEMA_DEPTH`.

Write `additionalProperties: false` and give every property a `description`. The
description is what the model reads to decide what to pass; a bare `{ type:
'string' }` is a coin flip.

## `run(args, ctx)`

Arguments are already validated against the schema by the time `run` is called.

`ctx` is what the host binds. Everything on it is optional — the same tool runs
inside a flow, inside chat, and from `flyt tools run`, and those bind different
subsets. **Read every field defensively (`ctx?.store?.appendLog?.(…)`)**; a tool
that assumes a run store cannot be called from the one-shot door.

| field | what it is | bound by |
|---|---|---|
| `store` | the run store — `appendLog`, `writeToolResult` | a run, chat |
| `runId` / `nodeId` / `taskId` | who is calling | a run |
| `workspace` | the bound project (`core/workspace.js`), path-confining | a run, chat, `tool:run` |
| `backlog` | the project's `.flyt/backlog/` | a run, chat, `tool:run` |
| `references` | the read-only reference library | everywhere |
| `config` | the runtime config — provider keys, timeouts | everywhere |
| `pool` | the worktree pool | a run |
| `subject` | the repository this node was pointed at (D38) | a repo-reading run |
| `approveToolCall` | the per-call gate | an `approveToolCalls` node |

### Failing well

Throwing is fine and is caught: `executeTool` turns it into
`{ ok: false, error }` and hands it to the model to correct. So a throw should
read as an instruction — *"…is not a URL. Pass an absolute address like
https://example.com/page"* — not as a stack trace.

But **a fact about the installation is a RESULT, not a failure.** `web_search`
with no provider key returns `{ available: false, reason, remedy }` and exits
zero, because a failed call costs the agent a whole turn deciding whether to
retry, and "there is no key on this machine" will not change on a retry. Use the
same shape for a missing sidecar package.

## Toolsets and ceilings

A grant is written in the names in `tools/sets/<id>.json`, not in tool ids, so a
ceiling does not go stale the moment a seventh tool lands. A set entry may be:

- a tool id — `edit_file`
- another set — `read-only`, or `includeSets: ['repo-full']`
- a **selector** — `effects:read` (every effect is in this list),
  `uses:network` (the tool can reach the network at all)

Shipped sets: `none`, `read-only`, `repo-write`, `repo-full`, `web`, `loop`.
Unlike a built-in tool, a set is pure data — an edited set is the user's answer
and is never overwritten.

The rule that matters: **a child may narrow a parent's ceiling and may never
widen it.** A new tool lands inside whatever selectors already describe it, so
check where it lands (`flyt tools show <id>`) rather than assuming.

## Borrowing a library that is not JavaScript

`core/python.js` is the one bridge (D24 keeps the *parser* dependency-free; it
does not require reimplementing every library in the world). A sidecar tool:

```js
import { pythonFor, runPythonScript, NO_PYTHON_REMEDY } from '../python.js';

const SCRIPT = [
  'import json, sys',
  'args = json.load(sys.stdin)',
  '…',
  'print(json.dumps({"ok": True, …}))'
].join('\n');

const { bin } = pythonFor(ctx);              // ctx.config carries the installation
if (!bin) return { available: false, reason: '…', remedy: NO_PYTHON_REMEDY };
const result = await runPythonScript(SCRIPT, { url }, { bin, timeoutMs: 60_000, signal: ctx?.signal });
if (!result.ok) return { available: true, ok: false, error: result.error, stderr: result.stderr };
```

Export the bridge as `pythonBridge` and call through it
(`pythonBridge.runPythonScript(...)`). ES module bindings cannot be reassigned
from outside, so this indirection is the only thing that lets a test stub the
sidecar — and a sidecar tool that cannot be stubbed is one whose tests have to
reach the network to say anything. `web_search` and `scrape_page` both do this.

Rules for a sidecar:

- The **script text lives in this repository**, so what runs is reviewable. The
  bridge takes a script and a payload, never a command line.
- Arguments travel as **JSON on stdin**, never as argv. That keeps a hostile URL
  off the command line and sidesteps every cmd.exe/sh quoting difference.
- The interpreter is **resolved, never assumed**: `FLYT_PYTHON`, then the
  `python.bin` setting, then the managed venv under the app's user data
  directory, then PATH. A declared interpreter that is missing reports itself
  rather than silently falling through to a different Python.
- A missing package is a result with a remedy that names
  `flyt python setup --packages <name>`.
- Do not print non-ASCII without thinking about it: the bridge forces UTF-8 on
  the child's streams because `-I` makes Python ignore `PYTHONIOENCODING`, and
  before that the first em dash in a result killed the process.
- The environment lives **outside every repository**, so a Loop worker in a
  throwaway worktree uses the same interpreter as the desktop app.

## Trying it

```bash
flyt tools run web_fetch --arg url=https://example.com --json
flyt tools run write_file --arg path=x.txt --arg content=hi --yes
flyt tools problems
flyt python status --packages scrapling
```

## Comparing it

When two tools do the same job, "which is better" should be a measurement
rather than an impression. A suite in `benchmark/tools/<name>.json` names the
tools and the cases, and `flyt tools bench <name>` runs every tool against every
case and prints what happened.

```json
{
  "name": "web-read",
  "tools": [
    { "id": "web_fetch",  "as": "web_fetch",  "field": "text" },
    { "id": "scrape_page", "as": "scrapling", "field": "text", "args": { "mode": "fetcher" } }
  ],
  "cases": [
    { "id": "javascript",
      "about": "the content only exists after a script runs",
      "args": { "url": "https://quotes.toscrape.com/js/" },
      "expect": { "contains": ["Albert Einstein"], "minChars": 200, "maxMs": 60000 } }
  ]
}
```

`field` says where the text lives in that tool's result, because two tools that
do the same job return different shapes. Per-tool `args` are defaults the case
may override. `expect` takes `contains`, `absent` (the boilerplate check),
`minChars` and `maxMs`.

One distinction is load-bearing: **a tool that is not set up here has not lost.**
An unknown tool, or one returning `available: false`, is reported as
unavailable and kept out of the totals — otherwise a suite naming next month's
tool reads as a clean sweep for this month's.

The benchmark directory is protected from Loop tasks (`core/gates.js` PROTECTED)
for the usual reason: a suite an agent can edit is not a measurement of it.

`--arg k=v` for strings, `--arg-json k=<json>` for numbers, arrays and objects.
`--yes` is required for a write/shell/destructive tool: the one-shot door
**narrows** authority relative to a run, and must never widen it.

## Checklist before you call a tool done

- [ ] the module is in `BUILTIN_MODULES`
- [ ] `flyt tools show <id>` reports `bound: true`
- [ ] `flyt tools run <id>` returns what the description promises
- [ ] third-party content is `trust: 'untrusted'` and says so in its own result
- [ ] a missing key/package/interpreter is a result with a remedy, not a throw
- [ ] the full result is archived and the preview is bounded
- [ ] `flyt tools problems` is empty
- [ ] there is a test, and `npm test` is green
