# Safety and the local execution world

Flyt layers tool classification, block ceilings, resource permission,
attended approval, and a per-run execution world. None replaces the others.

New runs default to `workspace-write`. File tools are fenced to the canonical
workspace, and commands are admitted only when the platform backend passes a
functional write-denial probe. `read-only` denies workspace mutations too.
When a confined backend is missing, broken, weaker than the requested minimum,
or rejects its generated policy, Flyt returns `SANDBOX_UNAVAILABLE` or
`SANDBOX_RUNNER_FAILED`; it does not silently launch the original command.

Linux uses Bubblewrap and macOS uses Seatbelt (`sandbox-exec`). Windows uses a
packaged write-restricted-token, ACL capability, and kill-on-close Job Object
runner and reports `partial` enforcement. Flyt refuses confined execution when
elevated or when the target filesystem cannot express the required ACLs.

The Windows runner includes a private-pipe compatibility adapter so Node/libuv
can launch piped children under the same restricted token. New pipes without
an explicit descriptor use the token's default DACL and a per-invocation IPC
capability with no filesystem grants. Both x64 and x86 descendants retain the
existing write restrictions. Adapter initialization failure blocks launch.
Linux uses a private PID namespace so cancelling the sandbox tears down its
descendants even when they start a separate session.

This is file-effect confinement, not a general machine-security boundary.
Networking is ambient in every mode. The sandbox does not promise read secrecy,
network isolation, IPC/process isolation, syscall or kernel isolation, defense
from a compromised Electron main process, or full Windows isolation. Worktree
isolation remains useful for review and rollback but is not process confinement.

`danger-full-access` is explicit and unconfined. Commands still use managed
argv, scrubbed environment, bounded output, timeouts, descendant ownership, and
teardown. Keep backups and prefer disposable development environments for
valuable or sensitive work.

For non-interactive hosts, `FLYT_SANDBOX_MODE` is the explicit launch equivalent
of the CLI flag. The repository test scripts set it to `danger-full-access`
because compatibility tests exercise orchestration independently of the
machine's installed sandbox backend.

## Operator remedies

- Linux: install Bubblewrap and enable the user-namespace support it requires.
- macOS: ensure `/usr/bin/sandbox-exec` is present and accepts the generated Seatbelt profile.
- Windows: do not run Flyt elevated; use NTFS; reinstall if the sandbox runner or either `flyt-sandbox-pipes` DLL is missing.
- Run `flyt doctor --refresh` to repeat the functional probe after fixing the host.

Forwarded environment names are an explicit settings allow-list. Credential-
shaped names and all `FLYT_*` facts are otherwise removed, and values never
enter session metadata, diagnostics, or host-pool keys.
