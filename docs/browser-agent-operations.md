# Browser agent operations

The browser agent is two Cloudflare Workers: the workbench and its separate generated-code sandbox. The guarded deploy command always builds once, deploys the sandbox first, verifies its framing policy, deploys the workbench, and runs non-billable probes. A failed probe rolls both Workers back to the versions that were active before the command began.

## Preflight and deploy

```sh
npm run deploy:browser-agent:dry-run
npm run deploy:browser-agent
```

An actual deploy requires a clean worktree. The Git commit is attached as the Cloudflare version tag and message. Dashboard-managed variables are retained with `--keep-vars`.

The smoke gate checks:

- `/api/health` and `/api/ready`, including the exact deployed Worker version;
- session-cookie rejection without starting device auth;
- cross-origin mutation rejection without contacting xAI;
- the workbench CSP and removal of runtime CDN access;
- the sandbox CSP and its exact workbench `frame-ancestors` boundary.

Run the workbench probes independently with:

```sh
npm run smoke:browser-agent -- https://vibewaiting-browser-agent.aaron-0ed.workers.dev
```

These probes never invoke inference, media generation, web fetch, or device authorization.

## Health and metrics

`GET /api/health` is a liveness check. `GET /api/ready` validates every required binding, the 32-byte session-encryption secret, the xAI client configuration, and all kill-switch values. An intentionally disabled capability is reported in `capabilities` but does not make the deployment unready.

Every API response includes `X-Vibewaiting-Version` and `Server-Timing`. Cloudflare observability receives one structured `api_request` record with:

- normalized route and method;
- response status;
- Worker duration in milliseconds;
- Cloudflare Worker version ID.

Unexpected failures add an `api_exception` record containing only the normalized route, method, error class, and version. Logs never contain cookies, account IDs, IP addresses, access tokens, prompts, request bodies, generated content, or upstream error text.

## Cost controls

The single `RateGate` Durable Object applies globally consistent daily and concurrency budgets. Cloudflare Rate Limiting bindings add per-minute IP and account limits. The active ceilings are exported as `SECURITY_LIMITS` and covered by direct Durable Object tests.

Environment switches fail closed unless their value is exactly `true`:

| Variable | Scope |
| --- | --- |
| `RELAY_ENABLED` | all `/api/grok/*` proxy routes |
| `INFERENCE_ENABLED` | text and media inference |
| `MEDIA_ENABLED` | image/video generation and downloads |
| `WEB_FETCH_ENABLED` | server-side documentation fetches |

Authentication and health remain available when the relay is disabled, so users can disconnect and operators can diagnose the deployment.

## Manual rollback

The guarded deploy performs this automatically after a failed smoke test. To select an older version manually:

```sh
npx wrangler deployments list --json
npx wrangler rollback <version-id> --yes --message "rollback reason"
```

For the sandbox, add `--config wrangler.sandbox.jsonc`. Roll back the workbench before the sandbox so an already-open workbench never points at an incompatible sandbox.

## Secret rotation

Set the new 32-byte base64url key as `SESSION_ENCRYPTION_KEY` and keep the old value temporarily as `SESSION_ENCRYPTION_KEY_PREVIOUS`. Sessions are re-encrypted with the current key when read. After the maximum 30-day session lifetime, remove the previous key. Neither value belongs in Wrangler configuration, logs, health output, or source control.
