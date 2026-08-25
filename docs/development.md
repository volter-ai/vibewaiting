# Extension development

Run `npm run dev:extension` once. It owns a persistent, isolated Brave or Chromium
profile, installs the matching native host, watches Vibewaiting sources, and reloads the
extension and ordinary web tabs after each successful build. Settings survive restarts.

The development loop selects the browser process whose loaded-extension directory
matches the current checkout. Every reload is checked against the completed build's
content fingerprint, so a stale or wrong checkout is an error rather than a successful
update.

These environment variables customize the loop:

| Variable | Purpose |
| --- | --- |
| `VIBEWAITING_DEV_BROWSER` | Brave or Chromium executable |
| `VIBEWAITING_DEV_CDP_PORT` | Dedicated debugging port |
| `VIBEWAITING_DEV_PROFILE` | Isolated browser profile directory |
| `VIBEWAITING_DEV_URL` | Initial ordinary web page |
| `VIBEWAITING_DEV_WORKSPACE` | Workspace selected on a new profile |

## Develop against local Supercode

The default path uses packages pinned by `package-lock.json`. To use an adjacent
Supercode source checkout coherently, run:

```sh
npm run dev:extension:local
```

This builds the local Supercode binary and syncs its harness SDK, client, UI, and
terminal packages into this checkout without modifying `package.json` or the lockfile.
The selected source worktree and binary are recorded in ignored local state and reused
by subsequent `npm run dev:extension` invocations. `npm ci` restores published-package
parity.

Set `SUPERCODE_DIR` for a non-sibling checkout. An explicitly named
`SUPERCODE_BINARY=/absolute/path/to/supercode` avoids rebuilding Rust when the selected
worktree changes UI only. Local Lucarne and Widget Shell sources are opt-in through
`VIBEWAITING_LOCAL_SURFACES=1`, with `LUCARNE_DIR` and `WIDGET_SHELL_DIR` available for
non-sibling checkouts.

The development loop never runs in CI. Chromium installation remains confined to the
nightly browser workflow.
