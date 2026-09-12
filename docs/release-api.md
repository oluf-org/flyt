# Website integration: Flyt releases API v1

This is the contract for the separate `flyt.pro` website project. It uses public HTTPS only. Do not configure AWS/S3 libraries, R2 keys, or Cloudflare deployment tokens in the website to fetch releases.

## Origins and environments

- Production: `https://updates.flyt.pro`
- Infrastructure staging: `https://updates-staging.flyt.pro`
- Channels within either origin: `stable`, `beta`.

The public website should request `stable`. Do not enumerate or advertise beta on the public download page. Beta is unlisted, not access-controlled. Staging can contain disposable test fixtures and must never be used by production download buttons.

## Endpoints

| Method | Path | Meaning |
|---|---|---|
| GET/HEAD | `/healthz` | Worker and R2-binding health |
| GET/HEAD | `/v1/releases/stable` | Stable website catalog |
| GET/HEAD | `/v1/releases/beta` | Candidate website/tester catalog |
| GET/HEAD | `/{channel}/latest.yml` | Windows electron-updater manifest |
| GET/HEAD | `/{channel}/latest-mac.yml` | macOS manifest; currently blocked until signing |
| GET/HEAD | `/{channel}/latest-linux.yml` | Linux x64 manifest |
| GET/HEAD | `/{channel}/releases/{version}/{platform}/{filename}` | Immutable release file authorized for that channel |
| OPTIONS | Any path | CORS preflight |

The website should consume the JSON catalog and follow returned URLs. The YAML endpoints are for the desktop updater. They contain JSON syntax, which is valid YAML and accepted by electron-updater.

## Catalog response

Every successful catalog response has `schemaVersion: 1`, the requested `channel`, a `revision` string, and `platforms` in windows/mac/linux order. Platform versions can differ: never assume a single global latest version across Windows Store and direct distribution.

Before publication, HTTP 200 returns:

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "revision": "initial",
  "platforms": [
    {"platform": "windows", "available": false, "reason": "not_published"},
    {"platform": "mac", "available": false, "reason": "not_published"},
    {"platform": "linux", "available": false, "reason": "not_published"}
  ]
}
```

An available entry has this shape (example values, not an assertion of a live release):

```json
{
  "platform": "linux",
  "available": true,
  "version": "2.1.23",
  "releasedAt": "2026-09-12T12:00:00.000Z",
  "notes": "Flyt 2.1.23",
  "distribution": "direct",
  "signing": "not-applicable",
  "autoUpdateAvailable": true,
  "downloads": [
    {
      "name": "Flyt-2.1.23-linux-x64.AppImage",
      "size": 123456789,
      "sha512": "<base64-encoded SHA-512 of the file>",
      "url": "https://updates.flyt.pro/stable/releases/2.1.23/linux/Flyt-2.1.23-linux-x64.AppImage"
    }
  ]
}
```

`releasedAt` is the artifact record's creation time, not the latest promotion time. `revision` changes with publication operations and is opaque. `size` is bytes. `sha512` is base64, not hexadecimal. `notes` is text/Markdown; sanitize it before rendering as HTML. `signing` is currently `not-configured` for Windows/macOS and `not-applicable` for Linux. An available download does not imply an auto-update-compatible or signed build.

Only direct distribution is implemented. Future Store support will extend this contract explicitly. Do not invent a Store URL from package filenames or treat the current Windows EXE as Store-distributed.

## File and architecture selection

Files use `Flyt-{version}-{os}-{architecture}.{extension}`:

| Platform | Architecture | Primary installer | Other file |
|---|---|---|---|
| windows | x64 | `-win-x64.exe` | Blockmap is updater-only and omitted from website catalog |
| mac | x64 | `-mac-x64.dmg` | `-mac-x64.zip` is the updater payload |
| mac | arm64 | `-mac-arm64.dmg` | `-mac-arm64.zip` is the updater payload |
| linux | x64 | `-linux-x64.AppImage` | — |

For v1, select architecture/format by these filename suffixes. Offer an explicit Intel/Apple Silicon choice on macOS; browser architecture detection is unreliable. Do not select the first ZIP as the default Mac installer. Windows ARM and Linux ARM are not currently produced.

## Website example

```js
const origin = 'https://updates.flyt.pro';
const response = await fetch(`${origin}/v1/releases/stable`, {
  cache: 'no-store',
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error('Download information is temporarily unavailable');
const catalog = await response.json();
if (catalog.schemaVersion !== 1) throw new Error('Unsupported releases API');

const linux = catalog.platforms.find(p => p.platform === 'linux');
const installer = linux?.available
  ? linux.downloads.find(f => f.name.endsWith('-linux-x64.AppImage'))
  : undefined;

// Bind installer.url to a normal <a href> download button when present.
// Otherwise show "Not available yet"; never fabricate a URL or fall back to beta.
```

Use ordinary links for large installer downloads rather than fetching the entire binary into browser memory. The service returns `Content-Disposition: attachment`. Keep all platform choices available; OS detection can highlight a choice but must not hide alternatives.

A website can deploy independently of releases. Fetch at request/runtime, or use a short explicit revalidation interval if the website framework requires caching. Do not permanently bake a release version/URL into a static website build. A previously returned URL can stop working after withdrawal; refresh the catalog and show an understandable error.

## HTTP, errors and caching

- Successful catalogs: 200, including an empty catalog. `available: false` is a normal product state.
- Unknown path, file, version or channel: 404 with `{"error":{"code":"not_found"}}`.
- Empty platform updater feed: 404 `not_published`.
- Unsigned macOS updater feed: 409 `signing_required` (manual beta downloads remain available).
- Non-read HTTP methods: 405 `method_not_allowed` and an Allow header.
- Invalid/multiple/out-of-bounds byte ranges: 416 with `Content-Range: bytes */<size>`.
- Invalid channel metadata or missing/corrupt published record: 503 `service_unavailable`. Do not show this as "no releases".
- Conditional unchanged asset: 304; single byte-range asset: 206.

All current responses use `Cache-Control: no-store`, including binaries, so withdrawal does not leave publicly cached release copies. ETags still support explicit conditional requests. Downloads support a single `Range`, suffix and open-ended ranges, and ETag `If-Range`. Multi-range is not supported.

CORS allows any origin without credentials because this API is public. Allowed methods are GET, HEAD and OPTIONS. Allowed request headers are Range, If-None-Match and If-Range. Exposed response headers include Content-Length, Content-Range, ETag, Accept-Ranges and Content-Disposition. No cookies or Authorization header are required.

## Ownership and change policy

The application repository owns API versioning, release records, channel changes and update-service infrastructure. The website repository owns its rendering, domain/apex hosting and user-facing download choices. It must not write `channels.json`, upload installers, or possess release-publishing keys.

Additive fields may appear in v1; ignore unknown fields. A breaking schema or URL change requires a new versioned API plus a migration window. Existing electron-updater feed URLs must remain supported for installed clients. App updates and website updates are separate deployment events.

See [releases.md](releases.md) for workflows, signing gates, credential setup, retention and operational recovery.
