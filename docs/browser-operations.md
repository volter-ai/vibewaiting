# Supercode browser provider

Vibewaiting provides the active ordinary extension tab to Supercode. Supercode owns
the canonical operation registry, policy decisions, provider selection, SDK, CLI, and
MCP tools. Vibewaiting owns the browser permission boundary and provider adapter and
hosts Supercode's shared in-page executor.

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

The shared operations are `browser.status`, `browser.snapshot`, `browser.query`,
`browser.wait`, `browser.click`, `browser.fill`, `browser.press`, `browser.hover`,
`browser.focus`, `browser.check`, `browser.uncheck`, `browser.select`,
`browser.scroll`, `browser.back`, `browser.forward`, and `browser.reload`.
Vibewaiting accepts CSS, accessibility-ref, role/name, text, and `data-testid`
locators. Results include an opaque page handle so follow-up calls remain on the page
the agent observed even if browser focus moves. The handle is invalidated when the
content script disconnects and never reveals a Chrome tab ID.

`@volter-ai-dev/supercode-playwright-shim` provides the Playwright-shaped DOM surface
in the page that already contains the extension. It does not use CDP or create another browser. Events are synthetic
(`isTrusted` remains false), and unsupported Playwright capabilities are absent rather
than emulated dishonestly. There is no arbitrary `evaluate` or callback-source wire.
Password/file fields and controls likely to submit, purchase, publish, send, transfer,
or delete return `APPROVAL_REQUIRED`; a future Supercode approval/resume flow can
extend that boundary without changing Vibewaiting's provider protocol.

The existing `scripting`, `nativeMessaging`, `storage`, and optional HTTP/HTTPS host
access are sufficient. Vibewaiting does not request `debugger`, `tabs`, `cookies`,
`webRequest`, browsing-history, or clipboard permission for this provider. Revoking
website access unregisters the content script and makes the provider unavailable.
