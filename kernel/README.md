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

Nothing in the shipping app imports this while the v2 flag is off.

- `src/index.ts` — `createKernel()`, the root context and its lifecycle.
- `src/events.ts` — the event names and their payloads.
- `src/seams/` — the eight capability seams.

Build: `npm run build:kernel` (runs before `npm test` and before `npm run build`).
