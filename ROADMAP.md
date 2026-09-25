# Roadmap

Vibewaiting is a thin browser and mobile companion for local coding-agent sessions. It
composes Supercode's agent/session model, Widget Shell's overlay runtime, and optional
Lucarne browser attachment. The roadmap favors seamless continuation and trustworthy
local control over adding another standalone coding environment.

What ships today is in [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md). The 0.2.0 release, with the
active-tab provider for Supercode's browser capability, is tracked with its Supercode and Widget Shell parts in
`volter-ai/volter`'s roadmap (`vibewaiting-release`).

## Next

- One-click provisioning and revocation of a durable remote origin
- Signed browser-store packaging and automatic updates
- Setup diagnostics and guided recovery beyond the current permission onboarding
- Verified Firefox and Windows support
- Deeper mobile terminal input, selection, and session-switching parity

## Later

- Deliberate UI admission for additional Supercode harnesses after their capabilities
  and identity are verified end to end
- Reusable browser-companion integrations built from the generic Widget Shell and
  Supercode UI packages

## Non-goals

- Becoming a coding harness, model provider, or IDE
- Hosting or proxying users' coding-agent execution
- General remote desktop or terminal fleet management
- Reimplementing reusable functionality already owned by Supercode, Widget Shell,
  Lucarne, or Volter Tunnel

This roadmap communicates direction, not a delivery promise. Proposals should begin
with the user problem and preserve the trust boundaries in
[docs/architecture.md](docs/architecture.md).
