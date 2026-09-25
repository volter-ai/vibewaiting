# Changelog

Vibewaiting follows [Semantic Versioning](https://semver.org/). GitHub Releases contain
the complete generated notes and downloadable artifacts for each version.

## [Unreleased]

## [0.2.0] - 2026-09-25

### Added

- Vibewaiting can publish its active extension tab as a Supercode browser provider.
  Supercode owns the shared SDK, CLI, MCP operation registry, and policy surface;
  Vibewaiting answers all 21 operations with unmodified Playwright running in a
  sandboxed extension page against an AlmostCDP surface in the tab, including
  `browser.script`, and keeps the tab across navigations. A page whose
  Content-Security-Policy forbids eval (GitHub) is driven through Chrome's debugger
  instead: Chrome's debugging bar shows on that tab only, and the debugger detaches
  60 seconds after the last browser operation and re-attaches on the next. Snapshots
  leave out Vibewaiting's own messenger and launcher. Firefox remains unsupported: it
  does not install the extension.
- Browser approvals in the messenger. Before an agent fills a password or file field,
  activates a consequential control, presses, clicks, scrolls or drags with the raw
  mouse (always, whatever is under it), or runs a script, the messenger opens with a
  card naming the exact action and page, with a script's full source and arguments.
  On the in-page path every fill and key press is asked too, and cards say the page
  described the element. The classifier catches an agent's mistakes on honest pages; a
  hostile page can mislabel its own elements on the in-page path. Approve once re-runs that one operation with a
  single-use, nonce-bound grant for its operation id, tab and target, and becomes
  clickable only after the card has been visible and still for a continuous second. Deny, no
  answer within 90 seconds, closing the tab, or the agent's call ending refuses it
  with the reason; while a card is open, nothing else runs on that tab. The agent's
  call stays open while the person decides (Supercode `pending` lines: needs a
  Supercode CLI with `BROWSER_PERSON_TIMEOUT`). The guard reads each target from the
  browser side (Supercode browser-playwright 0.2.0).

### Fixed

- The messenger becomes ready again: the overlay's handshake addresses the extension's
  own origin, which the frame keeps when it loads from Chrome's dynamic
  web-accessible-resource URL.

### Security

- Supercode provider discovery is loopback-only with random-token, owner-only
  discovery. Nothing an agent does in the tab is approved standing, the approval card
  never takes keyboard focus, a point on Vibewaiting's own interface is refused, scripts
  over 20,000 characters are refused, and revoking website access removes the executor
  and detaches the debugger.
- The store listing and privacy policy explain the `debugger` permission: used only on
  pages that block the in-page executor, only on the tab an agent drives, and only
  while it drives it.

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
