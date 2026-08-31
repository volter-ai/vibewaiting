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
  when the workspace-scoped provider receives a call. There is no
  arbitrary JavaScript/evaluate operation. Snapshots and query results are bounded;
  password/file fields and consequential controls fail closed. Credential-like URL
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
