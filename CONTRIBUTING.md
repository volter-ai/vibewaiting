# Contributing to Vibewaiting

Thanks for helping make coding-agent sessions easier to follow and continue from the
browser.

Read the [Code of Conduct](CODE_OF_CONDUCT.md), [architecture](docs/architecture.md),
and [roadmap](ROADMAP.md) before proposing a substantial change. Security-sensitive
work should follow [SECURITY.md](SECURITY.md).

Release and repository-administration work also follows the
[public launch checklist](docs/public-launch-checklist.md) and
[release procedure](docs/releasing.md).

## Development setup

Requirements:

- Node.js 22.12 or newer on an LTS release line (22, 24, and later) and npm
- macOS or Linux for native-host development
- Chrome, Chromium, or Brave for extension validation
- a locally installed coding harness supported by Supercode

```sh
git clone https://github.com/volter-ai/vibewaiting.git
cd vibewaiting
npm ci
npm run check
```

`npm run check` is the merge gate: strict TypeScript, the focused Vitest suite, and a
production build. Chromium tests are deliberately excluded from merge CI and run only
in the nightly browser workflow or manually with `npm run check:browser`.

To exercise an unpacked development extension:

```sh
npm run dev:extension
```

This uses an isolated browser profile, installs a development native host, watches the
relevant sources, and reloads only after a successful build. See
[the development guide](docs/development.md) before pointing it at a non-default
checkout.

Contributors working on Supercode and Vibewaiting together can run `npm run sync:local`
to install a coherent adjacent Supercode build into this checkout without modifying the
lockfile, or use `npm run dev:extension:local` for the initial sync and development launch.

Vibewaiting consumes published Supercode packages in a normal checkout. Contributors
can build and test this repository without Supercode source access; changes to agent
semantics or shared UI require coordination with the Supercode maintainers until that
repository is publicly available.

## Scope and design rules

- Keep Vibewaiting a thin browser/mobile companion. Harness semantics and reusable chat
  components belong in Supercode packages; generic overlay geometry belongs in Widget
  Shell.
- Preserve the browser/native boundary. Never send locators, filesystem recovery paths,
  tmux handles, credentials, or execution policy into ordinary page content.
- Capability-gate behavior. A fabricated fallback identity or action is a bug.
- Keep merge CI under one minute. Browser installation and Chromium belong to nightly
  validation.
- Generated `dist/` output and `.vibewaiting/` state are not committed.

## Test inclusion bar

Tests are intentionally scarce. Add one only when behavior is both genuinely complex
and likely to regress: lifecycle transitions, concurrency or leak prevention, a trusted
host boundary, bounded-wire performance, or a recurring browser interaction. Do not
add tests for copy, constants, formatting examples, trivial parsers, or behavior owned
by an upstream package.

Every pull request should explain how it was verified. A focused manual proof is often
more appropriate than a new test.

## Pull requests

1. Start from a focused issue or explain the user problem in the pull request.
2. Keep unrelated cleanup out of the change.
3. Run `npm run check`.
4. Update public documentation when behavior, permissions, setup, or trust boundaries
   change.
5. Use a concise conventional commit title such as `feat:`, `fix:`, `docs:`, or `chore:`.

By submitting a contribution, you agree that it is licensed under the repository's
[MIT License](LICENSE).
