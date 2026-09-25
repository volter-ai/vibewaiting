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
  debugging this browser" bar; the tab stays on this path until the debugger
  detaches, when the person cancels the bar, closes the tab or revokes website
  access. Other tabs are not attached.

`browser.snapshot` leaves out Vibewaiting's own messenger and launcher: the
executor's `snapshotExclude` drops their nodes from the snapshot without changing the
page, so a screen reader still reads them.

Password/file fields and controls likely to submit, purchase, publish, send, transfer,
or delete return `APPROVAL_REQUIRED`: Vibewaiting's guard is asked before each locator
action. `browser.script` runs the agent's Playwright source with the real `page`,
including `page.evaluate`, and its locator calls do not pass the guard, so every
`browser.script` returns `APPROVAL_REQUIRED` as well. Vibewaiting has no approval
step yet that lets a refused operation run.

The `scripting`, `offscreen`, `debugger`, `nativeMessaging`, `storage`, and optional
HTTP/HTTPS host access are sufficient. Vibewaiting does not request `tabs`,
`cookies`, `webRequest`, browsing-history, or clipboard permission for this provider.
Revoking website access unregisters the content script, detaches the debugger from
any tab it drives, and makes the provider unavailable.

Firefox has no offscreen documents or extension debugger API, so there
`browser.status` and every other operation answer `NOT_AVAILABLE` with that reason.
