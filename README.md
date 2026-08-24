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

The extension uses `storage`, `nativeMessaging`, and its own browser context-menu entry, plus host
access for its on-page overlay and browser-context capture on ordinary web pages. Content scripts receive a bounded launcher projection—not
transcripts, filesystem paths, credentials, or policy. Full messenger state is sent only to the
extension-owned, origin-isolated iframe; native message frames and reassembly are bounded, and
unknown harnesses remain hidden instead of receiving a fabricated fallback identity. Page context
never travels to the native host until the user attaches it to a message. URLs lose credentials,
credential-like parameters, and tracking parameters while semantic identity such as Hacker News
item IDs and GitHub line anchors survives. Every text payload is size-bounded and validated on both
sides of the tab boundary.

The composer's attach button and shortcut share one deliberately one-step resolver. They attach an
active selection first, then a keyboard-focused or pointed link, image, or meaningful element, and
fall back to a typed reference for the visible page only when no precise target exists. The last
real page target survives the pointer crossing into the overlay, so clicking Attach does not lose
what the user was pointing at. GitHub repository, issue, pull request, discussion, commit,
file/line, and Actions-run URLs retain their domain identity; Hacker News item URLs retain their
item ID. The browser's right-click link entry remains a precision fallback rather than the taught
workflow. Files can be dragged directly onto the composer. Four browser-remappable commands make the overlay callable
without hunting for its launcher:

- `⌥⇧V` (`Alt+Shift+V`) opens Vibewaiting and focuses the message box.
- `⌥⇧A` (`Alt+Shift+A`) immediately attaches the current selection, pointed target, or page.
- `⌥⇧←` (`Alt+Shift+Left`) opens the previous conversation.
- `⌥⇧→` (`Alt+Shift+Right`) opens the next conversation.

The previous/next commands rotate through the current stable list rather than following live
activity reordering, so a busy fleet cannot move the target underneath the shortcut. Browser users
can change all four bindings from the browser's extension-shortcuts page.

The extension presents Chat and Terminal as two header-selected views of the current conversation.
When that conversation already has a proven tmux association, the Terminal side attaches directly;
otherwise selecting it resumes the same native session inside a new owned tmux session.
The association lives in opaque tmux metadata, so it survives browser and native-host restarts
without putting a harness session id or tmux handle in the visible session name. Switching back to
Chat only releases the viewer—it does not detach or stop the durable tmux session. The browser
receives a short-lived, one-use
attachment grant rather than a tmux session or socket handle; the loopback stream accepts only the
exact extension origin, and closing the viewer
releases its PTY without killing the durable tmux session. Widget Shell's named presentations keep
the messenger phone-sized and reshape the same surface for a terminal before terminal UI appears.

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
