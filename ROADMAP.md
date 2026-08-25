# Roadmap

Vibewaiting is a thin browser and mobile companion for local coding-agent sessions. It
composes Supercode's agent/session model, Widget Shell's overlay runtime, and optional
Lucarne browser attachment. The roadmap favors seamless continuation and trustworthy
local control over adding another standalone coding environment.

## Available now

- A messenger overlay in ordinary Chrome, Chromium, and Brave pages
- Claude Code and Codex conversation discovery, continuation, unread state, and
  capability-aware actions
- Switchable chat and tmux-backed terminal views
- One-action page, selection, link, GitHub, and Hacker News context attachment
- Authenticated phone access over temporary or stable tunnel providers
- Installable mobile app behavior on stable origins only

## Next

- One-click provisioning and revocation of a durable remote origin
- Signed browser-store packaging and automatic updates
- Polished onboarding, diagnostics, and permission explanations
- Verified Firefox and Windows support rather than configuration-only claims
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
