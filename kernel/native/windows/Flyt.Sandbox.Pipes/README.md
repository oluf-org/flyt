# Windows private-pipe compatibility

The runner assigns a random IPC SID to each confined invocation and includes it in the restricted token and its default DACL. This SID has no filesystem grants. The workspace and private-temp capabilities remain separate; the ordinary user's SID is never added to the restricting SID list.

Win32's default named-pipe descriptor ignores the token default DACL, preventing libuv from opening its own piped-stdio handles under a write-restricted token. This adapter supplies the token default DACL only for newly created named pipes whose caller supplied no explicit security descriptor. Explicit descriptors and existing pipe permissions are preserved. It propagates to descendants through Microsoft Detours; both x64 and x86 adapters are packaged. The launcher injects the adapter while the restricted child is suspended and owned by its kill-on-close Job Object. Initialization failure prevents that child from running.

The adapter is not a security boundary. It does not replace the token, alter filesystem permissions, grant ambient pipe access, or run a command outside confinement. A process that unloads or bypasses the adapter still has its restricted token. General IPC isolation is not claimed. Newly created default pipes retain ordinary user access and add the invocation-specific IPC capability, so different confined invocations do not gain each other's private pipe capability.

`npm run build:sandbox:win` requires Visual Studio C++ build tools with the v143 toolset and Windows SDK, plus .NET 8. Both architectures use a static C runtime. Package verification checks the runner and both DLLs.

`vendor/detours` contains the unmodified C++ sources and headers from Microsoft Detours commit `adb07604aa56508448b95bf037c2a6d0d3b6831a` (4.0.1), with the upstream MIT license in `LICENSE.txt`. Source: https://github.com/microsoft/Detours/tree/adb07604aa56508448b95bf037c2a6d0d3b6831a/src. The license is also included in the application's third-party notices.

Native tests run unchanged npm/Node commands and piped grandchildren in both file-effect modes, check outside-write denial, private temp capabilities, architecture transitions, and descendant termination. GitHub repeats these as a standard user before packaging.
