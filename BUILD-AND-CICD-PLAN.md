# LLM Flow — Build Plan & CI/CD Pipeline

**Date:** 2026-07-23
**Current state (verified):** Electron 33 + React 18 + Vite 6 app ("AI-first orchestration MVP"). Working core: file-based state, node library, canvas (@xyflow/react), flow DSL (`core/flowlang/cli.js`), one execution engine with mock/real model adapters. Tests: `node --test`. **No packaging tooling (electron-builder/forge), no GitHub repo/CI yet.** Most of the product vision (coding-agent toolbox, workspace binding, streaming UI, model routing, subscription/auth per `SUBSCRIPTION-AUTH-GUIDE.md`) is specified but not built.

---

## Part 1 — Build plan

### Phase 0 — Foundations (before features)
1. **Decide the repo/hosting** (GitHub assumed below). Push current history; add `main` branch protection later.
2. **Add packaging toolchain:** `electron-builder` (recommended; electron-forge is the alternative). Configure appId, icons, artifact names per OS.
3. **Versioning policy:** semver via `package.json`; releases tagged `vX.Y.Z`; CHANGELOG kept (auto-generated from conventional commits if adopted).
4. **Code quality gates:** add ESLint + Prettier (repo currently has neither), keep `node --test` as the test runner, add coverage later.

### Phase 1 — Ship a real desktop build ("v0.1 installable")
- electron-builder config producing:
  - Windows: NSIS installer (+ portable zip optional)
  - macOS: DMG (+ zip for auto-update)
  - Linux: AppImage (+ deb)
- Smoke-test script that launches the packaged app headlessly-ish (electron `--version` check + main-process boot test).
- Decide **code signing** (see open questions). Unsigned builds work but trigger SmartScreen/Gatekeeper warnings.

### Phase 2 — Product features, in priority order from PRODUCT-SPEC.md
The spec defines the line between built and planned (`DESIGN-SPEC.md`). Suggested order:
1. **Run Mode / streaming UI** (`RUN-MODE.md`, `OUTPUT-VIEW-PLAN.md`) — the core "watch it work" experience; highest product value.
2. **Workspace binding** — point flows at a real project directory.
3. **Coding-agent toolbox** — the tool-using `agentTask` nodes beyond Test-creation.
4. **Model routing + real adapters hardening** — move off mock adapters; cost/timeout/retry policy.
5. **Model-comparison / ranking** — the thesis-validation feature (§7).
6. **Subscription/auth** (`SUBSCRIPTION-AUTH-GUIDE.md`) — only when the above is demo-able; gating too early slows iteration.

### Phase 3 — Release readiness
- Auto-update via `electron-updater` (GitHub Releases as the feed, or a private update server).
- Crash reporting (Sentry or similar) — opt-in.
- Beta channel (`latest.yml`/`beta` prereleases) before stable.

---

## Part 2 — CI/CD pipeline (GitHub Actions, `.github/workflows/`)

### Workflow A — CI (on every PR + push to main)
```
jobs:
  test (matrix: windows-latest, macos-latest, ubuntu-latest):
    - checkout, setup node 22, npm ci
    - lint (once added)
    - npm test
    - npm run build   (vite build must stay green)
```

### Workflow B — Release (on tag `v*`, or manual dispatch)
```
jobs:
  build (matrix: windows-latest, macos-latest, ubuntu-latest):
    - npm ci
    - npm test (gate)
    - electron-builder --publish never
    - upload artifacts (NSIS/DMG/AppImage + latest*.yml)
  release:
    - create/update GitHub Release from tag, attach artifacts
    - mark prerelease for beta tags (vX.Y.Z-beta.N)
```
- Secrets needed: `GH_TOKEN` (built-in `GITHUB_TOKEN` suffices for releases), plus `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows cert) and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`CSC_LINK` (macOS signing/notarization) once signing is adopted.

### Workflow C — Auto-update channel
- `electron-updater` reads `latest.yml` / `latest-mac.yml` / `latest-linux.yml` from GitHub Releases.
- Beta builds publish with `prerelease: true`; app checks the channel matching its version.

### Workflow D (optional, later)
- Nightly/scheduled E2E run of packaged app smoke test.
- Dependency updates via Dependabot.

---

## Open questions (answers change the plan)
1. Repo hosting: GitHub? Public or private?
2. Target platforms for v0.1: all three OSes, or Windows-only first (your dev machine is Windows)?
3. Code signing: do you have (or plan to buy) certificates? Unsigned is fine for private beta.
4. Distribution: direct download from GitHub Releases, or a store/website later?
5. Backend: does subscription/auth imply a hosted server component? That needs its own pipeline (separate from the desktop app).
