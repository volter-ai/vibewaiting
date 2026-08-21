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

## Local Supercode development

Run `npm run sync:local` to build the adjacent Supercode binary and install its harness SDK, client,
and UI packages directly into Vibewaiting's working `node_modules`. When adjacent Lucarne and Widget
Shell checkouts exist, the same command builds and installs those too. Pass another Supercode checkout
as the final argument or set `SUPERCODE_DIR`; set `LUCARNE_DIR` or `WIDGET_SHELL_DIR` when either
repository is not a sibling. The command
records the local binary beside those packages, so Vibewaiting cannot accidentally pair local UI with
the published runtime. It does not contact npm or modify `package.json`/`package-lock.json`; a later
`npm ci` restores the published dependencies for release and CI parity. `sync:local-ui` remains an
alias for the complete coherent-stack sync so older development commands are safe.

When the selected Supercode worktree is UI-only, `SUPERCODE_BINARY=/absolute/path/to/supercode` reuses
an explicitly named local binary and skips an unnecessary Rust rebuild.

## Test inclusion bar

Tests are deliberately scarce. Add one only when the behavior is both multi-step or genuinely
complex **and** likely to regress: controller lifecycle transitions, concurrency/leak prevention,
trusted-host boundaries, bounded wire performance, or a previously recurring browser interaction.
Do not test copy, constants, formatting examples, trivial parsers/helpers, or behavior already owned
by Lucarne or Supercode UI. Chromium coverage stays in the nightly workflow, never the merge gate.
