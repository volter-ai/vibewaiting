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
  Attach. An agent reaches the tab only through `vibewaiting mcp`, which serves
  Playwright's own browser tools less those that run code (`browser_evaluate`,
  `browser_run_code_unsafe`), touch files, read the page's request headers and bodies,
  or reach other tabs and the window; navigation goes only to http and https; no CDP
  endpoint is exposed to local processes, and no agent code runs in the page or the
  extension. Every acting call (click, drag, select, type, fill a form, press a key,
  navigate, go back, answer a dialog) runs only after the person allows it in the
  messenger, once or for the tab's current origin for the agent's task (ended by the
  task, the tab closing, or 15 minutes without use); reading never asks, though
  hovering scrolls its element into view. Typing into password, one-time-code, card or
  file fields (or fields that were one on this document) and pages without a real
  origin are allowed once each, even on an allowed origin. A navigation in flight or a
  changed origin refuses a call before it runs; the page can still change between that
  check and the input. Each tab's in-page connection is
  bound to the tab Chrome names for its port, so a page cannot claim another tab's
  connection. Allowances end after 15 minutes unused, when the tab closes, or when the
  agent's MCP session ends.
  Denial, no answer in 90 s, or a changed page refuses the action.
- Whether to ask never depends on what an element is called; those words only shape
  the card. The page describes its own elements, so a hostile page can mislabel them,
  and cards say "(as described by the page)". The cards protect against an agent's
  mistakes on pages that describe themselves honestly. Nothing an agent types is secret
  from the page it types into. A call naming a selector or an element inside a frame,
  and any call on Vibewaiting's own launcher or messenger, is refused. Credential-like URL
  parameters and tracking parameters are removed from Attach payloads.
- The browser broker's discovery files are owner-only under `~/.vibewaiting/browser`;
  every native-host process binds a random-token-protected server to loopback and
  removes its own record on shutdown. Calls go to the active tab of the last-focused
  window.
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
