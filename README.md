# vibewaiting

Vibe code without leaving your browser: a lucarne glass widget in the corner of every page, wired to the coding agents in your CLIs via supercode.

Vibewaiting is intentionally a thin composition:

- Lucarne provides browser attachment, isolation, launcher lifecycle, and the glass shell.
- `@volter-ai-dev/supercode-client` owns session/runtime state and capability-gated actions.
- `@volter-ai-dev/supercode-ui` supplies the component library and complete Storybook contract.
- This repository bridges bounded state, trusted host persistence, notifications, and intents.

The browser never receives native locators, recovery paths, credentials, or execution policy. In
particular, reduce-and-continue is shown only when the Supercode controller exposes its real
reversible operation; success is rendered only from a disk-verified reduction receipt.

Vibewaiting appears directly in the attached browser's normal windows and tabs. Lucarne's porthole
is an optional remote/headless viewing surface, not the primary way a local user browses.

## Local Supercode UI development

Run `npm run sync:local-ui` to build and install the adjacent Supercode UI checkout directly into
Vibewaiting's working `node_modules`; pass another UI directory as the final argument or set
`SUPERCODE_UI_DIR` when the repositories are not siblings. The sync does not contact npm or modify
`package.json`/`package-lock.json`. A later `npm ci` restores the published dependency for release
and CI parity.

## Test inclusion bar

Tests are deliberately scarce. Add one only when the behavior is both multi-step or genuinely
complex **and** likely to regress: controller lifecycle transitions, concurrency/leak prevention,
trusted-host boundaries, bounded wire performance, or a previously recurring browser interaction.
Do not test copy, constants, formatting examples, trivial parsers/helpers, or behavior already owned
by Lucarne or Supercode UI. Chromium coverage stays in the nightly workflow, never the merge gate.
