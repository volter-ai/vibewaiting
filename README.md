# vibewaiting

Vibe code without leaving your browser: a lucarne glass widget in the corner of every page, wired to the coding agents in your CLIs via supercode.

Vibewaiting is intentionally a thin composition:

- Lucarne owns browser attachment, isolation, launcher lifecycle, and the glass shell.
- `@volter-ai-dev/supercode-client` owns session/runtime state and capability-gated actions.
- `@volter-ai-dev/supercode-ui` supplies the component library and complete Storybook contract.
- This repository bridges bounded state, trusted host persistence, notifications, and intents.

The browser never receives native locators, recovery paths, credentials, or execution policy. In
particular, reduce-and-continue is shown only when the Supercode controller exposes its real
reversible operation; success is rendered only from a disk-verified reduction receipt.
