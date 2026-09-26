# Architecture

Vibewaiting is composition glue. It owns the browser/native adaptation and product
workflow; upstream packages own reusable agent semantics, UI, terminals, browser
attachment, and tunnels.

```text
ordinary web page
  └─ content script: launcher + page context + structured browser executor
       └─ extension-owned iframe: full Volter Harness messenger UI
            └─ browser native messaging (bounded, chunked protocol)
                 └─ Vibewaiting native host
                      ├─ browser broker for `vibewaiting mcp` (Playwright's tools on the active tab)
                      ├─ Volter Harness controller: discovery, resume, input, settings
                      ├─ local terminal service: opaque short-lived attachment grants
                      ├─ local persistence: drafts, unread state, presentation memory
                      └─ remote messenger: authenticated mobile chat/terminal relay
                           └─ Volter Harness remote-access provider
```

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Session discovery, harness capabilities, continuation semantics | Volter Harness client and harness SDK |
| Chat components, transcripts, logos, intent schema | Volter Harness UI |
| Terminal transport and viewer | Volter Harness Terminal |
| Overlay lifecycle, geometry, iframe isolation | Widget Shell |
| Optional managed/headless browser attachment | Volter Browsers |
| Stable or temporary public transport | Volter Harness Remote Access and Volter Tunnel |
| Browser permissions, context capture, the browser tools' MCP server and approval policy, native messaging, product composition | Vibewaiting |
| Browser tools and their schemas | Playwright (`playwright-core`'s MCP tool backend) |
| Playwright in the browser, the in-page CDP surface | AlmostCDP |

If a change is useful to another Volter Harness frontend or overlay application without
Vibewaiting's browser-companion workflow, it likely belongs upstream.

## Browser isolation

The content script runs in ordinary pages but receives only the launcher state needed
to render the fob and a redacted remote-access status. The complete messenger and all
pairing URLs, passcodes, and device details render inside an extension-origin iframe.
Attach context crosses into the extension only after an explicit attach action and is
normalized and bounded before native messaging. Separately, `vibewaiting mcp` serves an
agent Playwright's own browser tools on the active tab, answered by Playwright's MCP tool
backend in a sandboxed extension page against an AlmostCDP surface in the page's main
world, or through `chrome.debugger` on a page whose Content-Security-Policy forbids eval
([browser tools](browser-tools.md)). On the AlmostCDP path
events are synthetic; it does not claim downloads, network interception, or
hidden-tab selection.

HTTP and HTTPS access is optional rather than an install-time host grant. Onboarding
discloses the page-facing behavior before requesting access. The background worker
registers the content script only after consent, injects it idempotently into existing
ordinary tabs, and unregisters plus tears down mounted overlays when access is revoked.

Native messages have explicit protocol versions, bounded frames, bounded
reassembly, parsed intent shapes, and correlated browser request IDs. Unknown harness identities and unsupported
actions are omitted; the UI never invents a fallback capability.

## Terminal isolation

Terminal sessions remain native. The browser receives a short-lived, one-use opaque
grant associated with an owned terminal session, never a tmux session name, socket, or
native locator. Switching to chat releases the viewer without killing the underlying
tmux session.

## Remote access

The remote messenger binds to loopback and is exposed only by a selected tunnel
provider. A one-scan QR carries a short-lived pairing grant in the URL fragment; page
JavaScript consumes it once, so the fragment is not sent in the initial HTTP request.
The fallback flow uses a rate-limited six-digit code. Successful pairing creates an
HTTP-only, same-site device session that can be revoked from the desktop companion.

Temporary tunnel URLs are browser-only. Manifest and service-worker routes return
`404` unless the request host exactly matches the active stable public origin.

## State and refresh behavior

The native host projects revisioned state. Browser transports coalesce equivalent
inventory refreshes and preserve stable conversation ordering, active selection,
drafts, unread boundaries, and presentation state. Refreshing native inventory must
not remount the messenger or replay its opening animation.

## Build and validation

`npm run check` performs strict typechecking, the small high-value Vitest suite, and a
production build. Browser regression uses Chromium only in the nightly workflow. The
extension build ID hashes both extension and mobile assets so the development reload
loop cannot report success while serving stale output.
