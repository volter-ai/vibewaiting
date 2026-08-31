# Privacy

Vibewaiting is local-first developer tooling. It has no analytics, advertising SDK, hosted account,
telemetry endpoint, or Volter-operated transcript service. By default, your
coding-agent sessions stay on the computer where their harness stores them. If you
deliberately enable remote access, selected chat and terminal traffic travels through
the tunnel provider you choose to a paired device.

## Data Vibewaiting handles

| Data | Why and when it is handled | Where it goes and how long it lasts |
| --- | --- | --- |
| Coding-agent messages and terminal traffic | Show and continue the local Claude Code or Codex session you select. | Read from the local harness. Browser-local drafts and unread boundaries remain until removed; the harness owns transcript retention. Remote traffic leaves the computer only while remote access is enabled. |
| Page URL and title, selected text, and the latest link, image, or visible control pointed at or focused | Keep the messenger on ordinary pages and make the explicit **Attach** action work in one step. | Held temporarily in browser memory and replaced as you move, focus, navigate, or close the page. It enters the local companion only when you choose **Attach**; attached content then follows the selected harness's transcript retention. |
| Pointer and focus activity | Determine which visible page target **Attach** should offer. | Used only in temporary browser memory. Vibewaiting does not create an activity history or send this activity to Volter. |
| Active-page accessibility snapshots and browser-operation results | Answer a Supercode browser operation that you or a local agent invokes. | Returned through the loopback native companion to Supercode. Vibewaiting does not host a copy; the calling agent may retain tool input/output under its own transcript policy. |
| Workspace path, UI choices, drafts, unread boundaries, and remote-device state | Restore local settings and the messenger state. | Stored in browser storage or `~/.vibewaiting` until you remove or purge it. |
| Vibewaiting pairing grants, passcodes, and device-session cookies | Authenticate a phone or other remote browser that you explicitly pair. | Short-lived grants expire; paired devices remain authorized until revoked. Agent-provider passwords, API keys, and login cookies are not read or stored by Vibewaiting. |

## Browser permissions

| Permission | Why it is needed |
| --- | --- |
| Optional access to websites | Place the isolated messenger overlay on ordinary pages, capture context you explicitly attach, and let invoked local browser tools inspect or operate the active page. You grant or revoke HTTP/HTTPS access from Vibewaiting settings. |
| Native messaging | Chrome cannot read local coding-agent transcripts, process state, or terminals. This connects the extension-owned messenger to the on-device Vibewaiting companion that can bridge those existing Claude Code and Codex sessions. |
| Storage | Remember the selected workspace and local UI preferences. |
| Context menus | Offer a precise fallback for attaching a link. |

The page-facing content script receives only enough coding-agent state to render the
launcher plus a redacted remote-access status. Full session state, pairing URLs,
passcodes, and device details render inside an extension-origin iframe. Website access
is requested only after an in-product disclosure names the page data and pointer/focus
activity described above. Password/file fields and consequential browser controls fail
closed in browser tools. Page text, selections, links, and images do not cross into the
local companion unless you use **Attach** or invoke a browser snapshot/query operation. URLs are
normalized to remove credentials, credential-like parameters, and tracking parameters.
Disabling website access unregisters the page script and removes the overlay from open
pages.

The use of information received from Google APIs adheres to the Chrome Web Store User
Data Policy, including its Limited Use requirements. Vibewaiting uses browser and page
data only to provide its disclosed messenger, context-attachment, and local browser-tool features;
it does not sell the data, use it for advertising, or allow humans to read it.

## Data on your computer

Vibewaiting reads agent sessions through Supercode and stores local drafts, unread
boundaries, presentation choices, and remote-device state. Native paths, credentials,
tmux handles, and execution policy are not exposed to ordinary web pages. Removing the
extension removes browser-local settings. Run
`vibewaiting native uninstall --browser <browser> --purge-state` before removing the
native package to unregister the browser, remove the shared launcher when it is no
longer used, and erase state in `~/.vibewaiting`.

## Remote access

Remote access is off until you turn it on. When enabled, chat state, messages, and any
terminal traffic you use remotely travel over HTTPS/WSS through the selected transport
provider to your paired device. Automatic mode may select Cloudflare; you can instead
choose an installed ngrok client or a stable HTTPS relay you configure. Insecure stable
relay URLs are rejected. Those providers process the
transport under their own terms and privacy policies: see
[Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) and
[ngrok's privacy policy](https://ngrok.com/legal/privacy). A stable relay is infrastructure
chosen and configured by the user. Temporary URLs are not durable app identities.
Pairing is short-lived, authenticated devices can be revoked, and stopping access
closes the public route. Vibewaiting does not intentionally retain a remote transcript
copy after the local bridge stops. See [SECURITY.md](SECURITY.md) for the trust model.

## Delete your data

Removing the extension deletes its browser-local settings. To unregister the native
bridge and delete Vibewaiting's local drafts, unread state, pairing state, and stable
tunnel identity, run
`vibewaiting native uninstall --browser <browser> --purge-state` before uninstalling the
native package. Agent transcripts remain subject to Claude Code's or Codex's own
retention and deletion controls.

## Questions

For privacy questions, open a GitHub Discussion without including session content or
email `aaron@volter.ai`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
