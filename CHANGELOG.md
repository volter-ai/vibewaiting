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
- Browser permissions in the messenger, after Claude in Chrome's per-site permissions.
  Every action that can change a page or send it input (click, fill, press, focus,
  check, select, scroll, back, forward, reload, raw mouse presses, wheel, drag, scripts)
  asks unless the person allowed the tab's current origin for the agent's task; reading
  never asks. Cards offer Deny, Allow once and Allow on <origin> for this task; scripts
  and fills into password, one-time-code, card or file fields offer only Allow once,
  every time. Cards name what actually happens (the key Playwright sends, a select's
  options, a drag's drop target, a script's full source, arguments and reach) and, on
  the in-page path, say the page described it. Allow buttons arm after a second of
  visibility and stillness and half a second of the pointer resting on them. Deny, no
  answer within 90 seconds, closing the tab, or the agent's call ending refuses the
  action with the reason; while a card is open, nothing else runs on that tab. The
  agent's call stays open while the person decides (Supercode `pending` lines: needs a
  Supercode CLI with `BROWSER_PERSON_TIMEOUT`). Targets are described from the browser
  side, and a script's routes, bindings, init scripts and listeners are removed when it
  ends (Supercode browser-playwright 0.2.1).

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
