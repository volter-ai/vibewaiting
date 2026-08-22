# vibewaiting

Vibe code without leaving your browser: a messenger in the corner of every page, wired to the coding agents in your CLIs via Supercode.

Vibewaiting is intentionally a thin composition:

- Lucarne provides browser attachment plus the versioned state-and-intent transport.
- Widget Shell provides the isolated launcher, stable viewport, responsive geometry, and visual lifecycle.
- `@volter-ai-dev/supercode-client` owns session/runtime state and capability-gated actions.
- `@volter-ai-dev/supercode-ui` supplies the component library and complete Storybook contract.
- This repository bridges bounded state, trusted host persistence, notifications, and intents.

The browser never receives native locators, recovery paths, credentials, or execution policy. In
particular, reduce-and-continue is shown only when the Supercode controller exposes its real
reversible operation; success is rendered only from a disk-verified reduction receipt.

Vibewaiting appears directly in the attached browser's normal windows and tabs. Lucarne's porthole
is an optional remote/headless viewing surface, not the primary way a local user browses.

## Browser extension

The native extension is the ordinary-browser path. It injects Widget Shell directly into existing
Chrome, Chromium, Brave, or Firefox tabs and connects to a small local native-messaging host; it does
not start, own, or look through a Lucarne browser session.

For a development checkout:

```sh
npm run build
node dist/cli.js native install --browser chrome
```

Load `dist/extension` as an unpacked extension, open its settings, and select an absolute workspace.
Use `--browser brave`, `chromium`, or `firefox` to register the host for another browser. If a browser
assigns a different unpacked-extension ID, copy the ID shown on the settings page and reinstall with
`--extension-id <id>`.

The extension has only `storage` and `nativeMessaging` privileges. Content scripts receive a bounded
launcher projection—not transcripts, filesystem paths, credentials, or policy. Full messenger state
is sent only to the extension-owned, origin-isolated iframe; native message frames and reassembly are
bounded, and unknown harnesses remain hidden instead of receiving a fabricated fallback identity.

The extension can also mirror local tmux sessions as a familiar terminal surface. Existing sessions
are read-only and attach without changing their tmux window size. Sessions created from Vibewaiting
run only the structured Claude Code or Codex command and may be controlled or stopped from the
widget. The browser receives a short-lived, one-use attachment grant rather than a tmux session or
socket handle; the loopback stream accepts only the exact extension origin, and closing the viewer
releases its PTY without killing the durable tmux session.

### Zero-touch development

Run `npm run dev:extension` once. It owns a persistent, isolated Brave/Chromium development profile,
installs the matching native host, syncs the remembered local Supercode worktree, watches both
projects' relevant sources, and after every successful build reloads the extension and refreshes
its ordinary web tabs. The profile and settings
survive restarts, so neither developers nor reviewers need to revisit the extensions page. Override
the browser, CDP port, profile, or initial page with `VIBEWAITING_DEV_BROWSER`,
`VIBEWAITING_DEV_CDP_PORT`, `VIBEWAITING_DEV_PROFILE`, or `VIBEWAITING_DEV_URL`. A new profile is
configured to the checkout automatically; set `VIBEWAITING_DEV_WORKSPACE` to use another project.

This loop is development-only and never runs in CI. Store installations use the browser's normal
signed automatic-update mechanism.

## Local Supercode development

Run `npm run sync:local` to build the adjacent Supercode binary and install its harness SDK, client,
UI, and optional terminal packages directly into Vibewaiting's working `node_modules`. Pass another
Supercode checkout as the final argument or set `SUPERCODE_DIR`. Local Lucarne and Widget Shell
sources are intentionally opt-in: set `VIBEWAITING_LOCAL_SURFACES=1`, plus `LUCARNE_DIR` or
`WIDGET_SHELL_DIR` when either repository is not a sibling. The command
records both the local binary and selected source worktree in ignored local-development state, so Vibewaiting
cannot accidentally pair local UI with the published runtime. `dev:extension` reuses that selection
and automatically resyncs Supercode source changes; no repeated manual command is needed. It does
not contact npm or modify `package.json`/`package-lock.json`; a later
`npm ci` restores the published dependencies for release and CI parity without forgetting which
local worktree the next development run should resync. `sync:local-ui` remains an
alias for the complete coherent-stack sync so older development commands are safe.

When the selected Supercode worktree is UI-only, `SUPERCODE_BINARY=/absolute/path/to/supercode` reuses
an explicitly named local binary and skips an unnecessary Rust rebuild.

Harness interoperability settings follow the same trust boundary. The browser renders only
Supercode's bounded, revisioned controls and returns a declared choice. Vibewaiting's local daemon
strictly parses that intent, while Supercode revalidates the active harness, control, choice, reset
capability, and revision before atomically changing a native settings file. This is intentionally
not a general harness preferences editor.

## Test inclusion bar

Tests are deliberately scarce. Add one only when the behavior is both multi-step or genuinely
complex **and** likely to regress: controller lifecycle transitions, concurrency/leak prevention,
trusted-host boundaries, bounded wire performance, or a previously recurring browser interaction.
Do not test copy, constants, formatting examples, trivial parsers/helpers, or behavior already owned
by Lucarne or Supercode UI. Chromium coverage stays in the nightly workflow, never the merge gate.
