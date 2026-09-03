# Low-Effort Issue Brief: harness loop-status file is not git-ignored

**Workspace:** the bound workspace (this repository)
**Area:** per-project harness state directory `.flyt/`
**Type:** trivial configuration problem
**Effort:** one line, in one file
**Risk:** none — version-control metadata only
**Status:** validated — **ACCEPTED** (see "Final acceptance verdict" at the end)

## 1. Issue description

The per-project harness state directory `.flyt/` deliberately mixes two kinds of content. Its own `.gitignore` states the policy in its header:

> "run artifacts never belong in version control. config.json and skills/ are yours to commit."

The ignore list, however, contains only `runs/`. Everything else the harness churns at runtime remains trackable. The clearest case is `loop-status.json` — the supervisor's live status file, rewritten continuously, containing a process PID, in-flight run IDs, heartbeat timestamps, and token/spend counters. Because it is not ignored, any whole-directory add of the project state (`git add .flyt`) sweeps a machine-specific PID and churning counters into version control — producing noisy diffs and misleading history, exactly the outcome the file's own header says is not wanted.

## 2. Why it is easy to solve

- **Single-line change in a single existing file:** one entry appended to `.flyt/.gitignore`.
- **Fits existing conventions:** the rule is already stated in the file's own header and already applied once (`runs/`); the fix applies the same rule to the same class of artifact, in the same file.
- **No side effects:** git ignore rules do not influence the running loop — the harness reads and writes `.flyt/loop-status.json` regardless of tracking status. The file stays on disk; only git stops offering it for commit.
- **No new tests required:** there is no code path to test; behavior is verified with git's own tooling plus the existing suite staying green.

## 3. Suggested fix

Append one line to `.flyt/.gitignore` so it reads:

```gitignore
# Written by LLM Flow: run artifacts never belong in version control.
# config.json and skills/ are yours to commit.
runs/
loop-status.json
```

This brief addresses **exactly one issue**: `loop-status.json` being left trackable. The optional follow-up below names sibling runtime entries only to mark the boundary of the chosen fix; it is a separate, clearly separable decision and is **not** part of this brief's resolution plan.

Optional follow-up (same one-line-per-entry pattern, same rationale, and clearly separable if a team deliberately commits some of this state): the other churning runtime entries `ledger/`, `feedback/`, `incidents/`, `archive/`, `chats/`, `userdata/`, and `loop/` may be excluded the same way. `loop-status.json` alone is the unambiguous case — it holds a live PID and wall-clock state by design. Backlog task files and `context.md` are intentionally out of scope here, since the task queue is designed to outlive runs and may be worth committing.

## 4. Acceptance criteria

The issue is resolved when:

1. `git check-ignore -v .flyt/loop-status.json` (or `git status --ignored`) shows the file excluded from tracking.
2. `git add .flyt` stages no runtime artifacts — only `config.json`, `skills/`, and any content deliberately chosen for commit.
3. The change is **covered by the existing test/build suite**: any test/build gate the project declares (e.g. `npm test`, `npm run build`) is unaffected by a git-ignore entry and continues to pass — green stays green by construction, and no new test is required. In the bound workspace the change is version-control metadata only: no application test/build suite is declared for this deliverable, so suite-greenness is asserted structurally (the change lies outside every code path) rather than by execution.
4. The change aligns with project coding standards: it extends the policy and comment style already present in the file's header rather than inventing a new one.
5. No new risks are introduced: no code path changes, no behavior change for the running loop, nothing deleted from disk — the file simply becomes untracked, and the fix can be merged without adverse effects on the current code base.

## 5. Merge-readiness statement

The proposed fix aligns with the project's coding standards and can be merged without adverse effects on the current code base. Concretely: it appends one pattern to an existing metadata file, reusing the policy and comment style that file already establishes; it changes no code, no dependencies, and nothing the running loop reads or writes; it introduces no new risks (the only observable change is that git stops offering `loop-status.json` for commit); and it is covered by the existing test/build suite in the sense that every existing gate is unaffected and remains green — no new tests are needed and none are added.

## Scope and method notes

- Inspection was high-level only: workspace directory structure, `.flyt/config.json`, `.flyt/.gitignore`, `.flyt/loop-status.json`, the `.claude/` launch/permission manifests, and the task-queue titles; no deep file-level analysis, no code execution, no debugging.
- All references above are workspace-relative ("the bound workspace"); the reader does not need to supply repository paths or file contents.
- Duplicate check: no task in the visible backlog queue covers this issue. (Full-text backlog search was unavailable in this environment, so the check was title-level.)
- Validation pass: the brief was re-checked against every acceptance condition and amended where vague (exactly-one-issue pin in §3, honest suite wording in criterion 3, explicit merge-readiness statement in §5). The gate runner in this environment fails with a recurring harness-internal error (`appendLog cannot mutate canonical run …`) and the workspace declares no gates (no `package.json` present anywhere), so no gate run was possible — and none is required for a metadata-only change.

## Final acceptance verdict

**Verdict: ACCEPTED.** The brief is self-contained and downstream blocks can act on it without further input.

Validation checklist — each condition checked against the brief as amended above:

| # | Acceptance condition | Status | Where it holds |
|---|---|---|---|
| 1 | Exactly one well-described issue meeting the "easy-to-solve" definition | ✅ Pass | §1 (one issue: `loop-status.json` left trackable); §2 (single line, no side effects, no new tests, fits existing conventions); §3 pins the brief to exactly this one issue |
| 2 | Concrete, minimal fix proposal / remediation step | ✅ Pass | §3 — exact resulting `.flyt/.gitignore` content, one appended line |
| 3 | Explicit statement: aligns with coding standards, mergeable without adverse effects, no new risks, covered by existing test/build suite | ✅ Pass | §5 (consolidated statement) and §4 criteria 3–5 (per-element breakdown) |
| 4 | Analysis grounded in high-level inspection only | ✅ Pass | Scope and method notes — shallow scans of config/status files only; no deep file-level analysis, no execution, no debugging |
| 5 | Self-contained: no dependency on user-supplied repository paths or file contents | ✅ Pass | Header names "the bound workspace"; all paths workspace-relative; the only quoted file content is reproduced inline |

Residual caveats, disclosed and non-blocking: (a) no gate could be executed in this environment (harness-internal `appendLog` error; no declared gates exist for a docs-only, metadata-only change); (b) the backlog duplicate check was title-level only.
