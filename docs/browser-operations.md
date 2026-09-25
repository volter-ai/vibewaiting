# Supercode browser provider

Vibewaiting provides the active ordinary extension tab to Supercode. Supercode owns
the canonical operation registry, policy decisions, provider selection, SDK, CLI, and
MCP tools. Vibewaiting owns the browser permission boundary and provider adapter, and
answers the operations with Playwright running inside the extension.

Once the extension and native companion are running for a workspace, the shared
Supercode surface is immediately callable from the CLI:

```sh
supercode browser list
supercode browser snapshot
supercode browser query --input '{"locator":{"by":"role","role":"button","name":"Continue"}}'
supercode browser click --input '{"locator":{"by":"ref","value":"e12"}}'
```

The `@volter-ai-dev/supercode-client/browser` SDK calls the same CLI projection. A
running `supercode mcp serve` exposes the same stable `browser.*` tool set and discovers
provider availability dynamically. An agent host needs a restart only when the MCP
server itself has not already been configured; starting or stopping Vibewaiting does
not change the MCP tool list.

Vibewaiting answers all 21 shared operations, `browser.status` through
`browser.script`, with every locator kind the registry defines. Results include an
opaque page handle so follow-up calls remain on the page the agent observed even if
browser focus moves. The handle is replaced when the page's document changes and
never reveals a Chrome tab ID.

The operations are unmodified `playwright-core` 1.63, the client and its CDP half
bundled for the browser (`@volter/almostcdp/playwright`), answered by Supercode's
executor (`@volter-ai-dev/supercode-browser-playwright/executor`). Playwright runs in
a sandboxed extension page (`playwright.html`, where Manifest V3 allows eval) held by
an offscreen document, so it survives the tab's navigations. It reaches a tab in one
of two ways, chosen per tab when an operation arrives:

- **AlmostCDP**, for a page that allows eval: an AlmostCDP surface (`surface.js`)
  runs in the page's main world and idles until an agent first drives that tab; the
  tab's content script relays the surface's port. Playwright's evaluations run with
  `eval` in the page, and events are synthetic (`isTrusted` remains false).
- **Chrome's debugger**, for a page whose Content-Security-Policy forbids
  `unsafe-eval` (GitHub, for example), where the surface cannot evaluate: the
  background attaches `chrome.debugger` to that tab and relays Chrome's own DevTools
  protocol to Playwright, which sees a browser holding that one page. Input is
  Chrome's own. While it is attached, Chrome shows its "Vibewaiting started
  debugging this browser" bar. The debugger detaches 60 seconds after the tab's
  last operation (an approval the person is still deciding keeps it attached),
  and at once when the person cancels the bar, closes the tab or revokes website
  access; the next operation attaches it again. Other tabs are not attached.

`browser.snapshot` leaves out Vibewaiting's own messenger and launcher: the
executor's `snapshotExclude` drops their nodes from the snapshot without changing the
page, so a screen reader still reads them.

## Approvals

Vibewaiting asks the person before an agent changes a page, after Claude in Chrome's
per-site permissions (`extension/browser-policy.ts`):

- **Asks:** every action that can change the page or send it input: click, fill,
  press (with or without a locator), focus, check, uncheck, select, scroll, back,
  forward, reload, every raw mouse down, up and click, wheel, drag, and every
  `browser.script`.
- **Never asks:** reading: status, snapshot, query, wait, box, hover, and moving the
  mouse. Hovering moves the mouse over the element and scrolls it into view, without
  asking.
- **Allowing a site:** a card offers **Deny**, **Allow once** and **Allow on
  &lt;origin&gt; for this task**. The allowance covers that exact origin, in that tab,
  for the agent task that asked, and lives only in the extension's memory. It ends
  after 15 minutes in which it let no action through, when the tab closes, or, for an
  agent connected through `supercode mcp serve`, when that server (the agent's session)
  ends: its random task id dies with it and is never reused. A one-shot CLI call carries
  `SUPERCODE_TASK_ID` when it is set; Vibewaiting cannot see such a task end, so only the
  idle limit and the tab end its allowance. Without a task a card offers only Allow once.
  `supercode mcp serve` always uses its own task id (an environment variable cannot
  replace it).
  Navigating to another origin asks again. Pages without a real origin (about:, data:,
  file:, blob:) never get the site option.
- **Always asks, once only:** `browser.script`; typing (fill or press) into a sensitive
  field: an input whose `type` is `password` or `file`, or whose `autocomplete` names a
  password, a one-time code or a card (`cc-*`), or a field that was one of these when
  the guard saw it earlier on this document (a "Show password" toggle does not make it
  ordinary); raw pointer input whose target cannot be identified (a point inside a
  frame); and any action on a page without a real origin. These cards offer only Allow
  once, even on an allowed origin.

`browser.script` runs its source as JavaScript in the page: the body of an async
function of `args`, evaluated by the page itself, with the page's own power and
nothing more: it can do whatever the page itself can, including reaching other windows
and tabs the page can reach (its opener, windows it opens, same-site tabs through
storage or `BroadcastChannel`). It cannot reach Vibewaiting's extension or the agent;
no agent code runs in the extension. Its card shows the source and arguments and says
it runs as the page.

Whether to ask never depends on what an element is called. The words on and around
the element only shape the card: "may submit, pay or delete" when they include words
such as submit, pay, delete, order, approve, merge or transfer, and "may submit its
form" for Enter in a text field inside a form. A card names the key Playwright
actually sends (modifiers kept, `NumpadEnter` shown as Enter), a select's chosen
options by label and value, a drag's element at the drop point, and a raw pointer
action's point and the element under it. A script card shows the full source and
arguments and says it runs as the page; scripts over 20,000 characters are refused.

What the card describes comes from Supercode's executor, which describes each target
from the browser side: a locator is resolved once (waiting up to 5 s) and the action
runs on that same element handle; the handle must be in the page's main frame and
must be one of the elements found at its box in an isolated world (a one-off marker
attribute confirms it), and those elements are described over CDP (tag, attributes,
accessible role and name, the controls they sit in, whether they belong to a form).
For an element in a `<label>`, the control the label forwards to is described too. A
locator that resolves inside another frame, to a frame, or to a box more than eight
elements share is refused. A locator press focuses its element and is refused if focus
is not then on or inside it; a press without a locator is described from the focused
element and refused when focus is inside a frame or a closed shadow root. Before
every mouse down, up and wheel the mouse is moved to the point that was described;
after a locator action the pointer's position is the acted element's box centre, or
unknown, and a press then needs coordinates. A point inside a frame is described as
"an element that could not be identified", and asks; a point on Vibewaiting's own
messenger or launcher is refused.

On the debugger path those descriptions are Chrome's. On the in-page (AlmostCDP) path
the CDP endpoint itself runs in the page, so the page describes its own elements and
URL, and every card there says "(as described by the page)". What the cards protect
against: an agent's mistakes, on pages that describe themselves honestly. A hostile page
can mislabel its own elements on the in-page path, and nothing an agent types is secret
from the page it types into.

Each document's in-page connection is bound to it by Chrome. The document's surface
port reaches the offscreen document, which takes its tab, frame and document from the
port's sender (Chrome's, never the page's); the background mints a fresh target id for
that document, and the Playwright host registers the connection with AlmostCDP as that
id (`attachSurface(peer, { id })`). The endpoint runs with `requireExpect`, so a
connection that announces any other id, or none the host named, is refused; the
workers a page runs become subsurfaces whose ids AlmostCDP assigns (`<parent>.<n>`,
always `worker` targets), so a page cannot register one under a tab's id. An operation
on a tab goes only to its current document's id, and a tab with no connected document
answers "No page for target" rather than reaching any other page. A page that recorded
another tab's id and token cannot use them.

A page restored from the back/forward cache is not instrumented a second time: its
messenger comes back, but agent calls on the tab fail at once with "This page was
restored from the browser's back/forward cache; reload it to let the agent drive it",
and the messenger shows the person the same line. Reloading (or any new document)
clears it.

On the in-page path Vibewaiting leaves `navigator.webdriver` as the browser reports it,
so the person's signed-in sites do not see an automated browser.

Input goes only to the document that was checked. Just before any input is sent, the
executor confirms the main frame still holds the document the action was checked on
(its loader id and URL) with no navigation requested or loading, and Vibewaiting asks
Chrome for the tab: a navigation in flight (`pendingUrl`), another origin than the one
checked, or, on the in-page path, a page-reported URL that differs from the tab's
refuses the action with `STALE_PAGE`, and nothing is sent. One race remains: on the
debugger path, a back/forward navigation served from the back/forward cache can
complete between the last check and the dispatch of the input, and the input then
reaches the restored page.

The Playwright host takes messages only from the offscreen document that holds it
(trusted `postMessage` events from its parent), and an approved re-run only by a
single-use nonce the background issued for that tab; the approved action's key never
travels with an operation.

When an operation asks, the messenger in that tab opens with the card and the agent's
call stays open: the native companion writes Supercode `pending` lines, and Supercode
waits up to 120 s after each, never past 10 minutes. A caller that does not declare it
can wait is refused at once and the person is not asked. While a card is open, every
other browser operation on that tab is refused with the pending decision named, both
when it is routed and again when a call queued earlier starts to run.

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

- **Allow once** and **Allow on &lt;origin&gt;** re-run that one operation with a
  one-time grant bound to the operation's id, its tab and the exact action the card
  named. The background mints a single-use nonce per card, and the Playwright host's
  offscreen document honours the grant only with that nonce, for that tab, from the
  background. If the page changed so the action no longer matches, nothing runs and
  the agent is told so.
- **Deny** returns `APPROVAL_REQUIRED` with "The person denied this in Vibewaiting: …
  Nothing ran."
- No answer in 90 seconds, or closing the tab, refuses the same way and says why.
- If the agent's call ends first, the card says "The agent stopped waiting. Nothing
  ran." and can no longer allow anything.

## Permissions

The `scripting`, `offscreen`, `debugger`, `nativeMessaging`, `storage`, and optional
HTTP/HTTPS host access are sufficient. Vibewaiting does not request `tabs`,
`cookies`, `webRequest`, browsing-history, or clipboard permission for this provider.
Revoking website access unregisters the content script, detaches the debugger from
any tab it drives, and makes the provider unavailable.

Firefox is not supported. Firefox 149 refuses to install the extension
("background.service_worker is currently disabled"), and the native companion does
not accept Firefox's native-messaging launch, so no browser operation reaches Firefox.
Firefox also has no offscreen documents or extension debugger API; were the extension
running there, every operation would answer `NOT_AVAILABLE` with that reason.
