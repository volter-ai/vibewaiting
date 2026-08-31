# Changelog

Vibewaiting follows [Semantic Versioning](https://semver.org/). GitHub Releases contain
the complete generated notes and downloadable artifacts for each version.

## [Unreleased]

### Added

- Vibewaiting can publish its active extension tab as a Supercode browser provider.
  Supercode owns the shared SDK, CLI, MCP operation registry, and policy surface;
  Vibewaiting supplies bounded accessibility snapshots and structured DOM actions
  without CDP or arbitrary page evaluation.

### Security

- Supercode provider discovery is loopback-only with random-token, owner-only
  discovery. Password/file fields and consequential controls fail closed with
  `APPROVAL_REQUIRED`, and revoking website access removes the executor.

## [0.1.2] - 2026-08-26

### Changed

- Store and onboarding copy now lead with the developer need for the local companion:
  Claude Code and Codex keep transcripts, process state, and terminals outside Chrome's
  extension sandbox, so an on-device bridge is required to reach those existing sessions.
- The package summary and native-messaging justification now name the supported developer
  tools and the exact local surfaces being bridged.

## [0.1.1] - 2026-08-26

### Changed

- The website-access screen now names the page data and pointer/focus activity used by
  one-action Attach before Chrome asks for permission, including retention, exclusions,
  transmission boundaries, and revocation.
- The public privacy policy and Chrome Web Store copy now distinguish local agent
  credentials from Vibewaiting pairing credentials and state every external prerequisite
  a reviewer needs to exercise the core feature.

### Security

- Stable remote access now rejects non-HTTPS relay URLs before any chat or terminal
  traffic can leave the computer.
- Page-facing content scripts now receive only redacted remote-access status; pairing
  URLs, passcodes, and device details render solely inside the extension-origin iframe.
- Extension iframe assets use Chrome's per-session dynamic web-accessible-resource ID.

## [0.1.0] - 2026-08-26

### Added

- Product-first open-source documentation and release packaging.
- Reproducible extension, native companion, checksum, and SBOM artifacts.
- Optional website-access onboarding with immediate grant revocation.
- Ownership-safe native-host removal with an explicit local-state purge option.
- A pinned, bundled CLI runtime with complete third-party notices.
- Three-step companion, workspace, and website-access onboarding with backward-compatible
  detection of an already installed native companion.
- Chrome Web Store artwork, identity verification, and clean release evidence.

### Changed

- Native Claude Code and Codex sign-in now uses Supercode's shared verified lifecycle while
  Vibewaiting retains only the visible terminal execution adapter.
- First-alpha scope now includes switchable chat and tmux-backed terminal views,
  explicit browser-context attachment, and authenticated mobile access.
- Agent and remote-access defaults now stay outside the first-run critical path, and the
  unsafe confirmation override is labeled explicitly instead of as “Yolo.”

[Unreleased]: https://github.com/volter-ai/vibewaiting/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/volter-ai/vibewaiting/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/volter-ai/vibewaiting/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/volter-ai/vibewaiting/releases/tag/v0.1.0
