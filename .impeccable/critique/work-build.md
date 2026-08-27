# Impeccable critique — Work and Build

- **Payload:** provider-shaped Impeccable 4.1.1 at `.flyt/skills/impeccable/`
- **Command:** `node .flyt/skills/impeccable/scripts/detect.mjs detect --json src/v2`
- **Surfaces:** Work (`Work.jsx`, `workStyles.css`) and Build (`Shell.jsx`, `BlockEditor.jsx`, `Library.jsx`, their v2 styles)
- **Result:** one deterministic finding (exit 2)
- **Recorded:** 2026-08-24

## Finding

- `bounce-easing` in `src/v2/blockEditorStyles.css:150` (imported by `BlockEditor.jsx`): `animation: var(--spring` — “Bounce and elastic easing feel dated and tacky. Real objects decelerate smoothly — use exponential easing (ease-out-quart/quint/expo) instead.”

This is the detector's complete JSON result transcribed without treating its findings exit code as a failed invocation. The detector was run from the installed provider payload, not from a separately privileged package. Future changes can rerun the command and replace this record; findings should be retained here and promoted to backlog tasks.

The installed provider-shaped skill keeps its relative `reference/`, `scripts/`, and `agents/` resources intact. Flyt adds only `requiresTools: [impeccable_detect]`; that request is not a grant. The detector wrapper in `kernel/src/plugins/impeccable.ts` executes the payload's bundled `scripts/detect.mjs`, enters through the external plugin installer, is inferred as shell-capable, requires attended human confirmation, remains constrained by the block ceiling, and is refused before import on the Loop profile.
