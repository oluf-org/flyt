# Plugin UI extensions: declarations, not renderers (D61)

Plugins extend Flyt's UI by sending typed data to the host's `UiExtensionRpc`. The host validates and stores that data before the renderer can receive it. Flyt then renders the declaration with its own React components and styles.

The first rendered points are:

- **block configuration** — a bounded object schema becomes Flyt labels, inputs, checkboxes, and selects;
- **tool view** — a tree using the closed `text`, `code`, `badge`, `notice`, `key-value`, and `stack` vocabulary becomes Flyt-owned result chrome.

`trace-decoration`, `settings-section`, and `library-entry` use the same typed contribution union and RPC boundary. Their declarations can be registered and listed, but they are not dispatched to UI locations yet. Adding those locations does not require broadening the trust boundary.

The boundary refuses unknown extension points and components, extra fields, functions, non-plain objects, cycles, HTML, scripts, renderers, event handlers, class names, and styles. Renderer code therefore does not need to sandbox plugin values: refused values never become renderer input. Plugins cannot access the DOM or imitate Flyt's chrome with custom CSS because neither capability exists in the protocol.

## Iframe escape hatch: decision not taken

An iframe contribution is deliberately **not implemented**. The protocol leaves room for a future, separately named extension point rather than treating arbitrary content as a `UiNode`. Before that point can exist, its design must prove all of the following:

1. process and origin isolation with no Electron, Node, preload, same-origin, filesystem, or parent-DOM reach;
2. a deny-by-default Content Security Policy with no ambient network access, plus an explicit permission and consent model for any RPC or network capability;
3. authenticated, schema-validated, size- and rate-bounded `postMessage` traffic with a fixed target origin;
4. lifecycle, crash, focus, keyboard, accessibility, clipboard, download, navigation, and resource-exhaustion behavior that cannot degrade the host;
5. unmistakable third-party visual provenance that cannot impersonate Flyt chrome, approval prompts, or trusted settings;
6. install-time disclosure, revocation, auditability, and tests demonstrating that compromise remains confined to the iframe.

Until those claims are demonstrated together, an iframe would be arbitrary renderer code under another name. The current boundary therefore has no URL, HTML, webview, iframe, or renderer field.