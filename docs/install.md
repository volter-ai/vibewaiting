# Install, update, and remove

The current alpha supports macOS or Linux with Chrome, Chromium, or Brave and a local
Claude Code or Codex installation. Windows and Firefox are not yet release-supported.

## Install a release

Download the native package and `SHA256SUMS` from the newest
[GitHub Release](https://github.com/volter-ai/vibewaiting/releases). Verify the package,
then install it:

```sh
npm install --global ./vibewaiting-0.1.0.tgz
vibewaiting native install --browser chrome
```

Use `--browser brave` or `--browser chromium` when appropriate. The command prints the
durable extension folder. Open the browser's extensions page, enable developer mode,
choose **Load unpacked**, and select that folder. This one browser step remains necessary
until signed store distribution is available.

The separately published extension ZIP is the same browser payload for inspection and
packaging; the native package already contains the durable extension folder you need.

Open Vibewaiting's extension settings, choose the workspace whose sessions you want to
follow, and select **Save and connect**. A launcher appears on ordinary HTTP and HTTPS
pages. The default agent choice discovers Claude Code or Codex automatically.

## Update

Download the new native package, verify its checksum, and install it over the existing
version:

```sh
npm install --global ./vibewaiting-NEW_VERSION.tgz
vibewaiting native install --browser chrome
```

The extension folder remains at the same global package path. Reload Vibewaiting from
the browser extensions page or restart the browser. Signed store releases will replace
this manual reload path.

## Remove

Remove Vibewaiting from the browser, then uninstall its package:

```sh
npm uninstall --global vibewaiting
```

The browser native-messaging manifest and local state are intentionally not deleted by
npm. Remove the manifest printed by `vibewaiting native install` and
`~/.local/share/vibewaiting` if you want to erase the launcher, drafts, unread state,
presentation memory, and paired-device state as well.

## Install from source

```sh
git clone https://github.com/volter-ai/vibewaiting.git
cd vibewaiting
npm ci
npm run build
node dist/cli.js native install --browser chrome
```

Load `dist/extension` as the unpacked extension. Source development and local Supercode
workflows are covered in [CONTRIBUTING.md](../CONTRIBUTING.md).
