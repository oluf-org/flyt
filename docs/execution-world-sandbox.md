# Add a real execution-world and sandbox provider

Status: implementation specification
Audience: the agent implementing the provider, reviewers, and maintainers
Scope: model-reachable filesystem and process execution, sandbox policy, local OS confinement, run metadata, lifecycle, diagnostics, settings, packaging, and tests

## Outcome

After this work, every new Flyt run executes file operations and child processes through one explicitly selected **execution world**. The shipped world is local: its filesystem and processes share the same workspace on the host. Commands in that world are governed by a real operating-system file-effect sandbox with these modes:

- `read-only`
- `workspace-write`
- `danger-full-access`

`read-only` and `workspace-write` must be enforced by a usable platform backend. If Flyt cannot enforce the requested mode, it refuses the process with `SANDBOX_UNAVAILABLE`; it never silently starts the command without confinement. `danger-full-access` is the only unconfined mode and must be an explicit launch choice or a human-approved, one-call escalation.

The same resolved policy applies to both in-process file mutations and spawned commands. A run cannot tell `write_file` that the workspace is read-only while allowing `bash` to write it, or bind file tools to one root and shell commands to another. Every child process is owned, bounded, environment-scrubbed, tree-terminated, and awaited during run or host teardown.

Flyt's existing authority model remains above this boundary:

```text
tool classification
  -> block static ceiling
  -> runtime grant / resource permission
  -> attended approval when required
  -> resolved sandbox policy
  -> filesystem or process provider
```

An approval does not itself disable the sandbox. A sandbox does not make an ungranted tool reachable. Worktree isolation is still useful for review and rollback, but it is no longer presented as process confinement.

This specification adds the local provider family and the seams needed to replace it later. It does not require a remote provider, container service, VM, network firewall, or distributed execution.

## Prerequisite and sequencing

Implement this after the production-path cutover in [`docs/single-kernel-cutover.md`](./single-kernel-cutover.md), or on a branch where that cutover has already landed. The relevant prerequisite is not file deletion; it is the invariant that Desktop, CLI, and Loop launches all enter one `RunController` and one kernel stack runner.

If `core/stackRunner.js` or another legacy runner is still production-reachable, do not add a second sandbox integration to it. Complete the single-kernel cutover first. Historical runs remain readable and need no retroactive sandbox metadata.

## Read this first: current repo state

The repository contains several pieces of the target design, but they do not yet form a security boundary.

- `kernel/src/seams/fs.ts` provides a useful path-confined `FsSeam`. It rejects lexical traversal and checks the nearest existing ancestor's real path. Its implementation still calls host `node:fs` directly and has no read-only/workspace-write policy.
- `kernel/src/plugins/fs.ts` mounts that seam for a workspace root. `core/kernelHost.js` installs it as `workspace-fs`.
- `kernel/src/seams/shell.ts` declares a screened `ShellSeam`, but there is no shipped provider. Its own header correctly says screening is not sandboxing.
- `kernel/src/seams/sandbox.ts` declares a worktree-style `Realm` factory, but there is no provider and no production consumer. A directory and a cleanup owner are not process confinement.
- `core/tools/bash.js` imports `spawn` directly, uses `shell: true`, inherits the app environment, and relies on `cwd` plus approvals. A command can `cd ..`, follow absolute paths, and start descendants which are not reliably tree-owned.
- `core/python.js` is the central Python bridge and already has useful time/output bounds, but it imports `spawn` directly and inherits almost all of the parent environment.
- `core/gates.js` runs project-authored commands directly with `execFile(..., { shell: true })`. Gates are trusted as definitions of done, but the project code they execute is not trusted with the rest of the machine.
- `core/worktree.js`, `core/effect.js`, `core/adapters/cliDelegate.js`, and setup/build code also spawn processes. Some are trusted host control-plane operations and must remain distinguishable from agent execution rather than being moved blindly.
- `kernel/src/plugins/approvals.ts` already applies classification, static ceiling, resource permission, and approval in the right strict-to-broad order. Do not merge sandbox mode into approval mode.
- `kernel/src/security/permissions.ts` is a resource decision layer. It is not an OS boundary and cannot constrain what a permitted shell's grandchildren do.
- `run.created` already carries workspace, approval mode, and profile metadata. Sandbox/world facts belong there too, with typed follow-up events for per-call decisions.
- `GOALS.md` and `DESIGN-SPEC.md` honestly state that production-grade process sandboxing is not claimed. Update that statement only to the narrower claim this work can prove.

The implementation must remove the production bypasses; adding attractive seams while `bash` and Python still call `node:child_process` directly is not completion.

## Lessons taken from DeepSeek Harness

This design was informed by the public DeepSeek Harness checkout at commit `4e84901e6471b79ec0338099867ebb4606d12bb5` (`0.1.2-alpha.4`). Treat that repository as design evidence, not as a runtime dependency or hidden implementation context.

The applicable lessons are:

1. **An execution world is a coherent provider family.** Filesystem and subprocess paths must name the same world. A remote or container world replaces both capabilities; it is not a local process wrapper mounted under an otherwise local filesystem.
2. **Subprocess is a capability seam of its own.** Shell, Python, gates, terminals, language servers, and future out-of-process plugins need the same process ownership, environment, output, and teardown rules.
3. **Same-world confinement and isolated worlds are different abstractions.** A local sandbox wraps an exact argv while sharing the host kernel and filesystem. A container, microVM, or remote service instead provides a new filesystem and subprocess implementation together.
4. **Policy rides each call.** The provider is not mutated globally when one run or one approved retry needs a different mode. Concurrent calls can use different policies safely.
5. **Fail closed and probe functionally.** Finding an executable is not evidence that it can enforce a policy. Backends must prove a denied write and an allowed operation before they are selected.
6. **Report enforcement completeness.** A backend can be useful without being absolute. Windows write-restricted tokens and some kernel mechanisms have residual boundaries; Flyt must record `full` or `partial`, not imply equivalence.
7. **Filesystem and command denial vocabulary must agree.** The model should see one stable denial code and mode, independent of which capability noticed it.
8. **Process lifetime belongs to the provider.** Disposing a consumer must not orphan its children. Stopping a run and disposing a host both await tree quiescence.
9. **Environment inheritance is an authority channel.** Ambient API keys and Flyt process metadata must not leak merely because a project runs a command.
10. **The security claim stays narrow.** File-effect confinement is not network isolation, read secrecy, syscall isolation, or protection from kernel vulnerabilities.

Flyt should not copy DeepSeek Harness's package graph, tool schemas, model context text, or E2B proof of concept. Flyt already has stronger product-level run logs, static block ceilings, resource permissions, worktree ownership, gates, independent review, and post-merge canaries. Preserve those.

## Definitions

- **Execution world**: one coherent namespace and lifecycle for filesystem operations and processes. Its filesystem root, process working path, temp space, executable resolution, and teardown facts agree.
- **Local world**: an execution world backed by the host filesystem and host processes.
- **Isolated world**: a future container, VM, or remote implementation which replaces filesystem and subprocess providers together. It is not implemented by this specification.
- **Sandbox**: same-world OS enforcement applied to an exact process argv under a file-effect policy. It does not create a different filesystem world.
- **Sandbox mode**: `read-only`, `workspace-write`, or `danger-full-access`.
- **Standing mode**: the mode recorded at run creation and used unless a single call has an approved escalation.
- **Effective mode**: the mode actually applied to one filesystem or process call after resolving the standing mode and any one-call escalation.
- **Enforcement**: `full`, `partial`, or `none`. `none` is legal only with `danger-full-access`.
- **Backend**: the platform mechanism selected by the local sandbox provider, such as `bubblewrap`, `seatbelt`, or `windows-restricted-token`.
- **Execution plane**: processes which execute model-requested commands, project code, tool sidecars, or verification code against the working copy.
- **Control plane**: trusted host operations which provision worktrees, call model providers, manage the app, or install Flyt-owned dependencies. These do not receive model-authored shell strings.
- **Owner**: the stable run/call identity used to track and terminate a process tree.
- **Private temp**: a provider-created directory scoped to a run or process owner. It is not a general grant to the ambient OS temp tree.

## Threat model and honest claim

### Protect against

For confined local commands, Flyt must prevent accidental or model-directed writes outside the allowed roots, including through:

- `cd ..` and absolute paths;
- a child or grandchild process;
- shell redirection;
- symlink traversal where the selected OS backend governs the resolved target;
- Python and project test/build scripts;
- concurrent runs which use different sandbox modes;
- inherited credential-shaped environment variables;
- runaway output, timeouts, stop requests, and host shutdown.

For in-process file tools, Flyt must prevent writes outside the canonical workspace root and enforce `read-only` before the mutation syscall. The existing transactional patch/version behavior must remain intact.

### Do not claim

This work does not promise:

- network denial or egress filtering;
- that a confined process cannot read host files the current user can read, especially on Windows;
- hiding other processes or preventing all IPC;
- syscall, device, kernel, or speculative-execution isolation;
- defense against a compromised Electron main process or malicious trusted plugin;
- containment of privileged/elevated execution;
- protection on filesystems which cannot express the backend's policy;
- that `partial` enforcement is equivalent to `full`;
- survival of sandbox state across machines;
- a remote, container, or VM execution service.

`SAFETY.md` or the closest existing safety document must say that the sandbox and approvals reduce risk but are not the sole security control. Keep backups and disposable environments in the operational guidance.

## Non-negotiable invariants

The implementation is incomplete unless all of these hold.

### World coherence

1. One resolved execution-world descriptor is recorded before a run executes its first block.
2. `ctx.fs`, `ctx.subprocess`, and `ctx.shell` installed in a run host belong to the same provider family and workspace identity.
3. File tools and shell commands resolve the same workspace root from one policy service. They may not each normalize a separately supplied string.
4. A future isolated provider must replace filesystem and subprocess capabilities together. Mounting remote subprocess over local filesystem, or the reverse, is rejected during composition.
5. A host-pool key includes provider kind, canonical workspace identity, sandbox defaults, minimum enforcement, and environment-forwarding policy. Hosts with different authority are never reused.

### Authority

6. Classification, ceiling, runtime grant, resource permission, and approval are checked before sandbox execution and remain independently necessary.
7. Approval cannot convert a confined call to unconfined execution unless the exact call requested a strictly wider mode and a person approved that one escalation.
8. A saved resource approval is not a saved sandbox escalation.
9. Unattended Loop runs cannot escalate to `danger-full-access`. They fail and park with an actionable reason.
10. Sandbox policy can narrow a granted tool but cannot make an ungranted tool reachable.

### Fail closed

11. `read-only` or `workspace-write` with no usable backend throws/refuses with code `SANDBOX_UNAVAILABLE`; raw argv is never a fallback.
12. A backend which exists but fails its functional probe is unavailable.
13. A selected runner failure is distinguishable from the wrapped command's non-zero exit.
14. `danger-full-access` is explicit and records enforcement `none`; no code infers it from missing configuration.
15. Resume refuses if it cannot recreate at least the recorded standing mode and minimum enforcement. It never silently downgrades an old confined run.

### Process lifecycle

16. All execution-plane processes start through `ctx.subprocess`. There is no direct `spawn`, `exec`, `execFile`, or `fork` in their production paths.
17. Each spawned process is attached to a run/call owner before model-visible success is returned.
18. Stop, timeout, run settlement, and host disposal terminate the whole observable process tree, await it, and are idempotent.
19. A consumer reload does not orphan a process owned by the longer-lived subprocess provider.
20. Output is bounded in memory. Full output remains recoverable through the existing tool-artifact mechanism when configured, and truncation is explicit.
21. A process never implicitly inherits credential-shaped variables or ambient `FLYT_*` execution facts.

### Durability and observability

22. `run.created` records requested/effective world and sandbox facts without secrets.
23. Every execution-plane call records its effective mode, backend, enforcement, and escalation outcome before or with its tool result.
24. Work and Trace derive sandbox facts from `session.jsonl`; renderer-only state is not authoritative.
25. Diagnostics report the actual functional probe, not only platform guesses or executable presence.
26. Logs never contain API-key values, full inherited environments, access tokens, or private sandbox capability identifiers.

## Target architecture

```text
Desktop / CLI / Loop launch
          |
          v
   resolved RunLaunch
   provider + mode + minimum enforcement
          |
          v
     RunController
          |
          v
  Cordis run host / host pool
          |
          +---------------- execution-world-local ----------------+
          |                                                        |
          |  ctx.sandboxPolicy                                     |
          |       |                                                |
          |       +----------+------------------+                  |
          |                  |                  |                  |
          |             ctx.fs             ctx.shell               |
          |        policy-fenced I/O      command semantics         |
          |                                     |                  |
          |                                ctx.sandbox              |
          |                              argv confinement           |
          |                                     |                  |
          |                              ctx.subprocess             |
          |                         process tree / env / output      |
          +--------------------------------------------------------+
                                |
                                v
                  one canonical local workspace
```

The execution world is a composition property, not a ninth object every consumer must manually unpack. Consumers keep depending on the narrow capability they need. Coherence is proven by a shared immutable descriptor carried by all providers:

```ts
export interface ExecutionWorldDescriptor {
  id: string;
  provider: 'local';
  workspaceId: string;       // opaque stable hash, not the raw path
  hostRoot: string;          // diagnostics only; never sent to remote worlds
  processRoot: string;       // local world equals hostRoot
  platform: NodeJS.Platform;
  sandbox: {
    standingMode: SandboxMode;
    backend: SandboxBackend;
    enforcement: SandboxEnforcement;
    network: 'ambient';
  };
}
```

Every provider exposes the same descriptor object by identity. The composition helper asserts `ctx.fs.world === ctx.subprocess.world === ctx.shell.world`. Do not compare only strings: identity makes accidental mixed composition fail immediately.

## Replace the current sandbox seam

The unused realm factory in `kernel/src/seams/sandbox.ts` is the wrong abstraction for same-world process confinement. Replace `Realm`, `RealmOptions`, and `SandboxSeam.create/list` with the following vocabulary. No compatibility adapter is required because no production provider or consumer exists.

```ts
export type SandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>;
export type SandboxEnforcement = 'full' | 'partial' | 'none';
export type SandboxBackend =
  | 'bubblewrap'
  | 'seatbelt'
  | 'windows-restricted-token'
  | 'unconfined';

export interface SandboxExecutionPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
  owner: { runId: string; callId: string };
  privateTemp: string;
  minimumEnforcement: Exclude<SandboxEnforcement, 'none'>;
}

export interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: ConfinedSandboxMode;
}

export interface ConfinedArgv {
  argv: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  backend: Exclude<SandboxBackend, 'unconfined'>;
  enforcement: Exclude<SandboxEnforcement, 'none'>;
  runnerFailure: RunnerFailureRule;
}

export interface SandboxProbe {
  platform: NodeJS.Platform;
  backend: SandboxBackend | null;
  available: boolean;
  enforcement: SandboxEnforcement | null;
  checkedAt: string;
  reason?: string;
}

export interface SandboxSeam {
  readonly world: ExecutionWorldDescriptor;
  probe(force?: boolean): Promise<SandboxProbe>;
  confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv>;
  disposeOwner(runId: string): Promise<void>;
}
```

`confine` only accepts confined modes. The shell consumer handles `danger-full-access` by passing its original argv to `ctx.subprocess` and records `backend: unconfined`, `enforcement: none`. This makes an accidental unconfined return impossible to confuse with successful confinement.

Define `SandboxUnavailableError` with stable code `SANDBOX_UNAVAILABLE`. Define a separate `SANDBOX_RUNNER_FAILED` result classification for a runner which started but did not start the wrapped command. Do not infer either from exit code alone; match a provider-owned stderr signature and allowed exit code, then strip only exact provider informational lines.

## Add a real subprocess seam

Create `kernel/src/seams/subprocess.ts` and add `subprocess` to `Seams`, `SEAM_NAMES`, exports, contribution classification, and seam tests. Update `tests/dshCompat.test.js` deliberately: the old eight-name assertion reflects an earlier DeepSeek surface and must not prevent a capability Flyt now needs.

The seam is below shell semantics. It accepts argv, never a command string and never `shell: true`.

```ts
export interface ProcessOwner {
  runId: string;
  callId: string;
}

export interface ProcessOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  runnerFailed?: { code: 'SANDBOX_RUNNER_FAILED'; detail: string };
}

export interface CollectedStream {
  text: string;
  truncated: boolean;
  bytesSeen: number;
  spillPath?: string;       // provider-private; archive through the tool layer
}

export interface ProcessHandle {
  readonly pid: number;
  readonly owner: ProcessOwner;
  readonly stdout: CollectedStream;
  readonly stderr: CollectedStream;
  readonly done: Promise<ProcessOutcome>;
  terminate(reason?: string): Promise<void>;
  waitForExit(): Promise<void>;
}

export interface SpawnSpec {
  owner: ProcessOwner;
  argv: readonly [string, ...string[]];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin?: string | Uint8Array;
  stdout: { maxBytes: number; spillMaxBytes?: number };
  stderr: { maxBytes: number; spillMaxBytes?: number };
  timeoutMs: number;
  graceMs: number;
  signal?: AbortSignal;
  runnerFailure?: RunnerFailureRule;
}

export interface SubprocessSeam {
  readonly world: ExecutionWorldDescriptor;
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>): Promise<string>;
  spawn(spec: SpawnSpec): ProcessHandle;
  terminateOwner(runId: string, reason?: string): Promise<void>;
  active(runId?: string): readonly { owner: ProcessOwner; pid: number }[];
  dispose(): Promise<void>;
}
```

Implementation requirements:

- Absolute executable paths are verified. Bare names use the scrubbed `PATH` plus explicit overrides. Relative paths containing a separator are refused.
- POSIX children start in a distinct process group/session. Windows children enter a Job Object configured for kill-on-close. Termination targets the tree, not only the direct child.
- `terminate()` is idempotent. POSIX termination is `SIGTERM`, bounded grace, then `SIGKILL`; Windows terminates the Job Object and waits.
- The abort signal and timeout enter the same termination path. They do not create parallel kill logic.
- `done` rejects only when spawn itself never began. A command's non-zero exit is data.
- Collection retains a bounded tail because diagnostics cluster at the end. If a spill cap is configured, the complete stream goes to a private file until that cap; an overflow deletes/marks the incomplete spill.
- Provider disposal first prevents new spawns, then terminates all active owners, waits for quiescence, cleans private temp, and aggregates cleanup failures.
- Run settlement calls `terminateOwner(runId)` even when the host will remain pooled for another run.

Interactive PTY support is not required because Flyt has no canonical model-facing terminal seam today. The subprocess contract must not preclude a later `spawnTerminal`, but do not add unused terminal code in this change.

## One sandbox policy resolver

Create `kernel/src/plugins/sandbox-policy.ts`. It is a Cordis service available as `ctx.sandboxPolicy`, but it is policy, not a model-effect capability, so it does not belong in `SEAM_NAMES`.

```ts
export interface SandboxPolicyConfig {
  mode: SandboxMode;
  workspaceRoot: string;
  minimumEnforcement: 'full' | 'partial';
  allowAttendedEscalation: boolean;
}

export interface SandboxPolicyRequest {
  runId: string;
  callId: string;
  requestedMode?: SandboxMode;
  attended: boolean;
}

export interface ResolvedSandboxPolicy extends SandboxExecutionPolicy {
  standingMode: SandboxMode;
  escalated: boolean;
}

export interface SandboxPolicySeam {
  readonly world: ExecutionWorldDescriptor;
  resolve(request: SandboxPolicyRequest): Promise<ResolvedSandboxPolicy>;
  describe(): Readonly<SandboxPolicyConfig>;
}
```

Rules:

1. Canonicalize `workspaceRoot` once at provider construction. Resolve symlinks before deriving the world identity.
2. The run's standing mode is immutable. A settings change affects new runs only.
3. The only widening order is `read-only < workspace-write < danger-full-access`.
4. A requested mode equal to or narrower than the standing mode does not prompt; use the narrower effective mode.
5. A wider request must include a non-empty justification and must be approved for that exact `(runId, callId, requestedMode)`.
6. Approval is one-call only and is consumed before execution. Retry or duplicate call ids do not reuse it.
7. `flyt-loop-worker` sets `allowAttendedEscalation: false` and cannot request `danger-full-access`.
8. `privateTemp` is minted below Flyt's user-data temp root per run/call and created with user-only permissions where the platform supports them.
9. The resolver returns data; it never changes global provider state.

Add the optional common arguments below to `bash` and every mutating file tool schema. Keep `additionalProperties: false` and validate the pair before prompting:

```json
{
  "sandbox_permissions": {
    "enum": ["workspace-write", "danger-full-access"],
    "description": "Optional one-call request for the narrowest wider sandbox mode required."
  },
  "justification": {
    "type": "string",
    "description": "Why this exact call cannot complete under the current sandbox mode."
  }
}
```

Reject an unpaired field, a non-widening escalation, an unattended escalation, or a request beyond the profile before asking a person. File and shell tools use the same resolver and approval callback. Do not teach each tool its own mode precedence.

### Carry call identity explicitly

Do not use `AsyncLocalStorage`, a mutable “current run,” or a property on the shared provider to tell filesystem and shell calls which policy applies. Extend the seam calls with an explicit immutable execution record derived from `ToolExecution.call.id`:

```ts
export interface CapabilityExecution {
  owner: ProcessOwner;
  tool: string;
  attended: boolean;
  requestedMode?: SandboxMode;
  justification?: string;
  signal?: AbortSignal;
}

export interface FsMutationOptions {
  execution: CapabilityExecution;
  diagnose?: DiagnoseBatch;
}

export interface FsSeam {
  readonly root: string;
  readonly world: ExecutionWorldDescriptor;
  read(path: string, signal?: AbortSignal): Promise<string>;
  write(path: string, content: string, options: FsMutationOptions): Promise<void>;
  hash(path: string, signal?: AbortSignal): Promise<string>;
  patch(patches: readonly FilePatch[], options: FsMutationOptions): Promise<MutationBatchResult>;
  exists(path: string, signal?: AbortSignal): Promise<boolean>;
  list(path?: string, signal?: AbortSignal): Promise<FsEntry[]>;
  remove(path: string, options: FsMutationOptions): Promise<void>;
}
```

Focused tests which construct `createFsSeam` directly may use a deliberately named unrestricted test policy helper; production mutation call sites must always supply `CapabilityExecution`. Do not make the options optional merely to avoid updating call sites: a missing identity is exactly how shared-host policy leaks between concurrent runs.

Likewise, make shell execution identity explicit:

```ts
export interface ShellOptions {
  execution: CapabilityExecution;
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}
```

The abort signal lives in `CapabilityExecution`, so there is one cancellation source. The shell provider derives `SandboxPolicyRequest` from this record and never reads model fields which were not schema-validated by the tool registry.

## Mode semantics

The modes govern file effects in the selected execution world. Network remains `ambient` and is recorded as such.

| Mode | In-process file tools | Spawned commands | Enforcement |
|---|---|---|---|
| `read-only` | reads/list/hash allowed; write/patch/remove denied | OS backend denies file writes except required OS sinks | `full` or honestly `partial` |
| `workspace-write` | mutations only below canonical workspace root | OS backend permits writes below workspace plus the call's private temp | `full` or honestly `partial` |
| `danger-full-access` | existing resource policy still applies, no sandbox fence | original argv runs through managed subprocess without OS file confinement | `none` |

The ambient OS temp root is never a writable allow-list entry. Only the provider-created private temp directory is. Set `TMPDIR` on POSIX and `TEMP`/`TMP` on Windows to that directory for the child.

`read-only` may grant platform sinks required to start normal processes (`/dev/null`, Windows `NUL`). It must not grant a reusable temp directory. If a tool cannot start without temp writes, it should request `workspace-write`, not reinterpret `read-only`.

The filesystem fence must canonicalize immediately before a mutation and mutate the freshly resolved target. Keep the existing nearest-existing-ancestor symlink defense for not-yet-created paths. For `workspace-write`, the fresh target must be contained by the canonical workspace root; private temp is for child processes, not model-facing file paths.

## The local execution-world provider family

Add a single built-in composition entry, `flyt:execution-world-local`, whose implementation is split into testable modules but installed atomically. Suggested files:

```text
kernel/src/plugins/execution-world-local.ts
kernel/src/plugins/sandbox-policy.ts
kernel/src/plugins/fs-sandbox.ts
kernel/src/plugins/shell-screened.ts
kernel/src/plugins/subprocess-local.ts
kernel/src/plugins/sandbox-local.ts
kernel/src/sandbox/backends/linux-bwrap.ts
kernel/src/sandbox/backends/macos-seatbelt.ts
kernel/src/sandbox/backends/windows-restricted-token.ts
kernel/src/sandbox/environment.ts
kernel/src/sandbox/output.ts
kernel/src/sandbox/errors.ts
```

The composition entry receives:

```ts
interface LocalExecutionWorldConfig {
  workspaceRoot: string;
  mode: SandboxMode;
  minimumEnforcement: 'full' | 'partial';
  allowAttendedEscalation: boolean;
  forwardedEnv?: readonly string[];
  runsTempRoot: string;
}
```

It constructs one immutable descriptor, mounts policy, local fs, local subprocess, local sandbox, and screened shell, asserts descriptor identity, and rolls back all mounted services if any provider fails. `BUILTIN.fs` should no longer be installed separately for run hosts; either retire that built-in or retain it only for focused seam tests and non-running Build surfaces.

### Linux backend

The first Linux backend is Bubblewrap (`bwrap`). It must:

- be resolved as an executable through trusted provider startup, not through a model string;
- use `--die-with-parent` and a new process/session boundary;
- expose the host filesystem read-only, then bind the canonical workspace read-write only for `workspace-write`;
- provide `/proc`, required devices, and `/dev/null` without making arbitrary host directories writable;
- bind only the call's private temp directory as writable and point temp environment variables at it for `workspace-write`;
- keep networking unchanged and report `network: ambient`;
- pass the exact command argv after `--` without shell reconstruction;
- classify Bubblewrap setup failures separately from command failures.

The functional probe must run an allowed read, attempt a sentinel write outside the workspace and verify denial, and for `workspace-write` verify a sentinel inside a disposable probe workspace succeeds. Delete probe artifacts. Merely running `bwrap --version` is insufficient.

Do not silently fall back to cwd confinement when Bubblewrap is missing or user namespaces are disabled. A Landlock fallback can be added later as another backend, but is not required for this implementation; diagnostics should name Bubblewrap installation/user-namespace remediation.

### macOS backend

Use the built-in `sandbox-exec` Seatbelt runner while it is available. Generate an SBPL profile per call which:

- allows normal reads and process execution;
- denies `file-write*` by default;
- permits only required sinks in `read-only`;
- additionally permits the canonical workspace and private temp subpaths in `workspace-write`;
- quotes paths as SBPL string literals without interpolation;
- does not claim network restriction;
- passes exact argv after the profile arguments.

Functionally probe an external denied write and an allowed workspace write. If `sandbox-exec` is absent or the profile is rejected, confined modes are unavailable. Do not parse localization-sensitive prose when an exit/status signature can be owned by Flyt's runner wrapper.

### Windows backend

Use a restricted-token plus ACL write-allowlist backend. A Job Object alone is process cleanup, not file confinement, and is insufficient.

Required behavior:

- duplicate the current non-elevated token into a `WRITE_RESTRICTED` token;
- create a deterministic capability SID for the canonical workspace and a random capability SID for each private temp directory;
- add inheritable write ACEs for those capability SIDs only to their owning directories;
- include no workspace/temp write SID in `read-only`;
- include the workspace and private-temp restricting SIDs in `workspace-write`;
- create the wrapped child under the restricted token and attach it to a kill-on-close Job Object before returning success;
- rewrite `TEMP` and `TMP` to the private temp directory;
- verify every Win32 return code and fail before spawning unrestricted on any setup error;
- revoke temporary grants on disposal; standing workspace grants may remain only if they are deterministic, inert without the restricting SID, documented, and idempotently reused;
- ensure a private temp capability from one run is not carried by another run.

Use a maintained FFI/native bridge appropriate to the Electron/Node versions in `package.json`. If a native dependency is added, pin it, document why, add its license to distribution notices, and verify unpacking/signing on every packaged platform. Do not shell out to `icacls` or build a command line containing workspace paths.

Report this backend as `partial`, because a Windows write-restricted token does not confine reads, retains ambient grants needed for process initialization, and NTFS hard links can alias a file object across paths. `minimumEnforcement: full` must therefore refuse it. The default Flyt policy may accept `partial` on Windows, but the UI and run record must say so plainly.

Refuse elevated/admin host tokens for confined execution until an explicit, tested policy exists. Refuse filesystem targets that cannot support the required ACL behavior rather than claiming confinement.

### Functional probe cache

Probe once per `(app version, platform, backend binary identity)` and cache only successful results for the process lifetime. A failure may be retried through `flyt doctor --refresh`; do not persist a green result across app upgrades or backend replacement.

Concurrent callers share one in-flight probe promise. Disposal racing a probe must prevent later process acquisition. Probe work uses a disposable provider-owned directory, never the user's workspace.

## Screened shell provider

Implement `kernel/src/plugins/shell-screened.ts` as the production `ctx.shell` provider. Screening remains a readable policy layer, not the sandbox.

`ShellSeam.run` should accept the owner and optional requested sandbox mode in addition to the existing cwd, timeout, signal, and environment fields. Its flow is:

1. Validate the command and relative cwd.
2. Apply the existing readable command screen.
3. Resolve the per-call sandbox policy.
4. Select the platform shell as trusted configuration:
   - Windows: canonical `ComSpec`, `[/d, /s, /c, command]`.
   - POSIX: resolved `/bin/sh`, `[-c, command]`.
5. For a confined mode, call `ctx.sandbox.confine(shellArgv, policy)`.
6. Spawn the returned exact argv through `ctx.subprocess`.
7. Await, classify runner failure/timeout/denial, archive output, and return one stable `ShellResult`.

Do not use Node's `shell: true` below this point. The shell is now explicit argv and therefore visible in tests and diagnostics.

Extend `ShellResult` with stable facts rather than requiring consumers to parse prose:

```ts
interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut?: boolean;
  refused?: string;
  errorCode?: 'SANDBOX_UNAVAILABLE' | 'SANDBOX_DENIED' | 'SANDBOX_RUNNER_FAILED' | 'SPAWN_FAILED';
  sandbox: {
    mode: SandboxMode;
    backend: SandboxBackend;
    enforcement: SandboxEnforcement;
    escalated: boolean;
  };
}
```

The model-facing denial marker is stable and short:

```text
[sandbox: file access denied under <mode> mode]
```

When an attended escalation is possible, append a bounded hint to retry the exact call with the narrowest wider `sandbox_permissions` and a justification. Do not show an escalation hint to Loop.

## Route existing consumers

### `core/tools/bash.js`

Delete its `node:child_process` and `node:fs` imports and its private `execShell`. The tool should validate its own schema/default timeout and call the kernel-bound `ctx.shell.run`. Preserve the current result shape (`command`, `target`, `exitCode`, `stdout`, `stderr`, `signal`, `timedOut`) and add the structured `sandbox` fact. Keep the existing artifact/preview behavior in `core/tools/index.js`.

`core/kernelHost.js` must pass the kernel services and the current `ToolExecution` identity into the legacy built-in tool-body bridge during the compatibility interval. At minimum the execution context contains:

```js
{
  fs: booted.ctx.fs,
  shell: booted.ctx.shell,
  subprocess: booted.ctx.subprocess,
  sandboxPolicy: booted.ctx.sandboxPolicy,
  execution: { runId, callId, attended, profile }
}
```

Do not let tool bodies import the root kernel context as a singleton.

### File tools

Refactor `core/tools/fileHost.js` and the built-in file tools so mutations call the async `ctx.fs` methods. Preserve text/BOM/EOL handling by keeping it in `kernel/src/seams/textFile.ts`; do not create a second interpretation in `core/`.

The relevant tools include read, create, write, edit, glob/list, search, and any tool which deletes or patches workspace files. Reads may continue to use bounded provider APIs. Mutations must not resolve a path through `Workspace` and then call `node:fs` themselves.

The sandboxed fs provider wraps the existing transactional implementation:

- `read`, `hash`, `exists`, and `list` delegate after path confinement;
- `write`, `patch`, and `remove` resolve policy for the current tool call;
- `read-only` returns `FS_SANDBOX_DENIED` before mutation;
- `workspace-write` re-canonicalizes and verifies containment immediately before the transactional syscall;
- `danger-full-access` still cannot escape the `FsSeam.root` unless the separate resource permission explicitly uses a future external-directory provider. In this change, model-facing file tools remain workspace-confined in every mode.

That last rule is deliberate: `danger-full-access` removes process confinement; it does not turn relative file tools into arbitrary host-file APIs.

### Python sidecars

Split `core/python.js` into resolution/setup policy and execution. `runPythonScript` must accept a subprocess service and owner and start Python through it. Keep `-I`, stdin JSON framing, UTF-8 preamble, timeout, and output cap.

Model-reachable Python sidecars run under the same effective sandbox policy as their owning tool call. The interpreter is resolved in the same local world. Its managed virtual environment may be read from outside the workspace, but it is not a writable sandbox root during the call.

`flyt python setup` is an attended control-plane install and may retain a separate managed spawn path. It must still use the shared environment scrub and explicit argv. Mark this exception in the direct-spawn allowlist.

### Project gates

Run `core/gates.js` commands through the execution world, not direct `execFile`. Gates are human/project-authored, but the test/build scripts they start can contain repository code modified by the model. Use `workspace-write`, never an automatic `danger-full-access`, so tests can generate project artifacts without writing elsewhere.

Preserve gate timeout, output clipping, and status semantics. A sandbox unavailability or runner failure is `status: infrastructure`, not a red test assertion. The supervisor parks the task with the remedy rather than spending a capability rung trying to fix the project.

### Trusted control-plane exceptions

Do not blindly route every `node:child_process` import into the run sandbox. Maintain a small reviewed allowlist with a reason for each exception:

- `core/worktree.js`: trusted argv-only git provisioning, ownership, cleanup, landing, and canary checkout outside the agent workspace. Project gate execution inside the canary still uses the world.
- `core/effect.js`: trusted read-only git inspection, argv-only.
- `core/adapters/cliDelegate.js`: model-provider transport in a neutral cwd. It must use scrubbed environment and retain provider-specific sandbox flags; it is not a project shell tool.
- `core/python.js::setupPython`: explicit user-invoked environment installation.
- app development/build scripts and Electron lifecycle helpers which are not shipped model capabilities.

Every exception must satisfy all of these: no model-authored shell string, argv-only spawn, explicit cwd, explicit environment, bounded/owned lifetime, and an architecture-test allowlist entry. A plugin which receives `ctx.subprocess` is execution-plane by default.

## Environment policy

Create one `scrubbedParentEnv()` implementation in `kernel/src/sandbox/environment.ts`.

By default, remove environment names matching `KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL` case-insensitively and every `FLYT_*` name. Preserve ordinary execution facts such as `PATH`, home directory, locale, system root, compiler variables, and proxy variables. On Windows, compare names case-insensitively.

Explicit environment layers are applied after the scrub:

1. provider-required temp variables;
2. a settings-owned `forwardedEnv` allow-list whose values are read from the host at launch;
3. consumer-owned non-secret execution values;
4. explicit tombstones (`undefined`) which remove a value.

The model cannot name arbitrary environment variables or request a value from the host. Forwarding a credential-shaped name requires an attended settings change and a warning; the value is never written to `session.jsonl`, host keys, logs, or diagnostics. The host key contains only a hash of the allow-list names, not values.

## Profiles, launch settings, and defaults

Add the execution-world built-in to all running profiles through the host overlay, because it requires a per-workspace root. Do not put an unconfigured world row in the static base arrays.

Resolved launch configuration includes:

```js
executionWorld: {
  provider: 'local',
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  minimumEnforcement: 'full' | 'partial',
  forwardedEnv: [],
}
```

Defaults:

- Desktop: `workspace-write`, `minimumEnforcement: partial`, attended one-call escalation allowed.
- CLI: `workspace-write`, `minimumEnforcement: partial`; escalation allowed only when the CLI has an interactive approver.
- Loop: `workspace-write`, `minimumEnforcement: partial`, escalation disabled.
- Read-only inspection workflows may author a narrower `read-only` standing mode.

These defaults do not change the existing approval defaults. Desktop/CLI project writes and shell calls still ask unless the user selected a more permissive approval mode. Loop retains its static ceiling, worktree, gates, review, spend limits, and canary.

Expose the resolved choice in the existing safety settings surface and CLI:

```text
--sandbox read-only|workspace-write|danger-full-access
--sandbox-enforcement full|partial
```

The UI must not label `workspace-write` as “safe” or “isolated.” Show backend and enforcement next to the mode. Selecting `danger-full-access` requires an attended confirmation which explains that commands can modify files outside the project. Do not force a second confirmation on every call; existing approval mode still governs calls.

## Durable events and projections

Extend `kernel/src/session/events.ts` and projection types. `run.created` adds:

```ts
executionWorld: {
  id: string;
  provider: 'local';
  workspaceId: string;
  processRoot: string;
};
sandbox: {
  requestedMode: SandboxMode;
  effectiveMode: SandboxMode;
  backend: SandboxBackend;
  enforcement: SandboxEnforcement;
  minimumEnforcement: 'full' | 'partial';
  network: 'ambient';
};
```

It is acceptable for local runs to record the process root because Flyt already records the workspace path. Never put env values, capability SIDs, private temp paths, runner profiles, or tokens there.

Add these session events:

```ts
'sandbox.decision': {
  callId: string;
  tool: string;
  standingMode: SandboxMode;
  requestedMode?: SandboxMode;
  effectiveMode: SandboxMode;
  backend: SandboxBackend;
  enforcement: SandboxEnforcement;
  escalated: boolean;
};

'sandbox.escalation': {
  callId: string;
  tool: string;
  from: SandboxMode;
  to: SandboxMode;
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'invalid';
  justification: string; // bounded and redacted like other user-visible text
};

'sandbox.failure': {
  callId: string;
  tool: string;
  code: 'SANDBOX_UNAVAILABLE' | 'SANDBOX_DENIED' | 'SANDBOX_RUNNER_FAILED';
  mode: SandboxMode;
  backend?: SandboxBackend;
  remedy?: string;
};
```

Append the decision after approval settles and before spawn/mutation. Append failure before the tool result. A crash after a decision but before a result is reconstructed through the existing never-returned tool behavior; do not re-execute it on resume.

Update `kernel/src/session/projection.ts`, `core/runProjection.js`, Work, Trace, and stored-run metadata so the standing mode/backend/enforcement are visible. Projection deletion/rebuild must reproduce them from the session.

Resume rules:

- Recreate the recorded provider and standing mode.
- Re-probe the backend; do not trust the old machine fact.
- Require enforcement at least as strong as `minimumEnforcement`.
- A backend change is permitted when it enforces the same mode and minimum; append a diagnostic/run reconfiguration event before continuing.
- A standing mode change is a `run.reconfigured` action requiring the same attended authority as a new launch. Loop cannot widen it.
- Unconsumed one-call escalations do not survive process death.

## Host and lifecycle integration

`core/kernelHost.js` currently installs `run-projection`, `workspace-fs`, and LLM adapters. Replace the standalone fs install with the atomic local-world install. Probe confined modes before the host enters the reusable pool.

The host-pool key in `RunController` must include:

- canonical workspace identity;
- provider kind;
- standing sandbox mode;
- minimum enforcement;
- attended-escalation capability;
- forwarded-env name hash;
- existing profile, model/routing, approval, skills, and tool-context facts.

Do not key on backend identity alone: two `workspace-write` worlds rooted at different worktrees are not interchangeable. Do not key on secret env values.

When a run stops or settles:

1. stop accepting new tool dispatch for that run;
2. call `ctx.subprocess.terminateOwner(runId)` and `ctx.sandbox.disposeOwner(runId)`;
3. await process-tree exit and temp cleanup with the existing bounded shutdown policy;
4. append/report cleanup failure separately from the run's semantic outcome;
5. release the run/attempt lease;
6. leave shared provider services alive only if the host is still owned by another run.

On app shutdown, dispose consumers before the execution-world owner, then await owner disposal. Cleanup failure never changes a successfully landed task to failed, but it is an actionable diagnostic and must not disappear.

## Diagnostics and operator experience

Extend `flyt doctor` and the settings diagnostics with an execution-world section:

```text
Execution world: local
Workspace: <path>
Sandbox mode: workspace-write
Backend: bubblewrap
Enforcement: full
Network: ambient (not sandboxed)
Probe: passed at <time>
```

Failure output must name the remedy. Examples:

- Linux: install Bubblewrap or enable the required user-namespace support.
- macOS: `sandbox-exec` is unavailable or rejected the generated profile.
- Windows: restricted-token/ACL setup failed, the app is elevated, or the workspace filesystem cannot express the policy.
- Enforcement mismatch: the backend is `partial` but the run requires `full`.

Expose a refresh action which discards the failed in-process probe and retries. Never offer “continue unconfined” as an automatic button. An attended user may explicitly change the run/new-run mode to `danger-full-access`, which is a separate recorded decision.

## Migration plan

Each phase ends green and removes the bypass it supersedes. A pass-through implementation is useful for plumbing but must not be described or shipped as a completed sandbox.

### Phase 0: inventory and architecture guards

- Add an architecture test which enumerates application `node:child_process` imports.
- Classify each import as execution plane, reviewed control plane, or dev/test only.
- Add the explicit control-plane allowlist and fail on new imports.
- Add failing tests proving current `bash` can write outside the workspace and descendants survive direct-child assumptions. Keep them platform-neutral where possible.
- Record the prerequisite single-kernel production path.

Exit: every current spawn site is owned in the migration map.

### Phase 1: types and managed local subprocess

- Add `ctx.subprocess`, its provider, output bounds, environment scrub, tree ownership, and teardown.
- Add the descriptor identity shared by providers.
- Test argv preservation, executable lookup, env scrub, timeout, abort, tree kill, concurrent owners, spill behavior, and disposal.
- Do not route model tools yet.

Exit: the subprocess provider is production-quality even though sandbox confinement is not yet enabled.

### Phase 2: shared policy and filesystem fence

- Replace the old sandbox realm contract.
- Add the per-call sandbox policy resolver.
- Wrap `FsSeam` mutations with the standing mode and canonical root.
- Route all model-facing file tools through `ctx.fs`.
- Add stable errors and session decisions for fs calls.

Exit: `read-only` and `workspace-write` are consistently enforced for file tools; no file mutation bypass remains.

### Phase 3: shell, Python, and gate consumers

- Implement the screened shell provider over managed subprocess.
- Route `bash`, model-side Python, and project gates.
- Preserve existing result/artifact contracts.
- Add sandbox metadata to results and events.
- Leave only reviewed control-plane direct spawns.

Exit: every execution-plane process crosses `ctx.subprocess`, but confined modes must still be gated off until a real backend is ready.

### Phase 4: platform confinement backends

- Implement Bubblewrap, Seatbelt, and Windows restricted-token/ACL backends.
- Add functional probes, runner failure classification, private temp, and enforcement facts.
- Wire provider selection by platform with no unconfined fallback.
- Add packaging/signing/unpack rules for any native component.

Exit: every supported release platform has a real, functionally tested backend or the app explicitly refuses confined execution on that platform.

### Phase 5: escalation, UI, resume, and lifecycle

- Add exact one-call escalation to shell and mutation tools.
- Record run/world and per-call events.
- Update Work, Trace, settings, CLI, doctor, resume, host keys, and teardown.
- Ensure Loop cannot widen.

Exit: policy is usable and inspectable, not only enforced invisibly.

### Phase 6: remove old claims and compatibility code

- Delete direct execution helpers superseded by seams.
- Remove the unused Realm vocabulary and stale worktree-as-sandbox comments.
- Update `GOALS.md`, `DESIGN-SPEC.md`, safety docs, plugin metadata, and architecture tests.
- Keep the direct-spawn allowlist minimal and explained.

Exit: source, docs, diagnostics, and product behavior make the same narrow claim.

## File-level work map

The implementing agent should expect at least these changes.

| Area | Required work |
|---|---|
| `kernel/src/seams/sandbox.ts` | replace unused Realm factory with per-call confinement contract |
| `kernel/src/seams/subprocess.ts` | new managed subprocess contract |
| `kernel/src/seams/fs.ts` | attach world identity; expose policy-aware mutations without losing transactional/text behavior |
| `kernel/src/seams/shell.ts` | attach world/owner/policy/result facts |
| `kernel/src/seams/index.ts` | register/export subprocess and updated seams |
| `kernel/src/plugins/execution-world-local.ts` | atomic provider-family composition and descriptor check |
| `kernel/src/plugins/sandbox-policy.ts` | one standing/per-call policy resolver |
| `kernel/src/plugins/subprocess-local.ts` | process groups/jobs, env, output, teardown |
| `kernel/src/plugins/sandbox-local.ts` | backend selection, probe cache, fail-closed confine |
| `kernel/src/plugins/fs-sandbox.ts` | shared-policy mutation fence |
| `kernel/src/plugins/shell-screened.ts` | explicit shell argv, sandbox, subprocess, result classification |
| `kernel/src/sandbox/**` | platform backends and shared errors/env/output helpers |
| `kernel/src/profiles.ts` | built-in importer/metadata; host overlay integration |
| `kernel/src/plugins/classify.ts` | conservative classification for new subprocess reach |
| `kernel/src/session/events.ts` | world/sandbox event schemas |
| `kernel/src/session/projection.ts` | fold durable world/sandbox state |
| `core/kernelHost.js` | install one execution world; pass seams/owner into tool bodies |
| `core/runController.js` | world-aware host key, resume checks, owner teardown |
| `core/tools/bash.js` | delegate; remove direct spawn |
| `core/tools/fileHost.js` and file tools | delegate async I/O; remove mutation bypasses |
| `core/python.js` | model execution through subprocess; explicit setup exception |
| `core/gates.js` | world-backed project-code execution and infrastructure status |
| Work/Trace/settings/CLI/doctor | select and display mode/backend/enforcement |
| packaging config/scripts | include and verify native backend assets/dependencies |
| tests | unit, architecture, integration, platform E2E, packaging |

This is a minimum map, not permission to ignore another model-reachable spawn or write discovered by the Phase 0 inventory.

## Test plan

### Contract and unit tests

- mode ordering permits only strict widening;
- malformed escalation pairs never call the approver;
- Loop escalation is always denied;
- concurrent calls resolve independent policies without provider mutation;
- canonical workspace identity is stable across lexical aliases and symlinks;
- mixed provider descriptors fail composition;
- `read-only` rejects `write`, `patch`, and `remove` without touching bytes;
- `workspace-write` permits an internal mutation and rejects traversal/symlink escape;
- `danger-full-access` does not widen model-facing file tools past their `FsSeam.root`;
- secret environment names and case variants are scrubbed;
- forwarded names are explicit and values never enter metadata;
- subprocess output, spill, timeout, abort, spawn failure, and non-zero exit are distinct;
- termination and disposal are idempotent and await descendants;
- runner failure cannot be classified from exit code alone.

### Integration tests through real entry paths

Start runs through the same `RunController` path used by Desktop, CLI, and Loop.

For each profile, assert:

- `run.created` contains the resolved world and sandbox facts;
- file tool writes and `bash` see the same workspace content;
- `bash` cannot write an external sentinel in a confined mode;
- a child and grandchild cannot write the sentinel either;
- Python cannot write it;
- a project gate cannot write it;
- `workspace-write` can create project artifacts;
- `read-only` cannot modify the project;
- an attended exact escalation applies to one call and the following call returns to standing mode;
- an unapproved or unattended retry does not start a process;
- stop kills a long-running descendant and releases ownership;
- resume refuses a missing/weaker backend and accepts an equivalent or stronger backend;
- Work and Trace rebuild identical sandbox state from `session.jsonl`.

### Platform E2E tests

Run non-mocked tests on release CI for each platform.

Linux:

- Bubblewrap functional probe passes;
- outside write denied, workspace write allowed;
- symlink target outside the workspace is not writable;
- descendant process remains confined;
- parent death/stop tears down the tree.

macOS:

- generated Seatbelt profile handles spaces, quotes, Unicode, and symlinks;
- outside write denied, workspace/private-temp behavior matches modes;
- runner-profile failure is classified as infrastructure.

Windows:

- restricted token denies external NTFS writes;
- workspace and private temp writes succeed only in `workspace-write`;
- read-only carries no workspace/temp write SID;
- two runs sharing a workspace cannot use one another's private temp capability;
- descendants remain in the Job Object and die on stop;
- elevated tokens and unsupported filesystems fail closed;
- enforcement is recorded as `partial`;
- packaged Electron can load the FFI/native dependency and runner.

Platform tests may skip on an ordinary developer machine only with a visible reason. A release job for that platform may not skip its sandbox E2E suite.

### Architecture tests

- no execution-plane module imports `node:child_process`;
- every direct-spawn control-plane exception is in the reviewed allowlist;
- `core/tools/bash.js`, model-side Python, and gates call the seams;
- all run profiles install a coherent execution-world family;
- `flyt-loop-worker` remains no broader than Desktop and cannot escalate;
- `SEAM_NAMES` and conservative classification cover `subprocess`;
- no missing backend path selects `danger-full-access`;
- no raw environment or secret value is serialized into sessions/logs;
- packaged-app verification checks required native resources.

## Acceptance criteria

The feature is complete when all of the following are true:

1. A Desktop, CLI, and Loop run can execute `bash` and file tools in `workspace-write` through the single kernel path.
2. On every supported release OS, the real backend denies an attempted external write by the command and its descendant.
3. The same run can write inside its workspace, and file tools/commands immediately observe each other's changes.
4. `read-only` denies both file-tool and process writes.
5. Missing/broken confinement returns `SANDBOX_UNAVAILABLE` or `SANDBOX_RUNNER_FAILED` without starting the original command unconfined.
6. `danger-full-access` is never inferred, is visibly recorded, and still goes through managed subprocess lifetime/output/env handling.
7. One-call escalation is strict, attended, logged, consumed once, and unavailable to Loop.
8. Stop, timeout, settlement, and app shutdown leave no observable descendant owned by the run.
9. Credential-shaped host environment values do not reach a project command unless explicitly forwarded, and never appear in durable metadata.
10. Resume reproduces or refuses the recorded authority; it does not downgrade.
11. Work, Trace, CLI, and doctor show requested mode, effective mode, backend, enforcement, and ambient-network limitation.
12. Architecture tests prove no model-reachable filesystem mutation or process-spawn bypass remains.
13. `npm run build:kernel`, `npm test`, and `npm run build` pass.
14. The platform sandbox E2E and packaged-app smoke tests pass in the Linux, macOS, and Windows release jobs without skip.

## Required documentation changes

When implementation lands:

- Update `GOALS.md` from “production-grade process sandboxing is not claimed” to the exact local file-effect confinement claim and its limits.
- Update `DESIGN-SPEC.md` safety and known-gaps sections with the execution-world provider, modes, backend/enforcement reporting, environment scrub, and direct-spawn control-plane boundary.
- Add a safety notice if the repo has none. Do not call the sandbox a security boundary without also naming platform and `partial` limitations.
- Document Bubblewrap installation, Seatbelt availability, Windows partial enforcement, elevated-process refusal, and `flyt doctor` remedies.
- Document that network is ambient in every mode.
- Credit substantial MIT-licensed source adapted from DeepSeek Harness in the distribution notices, including the source repository and commit. Architectural similarity alone does not require copied-source attribution; copied or closely ported implementation does.

## Explicit non-goals

Do not expand this change into:

- an E2B, Docker, SSH, VM, WSL, or cloud provider;
- workspace upload/download or host/remote synchronization;
- network firewalling or URL allowlists;
- interactive terminal UI or LSP hosting;
- arbitrary external-directory file tools;
- a general secrets manager;
- replacing static ceilings, resource permissions, approvals, worktrees, gates, review, or canaries;
- sandboxing LLM HTTP requests or moving the kernel/session log out of Electron;
- guaranteeing full Windows isolation;
- rewriting the stack language or block scheduler.

The seams must make a future isolated provider possible: it will supply `ctx.fs`, `ctx.subprocess`, and `ctx.shell` from one shared remote/container owner and report a coherent descriptor. It must not register as the local `ctx.sandbox` backend while leaving `ctx.fs` on the host.

## Completion checklist

- [ ] Single-kernel prerequisite is true.
- [ ] Phase 0 spawn/write inventory exists and is enforced.
- [ ] Old Realm sandbox contract is removed.
- [ ] Managed subprocess seam/provider is installed.
- [ ] Shared sandbox policy resolves every fs/process call.
- [ ] File tools have no direct mutation bypass.
- [ ] Bash, model-side Python, and gates have no direct spawn bypass.
- [ ] Linux, macOS, and Windows backends functionally probe and fail closed.
- [ ] Backend enforcement is recorded honestly.
- [ ] Run metadata, events, projections, Work, and Trace agree.
- [ ] Host reuse and teardown include world authority and process ownership.
- [ ] Attended one-call escalation is strict and Loop cannot escalate.
- [ ] Environment inheritance is scrubbed and explicit.
- [ ] Doctor and settings show backend, enforcement, and network limitation.
- [ ] Native/package assets are verified in packaged Electron.
- [ ] Unit, integration, architecture, platform E2E, and build checks pass.
- [ ] Safety/design/goals documentation makes only the proven claim.
