# Install, update, and remove

The current alpha supports macOS or Linux with Chrome, Chromium, or Brave and a local
Claude Code or Codex installation. Windows and Firefox are not yet release-supported.

## Install a release

Install the signed extension from the Chrome Web Store when its listing is available.
While the first store release is under review, download the native package and
`SHA256SUMS` from the newest
[GitHub Release](https://github.com/volter-ai/vibewaiting/releases). Verify the package,
then install it:

```sh
npm install --global ./vibewaiting-0.1.1.tgz
vibewaiting native install --browser chrome
```

Use `--browser brave` or `--browser chromium` when appropriate. The command prints the
durable extension folder used for source or pre-store testing. For that path, open the
browser's extensions page, enable developer mode, choose **Load unpacked**, and select
the folder. Store-installed users do not load the extension folder manually.

The separately published extension ZIP is the same browser payload for inspection and
packaging; the native package already contains the durable extension folder you need.

Open Vibewaiting's extension settings. The three-step setup verifies the local
companion, asks for the folder where new chats should run, and then explains website
access before the browser-owned permission prompt. Existing Claude Code and Codex
sessions are discovered automatically; the folder is not a filter on existing chats.
When all three steps are complete, a launcher appears on ordinary HTTP and HTTPS pages.
You can revoke website access from the same screen at any time; revocation removes the
launcher and page-context listener from open tabs.

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

Remove Vibewaiting from the browser, unregister each browser where you installed the
native host, then uninstall its package:

```sh
vibewaiting native uninstall --browser chrome --purge-state
npm uninstall --global vibewaiting
```

Use `--browser brave` or `--browser chromium` for each additional registration. The
shared launcher remains until the last browser is unregistered. Omit `--purge-state`
to preserve drafts, unread state, presentation memory, and the stable remote-tunnel
identity in `~/.vibewaiting` for a later reinstall. Browser
settings are removed when you remove the extension; paired-device sessions expire when
the native bridge stops.

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
