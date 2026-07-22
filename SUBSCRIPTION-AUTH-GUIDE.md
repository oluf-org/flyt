# Using Claude & ChatGPT Subscriptions for Auth — Implementation Guide

*How T3 Code does it, what the providers actually require, and how to build it yourself from scratch.*

---

## The single most important finding

**T3 Code does not implement any OAuth flow of its own.** It never talks to `claude.ai/oauth`, `auth.openai.com`, or any token endpoint. Instead it treats each provider's official CLI as the authentication authority and simply *reuses the credentials those CLIs already stored on disk.*

Their own README states the prerequisite plainly: before using T3 Code you must install and authenticate each provider yourself —

- Codex → `codex login`
- Claude → `claude auth login` (Claude Code)
- OpenCode → `opencode auth login`

T3 Code then spawns/embeds those tools as subprocesses and lets them find their own tokens. This is the whole trick. It is also the only approach that is clearly within each provider's terms of service (more on that below). If you take one thing from this document: **delegate authentication to the vendor's own CLI/SDK, don't reimplement their OAuth.**

The rest of this guide explains (1) exactly how that delegation works so you can replicate it in `llm-flow`, and (2) as a reference, the underlying OAuth mechanics the CLIs themselves use, in case you decide to go direct — along with the compliance caveats that make that risky.

> This guide was written from reading T3 Code's public source and the providers' own docs. No T3 Code source was copied; the code samples here are original illustrations of standard, publicly documented OAuth patterns.

---

## Part 1 — How T3 Code actually works (the delegation model)

### Architecture in one paragraph

T3 Code is a monorepo with a Node WebSocket server (`apps/server`) that manages "provider" sessions and a React UI (`apps/web`). Each provider is a pluggable *adapter* behind a common interface (`ProviderAdapter`). The Claude adapter wraps Anthropic's `@anthropic-ai/claude-agent-sdk`; the Codex adapter wraps the Codex "app-server" (a JSON-RPC-over-stdio process shipped with the Codex CLI); the OpenCode adapter wraps `@opencode-ai/sdk`. In every case the adapter starts the vendor runtime as a child process and never handles a raw token.

### The Claude adapter: HOME-directory injection

The key mechanism for Claude is dead simple. The adapter builds an environment for the spawned SDK/CLI process and the only auth-relevant thing it sets is `HOME`:

- A helper resolves a configurable "Claude home" path (defaults to the OS home directory).
- If the user configured a custom home, the adapter overrides `HOME` (`process.env` otherwise passes through untouched).
- It then calls the Agent SDK's `query()` with that environment. **No API key, no OAuth token, no bearer header is ever passed by T3 Code.**

Why this works: Claude Code stores its subscription OAuth credentials under the home directory (`~/.claude/`, e.g. a `.credentials.json`, or the OS keychain on macOS). When the Agent SDK / `claude` binary boots with that `HOME`, it discovers those credentials on its own and authenticates as your Pro/Max subscription. By letting you point `HOME` at a specific directory, T3 Code even supports multiple Claude accounts (one credential dir each) — the same idea other community tools use when they read multiple keychain entries labeled by tier.

Practical takeaway for your own app:

```text
1. Ensure the user has run `claude auth login` (Claude Code) at least once.
2. Spawn the Claude Agent SDK / claude binary as a child process.
3. Pass through the environment, optionally overriding HOME to select
   which credential directory (which account) to use.
4. Do nothing else about auth. The SDK refreshes and uses the token itself.
```

### The Codex adapter: wrap the app-server, observe token refresh

For OpenAI, T3 Code embeds the **Codex app-server** — the same engine the Codex CLI runs — and speaks its JSON-RPC protocol over stdio. Authentication again belongs entirely to Codex: the app-server reads `~/.codex/auth.json` (or the OS keyring) that `codex login` created, and it refreshes the ChatGPT OAuth access token automatically before expiry.

T3 Code's role is purely to *observe*. Its event normalizer maps app-server notifications like `account/chatgptAuthTokens/refresh`, `account/updated`, and `account/rateLimits/updated` into its own internal event types so the UI can show account/rate-limit state. It reacts to token refreshes; it does not perform them. `CODEX_HOME` (default `~/.codex`) is the equivalent of the Claude `HOME` knob for selecting which credential store to use.

Practical takeaway:

```text
1. Ensure the user has run `codex login` (ChatGPT sign-in) once.
2. Launch the Codex app-server (bundled with the Codex CLI) as a subprocess,
   optionally setting CODEX_HOME to pick the auth.json to use.
3. Talk to it over JSON-RPC/stdio for turns; let it own token refresh.
4. Optionally listen for account/* notifications to surface account and
   rate-limit info in your UI.
```

### Why they chose delegation (and why you probably should too)

Reimplementing subscription OAuth means owning: the PKCE dance, a loopback callback server, token storage, silent refresh, clock-skew handling, error recovery, and — critically — a client identity the provider recognizes. The official CLIs already do all of this, are updated when the providers change endpoints, and are the *sanctioned* surface for subscription credentials. Wrapping them is less code, more robust, and stays on the right side of the terms of service.

---

## Part 2 — The underlying OAuth flows (reference only)

If you want to understand what the CLIs do internally — or you are considering a direct integration — here is the mechanism each provider uses. **Read Part 3 on compliance before acting on any of this.**

### 2a. Anthropic (what Claude Code does internally)

Claude Code performs a standard **OAuth 2.1 Authorization Code flow with PKCE (S256)** against Anthropic's auth service, running its own local flow on the user's machine.

Publicly observed shape of the flow:

- **Authorize endpoint:** `https://claude.ai/oauth/authorize` (subscription/Claude.ai path). A separate console client exists at `platform.claude.com` for API-billed usage — Claude Code selects between them depending on whether you're logging in with a subscription or an API org, which is the source of several well-known "authenticated as API instead of subscription" bugs.
- **Client ID:** Claude Code ships a fixed public client id (community-documented as `9d1c250a-e61b-44d9-88ed-5944d1962f5e`). Public clients like this legitimately have no secret; PKCE is what protects the exchange.
- **PKCE:** mandatory. Generate a high-entropy random `code_verifier`, compute `code_challenge = BASE64URL(SHA256(code_verifier))`, and send `code_challenge_method=S256`.
- **Redirect:** an RFC 8252 loopback redirect (`http://localhost:<ephemeral-port>/callback`) so the browser can hand the code back to the local process. There is also a "paste the code" fallback for headless machines.
- **Token exchange:** POST the `authorization_code` plus the original `code_verifier` to the token endpoint (form-encoded per RFC 6749). You receive an access token, a refresh token, and an expiry.
- **Storage & refresh:** persist tokens (Claude Code uses the OS keychain / a credentials file under `~/.claude`) and use the refresh token to mint new access tokens before expiry.

Original illustration of the client-side PKCE mechanics (generic, not provider-specific code):

```ts
import crypto from "node:crypto";

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };            // send challenge + method=S256, keep verifier
}

// Loopback redirect: start an ephemeral http server, put its URL in redirect_uri,
// open the authorize URL in the browser, and resolve when the callback hits with ?code=...
```

The requests themselves are ordinary OAuth: an authorize URL with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`; then a form-encoded POST to the token endpoint with `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`. Refresh is `grant_type=refresh_token`.

To *call the model* afterward you send the access token as `Authorization: Bearer <token>` to the Anthropic Messages API — but note the beta header / product-identity requirements and the ToS restriction in Part 3.

### 2b. OpenAI (what Codex CLI does internally)

Codex signs in with ChatGPT using an OAuth flow against `auth.openai.com`, with a **device-code** variant for headless use.

Publicly documented shape:

- **Authorize endpoint:** `https://auth.openai.com/oauth/authorize`.
- **Public client ID:** `app_EMoamEEZ73f0CkXaXp7hrann`.
- **Browser flow:** Codex opens the authorize URL; after sign-in the browser returns an access token to the CLI via a **localhost callback on port `1455`** (which is why the SSH tunneling fallback forwards `localhost:1455`).
- **Device-code flow (beta):** `codex login --device-auth` starts the device flow, prints a URL (`https://auth.openai.com/codex/device`) and a short one-time code that expires in ~15 minutes; the user enters the code in a browser. Device-code login must be explicitly enabled in ChatGPT Settings → Security ("Allow device code login") or by a workspace admin.
- **Token storage & refresh:** cached in `~/.codex/auth.json` (or the OS keyring via `cli_auth_credentials_store = file | keyring | auto`). Codex refreshes tokens automatically during active sessions. There's also `codex login --with-access-token` to feed a token via stdin, and API-key sign-in as an alternative.

Illustration of the device-code polling pattern (generic OAuth 2.0 Device Authorization Grant, RFC 8628):

```ts
// 1) POST to the device-authorization endpoint -> { device_code, user_code,
//    verification_uri, interval, expires_in }
// 2) Show user_code + verification_uri to the user.
// 3) Poll the token endpoint with grant_type=urn:ietf:params:oauth:grant-type:device_code
//    and the device_code, respecting `interval`, until you get tokens or it expires.
async function pollForToken(deviceCode: string, intervalSec: number, tokenUrl: string, body: Record<string,string>) {
  while (true) {
    await new Promise(r => setTimeout(r, intervalSec * 1000));
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const json = await res.json();
    if (res.ok) return json;                       // access_token, refresh_token, expires_in
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") { intervalSec += 5; continue; }
    throw new Error(json.error);                    // expired_token, access_denied, ...
  }
}
```

---

## Part 3 — Compliance: read before you build direct integration

This is the reason T3 Code delegates rather than reimplements, and it should shape your decision.

- **Anthropic explicitly restricts subscription OAuth tokens.** As of early 2026 Anthropic's legal/compliance terms state that OAuth authentication is intended *exclusively for Claude Code and Claude.ai*, and that using OAuth tokens obtained through Free/Pro/Max accounts in any other product, tool, or service — **including the Agent SDK directly** — is not permitted. Building your own client that logs in with the Claude Code client ID and then calls the API with that token is therefore against Anthropic's terms, even though it is technically possible.
- **OpenAI's device-code login is gated** behind an account/workspace setting and is described as beta; ChatGPT subscription usage follows your ChatGPT workspace policies, not API terms.
- **The safe pattern is the T3 pattern:** run the vendor's own authenticated runtime (Claude Code / Codex CLI / their SDKs) as the thing that holds and uses the credential. You are then *using the official client*, not impersonating it. Your app orchestrates; the vendor tool authenticates.

If your goal is a shippable product, use delegation. Reserve the direct-OAuth knowledge in Part 2 for understanding, debugging, or strictly personal use.

---

## Part 4 — Recommended design for `llm-flow`

A clean-room adapter layer that mirrors T3's model without copying it:

1. **Define a `ProviderRuntime` interface** with `start(env)`, `sendTurn()`, `onEvent()`, `stop()`, and a `credentialDir` option. Keep it transport-agnostic.

2. **Claude runtime (delegation):**
   - Precondition check: verify a Claude credential store exists (look for the Claude home dir / keychain entry); if missing, surface a "Run `claude auth login`" prompt in the UI.
   - Spawn the Agent SDK / `claude` process. Pass `env` through, overriding `HOME` only when the user selects a specific account directory.
   - Never touch the token yourself.

3. **Codex runtime (delegation):**
   - Precondition check for `~/.codex/auth.json` (or configured keyring); otherwise prompt "Run `codex login`".
   - Launch the Codex app-server as a subprocess; set `CODEX_HOME` to select the account. Speak its JSON-RPC/stdio protocol.
   - Subscribe to `account/*` notifications if you want to display account and rate-limit status.

4. **Multi-account support** falls out naturally: an account is just a credential directory. Store a small registry mapping a user-facing account label → `HOME`/`CODEX_HOME` path.

5. **Health/status:** poll each runtime for a lightweight "am I authenticated?" signal (e.g. a cheap capability/whoami call or the presence + validity of the credential file) and reflect Connected / Needs-login in the UI.

6. **Do not persist or log tokens** anywhere in `llm-flow`. Since the vendor runtime owns them, your app's attack surface stays minimal.

This gives you subscription-based Claude and ChatGPT usage with essentially none of the OAuth burden, and keeps you within both providers' terms.

---

## Sources

- [T3 Code repository (pingdotgg/t3code)](https://github.com/pingdotgg/t3code) — README prerequisites, provider adapter architecture (`apps/server/src/provider/**`, `ClaudeHome.ts`, Codex app-server manager, account event mapping).
- [OpenAI Codex — Authentication docs](https://developers.openai.com/codex/auth) — ChatGPT sign-in, device-code flow, `auth.json`, `CODEX_HOME`, token refresh, `localhost:1455` callback.
- [Codex CLI public client ID / device flow discussion](https://github.com/tumf/opencode-openai-device-auth) — `app_EMoamEEZ73f0CkXaXp7hrann`, device endpoint.
- [Claude connector authentication (PKCE S256 requirements)](https://claude.com/docs/connectors/building/authentication)
- [Anthropic OAuth notes & Claude Code client ID / flow](https://gist.github.com/cedws/3a24b2c7569bb610e24aa90dd217d9f2)
- [Anthropic OAuth restriction to Claude Code / Claude.ai (compliance)](https://github.com/anthropics/claude-code/issues/39445) and related Claude Code auth issues.
