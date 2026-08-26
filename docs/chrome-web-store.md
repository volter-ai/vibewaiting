# Chrome Web Store submission

This is the maintained submission source of truth. Dashboard answers must remain
consistent with the extension, [PRIVACY.md](../PRIVACY.md), and the current release.

## Listing

**Single purpose:** Follow and continue local Claude Code and Codex sessions from an
isolated messenger on ordinary browser pages, with explicit one-action attachment of
page context.

**Short description:** Follow local coding agents, reply from any browser tab, and
switch the same conversation into a terminal.

**Category:** Developer Tools

**Detailed description:**

> Vibewaiting keeps your local Claude Code and Codex sessions within reach while you
> work in the browser. Open a compact messenger on ordinary tabs, see what each agent is
> doing, reply, attach the page you are looking at, or switch the same conversation into
> a familiar terminal.
>
> Sessions and credentials remain on your computer. Vibewaiting has no hosted agent
> account, analytics, advertising, or cloud transcript service. Website access is
> optional and is requested only after a plain-language disclosure. Page context enters
> the local companion only when you explicitly choose Attach. Optional remote access is
> off until enabled and uses a paired, authenticated device.
>
> Requires macOS or Linux, the Vibewaiting native companion, and a local Claude Code or
> Codex installation. Chrome, Chromium, and Brave are supported in this alpha. Windows,
> Firefox, and other coding harnesses are not yet supported.

Do not advertise Windows, Firefox, or other harnesses until their complete release
lanes are verified.

## Permission justifications

| Permission | Dashboard justification |
| --- | --- |
| Optional HTTP/HTTPS host access | Granted from Vibewaiting onboarding after a prominent disclosure. It places the messenger on ordinary pages and remembers the latest pointed or focused page target locally so the user can explicitly attach it. No extension code runs on websites before consent. |
| Native messaging | Connects the extension-owned messenger to the local Vibewaiting companion that reads and continues local coding-agent sessions. |
| Scripting | Registers the content script only after optional website access is granted and unregisters it when access is revoked. |
| Storage | Keeps workspace selection, browser-local UI preferences, and overlay geometry. |
| Context menus | Provides a user-invoked fallback for attaching a selected link. |

The extension does not request tabs, cookies, webRequest, browsing history, clipboard,
downloads, or file-URL access.

## User-data declarations

- Website content and browsing activity are handled locally only for the disclosed
  overlay and explicit attachment features.
- Page context does not enter the native companion until the user chooses Attach.
- Local agent session content is read from the user's computer and rendered only in an
  extension-owned iframe or an authenticated paired device.
- Remote access is optional. When enabled, selected Cloudflare, ngrok, or configured
  stable-relay infrastructure processes chat and terminal transport to the paired
  device.
- No data is sold, used for advertising or credit decisions, or exposed for human
  review.
- The public privacy-policy URL is
  `https://github.com/volter-ai/vibewaiting/blob/main/PRIVACY.md` after launch.

## Required assets and proof

The final Chrome Web Store item ID must be
`dbcbmeiocgelabifljkclkacecapalgj`. It is derived from the public key in the packaged
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
