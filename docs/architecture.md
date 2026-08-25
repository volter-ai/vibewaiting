# Architecture

Vibewaiting is composition glue. It owns the browser/native adaptation and product
workflow; upstream packages own reusable agent semantics, UI, terminals, browser
attachment, and tunnels.

```text
ordinary web page
  └─ content script: launcher + explicit page-context capture
       └─ extension-owned iframe: full Supercode messenger UI
            └─ browser native messaging (bounded, chunked protocol)
                 └─ Vibewaiting native host
                      ├─ Supercode controller: discovery, resume, input, settings
                      ├─ local terminal service: opaque short-lived attachment grants
                      ├─ local persistence: drafts, unread state, presentation memory
                      └─ remote messenger: authenticated mobile chat/terminal relay
                           └─ Supercode remote-access provider
```

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Session discovery, harness capabilities, continuation semantics | Supercode client and harness SDK |
| Chat components, transcripts, logos, intent schema | Supercode UI |
| Terminal transport and viewer | Supercode Terminal |
| Overlay lifecycle, geometry, iframe isolation | Widget Shell |
| Optional managed/headless browser attachment | Lucarne |
| Stable or temporary public transport | Supercode Remote Access and Volter Tunnel |
| Browser permissions, context capture, native messaging, product composition | Vibewaiting |

If a change is useful to another Supercode frontend or overlay application without
Vibewaiting's browser-companion workflow, it likely belongs upstream.

## Browser isolation

The content script runs in ordinary pages but receives only the launcher state needed
to render the fob. The complete messenger renders inside an extension-origin iframe.
Page context crosses into the extension only after an explicit attach action and is
normalized and bounded before native messaging.

Native messages have an explicit protocol version, bounded frames, bounded
reassembly, and parsed intent shapes. Unknown harness identities and unsupported
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
