# Privacy

Vibewaiting is local-first. It has no analytics, advertising SDK, hosted account,
telemetry endpoint, or Volter-operated transcript service. Your coding-agent sessions
stay on the computer where their harness stores them unless you deliberately enable
remote access.

## Browser permissions

| Permission | Why it is needed |
| --- | --- |
| Read and change data on websites | Place the isolated messenger overlay on ordinary pages and capture only context you explicitly attach. |
| Native messaging | Connect the extension-owned messenger to the local Vibewaiting companion. |
| Storage | Remember the selected workspace and local UI preferences. |
| Context menus | Offer a precise fallback for attaching a link. |

The page-facing content script receives only enough state to render the launcher. Full
session state renders inside an extension-origin iframe. Page text, selections, links,
and images do not cross into the local companion until you use Attach. URLs are
normalized to remove credentials, credential-like parameters, and tracking parameters.

## Data on your computer

Vibewaiting reads agent sessions through Supercode and stores local drafts, unread
boundaries, presentation choices, and remote-device state. Native paths, credentials,
tmux handles, and execution policy are not exposed to ordinary web pages. Removing the
extension removes browser-local settings; remove the native package and
`~/.local/share/vibewaiting` to remove its installed launcher and local state.

## Remote access

Remote access is off until you turn it on. When enabled, Vibewaiting exposes its local
messenger through the provider you select. Temporary Cloudflare or ngrok URLs route
encrypted traffic but are not durable app identities. A stable relay is used only when
you configure one. Pairing is short-lived, authenticated devices can be revoked, and
stopping access closes the public route. See [SECURITY.md](SECURITY.md) for the trust
model.

## Questions

For privacy questions, open a GitHub Discussion without including session content or
email `yueranyuan@gmail.com`. Report vulnerabilities through [SECURITY.md](SECURITY.md).
