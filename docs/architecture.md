# Architecture

Vibewaiting is composition glue. It owns the browser/native adaptation and product
workflow; Supercode Agent owns reusable coding semantics, UI, coding terminal composition
and remote access. Supercode owns native fleet sessions and terminal transport;
browser attachment and tunnels retain their existing owners. This follows
[Supercode ADR 0265](https://github.com/volter-ai/supercode/blob/main/docs/adr/0265-supercode-is-the-fleets-harness.md).
The coding SDK starts `supercode-agent`; `SUPERCODE_CODING_BIN` selects an explicit
executable. Local development selects one Agent checkout and one Fleet checkout
(`SUPERCODE_FLEET_DIR`). `sync:local` packs their called public dependency closure
and installs those artifacts together through npm. Source-development locks select
the exact native archives produced from named Agent and Fleet commits. A bundled dependency is validated against its original archive declaration, so root inputs name those same producer artifacts; copying them to different paths would change npm's source identity. Native npm overrides bind the called graph to those same inputs. The producer binds its owned peer declarations to the exact versions it packs. npm validates bundled peers against those original declarations, so the bundle carries a complete valid closure without relying on peer overrides.
The local refresh leaves that committed manifest and lock unchanged. Copied Agent packages resolve the selected native Fleet readers
and transport, including their transitive dependencies. It never binds a coding
controller to the fleet command or an ambient native package graph.

```text
ordinary web page
  └─ content script: launcher + page context + structured browser executor
       └─ extension-owned iframe: full Supercode Agent messenger UI
            └─ browser native messaging (bounded, chunked protocol)
                 └─ Vibewaiting native host
                      ├─ browser broker for `vibewaiting mcp` (Playwright's tools on the active tab)
                      ├─ Supercode Agent controller: discovery, resume, input, settings
                      ├─ local terminal service: opaque short-lived attachment grants
                      ├─ local persistence: drafts, unread state, presentation memory
                      └─ remote messenger: authenticated mobile chat/terminal relay
                           └─ Supercode Agent remote-access provider
```

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Session discovery, harness capabilities, continuation semantics | Supercode Agent client and SDK |
| Chat components, transcripts, logos, intent schema | Supercode Agent UI |
| Terminal transport and viewer | Supercode Agent Terminal over the native fleet terminal |
| Overlay lifecycle, geometry, iframe isolation | Widget Shell |
| Optional managed/headless browser attachment | Volter Browsers |
| Stable or temporary public transport | Supercode Agent Remote Access and Volter Tunnel |
| Browser permissions, context capture, the browser tools' MCP server and approval policy, native messaging, product composition | Vibewaiting |
| Browser tools and their schemas | Playwright (`playwright-core`'s MCP tool backend) |
| Playwright in the browser, the in-page CDP surface | AlmostCDP |

If a change is useful to another Supercode Agent frontend or overlay application without
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
provider. The native messaging host owns startup capability probes and the remote-access controller through one lifetime. Native stdin closure or a process signal cancels that lifetime, closes the controller immediately, and joins queued commands and each service cleanup before exit. Tunnel shutdown is awaitable; failed cleanup propagates while the remaining local services still close. A one-scan QR carries a short-lived pairing grant in the URL fragment; page
JavaScript consumes it once, so the fragment is not sent in the initial HTTP request.
The fallback flow uses a rate-limited six-digit code. Successful pairing creates an
HTTP-only, same-site device session that can be revoked from the desktop companion.

Temporary tunnel URLs are browser-only. Manifest and service-worker routes return
`404` unless the request host exactly matches the active stable public origin.

## State and refresh behavior

The daemon's primary controller owns the coding transport; conversation mirrors share it. Shutdown seals local input, starts the primary controller's close alongside mirror, authentication and catalog cleanup, and joins those operations and pending UI delivery before removing the widget. A shared controller cannot keep its transport owner waiting behind its own pending request. Repeated shutdown calls join the same result, and cleanup failures propagate after every cleanup has been attempted.

Session attachment and sign-in follow their native completion, explicit error or owner cancellation; the host sets no inferred completion deadline. The native host projects revisioned state. Browser transports coalesce equivalent
inventory refreshes and preserve stable conversation ordering, active selection,
drafts, unread boundaries, and presentation state. Refreshing native inventory must
not remount the messenger or replay its opening animation.

## Build and validation

`npm run check` performs strict typechecking, the small high-value Vitest suite, and a
production build. Browser regression uses Chromium only in the nightly workflow. The
extension build ID hashes both extension and mobile assets so the development reload
loop cannot report success while serving stale output.
