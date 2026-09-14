# Execution-plane process inventory

All model-requested commands, Python sidecars, and project gates enter through
`ctx.subprocess`. The architecture test fails when a new direct
`node:child_process` import appears outside this reviewed map.

| Import | Plane | Reason |
|---|---|---|
| `kernel/src/plugins/subprocess-local.ts` | execution provider | Sole managed local process implementation; owns argv, output, timeout, tree termination, and disposal. |
| `core/python.js` | control exception | The remaining direct spawn is `setupPython`, an explicit attended environment installation. Model-side Python uses `ctx.subprocess`. |
| `core/worktree.js` | control | Trusted argv-only git provisioning, cleanup, landing, and canary checkout. |
| `core/workflowSupport.js` | control | Pinned local Git comparison with fixed argv, scrubbed environment, no external diff/textconv, and bounded output. Workspace checks execute through registered tools, never this launcher. |
| `core/effect.js` | control | Trusted argv-only, read-only git inspection. |
| `core/repoChanges.js` | control | Fixed argv-only Git file listing and no-index line statistics; scrubbed environment, no external diff/textconv, no hooks or index writes. |
| `core/adapters/cliDelegate.js` | control | Model-provider transport in a neutral cwd; not a project command capability. |
| `core/homeSeed.js` | control | Trusted seed-repository inspection at setup. |
| `core/stackRunner.js` | historical | Retained migration reader/legacy tests; production architecture tests prove it is unreachable. |
| `scripts/**` | development | Packaging, smoke-test, and Electron development lifecycle only. |

`core/tools/bash.js` and `core/gates.js` intentionally do not appear: both are
execution-plane consumers of the world provider.
