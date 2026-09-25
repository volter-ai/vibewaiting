# Security policy

Vibewaiting connects web pages to local coding-agent sessions and optionally to a
terminal. Treat its native host as local developer tooling with access equivalent to
the agent processes it controls.

## Trust boundaries

- The native messenger and terminal services bind to loopback. Do not expose their
  local ports directly.
- Browser content scripts receive only a bounded launcher projection and redacted
  remote-access status. Full messenger and pairing state live in an extension-owned
  iframe; native locators, tmux handles, agent credentials, and execution policy stay
  in the native host.
- The content script remembers the latest pointed or focused element reference for
  Attach. It also executes Supercode's closed, structured browser-operation protocol
  when the workspace-scoped provider receives a call. Snapshots and query results are
  bounded. Every action that can change a page or send it input (click, fill, press,
  focus, check, select, scroll, back, forward, reload, raw mouse presses, wheel, drag,
  and `browser.script`, which is Playwright with the page including `page.evaluate`)
  runs only after the person allows it in the messenger, once or for the tab's current
  origin for the agent's task; reading never asks. Scripts and fills into password,
  one-time-code, card or file fields are allowed once each, even on an allowed origin.
  Denial, no answer in 90 s, or a changed page refuses the action.
- Whether to ask never depends on what an element is called; those words only shape
  the card. What the cards say comes from the browser on the debugger path; on the
  in-page (AlmostCDP) path the page describes its own elements, so a hostile page can
  mislabel them, and cards there say "(as described by the page)". The cards protect
  against an agent's mistakes on pages that describe themselves honestly. Nothing an
  agent types is secret from the page it types into. A locator in another frame, a
  press whose focus lands elsewhere or inside a frame or closed shadow root, and a
  mouse press whose position is unknown are refused. Credential-like URL
  parameters and tracking parameters are removed from Attach payloads.
- Browser-provider discovery files are owner-only under Supercode's configuration
  directory; every native-host process binds a random-token-protected server to loopback
  and removes its own record on shutdown. Requests start on the current active tab and
  may continue only through the opaque page handle Vibewaiting returned for that tab.
- Remote access terminates at the authenticated messenger server. Pairing grants are
  short-lived and single-use, cookies are HTTP-only, login is rate-limited, and terminal
  grants remain opaque and short-lived. Public chat and terminal transport uses
  HTTPS/WSS; an insecure configured stable-relay URL is rejected.
- A temporary tunnel is browser-only. Install metadata is served only to the exact
  configured stable public host.

See [the architecture document](docs/architecture.md) for the data flow and ownership
boundaries.

## Supported versions

Until the first stable release, security fixes target the latest commit on `main` and
the newest published `0.x` release. Older alpha releases may not receive backports.

## Reporting a vulnerability

Do **not** open a public issue or paste secrets, session data, terminal output, or a
reproduction containing credentials into an issue.

Use GitHub's private vulnerability reporting from the repository's Security tab. If
that surface is unavailable, email `aaron@volter.ai` with
`[vibewaiting security]` in the subject. Include the affected version, impact, and the
smallest safe reproduction. Reports are acknowledged on a best-effort basis, normally
within five business days. Confirmed fixes credit the reporter unless anonymity is
requested.
