# Security policy

Vibewaiting connects web pages to local coding-agent sessions and optionally to a
terminal. Treat its native host as local developer tooling with access equivalent to
the agent processes it controls.

## Trust boundaries

- The native messenger and terminal services bind to loopback. Do not expose their
  local ports directly.
- Browser content scripts receive only a bounded launcher projection. Full messenger
  state lives in an extension-owned iframe; native locators, tmux handles, credentials,
  and execution policy stay in the native host.
- Page context is collected only after an explicit attach action. Credential-like URL
  parameters and tracking parameters are removed before the payload crosses the tab
  boundary.
- Remote access terminates at the authenticated messenger server. Pairing grants are
  short-lived and single-use, cookies are HTTP-only, login is rate-limited, and terminal
  grants remain opaque and short-lived.
- A temporary tunnel is browser-only. Install metadata is served only to the exact
  configured stable public host.

See [the architecture document](docs/architecture.md) for the data flow and ownership
boundaries.

## Supported versions

Until the first stable release, security fixes target the latest commit on `main` and
the newest published prerelease. Older prereleases may not receive backports.

## Reporting a vulnerability

Do **not** open a public issue or paste secrets, session data, terminal output, or a
reproduction containing credentials into an issue.

Use GitHub's private vulnerability reporting from the repository's Security tab. If
that surface is unavailable, email `aaron@volter.ai` with
`[vibewaiting security]` in the subject. Include the affected version, impact, and the
smallest safe reproduction. Reports are acknowledged on a best-effort basis, normally
within five business days. Confirmed fixes credit the reporter unless anonymity is
requested.
