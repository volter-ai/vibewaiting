# Grok Build browser port

This experiment translates the Apache-2.0 Grok Build agent path into browser-safe
TypeScript. The browser owns the conversation state machine, native prompt, full
27-tool request registry, Responses streaming/replay, tool dispatch, virtual filesystem,
and Vite-compatible preview. A small same-origin relay owns only xAI device credentials,
rate limits, token refresh, and authenticated forwarding to Grok Build's
`cli-chat-proxy.grok.com/v1` endpoints.

The current parity baseline is Grok Build `1.0.5` (`5115b46bc909`) at open-source
revision `9684fa3cdbf2995e30ea8b9b637f1db008f144fc`. Core file reads, edits, bounded
directory walks, parallel dispatch, completion ordering, and same-file FIFO locks are
translated from that revision rather than inferred from a generic agent harness.

Live browser sessions fetch the native model catalog and fetch remote settings twice
(early resolution followed by the native re-apply), with the same bounded retries and
embedded-model fallback behavior. The selected model supplies the context window,
reasoning effort, compaction threshold/count, and remotely gated tool registry. These
startup paths remain labelled `source-ported` until a dedicated native startup corpus
proves them end to end; `src/grok-build-parity.ts` in this experiment is the public release ledger and does
not collapse source translation into corpus-proven exactness.

After authentication, the browser also runs Grok Build's one-hour published-bundle
sync in the background. It tries the archive endpoint first, falls back to the legacy
JSON endpoint only on a non-401 failure, and stores the result under
`/.grok/bundled` in the persistent browser filesystem. Tar extraction supports the
PAX records used by the real archive and enforces entry, per-file, decompressed, and
compressed-size bounds. SHA-256 manifests preserve user edits: a locally modified
published file is never overwritten or pruned. The extractor is tested directly
against the 3.87 MiB native archive in the auto-compaction corpus and reproduces its
415 managed files.

Cached project and published skills are discovered before session construction.
Local `.grok`, `.agents`, `.claude`, and `.cursor` skills shadow bundled skills, and
the source-ported listing is inserted in native order between the user-info prefix and
the user query. The public parity ledger keeps dynamic/path-gated skill discovery,
custom extend-mode subagent layering, and Rhai workflow execution visible as separate
gaps. The three built-in subagent definitions use their native full prompt bodies and
tool-name template substitutions; project definitions can shadow them, and additional
bundled definitions are discoverable by name.

The project runs inside Almostnode's browser virtual filesystem. Local development uses
a same-origin iframe so it is easy to inspect; production must provide Almostnode's
cross-origin sandbox host before executing untrusted generated code.

## Run locally

```sh
GROK_HOME=/path/to/an/isolated/grok-home npm run dev:browser-agent
```

Open <http://127.0.0.1:4175>. The development relay rereads `GROK_HOME/auth.json` on
each request and never exposes the bearer token to browser JavaScript.

In production, the connection card starts xAI's device-code flow, shows the user code
and approval URL, and polls until the subscription is connected. Tokens and refresh
tokens remain encrypted in the Worker session object and are never returned to the page.

## Native transport conformance

`scripts/grok-conformance-proxy.mjs` records native Grok Build HTTP exchanges and then
acts as a fail-closed replay oracle for the browser port. It compares method, path,
query, every meaningful header, complete JSON bodies, ordering, and dynamic-ID reuse.
Credentials are redacted; UUIDs are matched by identity relationships rather than
literal values. A response is released only after the corresponding browser request
matches, and the first mismatch returns HTTP 409 with JSON-pointer differences.

Record a native session:

```sh
npm run build:conformance
node scripts/grok-conformance-proxy.mjs record \
  --corpus test/fixtures/grok-conformance/my-session.jsonl \
  --task "Build and verify the project" \
  --fixture three-pong-starter-v1 \
  --overwrite

GROK_HOME=/path/to/an/isolated/grok-home \
GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:4319/native/v1 \
grok --cwd /path/to/the/matching-fixture --permission-mode bypassPermissions \
  --output-format streaming-json -p "Build and verify the project"
```

Replay it against the browser:

```sh
node scripts/grok-conformance-proxy.mjs replay \
  --corpus test/fixtures/grok-conformance/my-session.jsonl

GROK_HOME=/path/to/an/isolated/grok-home \
GROK_CONFORMANCE_BASE_URL=http://127.0.0.1:4319/browser/v1 \
npm run dev:browser-agent
```

Then open
`http://127.0.0.1:4175/?conformance=http://127.0.0.1:4319`. Known fixtures execute
the native calls against the real browser filesystem and shell, validate their effects,
and return recorded text in native completion order so the next request remains
byte-exact. Unknown fixtures still test transport deterministically with recorded tool
outputs.

The current Pong corpus covers seven exact model requests: the title side-call, five
foreground turns, and the post-turn dashboard summary. Its 114k-token native trajectory
includes directory inspection, three parallel reads, a 265-line Three.js write,
`npm run check`, encrypted reasoning replay, and normal termination. The browser
execution produced one HMR update, no iframe reload, a `pong-v1` render marker, and a
working keyboard serve. Every request must match before its recorded response is
released, so the corpus replays quickly without weakening the comparison.

## Production boundary

The Cloudflare Worker exposes `/api/grok/responses`, performs xAI device authorization,
stores refresh/access tokens encrypted in a per-session Durable Object, validates the
pinned native Responses envelope, forwards streams without buffering, and applies
per-IP, per-user, global daily, and concurrency limits. `INFERENCE_ENABLED` defaults to
`false`; enable it only after configuring the cross-origin runtime sandbox and required
Worker secrets.

Service-backed tools—subagents, MCP/tool search, workflows, user questions, and media
generation—use explicit adapters. Local filesystem, terminal, edit/search, todo,
background command, scheduler, monitor, and plan-state tools run in the browser. A
missing service adapter returns a visible tool error instead of silently substituting a
different harness.
