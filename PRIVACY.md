# Privacy

Vibewaiting is local-first. It has no analytics, advertising SDK, hosted account,
telemetry endpoint, or Volter-operated transcript service. Your coding-agent sessions
stay on the computer where their harness stores them unless you deliberately enable
remote access.

## Browser permissions

| Permission | Why it is needed |
| --- | --- |
| Optional access to websites | Place the isolated messenger overlay on ordinary pages and capture context you explicitly attach. You grant or revoke HTTP/HTTPS access from Vibewaiting settings. |
| Native messaging | Connect the extension-owned messenger to the local Vibewaiting companion. |
| Storage | Remember the selected workspace and local UI preferences. |
| Context menus | Offer a precise fallback for attaching a link. |

The page-facing content script receives only enough state to render the launcher. Full
session state renders inside an extension-origin iframe. While website access is
enabled, the page-facing script remembers the most recent link, image, or meaningful
element you point at or focus on in local memory so one-action Attach can work after the
pointer crosses into the overlay. Page text, selections, links, and images do not cross
into the local companion until you use Attach. URLs are normalized to remove
credentials, credential-like parameters, and tracking parameters.

The use of information received from Google APIs adheres to the Chrome Web Store User
Data Policy, including its Limited Use requirements. Vibewaiting uses browser and page
data only to provide its disclosed messenger and explicit context-attachment features;
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
terminal traffic you use remotely travel through the selected transport provider to
your paired device. Automatic mode may select Cloudflare; you can instead choose an
installed ngrok client or a stable relay you configure. Those providers process the
transport under their own terms and privacy policies: see
[Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/) and
[ngrok's privacy policy](https://ngrok.com/legal/privacy). A stable relay is infrastructure
chosen and configured by the user. Temporary URLs are not durable app identities.
Pairing is short-lived, authenticated devices can be revoked, and stopping access
closes the public route. Vibewaiting does not intentionally retain a remote transcript
copy after the local bridge stops. See [SECURITY.md](SECURITY.md) for the trust model.

## Questions

For privacy questions, open a GitHub Discussion without including session content or
email `aaron@volter.ai`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
