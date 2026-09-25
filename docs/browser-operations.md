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

Filling a password or file field, activating a control likely to submit, purchase,
publish, send, transfer or delete, and every `browser.script` need the person's
approval. Vibewaiting's guard (`extension/browser-policy.ts`) is asked before each
locator action and before each script; a script runs the agent's Playwright source
with the real `page`, including `page.evaluate`, and its own locator calls do not pass
the guard, so the script itself is what the person approves.

When the guard stops an operation, the messenger in that tab opens with an approval
card naming the exact action and page ("Fill password field on github.com/login",
"Run script on example.com", with the script's source shown). The agent's call stays
open meanwhile: the native companion writes Supercode `pending` lines, and Supercode
waits up to 120 s after each.

- **Approve once** re-runs that one operation with a one-time grant bound to the
  operation's id, its tab and the exact action the card named (the action, the page
  URL and the element). The grant lets that single action through and ends with the
  operation; the agent receives the operation's own result. If the page changed so the
  action no longer matches, nothing runs and the agent is told so.
- **Deny** returns `APPROVAL_REQUIRED` with "The person denied this in Vibewaiting: …
  Nothing ran."
- No answer in 90 seconds, or closing the tab, refuses the same way and says why.

Nothing is approved standing: the same action later asks again. The card never takes
focus, so a keystroke meant for the page cannot answer it.

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
