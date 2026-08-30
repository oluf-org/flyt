# `kernel/` — the v2 spine

TypeScript, compiled to `dist/` with `.d.ts` beside it. The JS core and the
React renderer stay JavaScript and consume the generated types (D53).

**The boundary is the seam.** Anything a third-party plugin can touch is typed
and lives here: seam interfaces, the session event schema, event payloads,
plugin config. Anything only Flyt calls may stay JS in `core/`.

Import it as `#kernel` (a Node subpath import declared in the root
`package.json`), never by a relative path into `dist/`:

```js
import { createKernel } from '#kernel';
```

Install application plugins through logical composition rows (`kernel.install`
or `booted.install`) rather than calling `ctx.plugin()` from host code. The
managed path retains the Cordis fiber for catalog, configure, restart,
uninstall, rollback, and trust review. Plugin authors still use ordinary Cordis
modules and injected Flyt services. See [`docs/plugin-system.md`](../docs/plugin-system.md).

Nothing in the shipping app imports this while the v2 flag is off.

- `src/index.ts` — `createKernel()`, the root context and its lifecycle.
- `src/events.ts` — the event names and their payloads.
- `src/seams/` — the eight capability seams.
- `src/loader/host.ts` — the managed Cordis fiber/catalog boundary.

Build: `npm run build:kernel` (runs before `npm test` and before `npm run build`).
