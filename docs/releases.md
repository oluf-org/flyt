# Flyt release service and operating guide

This document describes the implemented Cloudflare delivery service and its GitHub Actions workflows. The website is a separate project; its integration contract is [release-api.md](release-api.md). No website build is needed to deploy this service.

## Resources and ownership

| Environment | Worker | Private R2 bucket | Public HTTPS origin |
|---|---|---|---|
| Production | `flyt-updates` | `production` | `https://updates.flyt.pro` |
| Staging | `flyt-updates-staging` | `staging` | `https://updates-staging.flyt.pro` |

Cloudflare account: `6143fe81aa04b0ef7babd956d371bc5c`. Zone: `flyt.pro`. Both buckets have default jurisdiction, Standard storage, and public r2.dev access disabled. Workers access them through the `RELEASES` binding. Workers have no upload HTTP endpoint and need no S3 secret. The app/website only use public HTTPS endpoints.

`services/updates/wrangler.jsonc` is the configuration source of truth. CI deploys staging first, checks its health/catalogs, then deploys production. These workers own only the two update subdomains; the separate website project owns the apex/website deployment. Do not attach the website to the update Worker or enable bucket public access.

Staging is an infrastructure test environment, not the beta channel. Production contains both stable and beta channels. Staging uses a separate bucket and has an independent catalog. It starts empty; production credentials do not need access to it to deploy a bound Worker. Uploading staging fixtures requires separately scoped staging S3 credentials.

## Current delivery policy

| Platform | Candidate downloads | Candidate automatic updates | Stable promotion |
|---|---|---|---|
| Windows x64 NSIS | Unsigned EXE | Supported by feed; signing not configured | Blocked pending signing or Store distribution integration |
| macOS Intel + ARM | Unsigned DMG and ZIP | Blocked with `409 signing_required` | Blocked pending signing and notarization |
| Linux x64 | AppImage | Supported | Allowed after candidate validation |

The Microsoft Store MSIX pipeline is not implemented here. Store-managed updates require a separate distribution path. Do not treat an R2 EXE as Store-signed. Signing readiness is deliberately enforced in code, not an editable workflow input that can bypass verification. A later signing integration must verify final artifacts and extend `stableEligible`/`updateEligible` with evidence appropriate to that platform.

The hidden Settings beta switch is a separate client task. New packages currently embed the stable generic feed. The beta HTTP feed is available for the forthcoming switch and installed-updater testing; enabling a backend channel alone does not enroll an app. Beta endpoints are unlisted, not authenticated: anyone who knows them can download candidates. There are no embedded tokens or shared passwords.

## Release identity and storage

Versions are ordinary three-component versions, e.g. `2.1.23`. Prerelease suffixes and `v` prefixes are not accepted in stored versions. Git tags use `v2.1.23` and must match `package.json`.

Beta/stable are distribution channels, not different application versions. Build once, test beta, promote the exact bytes. If a candidate changes, increment the version. Never replace a released version's files. It is valid for stable to skip candidate version numbers.

All application data is below the bucket prefix `flyt/`:

```text
flyt/releases/2.1.23/windows/release.json
flyt/releases/2.1.23/windows/Flyt-2.1.23-win-x64.exe
flyt/releases/2.1.23/windows/Flyt-2.1.23-win-x64.exe.blockmap
flyt/releases/2.1.23/mac/release.json
flyt/releases/2.1.23/mac/Flyt-2.1.23-mac-{x64,arm64}.{dmg,zip}
flyt/releases/2.1.23/linux/release.json
flyt/releases/2.1.23/linux/Flyt-2.1.23-linux-x64.AppImage
flyt/channels.json
flyt/history/<revision-uuid>.json
```

`release.json` contains `schemaVersion`, version, platform, source commit SHA, GitHub run ID, creation time, release notes, signing state, asset names/sizes/SHA-512 hashes, and the parsed electron-builder manifest. Both mac architectures must appear in the manifest. Manifests refer only to verified files in that release. Hashes describe final installer bytes.

Artifact uploads use `If-None-Match: *`, then re-download and hash-check the stored object. A conflicting object never gets clobbered. A record is written only after every asset for that platform is verified. Activation verifies all platform records/assets again and requires the same originating commit and workflow run. Partial uploads remain private and have no effect on either channel.

`channels.json` is the single publication point. Each channel/platform selection stores `current` and a list of accessible `versions`. Ordinary promotion retains older versions for in-progress and differential downloads. The Worker never exposes arbitrary bucket objects, release records, or history. It exposes only assets in a channel's accessible version list and the matching release record.

Channel writes use an ETag precondition (`If-Match`, or `If-None-Match` for initial state). A concurrent update fails rather than overwriting another action. GitHub jobs also share the `flyt-r2-channel-state` concurrency group. Before attempting the state write, the script stores an immutable history record with previous and proposed state. A failed compare-and-swap can leave an unapplied history record: check the current revision and subsequent history; the existence of a history object alone does not prove publication.

## GitHub credentials and variables

Repository: `oluf-org/flyt`.

| Name | Kind | Required value/scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Actions secret | Worker deployment permissions for this Cloudflare account/zone |
| `R2_ACCESS_KEY_ID` | Actions secret | R2 Object Read & Write access key scoped to `production` |
| `R2_SECRET_ACCESS_KEY` | Actions secret | Its paired secret |
| `CLOUDFLARE_ACCOUNT_ID` | Actions variable | `6143fe81aa04b0ef7babd956d371bc5c` |
| `R2_BUCKET_NAME` | Actions variable | `production` |
| `R2_ENDPOINT` | Actions variable | `https://6143fe81aa04b0ef7babd956d371bc5c.r2.cloudflarestorage.com` |

The region for the S3 SDK is `auto`. The endpoint is the private S3 API, not a browser-download URL. Only CI/release operators need these credentials. Never put them in a website repository, renderer bundle, public manifest, log, or documentation example.

The Cloudflare plugin's OAuth session is separate from GitHub Actions authentication. Deployment runs `release.mjs check` to verify S3 reads/writes and both conditional creation and replacement using a temporary `flyt/checks/<uuid>.json` object, then deletes that probe. It never changes a release/channel. Successful API/plugin deployment does not validate the GitHub secret values. Initial DNS/bucket provisioning and Worker deployment are separate operations from publishing an app release.

For staging publishing, use another R2 token scoped only to `staging` and the same variable/secret names in a local environment or separately configured GitHub environment. The included release workflows target production; they do not silently fall back from staging credentials to production credentials.

To rotate: create a replacement with equivalent scope, update the Actions secret, dispatch the Update service workflow and verify the authentication step, then revoke the old credential. Signing/Store credentials are intentionally absent until those systems are implemented.

## Workflows

### Update service (`.github/workflows/updates.yml`)

1. On relevant PRs: install the locked service dependencies, generate bindings, type-check, run release/Worker tests, and perform a deployment dry run. PRs receive no deployment secrets.
2. On relevant pushes to main or manual dispatch on main: run the same checks, then independently verify production S3 credentials and deploy the read-only service. Deployment proceeds staging → staging smoke test → production → production smoke test. The overall workflow fails if either credentials or deployment fails; successful Worker deployment alone does not establish release-upload readiness.
3. Deployment does not publish any app release or modify channel state.

### Release candidate (`.github/workflows/release.yml`)

1. Merge reviewed app changes and the version bump (package and lockfile) to main. Create/push the matching `vX.Y.Z` tag. Tagged commits must be ancestors of main.
2. Existing Windows/macOS/Linux CI runners test, build and package the application. Windows sandbox checks remain in place.
3. Each platform installs the locked uploader dependencies and uploads its immutable artifacts to R2. The three runners do not share mutable manifests.
4. Only after all jobs succeed does the final job verify and activate the candidate for every beta platform.
5. GitHub Releases are no longer created or published by this workflow. There is no automatic stable promotion.

A manual run on an untagged branch still produces short-lived Actions artifacts without uploading or changing channels. A manual tagged run follows the candidate path. Use a new tag containing the updated workflows: dispatching an old tag can execute its old workflow definition.

`npm run release` creates local installers only. Publication now goes through the tagged GitHub workflow (or the explicit uploader CLI below); electron-builder's generic provider does not upload to R2.

If a job fails, rerun the original workflow's failed jobs. Identical records from that run can be reused. If rebuilt bytes differ, or a completely new workflow run tries to reuse the version, publishing fails: increment the version instead. Do not delete a published release to make a rerun work.

CLI equivalent for a trusted CI job, from the repository root:

```sh
node services/updates/scripts/release.mjs upload --directory release \
  --version 2.1.23 --platform linux --commit <40-character-commit-sha> --run-id <github-run-id>
node services/updates/scripts/release.mjs activate --version 2.1.23 \
  --commit <40-character-commit-sha> --run-id <github-run-id>
```

`--notes-file <file>` optionally supplies Markdown notes at upload time. The current workflow defaults to `Flyt <version>`; pass curated notes when release editorial work is added. Do not render notes as unsanitized HTML.

### Promote or withdraw (`.github/workflows/release-channel.yml`)

Run on main. Inputs:

- `action`: `promote` or `withdraw`.
- `version`: an existing version without `v`.
- `platforms`: comma-separated `windows,mac,linux`; default `linux`.
- `channel`: used for withdrawal; promotion always targets stable.

Promotion accepts only the current beta version for each selected platform. It rechecks bytes and platform eligibility before updating stable. It never builds or signs again. Selecting Windows/macOS currently fails with the explicit signing/Store requirement; this is not a failed R2 integration.

Withdrawal selects a previously published version on the same channel. It removes the old current version from that channel's accessible list and selects the requested older version. It does not delete binaries or automatically downgrade installed applications. Repair already-updated clients with a higher-version corrective release. If this is a channel's first release and there is no prior target, an operator can use a conditional state update to clear `current` and `versions`; no unsafe automatic rollback target is invented.

## HTTP and cache operation

Manifests and catalogs are always `Cache-Control: no-store`. Artifact responses also use `no-store` in this first implementation so withdrawing a release immediately removes future HTTP access. This intentionally favors straightforward withdrawal semantics over CDN caching; downloads still stream from R2 without buffering the installer in Worker memory. Do not introduce a broad Cloudflare Cache Everything rule for these hosts.

Single byte-range requests, suffix/open-ended ranges, HEAD, ETag/If-None-Match, and ETag If-Range are supported. Multi-range requests return 416; the generic electron-builder provider sets `useMultipleRangeRequest: false`. Previous version files are retained for blockmap lookups. If the updater cannot find an old GitHub-era blockmap, it must fall back to a full download.

Worker error responses never disclose bucket credentials or internal object paths. Structured logs identify service failures. Health checks touch the bucket binding; a missing initial channel file is valid and produces an empty catalog. A corrupt channel file or missing published object yields 503 instead of advertising a misleading successful response.

## Validation and operational limits

From `services/updates`:

```sh
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --dry-run --env staging
node scripts/smoke.mjs https://updates-staging.flyt.pro
node scripts/smoke.mjs https://updates.flyt.pro
```

Tests use the actual Workers runtime and local R2 via Miniflare, plus publisher state-machine tests. They cover empty catalogs, release isolation, publication failure, immutable records, hash mismatch, missing mac architectures, concurrent state changes, signing gates, withdrawal, HTTP methods, byte ranges and conditional requests.

An end-to-end installed application update on every OS remains a release acceptance check. Worker unit/runtime tests cannot verify OS signature trust, installer restart behavior, Store certification, or user-data migration. Do not label these as completed solely because the HTTP smoke tests pass.

Uploads currently use single-object S3 PUT, with a 4 GiB per-file ceiling. Metadata is capped at 1 MiB; a channel history approaching that size needs an explicit archival policy. No automated retention deletion is installed. Preserve any file referenced by a current selection or needed by supported old-client update paths. Incomplete uploads can be inspected and removed deliberately after confirming they were never published.

## Existing installs and future work

New builds embed `https://updates.flyt.pro/stable/` as the generic feed. Existing installations still point to GitHub. Migrating them requires a deliberate GitHub bridge release or a manual reinstall; the new R2 workflow does not migrate old clients by itself. Unsigned macOS installations may require manual replacement once signed builds are available.

Next client work: hidden beta enrollment, persisted channel selection, canceling pending updates on channel switches, manual/periodic checks, and safe installation around active runs. Next distribution work: Windows MSIX feasibility and Store submission, then verified macOS signing/notarization. These require extending the current policy and acceptance tests, not weakening the guards.

Sources: [Cloudflare R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/), [Worker CI](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Electron auto-update](https://www.electron.build/v26/docs/features/auto-update/).
