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
  `browser.script` (Playwright with the real `page`, including `page.evaluate`).
- **Never asks:** reading: status, snapshot, query, wait, box, hover, and moving the
  mouse.
- **Allowing a site:** a card offers **Deny**, **Allow once** and **Allow on
  &lt;origin&gt; for this task**. The allowance covers that exact origin, in that tab,
  for the agent task that asked, and ends with the task: `supercode mcp serve` gives
  its calls one task id for its lifetime, and a CLI call carries `SUPERCODE_TASK_ID`
  when it is set (without one, a card offers only Allow once). Navigating to another
  origin asks again.
- **Always asks, once only:** scripts, and fills into a sensitive field: an input
  whose `type` is `password` or `file` when the fill is about to run, or whose
  `autocomplete` names a password, a one-time code or a card (`cc-*`). These cards
  offer only Allow once, even on an allowed origin.

Whether to ask never depends on what an element is called. The words on and around
the element only shape the card: "may submit, pay or delete" when they include words
such as submit, pay, delete, order, approve, merge or transfer, and "may submit its
form" for Enter in a text field inside a form. A card names the key Playwright
actually sends (modifiers kept, `NumpadEnter` shown as Enter), a select's chosen
options by label and value, a drag's element at the drop point, and a raw pointer
action's point and the element under it. A script card shows the full source and
arguments and what the script can reach while it runs; scripts over 20,000 characters
are refused.

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

A script holds the page through a membrane: when it ends, or its 9 seconds run out, the
membrane closes, so every later call it makes throws, and the routes, exposed bindings
and functions, init scripts and listeners it installed are removed before the next call.

When an operation asks, the messenger in that tab opens with the card and the agent's
call stays open: the native companion writes Supercode `pending` lines, and Supercode
waits up to 120 s after each, never past 10 minutes. A caller that does not declare it
can wait is refused at once and the person is not asked. While a card is open, every
other browser operation on that tab is refused with the pending decision named, both
when it is routed and again when a call queued earlier starts to run.

Against clickjacking, measured inside the extension's frame: an Allow button arms only
after the card has been fully visible and still for a second (IntersectionObserver v2:
not covered, faded or transformed; any move or resize of the card or of the messenger
frame restarts it) and the pointer has moved onto that button and rested there for half
a second (leaving or re-entering the button, or the frame moving, restarts it; a button
that appears under a pointer that is not moving does not arm). The card never takes
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
