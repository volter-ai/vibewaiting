# Chrome Web Store submission

This is the maintained submission source of truth. Dashboard answers must remain
consistent with the extension, [PRIVACY.md](../PRIVACY.md), and the current release.

## Listing

**Single purpose:** Follow and continue local Claude Code and Codex sessions from an
isolated browser messenger, with user-invoked page-context attachment and a terminal
view of the same conversation.

**Short description:** Follow local Claude Code and Codex sessions, reply from any tab,
and switch the same conversation into a terminal.

**Category:** Developer Tools

**Detailed description:**

> Vibewaiting is a browser companion for developers who run Claude Code or Codex
> locally. It keeps those sessions within reach while you work in the browser: see what
> each agent is doing, reply from an ordinary tab, attach the page you are looking at,
> or switch the same conversation into a familiar terminal.
>
> Why is a local companion needed? Claude Code and Codex keep their transcripts,
> process state, and tmux-backed terminals on the developer's computer, where Chrome's
> extension sandbox cannot read them. The Vibewaiting companion stays on that computer
> and bridges the extension to the sessions the developer already runs there.
>
> By default, session content stays on your computer. Vibewaiting has no hosted agent
> account, analytics, advertising, or cloud transcript service. Claude Code and Codex
> keep their own credentials; Vibewaiting never receives provider passwords, API keys,
> or login cookies.
>
> Website access is optional. If you enable it, Vibewaiting temporarily remembers the
> page URL and title, your selection, and the latest link, image, or visible control you
> point at or focus so the user-invoked Attach action works in one step. Password fields
> are excluded. Nothing enters a coding-agent session or paired device until you choose
> Attach, and you can revoke website access at any time.
>
> Optional remote access is off by default. When enabled, selected chat and terminal
> traffic travels over HTTPS/WSS through Cloudflare, your configured ngrok account, or
> a stable HTTPS relay to an authenticated device you pair. Insecure relay URLs are
> rejected and stopping remote access closes the route.
>
> Requires macOS or Linux, the Vibewaiting local companion, and a local Claude Code or
> Codex installation signed in with that provider. Chrome, Chromium, and Brave are
> supported in this alpha. Windows, Firefox, and other coding harnesses are not yet
> supported.

**Reviewer instructions (500-character dashboard limit):**

> Requires macOS/Linux, Node 22.12+ or 24+, and a signed-in Claude Code or Codex CLI; no
> Vibewaiting account. Run `npm i -g https://github.com/volter-ai/vibewaiting/releases/download/v0.1.2/vibewaiting-0.1.2.tgz`
> and `vibewaiting native install --browser chrome`. Open Options, save an existing
> folder, read/allow optional website access, and keep one agent session running. On an
> HTTP(S) page press Alt+Shift+V; open it, reply, Attach a selection, switch Terminal.
> Remote access is optional/off.

Do not advertise Windows, Firefox, or other harnesses until their complete release
lanes are verified.

## Permission justifications

| Permission | Dashboard justification |
| --- | --- |
| Optional HTTP/HTTPS host access | Granted from Vibewaiting onboarding after a prominent disclosure. It places the messenger on ordinary pages, supports explicit context attachment, and enables invoked local agent tools to inspect or operate the active tab through a fixed, bounded operation set. Password/file fields and consequential controls fail closed. No extension code runs on websites before consent. |
| Native messaging | Chrome's sandbox cannot read the local transcripts, process state, or terminals created by Claude Code and Codex. This permission connects the extension-owned messenger to the on-device Vibewaiting companion that bridges those existing sessions. |
| Scripting | Registers the content script only after optional website access is granted and unregisters it when access is revoked. |
| Storage | Keeps workspace selection, browser-local UI preferences, and overlay geometry. |
| Context menus | Provides a user-invoked fallback for attaching a selected link. |

The extension does not request tabs, cookies, webRequest, browsing history, clipboard,
downloads, or file-URL access.

## User-data declarations

- Website content, browsing activity, and the latest pointer/focus target are handled
  for the disclosed overlay, explicit attachment, and invoked local browser-tool features.
- Page context enters the native companion only when the user chooses Attach or a local
  Supercode caller invokes a bounded browser snapshot/query operation.
- Local agent session content is read from the user's computer and rendered only in an
  extension-owned iframe or an authenticated paired device.
- Remote access is optional. When enabled, selected Cloudflare, ngrok, or configured
  stable-HTTPS-relay infrastructure processes encrypted chat and terminal transport to
  the paired device.
- No data is sold, used for advertising or credit decisions, or exposed for human
  review.
- The public privacy-policy URL is
  `https://github.com/volter-ai/vibewaiting/blob/main/PRIVACY.md` after launch.

## Required assets and proof

The final Chrome Web Store item ID must be
`mpmpjbiopkncpnaihljcldljbpmaiiaj`. It is derived from the public key in the packaged
manifest and is also the origin authorized by the native installer. Configure the
repository variable `CHROME_WEB_STORE_EXTENSION_ID` to this value before tagging; the
release workflow rejects a missing or different store identity.

Do not submit until the release candidate has:

- a 128×128 store icon from the packaged Vibewaiting icon;
- at least one real 1280×800 or 640×400 screenshot of the messenger on an ordinary
  page, with all private paths and session content replaced by deliberate demo data;
- a real screenshot of Chat/Terminal switching and one of the website-access
  disclosure;
- an optional 440×280 promotional tile using the same monochrome identity;
- a support URL, privacy URL, and monitored developer contact;
- a clean install proof on a profile with no prior Vibewaiting permissions;
- enable, deny, revoke, extension-update, native-companion-update, and uninstall proofs;
- confirmation that packaged code contains no remote executable code.

Reviewable store artwork belongs in `docs/assets/store/`. Screenshots must be captured
from the release candidate with deliberate demo data, never from a maintainer's real
sessions. `npm run verify:store-assets` validates the required filenames and dimensions.

Chrome's permission prompt is browser-owned and cannot be accepted by unattended page
automation. The release checklist therefore requires a recorded manual grant and
revoke proof in the isolated profile; Chromium installation remains outside merge CI.
