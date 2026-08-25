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

The detailed description should lead with the same user outcomes and support matrix as
the README. It must say that the native companion, macOS or Linux, and a local Claude
Code or Codex installation are required. Do not advertise Windows, Firefox, or other
harnesses until their complete release lanes are verified.

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

Chrome's permission prompt is browser-owned and cannot be accepted by unattended page
automation. The release checklist therefore requires a recorded manual grant and
revoke proof in the isolated profile; Chromium installation remains outside merge CI.
