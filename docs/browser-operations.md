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
an offscreen document, so it survives the tab's navigations. It drives the tab
through an AlmostCDP surface (`surface.js`) that runs in the page's main world and
idles until an agent first drives that tab; the tab's content script relays the
surface's port. There is no second browser and no `debugger` permission. Events are
synthetic (`isTrusted` remains false).

The surface answers Playwright's evaluations with `eval` in the page, so a page whose
Content-Security-Policy forbids `unsafe-eval` refuses them: operations on such a page
fail at once with the policy's `EvalError`.

Password/file fields and controls likely to submit, purchase, publish, send, transfer,
or delete return `APPROVAL_REQUIRED`: Vibewaiting's guard is asked before each locator
action. `browser.script` runs the agent's Playwright source with the real `page`,
including `page.evaluate`, so it is not guarded: allowing the `browser.script`
permission class trusts the agent with the page.

The `scripting`, `offscreen`, `nativeMessaging`, `storage`, and optional HTTP/HTTPS
host access are sufficient. Vibewaiting does not request `debugger`, `tabs`, `cookies`,
`webRequest`, browsing-history, or clipboard permission for this provider. Revoking
website access unregisters the content script and makes the provider unavailable.
