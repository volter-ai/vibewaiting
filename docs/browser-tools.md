# Browser tools

Vibewaiting gives a coding agent the tab the person is looking at, through a normal
MCP server the agent's harness registers like any other:

```sh
claude mcp add vibewaiting -- vibewaiting mcp
codex mcp add vibewaiting -- vibewaiting mcp
```

The tools are Playwright's own: the core set `@playwright/mcp` serves, with the schemas
it publishes (`dist/browser-tools.json`, generated from the pinned `playwright-core` at
build time). Vibewaiting serves 15 of them:

- **Reading:** `browser_snapshot`, `browser_take_screenshot`, `browser_find`,
  `browser_hover`, `browser_wait_for`, `browser_console_messages`.
- **Acting:** `browser_click`, `browser_drag`, `browser_select_option`, `browser_type`,
  `browser_fill_form`, `browser_press_key`, `browser_navigate`, `browser_navigate_back`,
  `browser_handle_dialog`.

It does not serve the tools that reach past the page the person shares:
`browser_evaluate` and `browser_run_code_unsafe` (code), `browser_file_upload` and
`browser_drop` (files), `browser_tabs` and `browser_close` (other tabs),
`browser_resize` (the person's window), and `browser_network_requests` and
`browser_network_request` (the headers and bodies of the page's own requests, which
carry its cookies and tokens). `browser_navigate` goes only to http and https
addresses. No agent code runs in the page or in the
extension.

`vibewaiting mcp` forwards each call to the running native companion, over a loopback
socket whose address and token the companion writes to `~/.vibewaiting/browser/`
(readable only by the person's account); the extension answers it on the active tab of
the last-focused window. Playwright's MCP tool backend (the one `@playwright/mcp`
runs) answers inside the extension, in a sandboxed page (`playwright.html`, where
Manifest V3 allows eval) held by an offscreen document so it survives the tab's
navigations. That backend is unmodified `playwright-core` 1.63 bundled for the browser
(`@volter/almostcdp/playwright`). It reaches a tab in one of two ways, chosen per tab
when a call arrives:

- **AlmostCDP**, for a page that allows eval: an AlmostCDP surface (`surface.js`)
  runs in the page's main world and idles until an agent first drives that tab; the
  tab's content script relays the surface's port to that tab's own endpoint. Playwright's
  evaluations run with `eval` in the page, and events are synthetic (`isTrusted`
  remains false).
- **Chrome's debugger**, for a page whose Content-Security-Policy forbids
  `unsafe-eval` (GitHub, for example), where the surface cannot evaluate: the
  background attaches `chrome.debugger` to that tab and relays Chrome's own DevTools
  protocol to Playwright, which sees a browser holding that one page. Input is
  Chrome's own. While it is attached, Chrome shows its "Vibewaiting started
  debugging this browser" bar. The debugger detaches 60 seconds after the tab's
  last call (an approval the person is still deciding keeps it attached),
  and at once when the person cancels the bar, closes the tab or revokes website
  access; the next call attaches it again. Other tabs are not attached.

An agent names elements by the refs of the page's own snapshot (`e12`), for reading
calls too: a call that names a selector, or an element inside a frame, is refused, and so
is a key press while focus is inside a frame. After an action the answer
says what ran; the agent takes `browser_snapshot` to see the page again (there is no
file system for the snapshot `@playwright/mcp` would save beside it). Vibewaiting's own
messenger and launcher appear in snapshots, and every call on them, or a key press while
one of them has focus, is refused.

## Approvals

Vibewaiting asks the person before an agent changes a page, after Claude in Chrome's
per-site permissions (`extension/browser-policy.ts`):

- **Asks:** every acting call: click, drag, select, type, fill a form, press a key,
  navigate, go back, and answering the page's dialog.
- **Never asks:** reading: snapshots, screenshots, finding text, waiting, hovering,
  console reads.
- **Allowing a site:** a card offers **Deny**, **Allow once** and **Allow on
  &lt;origin&gt; for this task**. The allowance covers that exact origin, in that tab,
  for the agent task that asked, and lives only in the extension's memory. A task is
  one `vibewaiting mcp` server (the agent's session): its random id dies with it and is
  never reused. The allowance ends after 15 minutes in which it let no action through,
  when the tab closes, or when the task ends. Navigating asks unless the destination's
  origin is allowed. Pages without a real origin (about:, data:, file:, blob:) never
  get the site option.
- **Always asks, once only:** typing (type, fill a form, press a key) into a sensitive
  field: an input whose `type` is `password` or `file`, or whose `autocomplete` names a
  password, a one-time code or a card (`cc-*`), or a field that was one of these when
  the policy saw it earlier on this document (a "Show password" toggle does not make it
  ordinary); and any action on a page without a real origin. These cards offer only
  Allow once, even on an allowed origin, and never show what would be typed.

Whether to ask never depends on what an element is called. The words on and around
the element only shape the card: "may submit, pay or delete" when they include words
such as submit, pay, delete, order, approve, merge or transfer, and "may submit its
form" for Enter in a text field inside a form. A card names the element by its label,
`aria-label`, title, button value, alt text, placeholder or text, or by the controls it
sits in.

The page describes its own elements: the policy asks the page, through Playwright, what
each ref is, and every card says "(as described by the page)". What the cards protect
against: an agent's mistakes, on pages that describe themselves honestly. A hostile page
can mislabel its own elements, and nothing an agent types is secret from the page it
types into.

Each document's in-page connection is bound to it by Chrome. The document's surface
port reaches the offscreen document, which takes its tab, frame and document from the
port's sender (Chrome's, never the page's); the background mints a fresh target id for
that document, and the Playwright host registers the connection with that tab's
AlmostCDP endpoint as that id (`attachSurface(peer, { id })`). Each tab is its own
endpoint, so a tab's Playwright browser holds only that tab's documents. The endpoint
runs with `requireExpect`, so a connection that announces any other id, or none the
host named, is refused; the workers a page runs become subsurfaces whose ids AlmostCDP
assigns (`<parent>.<n>`, always `worker` targets), so a page cannot register one under a
tab's id. A call on a tab goes only to its current document's id, and a tab with no
connected document answers "No page for target" rather than reaching any other page.

A page restored from the back/forward cache is not instrumented a second time: its
messenger comes back, but agent calls on the tab fail at once with "This page was
restored from the browser's back/forward cache; reload it to let the agent drive it",
and the messenger shows the person the same line. Reloading (or any new document)
clears it.

On the in-page path Vibewaiting leaves `navigator.webdriver` as the browser reports it,
so the person's signed-in sites do not see an automated browser.

Just before an acting call runs, Vibewaiting asks Chrome for the tab: a navigation in
flight (`pendingUrl`), another origin than the one checked, or, on the in-page path, a
page-reported URL that differs from the tab's refuses the call, and nothing is sent.
Playwright then resolves the ref again as it acts. One race remains: the page can change
between that check and the input, and the input then reaches what the ref names at that
moment.

An approval holds only for the exact call on the same elements of the same document:
each element is identified on its document the first time the policy sees it, each
document when an approval is asked, and a dialog by its own opening, so an element
described the same way, a new document at the same address, or the next dialog is
another action. An approved re-run, whether the person pressed Allow once or Allow on
&lt;origin&gt;, runs only if its call still matches the card. A card for a dialog names
its kind and message.

A call the agent stopped waiting for (its call was cancelled, or the extension told it
the page did not answer in 30 seconds) never starts if it was still queued, and is
aborted if it was running.

The Playwright host takes messages only from the offscreen document that holds it
(trusted `postMessage` events from its parent), and an approved re-run only by a
single-use nonce the background issued for that tab; the approved action's key never
travels with a call.

When a call asks, the messenger in that tab opens with the card and the agent's call
stays open: the companion writes a `pending` line and `vibewaiting mcp` reports it as MCP
progress while it waits, and writes another when the person allows it and the call runs. While a card is open, every other call on that tab is refused
with the pending decision named, both when it is routed and again when a call queued
earlier starts to run.

Against clickjacking, measured inside the extension's frame: an Allow button arms only
after the card has been fully visible and still for a second (IntersectionObserver v2:
not covered, faded or transformed; any move or resize of the card or of the messenger
frame restarts it) and the pointer, having moved onto that button, had rested there for
half a second when the button is pressed: movement of 3 px or more, leaving or
re-entering the button, or the frame moving restarts it, movement between press and
release is ignored, and inside the frame a change in `screenX - clientX` (or its Y twin)
between pointer events counts as the frame moving. A button that appears under a
pointer that is not moving does not arm. An unarmed button reads "Hold still to allow",
and pressing it says so instead of doing nothing silently. By keyboard, Enter or Space
on an Allow button works when the visibility gate has passed and focus has rested on
the button for half a second, having arrived there by the person's own Tab or pointer
press inside the messenger; focus given by a script, including the page focusing the
messenger's frame, never arms, and Enter then shows the hold-still hint. The card never takes
focus, so a keystroke meant for the page cannot answer it.

- **Allow once** and **Allow on &lt;origin&gt;** re-run that one call with a
  one-time grant bound to the call's id, its tab and the exact action the card
  named. The background mints a single-use nonce per card, and the Playwright host's
  offscreen document honours the grant only with that nonce, for that tab, from the
  background. If the page changed so the action no longer matches, nothing runs and
  the agent is told so.
- **Deny** answers the call with an error: "The person denied this in Vibewaiting: …
  Nothing ran."
- No answer in 90 seconds, or closing the tab, refuses the same way and says why.
- If the agent's call ends first, the card says "The agent stopped waiting. Nothing
  ran." and can no longer allow anything.

## Permissions

The `scripting`, `offscreen`, `debugger`, `nativeMessaging`, `storage`, and optional
HTTP/HTTPS host access are sufficient. Vibewaiting does not request `tabs`,
`cookies`, `webRequest`, browsing-history, or clipboard permission for its browser
tools. Revoking website access unregisters the content script, detaches the debugger
from any tab it drives, and leaves the tools nothing to act on.

Firefox is not supported. Firefox 149 refuses to install the extension
("background.service_worker is currently disabled"), and the native companion does
not accept Firefox's native-messaging launch, so no tool call reaches Firefox.
Firefox also has no offscreen documents or extension debugger API; were the extension
running there, every call would answer with that reason.
